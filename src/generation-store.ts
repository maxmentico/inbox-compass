// SYNTHETIC PROTOTYPE ONLY. Not exported/bound by the production Worker. No production
// masking, retention, deletion, account mutation integration or rollout exists yet.
// A semantic verifier is mandatory: matching a supplied manifest cannot prove that it contains
// every cursor, recheck, identity, setting and digest change the real pipeline requires.
import type { AtomicCommit } from './job-state-core';

const ID = /^[A-Za-z0-9_-]{22,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const LIMIT_OPS = 1000, LIMIT_CHUNKS = 1024, LIMIT_BYTES = 8 * 1024 * 1024, CHUNK_BYTES = 64 * 1024;
type Chunk = { hash: string; bytes: number };
export type Change = { key: string; kind: 'put' | 'delete'; chunks?: Chunk[]; expiresAt?: number; metadata?: { arrived: number } };
type Version = { key: string; version: number };
export type Manifest = { job: string; generation: string; preparation: string; expectedPreparation: string | null; token: string; digest: string; previous: string | null; sourceId?: string; versions: Version[]; changes: Change[] };
/** Trusted, synchronous, same-transaction domain verifier; false or throw aborts all writes. */
export type SemanticVerifier = (sql: SqlStorage, manifest: Readonly<Manifest>) => boolean;

export class GenerationStore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage, private readonly verify?: SemanticVerifier) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS gen_prepared (generation TEXT NOT NULL, preparation TEXT NOT NULL, job TEXT NOT NULL, token TEXT NOT NULL, manifest TEXT NOT NULL, reserved INTEGER NOT NULL, PRIMARY KEY(generation, preparation))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS gen_preparation_ids (generation TEXT NOT NULL, preparation TEXT NOT NULL, PRIMARY KEY(generation, preparation))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS gen_chunks (generation TEXT NOT NULL, preparation TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (generation, preparation, key, idx))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS gen_selected (generation TEXT PRIMARY KEY, preparation TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS gen_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS gen_key_heads (key TEXT PRIMARY KEY, generation TEXT NOT NULL, preparation TEXT NOT NULL, kind TEXT NOT NULL, expires_at INTEGER, metadata TEXT, chunks INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS gen_key_heads_generation_preparation ON gen_key_heads (generation,preparation)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS gen_versions (key TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  }
  private validClaim(job: string, generation: string, token: string): boolean {
    const rows = this.sql.exec<{ expires: number; deadline: number }>("SELECT j.expires, f.deadline FROM core_jobs j JOIN core_final f ON f.job=j.job JOIN core_active a ON a.singleton=1 AND a.job=j.job WHERE j.job=? AND j.generation=? AND j.state='running' AND f.token=?", job, generation, token).toArray();
    return !!rows[0] && rows[0].expires > Date.now() && rows[0].deadline > Date.now();
  }
  private valid(m: Manifest): boolean {
    if (!m || !ID.test(m.job) || !ID.test(m.generation) || !ID.test(m.preparation) || (m.expectedPreparation !== null && !ID.test(m.expectedPreparation)) || !ID.test(m.token) || (m.sourceId!==undefined && !ID.test(m.sourceId)) || typeof m.digest !== 'string' || m.digest.length < 1 || m.digest.length > 128 || (m.previous !== null && !ID.test(m.previous)) || !Array.isArray(m.versions) || !Array.isArray(m.changes) || m.changes.length > LIMIT_OPS || m.versions.length > LIMIT_OPS) return false;
    const keys = new Set<string>(), versions = new Set<string>(); let chunks = 0, bytes = 0;
    for (const v of m.versions) { if (!v || typeof v.key !== 'string' || !v.key.length || v.key.length > 256 || versions.has(v.key) || !Number.isSafeInteger(v.version) || v.version < 0) return false; versions.add(v.key); }
    for (const c of m.changes) {
      if (!c || typeof c.key !== 'string' || !c.key.length || c.key.length > 256 || keys.has(c.key) || !['put','delete'].includes(c.kind)) return false;
      keys.add(c.key);
      if (c.kind === 'delete') { if (c.chunks !== undefined || c.expiresAt !== undefined || c.metadata !== undefined) return false; continue; }
      if (!Array.isArray(c.chunks) || c.chunks.length > 160 || (c.expiresAt !== undefined && (!Number.isSafeInteger(c.expiresAt) || c.expiresAt <= 0)) || (c.metadata !== undefined && (!c.metadata || Object.keys(c.metadata).some(k => k !== 'arrived') || !Number.isSafeInteger(c.metadata.arrived)))) return false;
      for (const part of c.chunks) { if (!part || !HASH.test(part.hash) || !Number.isSafeInteger(part.bytes) || part.bytes < 1 || part.bytes > CHUNK_BYTES) return false; bytes += part.bytes; chunks++; }
      if (chunks > LIMIT_CHUNKS || bytes > LIMIT_BYTES) return false;
    }
    return true;
  }
  prepare(input: Manifest): boolean {
    // Validate bounds before allocating or serializing. Ignore unrelated object properties.
    if (!this.valid(input)) return false;
    const m: Manifest = {
      job: input.job, generation: input.generation, preparation: input.preparation, expectedPreparation: input.expectedPreparation, token: input.token, digest: input.digest, previous: input.previous, ...(input.sourceId===undefined?{}:{sourceId:input.sourceId}),
      versions: input.versions.map(v => ({ key: v.key, version: v.version })),
      changes: input.changes.map(c => c.kind === 'delete' ? { key: c.key, kind: 'delete' } : {
        key: c.key, kind: 'put', chunks: c.chunks!.map(p => ({ hash: p.hash, bytes: p.bytes })),
        ...(c.expiresAt !== undefined ? { expiresAt: c.expiresAt } : {}),
        ...(c.metadata ? { metadata: { arrived: c.metadata.arrived } } : {}),
      }),
    };
    const serialized = JSON.stringify(m); if (new TextEncoder().encode(serialized).length > 512 * 1024) return false;
    return this.storage.transactionSync(() => {
      if (!this.validClaim(m.job, m.generation, m.token)) return false;
      const selected = this.sql.exec<{ preparation: string }>('SELECT preparation FROM gen_selected WHERE generation=?', m.generation).toArray()[0]?.preparation ?? null;
      const prior = this.sql.exec<{ manifest: string }>('SELECT manifest FROM gen_prepared WHERE generation=? AND preparation=?', m.generation, m.preparation).toArray()[0];
      if (prior) {
        const before = JSON.parse(prior.manifest) as Manifest;
        // A replacement finalizer may adopt exactly the same immutable preparation after the
        // previous claim expires; it cannot alter its contents or adopt a different job's work.
        if (JSON.stringify({ ...before, token: '' }) !== JSON.stringify({ ...m, token: '' })) return false;
        if (selected !== m.preparation) return false;
        if (before.token !== m.token) {
          this.sql.exec('UPDATE gen_prepared SET token=?, manifest=? WHERE generation=? AND preparation=?', m.token, serialized, m.generation, m.preparation);
        }
        return true;
      }
      if (selected !== m.expectedPreparation) return false;
      // Keep a tombstone even after reclaim: a delayed request must never reuse an old ID.
      if (this.sql.exec('SELECT preparation FROM gen_preparation_ids WHERE generation=? AND preparation=?',m.generation,m.preparation).toArray().length) return false;
      const count = this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM gen_prepared WHERE generation=?', m.generation).toArray()[0]?.n ?? 0;
      if (count >= 8) return false;
      const bytes = m.changes.reduce((sum,c) => sum + (c.chunks?.reduce((n,p) => n + p.bytes, 0) ?? 0), 0);
      const reserved = this.sql.exec<{n:number}>('SELECT COALESCE(SUM(reserved),0) AS n FROM gen_prepared WHERE generation=?', m.generation).toArray()[0]?.n ?? 0;
      if (reserved + bytes > LIMIT_BYTES) return false;
      this.sql.exec('INSERT INTO gen_preparation_ids (generation,preparation) VALUES (?, ?)', m.generation, m.preparation);
      this.sql.exec('INSERT INTO gen_prepared (generation, preparation, job, token, manifest, reserved) VALUES (?, ?, ?, ?, ?, ?)', m.generation, m.preparation, m.job, m.token, serialized, bytes);
      this.sql.exec('INSERT OR REPLACE INTO gen_selected (generation, preparation) VALUES (?, ?)', m.generation, m.preparation); return true;
    });
  }
  async stage(job: string, generation: string, token: string, preparation: string, key: string, index: number, bytes: Uint8Array): Promise<boolean> {
    if (!Number.isSafeInteger(index) || index < 0 || !(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > CHUNK_BYTES) return false;
    const copy = new Uint8Array(bytes);
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))].map(b => b.toString(16).padStart(2,'0')).join('');
    const data = btoa(String.fromCharCode(...copy));
    return this.storage.transactionSync(() => {
      if (!this.validClaim(job, generation, token)) return false;
      const selected = this.sql.exec<{preparation:string}>('SELECT preparation FROM gen_selected WHERE generation=?',generation).toArray()[0]?.preparation;
      if (selected !== preparation) return false;
      const row = this.sql.exec<{ manifest: string }>('SELECT manifest FROM gen_prepared WHERE generation=? AND preparation=? AND job=? AND token=?',generation,preparation,job,token).toArray()[0];
      if (!row) return false;
      const m = JSON.parse(row.manifest) as Manifest, change = m.changes.find(c => c.key === key), expected = change?.chunks?.[index];
      if (!expected || expected.hash !== hash || expected.bytes !== copy.byteLength) return false;
      const prior = this.sql.exec<{ hash: string; bytes: number; data: string }>('SELECT hash, bytes, data FROM gen_chunks WHERE generation=? AND preparation=? AND key=? AND idx=?',generation,preparation,key,index).toArray()[0];
      if (prior) return prior.hash === hash && prior.bytes === copy.byteLength && prior.data === data;
      this.sql.exec('INSERT INTO gen_chunks (generation,preparation,key,idx,hash,bytes,data) VALUES (?, ?, ?, ?, ?, ?, ?)',generation,preparation,key,index,hash,copy.byteLength,data); return true;
    });
  }
  /** Stop using one preparation before reclaiming its unpublished chunks. Does not move the head. */
  abandon(job:string,generation:string,token:string,preparation:string):boolean {
    if (![job,generation,token,preparation].every(v=>typeof v==='string'&&ID.test(v))) return false;
    return this.storage.transactionSync(()=>{
      if(!this.validClaim(job,generation,token))return false;
      const selected=this.sql.exec<{preparation:string}>('SELECT preparation FROM gen_selected WHERE generation=?',generation).toArray()[0]?.preparation;
      const prior=this.sql.exec('SELECT preparation FROM gen_preparation_ids WHERE generation=? AND preparation=?',generation,preparation).toArray().length;
      if(!prior || (selected!==undefined&&selected!==preparation))return false;
      if(selected===preparation)this.sql.exec('DELETE FROM gen_selected WHERE generation=? AND preparation=?',generation,preparation);
      return true;
    });
  }
  /** Bounded reclaim; quota is released only after every unselected, unpublished chunk is gone. */
  reclaim(job:string,generation:string,token:string,preparation:string,limit:number):{ok:boolean;remaining:number}|null {
    if(![job,generation,token,preparation].every(v=>typeof v==='string'&&ID.test(v)) || !Number.isSafeInteger(limit)||limit<1||limit>16)return null;
    return this.storage.transactionSync(()=>{
      if(!this.validClaim(job,generation,token))return null;
      const selected=this.sql.exec<{preparation:string}>('SELECT preparation FROM gen_selected WHERE generation=?',generation).toArray()[0]?.preparation;
      if(selected===preparation || this.sql.exec('SELECT key FROM gen_key_heads WHERE generation=? AND preparation=? LIMIT 1',generation,preparation).toArray().length)return {ok:false,remaining:0};
      const prior=this.sql.exec('SELECT preparation FROM gen_preparation_ids WHERE generation=? AND preparation=?',generation,preparation).toArray().length;
      if(!prior)return {ok:false,remaining:0};
      this.sql.exec('DELETE FROM gen_chunks WHERE rowid IN (SELECT rowid FROM gen_chunks WHERE generation=? AND preparation=? LIMIT ?)',generation,preparation,limit);
      const remaining=this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM gen_chunks WHERE generation=? AND preparation=?',generation,preparation).toArray()[0]?.n ?? 0;
      if(remaining===0)this.sql.exec('DELETE FROM gen_prepared WHERE generation=? AND preparation=? AND job=?',generation,preparation,job);
      return {ok:true,remaining};
    });
  }
  /** Must be passed to JobStateCore as its trusted AtomicCommit, never invoked outside its transaction. */
  atomicCommit(): AtomicCommit {
    return (sql, job, generation, digest, preparation) => {
      if (!this.verify || sql !== this.sql) throw new Error('semantic verifier or storage unavailable');
      const row = sql.exec<{ manifest: string; token: string }>('SELECT p.manifest, p.token FROM gen_prepared p JOIN gen_selected s ON s.generation=p.generation AND s.preparation=p.preparation WHERE p.generation=? AND p.job=?',generation,job).toArray()[0];
      if (!row) throw new Error('missing preparation');
      const m = JSON.parse(row.manifest) as Manifest;
      if (!this.valid(m) || m.digest !== digest || m.preparation !== preparation || !this.validClaim(job,generation,row.token)) throw new Error('invalid preparation or finalizer');
      const head = sql.exec<{ generation: string }>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation ?? null;
      if(head && sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='sgen_committed'").toArray().length && sql.exec('SELECT scope FROM sgen_committed WHERE scope=?',head).toArray().length) throw new Error('segmented head requires migrated store');
      if (head !== m.previous) throw new Error('stale head');
      for (const v of m.versions) {
        const current = sql.exec<{ version: number }>('SELECT version FROM gen_versions WHERE key=?',v.key).toArray()[0];
        if (!current || current.version !== v.version) throw new Error('stale or missing identity/version');
      }
      for (const c of m.changes) {
        const parts = sql.exec<{ idx: number; hash: string; bytes: number }>('SELECT idx,hash,bytes FROM gen_chunks WHERE generation=? AND preparation=? AND key=? ORDER BY idx',generation,m.preparation,c.key).toArray();
        const expected = c.chunks ?? [];
        if (parts.length !== expected.length || parts.some((p,i) => p.idx !== i || p.hash !== expected[i]?.hash || p.bytes !== expected[i]?.bytes)) throw new Error('incomplete or corrupt chunks');
      }
      if (this.verify(sql,m) !== true) throw new Error('semantic validation failed');
      for (const c of m.changes) sql.exec('INSERT OR REPLACE INTO gen_key_heads (key,generation,preparation,kind,expires_at,metadata,chunks) VALUES (?, ?, ?, ?, ?, ?, ?)',c.key,generation,m.preparation,c.kind,c.expiresAt ?? null,c.metadata ? JSON.stringify(c.metadata) : null,c.chunks?.length ?? 0);
      sql.exec('INSERT OR REPLACE INTO gen_head (singleton,generation) VALUES (1,?)',generation);
      return true;
    };
  }
  /** Point read from a pinned generation: if the head changes, callers must restart the read. */
  head(): string | null { return this.sql.exec<{ generation: string }>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation ?? null; }
  read(key: string, expectedHead: string | null, index: number): { kind: 'changed' | 'missing' | 'corrupt' } | { kind: 'value'; bytes: Uint8Array | null; metadata: unknown; expiresAt: number | null } {
    if (!Number.isSafeInteger(index) || index < 0 || index >= 160) return {kind:'missing'};
    return this.storage.transactionSync(() => {
      if (this.head() !== expectedHead) return {kind:'changed'};
      const row = this.sql.exec<{ generation:string; preparation:string; kind:string; expires_at:number|null; metadata:string|null; chunks:number }>('SELECT generation,preparation,kind,expires_at,metadata,chunks FROM gen_key_heads WHERE key=?',key).toArray()[0];
      if (!row || row.kind === 'delete' || (row.expires_at !== null && row.expires_at <= Date.now())) return {kind:'missing'};
      const part = this.sql.exec<{ data:string }>('SELECT data FROM gen_chunks WHERE generation=? AND preparation=? AND key=? AND idx=?',row.generation,row.preparation,key,index).toArray()[0];
      if (!part && index < row.chunks) return {kind:'corrupt'};
      return {kind:'value',bytes:part ? Uint8Array.from(atob(part.data),c=>c.charCodeAt(0)) : null,metadata:row.metadata ? JSON.parse(row.metadata) : null,expiresAt:row.expires_at};
    });
  }
}
