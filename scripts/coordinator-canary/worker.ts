// Private synthetic workload. The only input is a bodyless POST /run.
import { GenerationStore, type Manifest } from '../../src/generation-store';
import { JobStateCore } from '../../src/job-state-core';

const BOXES = 10;
const PER_BOX = 50;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const token = () => crypto.randomUUID();
const check = (ok: unknown, at: string) => { if (!ok) throw new Error(at); };
async function hash(bytes: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), n => n.toString(16).padStart(2, '0')).join('');
}

// Account for cursor reads after consumption as well as writes during exec(). These are
// application SQL counts and exclude platform operations, storage deletion and billing overhead.
function countedStorage(storage: DurableObjectStorage) {
  const stats = { statements: 0, rowsRead: 0, rowsWritten: 0 };
  const sql = {
    exec(query: string, ...args: SqlStorageValue[]) {
      stats.statements++;
      const cursor = storage.sql.exec(query, ...args);
      let read = 0, written = 0;
      function count() {
        stats.rowsRead += cursor.rowsRead - read;
        stats.rowsWritten += cursor.rowsWritten - written;
        read = cursor.rowsRead;
        written = cursor.rowsWritten;
      }
      count();
      return { toArray() { const rows = cursor.toArray(); count(); return rows; } };
    },
  };
  const measured = { sql, transactionSync: (fn: () => unknown) => storage.transactionSync(fn) };
  return { stats, measured: measured as unknown as DurableObjectStorage };
}

async function runScenario(storage: DurableObjectStorage) {
  const { stats, measured } = countedStorage(storage);
  const boxes = Array.from({ length: BOXES }, (_, i) => ({ alias: 'box' + i, identity: String(i).repeat(64) }));
  const job = token(), generation = token(), preparation = token(), final = token(), digest = 'invented-digest';
  const keys = new Set<string>();
  const store = new GenerationStore(measured, (_sql, manifest) =>
    manifest.digest === digest && manifest.changes.length === keys.size && keys.size === BOXES * PER_BOX + 1 &&
    manifest.changes.every(c => keys.has(c.key) && c.kind === 'put'));
  const core = new JobStateCore(measured, store.atomicCommit());
  check(core.create({ job, generation, driver: 'web', mailboxes: boxes }).ok, 'create');
  const chunks: { key: string; bytes: Uint8Array; hash: string; index: number }[] = [];
  const parts: Uint8Array[] = [];
  for (const box of boxes) {
    const attempt = token();
    const claim = core.claim(job, generation, attempt);
    check(claim.kind === 'claim' && claim.alias === box.alias, 'claim');
    check(core.claim(job, generation, token()).kind === 'wait', 'duplicate claim');
    const rows = [];
    for (let n = 0; n < PER_BOX; n++) {
      const key = 'cls:' + box.alias + ':synthetic-' + n;
      const row = { key, summary: 'Invented newsletter — résumé and план. '.repeat(11), done: false };
      const bytes = encoder.encode(JSON.stringify(row));
      rows.push(row);
      keys.add(key);
      chunks.push({ key, bytes, hash: await hash(bytes), index: 0 });
    }
    const partial = encoder.encode(JSON.stringify(rows));
    const h = await core.stage(job, generation, box.alias, attempt, partial);
    check(h && core.accept(job, generation, box.alias, attempt, h), 'partial');
    const accepted = core.readAcceptedChunk(job, generation, box.alias, 0);
    check(accepted && await hash(new Uint8Array(accepted)) === h, 'accepted partial read');
    parts.push(partial);
  }
  check(core.claimFinal(job, generation, final), 'finalizer');
  const digestKey = 'digest:' + digest;
  keys.add(digestKey);
  const changes: Manifest['changes'] = chunks.map(c => ({ key: c.key, kind: 'put', chunks: [{ hash: c.hash, bytes: c.bytes.length }] }));
  const digestChunks = [];
  for (const [index, bytes] of parts.entries()) {
    const h = await hash(bytes);
    digestChunks.push({ hash: h, bytes: bytes.length });
    chunks.push({ key: digestKey, bytes, index, hash: h });
  }
  changes.push({ key: digestKey, kind: 'put', chunks: digestChunks });
  const manifest: Manifest = { job, generation, preparation, expectedPreparation: null, token: final, digest, previous: null, versions: [], changes };
  check(store.prepare(manifest), 'prepare');
  let stagedBytes = 0;
  for (const c of chunks) {
    check(await store.stage(job, generation, final, preparation, c.key, c.index, c.bytes), 'stage');
    stagedBytes += c.bytes.length;
  }
  check(store.head() === null, 'premature visibility');
  check(core.finalize(job, generation, final, digest, preparation), 'commit');
  check(core.finalize(job, generation, final, digest, preparation), 'replayed commit');
  let verified = 0;
  for (const c of chunks) {
    const read = store.read(c.key, generation, c.index);
    check(read.kind === 'value' && read.bytes && await hash(new Uint8Array(read.bytes)) === c.hash, 'published bytes');
    if (c.key === digestKey && read.kind === 'value' && read.bytes) verified += JSON.parse(decoder.decode(read.bytes)).length;
  }
  check(verified === BOXES * PER_BOX, 'message count');
  return { ok: true, mailboxes: BOXES, messages: verified, changes: changes.length, stagedBytes,
    databaseBytesBeforeCleanup: storage.sql.databaseSize, ...stats };
}

export class Canary {
  constructor(private readonly state: DurableObjectState) {}
  async fetch(): Promise<Response> {
    try { return Response.json(await runScenario(this.state.storage)); }
    catch (e) { return Response.json({ ok: false, error: e instanceof Error ? e.message : 'unknown' }, { status: 500 }); }
    finally { await this.state.storage.deleteAll(); }
  }
}

export default {
  async fetch(req: Request, env: { CANARY: DurableObjectNamespace }) {
    if (req.method !== 'POST' || new URL(req.url).pathname !== '/run') return new Response(null, { status: 404 });
    if (req.body) {
      const reader = req.body.getReader();
      if (!(await reader.read()).done) {
        await reader.cancel();
        return new Response(null, { status: 404 });
      }
    }
    // An independent SQLite object per request. There are no production bindings.
    return env.CANARY.get(env.CANARY.newUniqueId()).fetch('https://fixture.invalid');
  },
};
