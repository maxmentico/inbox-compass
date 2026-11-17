// Isolated coordinator state-machine prototype. NOT connected to the production Worker.
// This module does not mask email content, implement production retention, or provide a real
// authoritative state commit. Inputs and stored partials must remain synthetic until those exist.
// No secrets, bearer tokens or payloads may be logged or returned by public routes.

const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const ALIAS = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const LEASE_MS = 6 * 60_000;
const ATTEMPT_MS = 2 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_MAILBOXES = 50;
const MAX_PARTIAL_BYTES = 64 * 1024;
const MAX_CHUNKS = 160;
// Synthetic safety cap only; production limits need workload and deployed-plan measurements.
const MAX_JOB_STAGE_BYTES = 32 * 1024 * 1024;

type Mailbox = { alias: string; identity: string };
type Create = { job: string; generation: string; driver: 'web' | 'cron'; mailboxes: Mailbox[] };
type JobRow = { job: string; generation: string; config: string; expires: number; state: string; committed: string | null; preparation: string | null };
type StepRow = { alias: string; identity: string; state: string; attempt: number; token: string | null; deadline: number | null; partial: string | null; partial_count: number | null };
type FinalRow = { token: string; deadline: number };
type ChunkRef = { hash: string; bytes: number };
/** A trusted same-storage callback. It must atomically write every authoritative value using
 * this exact SQLite transaction and throw on any failed identity/version/manifest check. */
export type AtomicCommit = (sql: SqlStorage, job: string, generation: string, digestId: string, preparation: string) => true;
/** Optional same-transaction initializer for binding account link epochs at job creation. */
export type AtomicJobBinding = (sql: SqlStorage, job: string, generation: string) => true;
/** Synchronous same-transaction check for retries of an already-created job. */
export type AtomicExistingJobCheck = (sql: SqlStorage, job: string, generation: string) => boolean;
/** Optional trusted same-transaction terminal-step metadata fence for synthetic coordinators. */
export type AtomicStepBinding = (sql: SqlStorage, job: string, generation: string, alias: string, token: string | null, state: 'done' | 'failed', hash: string | null, retry: boolean, cause?: 'timeout' | 'error') => boolean;
/** Optional transaction-bound snapshot pin for an attempt, including idempotent retries. */
export type AtomicClaimBinding = (sql:SqlStorage,job:string,generation:string,alias:string,token:string,attempt:number,retry:boolean)=>boolean;

export class JobStateCore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage, private readonly commit?: AtomicCommit, private readonly bindJob?: AtomicJobBinding, private readonly checkExisting?: AtomicExistingJobCheck, private readonly bindStep?: AtomicStepBinding,private readonly bindClaim?:AtomicClaimBinding) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS core_active (singleton INTEGER PRIMARY KEY CHECK(singleton=1), job TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS core_jobs (job TEXT PRIMARY KEY, generation TEXT UNIQUE NOT NULL, config TEXT NOT NULL, expires INTEGER NOT NULL, state TEXT NOT NULL, committed TEXT, preparation TEXT)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS core_steps (job TEXT NOT NULL, alias TEXT NOT NULL, identity TEXT NOT NULL, state TEXT NOT NULL, attempt INTEGER NOT NULL, token TEXT, deadline INTEGER, partial TEXT, partial_count INTEGER, PRIMARY KEY(job, alias))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS core_tokens (token TEXT PRIMARY KEY)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS core_stage_budget (job TEXT PRIMARY KEY, bytes INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS core_stages (job TEXT NOT NULL, alias TEXT NOT NULL, token TEXT NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job, alias, token))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS core_chunks (job TEXT NOT NULL, alias TEXT NOT NULL, token TEXT NOT NULL, idx INTEGER NOT NULL, total INTEGER NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY(job, alias, token, idx))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS core_final (job TEXT PRIMARY KEY, token TEXT NOT NULL, deadline INTEGER NOT NULL)');
  }
  private job(job: string): JobRow | undefined { return this.sql.exec<JobRow>('SELECT job, generation, config, expires, state, committed, preparation FROM core_jobs WHERE job = ?', job).toArray()[0]; }
  private current(job: string, generation: string, now: number): JobRow | undefined {
    const j = this.job(job);
    const active = this.sql.exec<{ job: string }>('SELECT job FROM core_active WHERE singleton = 1').toArray()[0];
    return j && j.generation === generation && j.state === 'running' && j.expires > now && active?.job === job ? j : undefined;
  }
  private row(job: string, alias: string): StepRow | undefined {
    return this.sql.exec<StepRow>('SELECT alias, identity, state, attempt, token, deadline, partial, partial_count FROM core_steps WHERE job = ? AND alias = ?', job, alias).toArray()[0];
  }
  private reserve(token: string): boolean {
    if (this.sql.exec('SELECT token FROM core_tokens WHERE token = ?', token).toArray().length) return false;
    this.sql.exec('INSERT INTO core_tokens (token) VALUES (?)', token);
    return true;
  }
  create(input: Create): { ok: boolean; reason?: string } {
    if (!input || !TOKEN.test(input.job) || !TOKEN.test(input.generation) || !['web', 'cron'].includes(input.driver) || !Array.isArray(input.mailboxes) || input.mailboxes.length > MAX_MAILBOXES || input.mailboxes.some(m => !m || !ALIAS.test(m.alias) || !HASH.test(m.identity)) || new Set(input.mailboxes.map(m => m.alias)).size !== input.mailboxes.length) return { ok: false, reason: 'invalid' };
    const config = JSON.stringify({ driver: input.driver, mailboxes: input.mailboxes.map(({ alias, identity }) => ({ alias, identity })).sort((a,b) => a.alias < b.alias ? -1 : a.alias > b.alias ? 1 : 0) });
    return this.storage.transactionSync(() => {
      const now = Date.now();
      const prior = this.job(input.job);
      if (prior) return { ok: prior.generation === input.generation && prior.config === config && prior.state === 'running' && prior.expires > now && (!this.checkExisting || this.checkExisting(this.sql, input.job, input.generation) === true) };
      const active = this.sql.exec<{ job: string }>('SELECT job FROM core_active WHERE singleton = 1').toArray()[0];
      const old = active && this.job(active.job);
      if (old && old.state === 'running' && old.expires > now) return { ok: false, reason: 'busy' };
      if (!this.reserve(input.generation)) return { ok: false, reason: 'used-token' };
      if (old && old.state === 'running') this.sql.exec("UPDATE core_jobs SET state = 'stopped' WHERE job = ?", old.job);
      this.sql.exec("INSERT INTO core_jobs (job, generation, config, expires, state) VALUES (?, ?, ?, ?, 'running')", input.job, input.generation, config, now + LEASE_MS);
      this.sql.exec('INSERT INTO core_stage_budget (job,bytes) VALUES (?,0)',input.job);
      for (const m of input.mailboxes) this.sql.exec("INSERT INTO core_steps (job, alias, identity, state, attempt) VALUES (?, ?, ?, 'todo', 0)", input.job, m.alias, m.identity);
      if (this.bindJob && this.bindJob(this.sql, input.job, input.generation) !== true) throw new Error('job identity binding did not complete synchronously');
      this.sql.exec('INSERT OR REPLACE INTO core_active (singleton, job) VALUES (1, ?)', input.job);
      return { ok: true };
    });
  }
  /** Observer has no access to lease or attempt tokens. */
  observe(job: string) {
    return this.storage.transactionSync(() => {
      const j = this.job(job); if (!j) return null;
      const rows = this.sql.exec<{ alias: string; state: string; attempt: number; partial: string | null }>('SELECT alias, state, attempt, partial FROM core_steps WHERE job = ? ORDER BY alias', job).toArray();
      return { job: j.job, state: j.state === 'running' && j.expires <= Date.now() ? 'stopped' : j.state, committed: j.committed, rows };
    });
  }
  renewJob(job: string, generation: string): boolean {
    return this.storage.transactionSync(() => { const now = Date.now(); if (!this.current(job, generation, now)) return false; this.sql.exec('UPDATE core_jobs SET expires = ? WHERE job = ?', now + LEASE_MS, job); return true; });
  }
  claim(job: string, generation: string, token: string): { kind: 'claim'; alias: string; identity: string; attempt: number; deadline: number } | { kind: 'wait' | 'ready' | 'stopped' | 'used-token' } {
    if (!TOKEN.test(token)) return { kind: 'used-token' };
    return this.storage.transactionSync(() => {
      const now = Date.now(); if (!this.current(job, generation, now)) return { kind: 'stopped' };
      const rows = this.sql.exec<StepRow>('SELECT alias, identity, state, attempt, token, deadline, partial, partial_count FROM core_steps WHERE job = ? ORDER BY alias', job).toArray();
      const same = rows.find(r => r.state === 'running' && r.token === token && r.deadline! > now);
      if (same) {if(this.bindClaim&&this.bindClaim(this.sql,job,generation,same.alias,token,same.attempt,true)!==true)return {kind:'stopped'};return { kind: 'claim', alias: same.alias, identity: same.identity, attempt: same.attempt, deadline: same.deadline! };}
      if (rows.some(r => r.state === 'running' && r.deadline! > now)) return { kind: 'wait' };
      const expired = rows.find(r => r.state === 'running');
      if (expired && expired.attempt >= MAX_ATTEMPTS) { if(this.bindStep && this.bindStep(this.sql,job,generation,expired.alias,expired.token,'failed',null,false,'timeout')!==true) throw new Error('step result binding failed'); this.sql.exec("UPDATE core_steps SET state = 'failed', token = NULL, deadline = NULL WHERE job = ? AND alias = ?", job, expired.alias); }
      const target = expired && expired.attempt < MAX_ATTEMPTS ? expired : rows.find(r => r.state === 'todo');
      if (!target) return { kind: 'ready' };
      if (!this.reserve(token)) return { kind: 'used-token' };
      const attempt = target.attempt + 1, deadline = now + ATTEMPT_MS;
      if(this.bindClaim&&this.bindClaim(this.sql,job,generation,target.alias,token,attempt,false)!==true)throw new Error('attempt binding failed');
      this.sql.exec("UPDATE core_steps SET state = 'running', attempt = ?, token = ?, deadline = ? WHERE job = ? AND alias = ?", attempt, token, deadline, job, target.alias);
      return { kind: 'claim', alias: target.alias, identity: target.identity, attempt, deadline };
    });
  }
  renewClaim(job: string, generation: string, alias: string, token: string): boolean {
    return this.storage.transactionSync(() => { const now = Date.now(), row = this.row(job, alias); if (!this.current(job, generation, now) || row?.state !== 'running' || row.token !== token || row.deadline! <= now) return false; this.sql.exec('UPDATE core_steps SET deadline = ? WHERE job = ? AND alias = ?', now + ATTEMPT_MS, job, alias); return true; });
  }
  async stage(job: string, generation: string, alias: string, token: string, bytes: Uint8Array): Promise<string | null> {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_PARTIAL_BYTES) return null;
    const copy = new Uint8Array(bytes);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
    const data = btoa(String.fromCharCode(...copy));
    return this.storage.transactionSync(() => {
      const now = Date.now(), row = this.row(job, alias);
      if (!this.current(job, generation, now) || row?.state !== 'running' || row.token !== token || row.deadline! <= now) return null;
      if (this.sql.exec('SELECT idx FROM core_chunks WHERE job = ? AND alias = ? AND token = ? LIMIT 1', job, alias, token).toArray().length) return null;
      const prior = this.sql.exec<{ hash: string; data: string }>('SELECT hash, data FROM core_stages WHERE job = ? AND alias = ? AND token = ?', job, alias, token).toArray()[0];
      if (prior) return prior.hash === hash && prior.data === data ? hash : null;
      const budget = this.sql.exec<{bytes:number}>('SELECT bytes FROM core_stage_budget WHERE job=?',job).toArray()[0];
      if(!budget || budget.bytes + copy.byteLength > MAX_JOB_STAGE_BYTES)return null;
      this.sql.exec('INSERT INTO core_stages (job, alias, token, hash, bytes, data) VALUES (?, ?, ?, ?, ?, ?)', job, alias, token, hash, copy.byteLength, data);
      this.sql.exec('UPDATE core_stage_budget SET bytes=bytes+? WHERE job=?',copy.byteLength,job); return hash;
    });
  }
  /** Stage a bounded immutable chunk; an attempt can never change its chunk count or bytes. */
  async stageChunk(job: string, generation: string, alias: string, token: string, index: number, total: number, bytes: Uint8Array): Promise<ChunkRef | null> {
    if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || total < 1 || total > MAX_CHUNKS || index < 0 || index >= total || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > MAX_PARTIAL_BYTES) return null;
    const copy = new Uint8Array(bytes);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
    const data = btoa(String.fromCharCode(...copy));
    return this.storage.transactionSync(() => {
      const now = Date.now(), row = this.row(job, alias);
      if (!this.current(job, generation, now) || row?.state !== 'running' || row.token !== token || row.deadline! <= now) return null;
      if (this.sql.exec('SELECT hash FROM core_stages WHERE job = ? AND alias = ? AND token = ?', job, alias, token).toArray().length) return null;
      const first = this.sql.exec<{ total: number }>('SELECT total FROM core_chunks WHERE job = ? AND alias = ? AND token = ? LIMIT 1', job, alias, token).toArray()[0];
      if (first && first.total !== total) return null;
      const prior = this.sql.exec<{ hash: string; data: string; bytes: number }>('SELECT hash, data, bytes FROM core_chunks WHERE job = ? AND alias = ? AND token = ? AND idx = ?', job, alias, token, index).toArray()[0];
      if (prior) return prior.hash === hash && prior.data === data ? { hash, bytes: copy.byteLength } : null;
      const budget = this.sql.exec<{bytes:number}>('SELECT bytes FROM core_stage_budget WHERE job=?',job).toArray()[0];
      if(!budget || budget.bytes+copy.byteLength>MAX_JOB_STAGE_BYTES)return null;
      this.sql.exec('INSERT INTO core_chunks (job, alias, token, idx, total, hash, bytes, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', job, alias, token, index, total, hash, copy.byteLength, data);
      this.sql.exec('UPDATE core_stage_budget SET bytes=bytes+? WHERE job=?',copy.byteLength,job);
      return { hash, bytes: copy.byteLength };
    });
  }
  /** Accept only a complete, ordered set of stored chunks; hash metadata, not the payload. */
  async acceptChunks(job: string, generation: string, alias: string, token: string, refs: ChunkRef[]): Promise<string | null> {
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > MAX_CHUNKS) return null;
    const pinned = refs.map(r => ({ hash: r?.hash, bytes: r?.bytes }));
    if (pinned.some(r => typeof r.hash !== 'string' || !HASH.test(r.hash) || !Number.isSafeInteger(r.bytes) || r.bytes < 1 || r.bytes > MAX_PARTIAL_BYTES)) return null;
    const descriptor = JSON.stringify(pinned.map(r => [r.hash, r.bytes]));
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(descriptor)))].map(b => b.toString(16).padStart(2, '0')).join('');
    return this.storage.transactionSync(() => {
      const now = Date.now(), row = this.row(job, alias);
      if (!this.current(job, generation, now) || !row) return null;
      if (row.state === 'done') return row.token === token && row.partial === hash && (!this.bindStep || this.bindStep(this.sql,job,generation,alias,token,'done',hash,true)===true) ? hash : null;
      if (row.state !== 'running' || row.token !== token || row.deadline! <= now) return null;
      const stored = this.sql.exec<{ idx: number; total: number; hash: string; bytes: number }>('SELECT idx, total, hash, bytes FROM core_chunks WHERE job = ? AND alias = ? AND token = ? ORDER BY idx', job, alias, token).toArray();
      if (stored.length !== pinned.length || stored.some((chunk, i) => chunk.idx !== i || chunk.total !== pinned.length || chunk.hash !== pinned[i]?.hash || chunk.bytes !== pinned[i]?.bytes)) return null;
      if(this.bindStep && this.bindStep(this.sql,job,generation,alias,token,'done',hash,false)!==true) throw new Error('step result binding failed');
      this.sql.exec("UPDATE core_steps SET state = 'done', partial = ?, partial_count = ?, deadline = NULL WHERE job = ? AND alias = ?", hash, pinned.length, job, alias); return hash;
    });
  }
  /** Read one accepted chunk in a bounded call. Trusted internal use only. */
  readAcceptedChunk(job: string, generation: string, alias: string, index: number): Uint8Array | null {
    if (!Number.isSafeInteger(index) || index < 0 || index >= MAX_CHUNKS) return null;
    return this.storage.transactionSync(() => {
      const row = this.row(job, alias);
      if (!this.current(job, generation, Date.now()) || row?.state !== 'done' || !row.token) return null;
      if (row.partial_count === null || index >= row.partial_count) return null;
      let chunk = this.sql.exec<{ data: string }>('SELECT data FROM core_chunks WHERE job = ? AND alias = ? AND token = ? AND idx = ?', job, alias, row.token, index).toArray()[0];
      if (!chunk && index === 0) chunk = this.sql.exec<{ data: string }>('SELECT data FROM core_stages WHERE job = ? AND alias = ? AND token = ? AND hash = ?', job, alias, row.token, row.partial).toArray()[0];
      if (!chunk) throw new Error('missing accepted partial chunk');
      return Uint8Array.from(atob(chunk.data), c => c.charCodeAt(0));
    });
  }
  accept(job: string, generation: string, alias: string, token: string, hash: string): boolean {
    if (!HASH.test(hash)) return false;
    return this.storage.transactionSync(() => {
      const now = Date.now(), row = this.row(job, alias);
      if (!this.current(job, generation, now) || !row) return false;
      if (row.state === 'done') return row.token === token && row.partial === hash && (!this.bindStep || this.bindStep(this.sql,job,generation,alias,token,'done',hash,true)===true);
      if (row.state !== 'running' || row.token !== token || row.deadline! <= now) return false;
      if (!this.sql.exec('SELECT hash FROM core_stages WHERE job = ? AND alias = ? AND token = ? AND hash = ?', job, alias, token, hash).toArray().length) return false;
      if(this.bindStep && this.bindStep(this.sql,job,generation,alias,token,'done',hash,false)!==true) throw new Error('step result binding failed');
      this.sql.exec("UPDATE core_steps SET state = 'done', partial = ?, partial_count = 1, deadline = NULL WHERE job = ? AND alias = ?", hash, job, alias); return true;
    });
  }
  fail(job: string, generation: string, alias: string, token: string): boolean {
    return this.storage.transactionSync(() => { const now = Date.now(), row = this.row(job, alias); if (!this.current(job, generation, now) || !row || row.token !== token) return false; if (row.state === 'failed') return !this.bindStep || this.bindStep(this.sql,job,generation,alias,token,'failed',null,true)===true; if (row.state !== 'running' || row.deadline! <= now) return false; if(this.bindStep && this.bindStep(this.sql,job,generation,alias,token,'failed',null,false,'error')!==true) throw new Error('step result binding failed'); this.sql.exec("UPDATE core_steps SET state = 'failed', deadline = NULL WHERE job = ? AND alias = ?", job, alias); return true; });
  }
  /** Give up only on unclaimed or expired work. A live attempt is never overwritten. */
  giveUp(job: string, generation: string, alias: string): boolean {
    return this.storage.transactionSync(() => {
      const now = Date.now(), row = this.row(job, alias);
      if (!this.current(job, generation, now) || !row) return false;
      if (row.state === 'failed') return !this.bindStep || this.bindStep(this.sql,job,generation,alias,row.token,'failed',null,true)===true;
      if (row.state !== 'todo' && !(row.state === 'running' && row.deadline! <= now)) return false;
      if(this.bindStep && this.bindStep(this.sql,job,generation,alias,row.token,'failed',null,false,'timeout')!==true) throw new Error('step result binding failed');
      this.sql.exec("UPDATE core_steps SET state = 'failed', token = NULL, deadline = NULL WHERE job = ? AND alias = ?", job, alias);
      return true;
    });
  }
  /** Bounded, fail-closed reclaim of an unaccepted attempt. Never deletes accepted/live data. */
  discardAttempt(job:string,generation:string,alias:string,token:string,limit:number):{ok:boolean;remaining:number}|null {
    if(!TOKEN.test(token)||!Number.isSafeInteger(limit)||limit<1||limit>16)return null;
    return this.storage.transactionSync(()=>{
      const now=Date.now(),row=this.row(job,alias);
      if(!this.current(job,generation,now)||!row)return null;
      if(row.token===token && (row.state==='done'||(row.state==='running'&&row.deadline!>now)))return {ok:false,remaining:0};
      const selected=this.sql.exec<{idx:number;bytes:number}>('SELECT idx,bytes FROM core_chunks WHERE job=? AND alias=? AND token=? ORDER BY idx LIMIT ?',job,alias,token,limit).toArray();
      let removed=0;
      for(const part of selected){this.sql.exec('DELETE FROM core_chunks WHERE job=? AND alias=? AND token=? AND idx=?',job,alias,token,part.idx);removed+=part.bytes;}
      if(selected.length<limit){
        const single=this.sql.exec<{bytes:number}>('SELECT bytes FROM core_stages WHERE job=? AND alias=? AND token=?',job,alias,token).toArray()[0];
        if(single){this.sql.exec('DELETE FROM core_stages WHERE job=? AND alias=? AND token=?',job,alias,token);removed+=single.bytes;}
      }
      const budget=this.sql.exec<{bytes:number}>('SELECT bytes FROM core_stage_budget WHERE job=?',job).toArray()[0];
      if(!budget||removed>budget.bytes)throw new Error('invalid stage budget');
      if(removed)this.sql.exec('UPDATE core_stage_budget SET bytes=bytes-? WHERE job=?',removed,job);
      const chunks=this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM core_chunks WHERE job=? AND alias=? AND token=?',job,alias,token).toArray()[0]?.n??0;
      const single=this.sql.exec('SELECT hash FROM core_stages WHERE job=? AND alias=? AND token=?',job,alias,token).toArray().length;
      return {ok:true,remaining:chunks+single};
    });
  }
  claimFinal(job: string, generation: string, token: string): boolean {
    if (!TOKEN.test(token)) return false;
    return this.storage.transactionSync(() => {
      const now = Date.now(); if (!this.current(job, generation, now)) return false;
      const pending = this.sql.exec("SELECT alias FROM core_steps WHERE job = ? AND state IN ('todo', 'running') LIMIT 1", job).toArray(); if (pending.length) return false;
      const existing = this.sql.exec<FinalRow>('SELECT token, deadline FROM core_final WHERE job = ?', job).toArray()[0];
      if (existing && existing.deadline > now) return existing.token === token;
      if (!this.reserve(token)) return false;
      this.sql.exec('INSERT OR REPLACE INTO core_final (job, token, deadline) VALUES (?, ?, ?)', job, token, now + ATTEMPT_MS); return true;
    });
  }
  finalize(job: string, generation: string, token: string, digestId: string, preparation: string): boolean {
    if (!this.commit || !digestId || digestId.length > 128 || !TOKEN.test(preparation)) return false;
    return this.storage.transactionSync(() => {
      const j = this.job(job); if (j?.generation === generation && j.state === 'committed') return j.committed === digestId && j.preparation === preparation && this.sql.exec<FinalRow>('SELECT token, deadline FROM core_final WHERE job = ?', job).toArray()[0]?.token === token;
      const now = Date.now(), final = this.sql.exec<FinalRow>('SELECT token, deadline FROM core_final WHERE job = ?', job).toArray()[0];
      if (!this.current(job, generation, now) || !final || final.token !== token || final.deadline <= now) return false;
      if (this.commit!(this.sql, job, generation, digestId, preparation) !== true) throw new Error('commit did not complete synchronously');
      this.sql.exec("UPDATE core_jobs SET state = 'committed', committed = ?, preparation = ? WHERE job = ?", digestId, preparation, job);
      this.sql.exec('DELETE FROM core_active WHERE singleton = 1 AND job = ?', job); return true;
    });
  }
}
