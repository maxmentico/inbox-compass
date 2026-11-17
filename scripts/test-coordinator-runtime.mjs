// Isolated local-runtime integration test. Requires permission to bind loopback; never connects
// to production and uses only synthetic data. Run: node scripts/test-coordinator-runtime.mjs
import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dir = await mkdtemp(join(tmpdir(), 'inbox-lease-test-'));
const port = 20000 + (process.pid % 20000);
const base = `http://127.0.0.1:${port}`;
const id = () => randomBytes(16).toString('base64url');
const coordinator = resolve('src/run-coordinator.ts');
// The wrapper exists only in this temporary synthetic test worker. Its trigger injects a SQLite
// error between the manifest insert and head swap, exercising actual transaction rollback.
await writeFile(join(dir, 'entry.ts'), `import { RunCoordinator as Base } from ${JSON.stringify(coordinator)};\nexport class RunCoordinator extends Base { constructor(state) { super(state); this.storage = state.storage; } async fetch(req) { const op = new URL(req.url).pathname; if (op.startsWith('/snap-')) { const d = await req.json(); const store = this.syntheticSnapshots; let r; if (op === '/snap-create') r = await store.create(d.owner, d.manifest); else if (op === '/snap-put') r = await store.put(d.owner, d.id, d.index, Uint8Array.from(atob(d.data), c => c.charCodeAt(0))); else if (op === '/snap-seal') r = store.seal(d.owner, d.id); else if (op === '/snap-read') { const bytes = await store.source(d.owner).read(d.id, d.index); r = bytes ? btoa(String.fromCharCode(...bytes)) : null; } else if (op === '/snap-cp-create') r = await store.checkpoints(d.owner).create(d.id); else if (op === '/snap-cp-read') r = await store.checkpoints(d.owner).read(d.id); else if (op === '/snap-cp-cas') r = await store.checkpoints(d.owner).compareAndAdvance(d.id, d.expected, d.next, d.complete); else return new Response(null, { status: 404 }); return Response.json({ result: r }); } if (op === '/test-fail') { this.storage.sql.exec("CREATE TRIGGER inject_failure BEFORE INSERT ON publication_chunks BEGIN SELECT RAISE(ABORT, 'injected'); END"); return new Response('ok'); } if (op === '/test-unfail') { this.storage.sql.exec('DROP TRIGGER inject_failure'); return new Response('ok'); } if (op === '/test-expire') { this.storage.sql.exec('UPDATE publications SET expires_at = 0 WHERE id = (SELECT id FROM publication_head)'); return new Response('ok'); } if (op === '/test-clean') { await super.alarm(); return new Response('ok'); } if (op === '/test-info') { const steps = this.storage.sql.exec('SELECT COUNT(*) AS n FROM steps').toArray()[0].n; const chunks = this.storage.sql.exec('SELECT COUNT(*) AS n FROM publication_chunks WHERE id = (SELECT id FROM publication_head)').toArray()[0].n; const snapshots = this.storage.sql.exec('SELECT COUNT(*) AS n FROM synthetic_snapshots').toArray()[0].n; const fragments = this.storage.sql.exec('SELECT COUNT(*) AS n FROM synthetic_fragments').toArray()[0].n; const checkpoints = this.storage.sql.exec('SELECT COUNT(*) AS n FROM synthetic_checkpoints').toArray()[0].n; return Response.json({ steps, chunks, snapshots, fragments, checkpoints, alarm: await this.storage.getAlarm() }); } return super.fetch(req); } }\nexport default { fetch(req, env) { return env.RUN_COORDINATOR.get(env.RUN_COORDINATOR.idFromName('run')).fetch(req); } };\n`);
await writeFile(join(dir, 'wrangler.json'), JSON.stringify({ name: 'lease-test', main: 'entry.ts', compatibility_date: '2026-10-01', durable_objects: { bindings: [{ name: 'RUN_COORDINATOR', class_name: 'RunCoordinator' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['RunCoordinator'] }] }));
let child;
async function call(path, body) {
  const response = await fetch(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(response.status, 200);
  return response.json();
}
async function start() {
  child = spawn(resolve('node_modules/.bin/wrangler'), ['dev', '--local', '--config', join(dir, 'wrangler.json'), '--persist-to', join(dir, 'state'), '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0'], { env: { ...process.env, XDG_CONFIG_HOME: dir, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  for (let i = 0; i < 150; i++) {
    if (child.exitCode !== null) throw new Error(`local runtime exited: ${output}`);
    try { await call('inspect', {}); return; } catch { await delay(100); }
  }
  throw new Error(`local runtime did not start: ${output}`);
}
async function stop() {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit));
  child.kill('SIGINT');
  await exited;
  child = undefined;
}
try {
  await start();
  const holder = { at: '2026-10-24T06:30:00Z', driver: 'web' };
  const owners = Array.from({ length: 60 }, id);
  const acquired = await Promise.all(owners.map((owner) => call('acquire', { owner, holder })));
  assert.equal(acquired.filter((r) => r.ok).length, 1);
  const lease = acquired.find((r) => r.ok).lease;
  const owner = lease.owner;
  const pieces = [Buffer.from('first synthetic fragment'), Buffer.from('second synthetic fragment')];
  const hex = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const descriptors = pieces.map((bytes) => ({ sha256: hex(bytes), bytes: bytes.length }));
  const totalBytes = pieces.reduce((sum, bytes) => sum + bytes.length, 0);
  const snapshotId = hex(JSON.stringify([1, totalBytes, descriptors.map((f) => [f.sha256, f.bytes])]));
  const snapshot = { version: 1, id: snapshotId, totalBytes, fragments: descriptors };
  const checkpointId = `${owner}:${snapshotId}`;
  assert.equal((await call('snap-create', { owner, manifest: snapshot })).result, true);
  assert.equal((await call('snap-seal', { owner, id: snapshotId })).result, false);
  for (let index = 0; index < pieces.length; index++) assert.equal((await call('snap-put', { owner, id: snapshotId, index, data: pieces[index].toString('base64') })).result, true);
  assert.equal((await call('snap-seal', { owner, id: snapshotId })).result, true);
  assert.equal((await call('snap-put', { owner, id: snapshotId, index: 0, data: pieces[0].toString('base64') })).result, false);
  assert.equal((await call('snap-cp-create', { owner, id: `${id()}:${snapshotId}` })).result, false);
  assert.equal((await call('snap-cp-create', { owner, id: checkpointId })).result, true);
  const checkpointRace = await Promise.all([1, 2].map(() => call('snap-cp-cas', { owner, id: checkpointId, expected: 0, next: 1, complete: false })));
  assert.equal(checkpointRace.filter((r) => r.result).length, 1);
  assert.equal((await call('acquire', { owner, holder })).lease.expiresAt, lease.expiresAt);
  const a = id(), b = id();
  const claims = await Promise.all([a, b].map((attempt) => call('claim', { owner, step: 'mailbox', attempt, expectedGeneration: 0 })));
  assert.equal(claims.filter((r) => r.ok).length, 1);
  const old = claims[0].ok ? a : b, next = claims[0].ok ? b : a;
  assert.equal((await call('claim', { owner, step: 'mailbox', attempt: next, expectedGeneration: 1 })).generation, 2);
  assert.equal((await call('claim', { owner, step: 'mailbox', attempt: old, expectedGeneration: 0 })).ok, false);
  assert.equal((await call('stage', { owner, step: 'mailbox', attempt: old, generation: 1, result: 'old' })).ok, false);
  const oversized = await fetch(`${base}/stage`, { method: 'POST', body: JSON.stringify({ owner, step: 'mailbox', attempt: next, generation: 2, result: 'x'.repeat(1024 * 1024 + 1) }) });
  assert.equal(oversized.status, 400);
  const huge = await fetch(`${base}/stage`, { method: 'POST', body: JSON.stringify({ owner, step: 'mailbox', attempt: next, generation: 2, result: 'x'.repeat(1024 * 1024 + 32 * 1024) }) });
  assert.equal(huge.status, 413);
  assert.equal((await call('stage', { owner, step: 'mailbox', attempt: next, generation: 2, result: 'synthetic' })).ok, true);
  assert.equal((await call('stage', { owner, step: 'mailbox', attempt: next, generation: 2, result: 'changed' })).ok, false);
  const publication = id(), manifest = [{ step: 'mailbox', generation: 2 }];
  assert.equal((await call('publish', { owner: id(), id: id(), manifest })).ok, false);
  assert.equal((await call('publish', { owner, id: publication, manifest })).ok, true);
  assert.equal((await call('publish', { owner, id: publication, manifest })).ok, true);
  assert.equal((await call('published', {})).id, publication);
  assert.equal((await call('published', { id: publication, step: 'mailbox' })).result, 'synthetic');
  const retryPublication = id();
  assert.equal((await fetch(`${base}/test-fail`, { method: 'POST' })).status, 200);
  const interrupted = await fetch(`${base}/publish`, { method: 'POST', body: JSON.stringify({ owner, id: retryPublication, manifest }) });
  assert.equal(interrupted.status, 500);
  assert.equal((await call('published', {})).id, publication);
  assert.equal((await fetch(`${base}/test-unfail`, { method: 'POST' })).status, 200);
  assert.equal((await call('publish', { owner, id: retryPublication, manifest })).ok, true);
  assert.equal((await call('published', {})).id, retryPublication);
  const attempts = Array.from({ length: 199 }, id);
  for (let start = 0; start < 199; start += 10) {
    const more = await Promise.all(Array.from({ length: Math.min(10, 199 - start) }, (_, i) => call('claim', { owner, step: `step${start + i}`, attempt: attempts[start + i], expectedGeneration: 0 })));
    assert(more.every((r) => r.ok));
  }
  assert.equal((await call('claim', { owner, step: 'overflow', attempt: id(), expectedGeneration: 0 })).reason, 'capacity');
  assert.equal((await call('publish', { owner, id: id(), manifest })).reason, 'incomplete');
  assert.equal((await call('published', {})).id, retryPublication);
  // About 9.7 MB across 200 chunks: representative of the prototype's 10 MiB cap.
  const payload = 'x'.repeat(50 * 1024);
  for (let start = 0; start < 199; start += 10) {
    const staged = await Promise.all(Array.from({ length: Math.min(10, 199 - start) }, (_, i) => call('stage', { owner, step: `step${start + i}`, attempt: attempts[start + i], generation: 1, result: payload })));
    assert(staged.every((r) => r.ok));
  }
  const fullPublication = id();
  const fullManifest = [...manifest, ...attempts.map((_, i) => ({ step: `step${i}`, generation: 1 }))];
  const startPublish = performance.now();
  assert.equal((await call('publish', { owner, id: fullPublication, manifest: fullManifest })).ok, true);
  console.log(`Local publication, 200 chunks / ${199 * payload.length + 'synthetic'.length} bytes: ${(performance.now() - startPublish).toFixed(1)} ms wall time (not a deployed CPU measurement).`);
  await stop();
  await start();
  assert.deepEqual((await call('inspect', {})).lease, lease);
  assert.deepEqual((await call('snap-cp-read', { owner, id: checkpointId })).result, { next: 1, complete: false });
  assert.equal(Buffer.from((await call('snap-read', { owner, id: snapshotId, index: 0 })).result, 'base64').toString(), pieces[0].toString());
  assert.equal((await call('snap-cp-cas', { owner, id: checkpointId, expected: 0, next: 1, complete: false })).result, false);
  assert.equal((await call('snap-cp-cas', { owner, id: checkpointId, expected: 1, next: 2, complete: true })).result, true);
  assert.equal((await call('read', { owner, step: 'mailbox' })).result, 'synthetic');
  assert.equal((await call('published', { id: retryPublication, step: 'mailbox' })).result, 'synthetic');
  assert.equal((await call('published', {})).id, fullPublication);
  const info = () => fetch(`${base}/test-info`, { method: 'POST' }).then((r) => r.json());
  assert.notEqual((await info()).alarm, null);
  assert.equal((await call('release', { owner })).ok, true);
  assert.equal((await call('snap-read', { owner, id: snapshotId, index: 0 })).result, null);
  assert.equal((await call('snap-cp-read', { owner, id: checkpointId })).result, null);
  assert.equal((await call('release', { owner })).ok, true);
  assert.equal((await call('acquire', { owner, holder })).ok, false);
  assert.equal((await fetch(`${base}/test-expire`, { method: 'POST' })).status, 200);
  assert.equal((await call('published', {})).ok, false);
  assert.equal((await call('published', { id: fullPublication })).ok, false);
  assert.equal((await call('publish', { owner, id: fullPublication, manifest: fullManifest })).ok, false);
  let last = await info();
  assert.deepEqual([last.steps, last.chunks, last.snapshots, last.fragments, last.checkpoints], [200, 200, 1, 2, 1]);
  for (let i = 0; i < 20; i++) {
    assert.equal((await fetch(`${base}/test-clean`, { method: 'POST' })).status, 200);
    const current = await info();
    assert(last.steps - current.steps <= 10 && last.chunks - current.chunks <= 10);
    last = current;
  }
  assert.deepEqual([last.steps, last.chunks, last.snapshots, last.fragments, last.checkpoints], [0, 0, 0, 0, 0]);
  assert.equal((await call('published', { id: retryPublication, step: 'mailbox' })).result, 'synthetic');
  console.log('Local runtime: concurrent leases and step fencing, retries and restart persistence passed.');
} finally {
  await stop();
  await rm(dir, { recursive: true, force: true });
}
