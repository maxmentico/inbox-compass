// SYNTHETIC, UNWIRED PROTOTYPE. This gate does not implement the trusted projector. A production
// owner-edit operation must update its actual state and increment the matching revision in the same
// SQLite transaction; these test-only mutation helpers do not provide that integration.
import type { Manifest, SemanticVerifier } from './generation-store';
import type { AtomicJobBinding } from './job-state-core';

const ALIAS = /^[A-Za-z0-9_-]{1,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const ID = /^[A-Za-z0-9_-]{22,128}$/;
type Version = { key: string; version: number };
/** Must independently verify the complete output against coordinator-owned accepted inputs and
 * snapshot, including values, redaction, TTL, failures, cursors and recheck/seen invariants. */
export type TrustedProjectionAuthority = (sql: SqlStorage, candidate: Readonly<Manifest>) => boolean;

function canonical(m: Manifest): string {
  const versions = m.versions.map(v => ({key:v.key, version:v.version})).sort((a,b)=>a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const changes = m.changes.map(c => c.kind === 'delete' ? {key:c.key,kind:'delete'} : {
    key:c.key,kind:'put',chunks:c.chunks!.map(p=>({hash:p.hash,bytes:p.bytes})),
    ...(c.expiresAt === undefined ? {} : {expiresAt:c.expiresAt}), ...(c.metadata ? {metadata:{arrived:c.metadata.arrived}} : {}),
  }).sort((a,b)=>a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return JSON.stringify({job:m.job,generation:m.generation,preparation:m.preparation,sourceId:m.sourceId ?? null,digest:m.digest,previous:m.previous,versions,changes});
}

export class DomainGenerationGate {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage, private readonly authority?: TrustedProjectionAuthority) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS domain_accounts (alias TEXT PRIMARY KEY, identity TEXT, epoch INTEGER NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS domain_plans (job TEXT NOT NULL, generation TEXT NOT NULL, preparation TEXT NOT NULL, canonical TEXT NOT NULL, PRIMARY KEY(job,generation,preparation))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS domain_job_bindings (job TEXT PRIMARY KEY, generation TEXT NOT NULL)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS domain_job_accounts (job TEXT NOT NULL, alias TEXT NOT NULL, identity TEXT NOT NULL, epoch INTEGER NOT NULL, PRIMARY KEY(job,alias))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS owner_done (item TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
    this.sql.exec('CREATE INDEX IF NOT EXISTS owner_done_expiry ON owner_done(expires_at)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS owner_done_scoped (namespace TEXT NOT NULL,message_id TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(namespace,message_id))');
    this.sql.exec('CREATE INDEX IF NOT EXISTS owner_done_scoped_expiry ON owner_done_scoped(expires_at)');
    this.sql.exec("INSERT OR IGNORE INTO gen_versions (key,version) VALUES ('settings',0),('done',0)");
  }
  /** Call exclusively inside JobStateCore.create's same SQLite transaction. */
  jobBinding(): AtomicJobBinding {
    return (sql,job,generation) => {
      if (sql !== this.sql) throw new Error('wrong storage');
      const rows = sql.exec<{alias:string;identity:string}>('SELECT alias,identity FROM core_steps WHERE job=?',job).toArray();
      for (const row of rows) {
        const account = sql.exec<{identity:string|null;epoch:number}>('SELECT identity,epoch FROM domain_accounts WHERE alias=?',row.alias).toArray()[0];
        if (!account || account.identity !== row.identity) throw new Error('missing or changed account identity');
        sql.exec('INSERT INTO domain_job_accounts (job,alias,identity,epoch) VALUES (?,?,?,?)',job,row.alias,row.identity,account.epoch);
      }
      sql.exec('INSERT INTO domain_job_bindings (job,generation) VALUES (?,?)',job,generation);
      return true;
    };
  }
  /** Synthetic helper: same-email relinks must still create a new epoch. */
  changeAccount(alias: string, identity: string | null): number | null {
    if (!ALIAS.test(alias) || (identity !== null && !HASH.test(identity))) return null;
    return this.storage.transactionSync(() => {
      const row = this.sql.exec<{epoch:number}>('SELECT epoch FROM domain_accounts WHERE alias=?',alias).toArray()[0];
      const epoch = (row?.epoch ?? 0) + 1;
      if (!Number.isSafeInteger(epoch)) throw new Error('epoch exhausted');
      this.sql.exec('INSERT OR REPLACE INTO domain_accounts (alias,identity,epoch) VALUES (?,?,?)',alias,identity,epoch);
      this.sql.exec('INSERT OR REPLACE INTO gen_versions (key,version) VALUES (?,?)',`account:${alias}`,epoch);
      return epoch;
    });
  }
  /** Synthetic helper only: the real settings/done edit must be atomic with its increment. */
  bump(kind: 'settings' | 'done'): number {
    if (kind !== 'settings' && kind !== 'done') throw new Error('invalid revision');
    return this.storage.transactionSync(() => {
      const row = this.sql.exec<{version:number}>('SELECT version FROM gen_versions WHERE key=?',kind).toArray()[0];
      if (!row || !Number.isSafeInteger(row.version + 1)) throw new Error('missing or exhausted revision');
      this.sql.exec('UPDATE gen_versions SET version=? WHERE key=?',row.version+1,kind);
      return row.version+1;
    });
  }
  /** Returns a trusted current revision vector only for the job's original account identities. */
  private versions(job: string, generation: string): Version[] | null {
    // Expiry changes logical done state without an edit call. Refuse to snapshot or commit
    // until bounded OwnerState cleanup removes expired rows and advances the done revision.
    if(this.sql.exec('SELECT item FROM owner_done WHERE expires_at<=? LIMIT 1',Date.now()).toArray().length || this.sql.exec('SELECT namespace FROM owner_done_scoped WHERE expires_at<=? LIMIT 1',Date.now()).toArray().length)return null;
    const jobRow = this.sql.exec<{generation:string;state:string;expires:number}>("SELECT generation,state,expires FROM core_jobs WHERE job=?",job).toArray()[0];
    if (!jobRow || jobRow.generation !== generation || jobRow.state !== 'running' || jobRow.expires <= Date.now()) return null;
    const binding = this.sql.exec<{generation:string}>('SELECT generation FROM domain_job_bindings WHERE job=?',job).toArray()[0];
    if (!binding || binding.generation !== generation) return null;
    const rows = this.sql.exec<{alias:string;identity:string;state:string}>('SELECT alias,identity,state FROM core_steps WHERE job=? ORDER BY alias',job).toArray();
    const boundCount = this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM domain_job_accounts WHERE job=?',job).toArray()[0]?.n;
    if(boundCount!==rows.length)return null;
    if (rows.some(r=>r.state !== 'done' && r.state !== 'failed')) return null;
    const out: Version[] = [];
    for (const row of rows) {
      const acct = this.sql.exec<{identity:string|null;epoch:number}>('SELECT identity,epoch FROM domain_accounts WHERE alias=?',row.alias).toArray()[0];
      const bound = this.sql.exec<{identity:string;epoch:number}>('SELECT identity,epoch FROM domain_job_accounts WHERE job=? AND alias=?',job,row.alias).toArray()[0];
      if (!acct || !bound || acct.identity !== row.identity || bound.identity !== row.identity || acct.epoch !== bound.epoch) return null;
      out.push({key:`account:${row.alias}`,version:acct.epoch});
    }
    for (const key of ['settings','done']) {
      const value = this.sql.exec<{version:number}>('SELECT version FROM gen_versions WHERE key=?',key).toArray()[0];
      if (!value) return null;
      out.push({key,version:value.version});
    }
    return out.sort((a,b)=>a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  }
  private expected(m: Manifest): boolean {
    const expected = this.versions(m.job,m.generation);
    if (!expected || m.versions.length !== expected.length) return false;
    const got = [...m.versions].sort((a,b)=>a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
    if (JSON.stringify(got) !== JSON.stringify(expected)) return false;
    const must = [`digest:${m.digest}`,'runs-index','last-run',`job-result:${m.job}`,`job-done:${m.job}`];
    return must.every(key=>m.changes.some(c=>c.key===key && c.kind==='put'));
  }
  /** Capture a trusted revision vector; changes while preparing force a new plan. */
  capture(job: string, generation: string): Version[] | null {
    if (!ID.test(job) || !ID.test(generation)) return null;
    return this.storage.transactionSync(()=>this.versions(job,generation));
  }
  /** Internal: caller must already hold this object's synchronous SQLite transaction. */
  captureInTransaction(sql: SqlStorage, job: string, generation: string): Version[] | null {
    return sql === this.sql ? this.versions(job,generation) : null;
  }
  /** Seal only a plan independently certified by the injected synchronous authority. */
  seal(job: string, generation: string, preparation: string): boolean {
    if (!this.authority || !ID.test(job) || !ID.test(generation) || !ID.test(preparation)) return false;
    // Only manifests already normalized and bounded by GenerationStore.prepare are accepted.
    return this.storage.transactionSync(() => {
      const stored = this.sql.exec<{manifest:string}>("SELECT p.manifest FROM gen_prepared p JOIN gen_selected s ON s.generation=p.generation AND s.preparation=p.preparation WHERE p.job=? AND p.generation=? AND p.preparation=?",job,generation,preparation).toArray()[0];
      if (!stored) return false;
      const candidate = JSON.parse(stored.manifest) as Manifest;
      if (!this.expected(candidate) || this.authority!(this.sql,candidate) !== true) return false;
      const value = canonical(candidate);
      const previous = this.sql.exec<{canonical:string}>('SELECT canonical FROM domain_plans WHERE job=? AND generation=? AND preparation=?',job,generation,preparation).toArray()[0];
      if (previous) return previous.canonical === value;
      this.sql.exec('INSERT INTO domain_plans (job,generation,preparation,canonical) VALUES (?,?,?,?)',job,generation,preparation,value);
      return true;
    });
  }
  /** Passed as GenerationStore's semantic verifier. No independent plan means no commit. */
  verifier(): SemanticVerifier {
    return (sql,m) => {
      if (sql !== this.sql || !this.expected(m)) return false;
      const plan = sql.exec<{canonical:string}>('SELECT canonical FROM domain_plans WHERE job=? AND generation=? AND preparation=?',m.job,m.generation,m.preparation).toArray()[0];
      return !!plan && plan.canonical === canonical(m);
    };
  }
}
