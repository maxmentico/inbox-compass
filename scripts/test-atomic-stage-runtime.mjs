// Synthetic local Workers runtime test. Run: node scripts/test-atomic-stage-runtime.mjs
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dir = await mkdtemp(join(tmpdir(), 'inbox-stage-runtime-'));
const port = 20000 + (process.pid % 20000);
const base = `http://127.0.0.1:${port}`;
const adapter = resolve('src/synthetic-atomic-stage-sqlite.ts');
const stage = resolve('src/atomic-stage-page.ts');
await writeFile(join(dir, 'entry.ts'), `import { SyntheticAtomicStageSqlite } from ${JSON.stringify(adapter)};
import { stageVerifiedOutputPage } from ${JSON.stringify(stage)};
export class StageTest {
 constructor(state) { this.state = state; this.store = new SyntheticAtomicStageSqlite(state.storage); }
 async fetch(req) {
  const op = new URL(req.url).pathname;
  try {
   const data = await req.json();
   if (op === '/init') return Response.json({ok:this.store.initialize(data)});
   if (op === '/stage') { data.bytes = Uint8Array.from(atob(data.bytes), c => c.charCodeAt(0)); return Response.json({result:await stageVerifiedOutputPage(this.store,data)}); }
   if (op === '/read') return Response.json(this.store.transactionSync(tx => ({cursor:tx.readCursor(data.scope), page:tx.readPage(data.scope,data.page) !== null})));
   if (op === '/fail') { this.state.storage.sql.exec("CREATE TRIGGER inject_cursor_fail BEFORE UPDATE ON synthetic_stage_cursor BEGIN SELECT RAISE(ABORT, 'injected'); END"); return Response.json({ok:true}); }
   if (op === '/unfail') { this.state.storage.sql.exec('DROP TRIGGER inject_cursor_fail'); return Response.json({ok:true}); }
   return new Response(null,{status:404});
  } catch { return Response.json({ok:false},{status:409}); }
 }
}
export default {fetch(req,env) { return env.STAGE_TEST.get(env.STAGE_TEST.idFromName('synthetic')).fetch(req); }};
`);
await writeFile(join(dir, 'wrangler.json'), JSON.stringify({ name: 'atomic-stage-test', main: 'entry.ts', compatibility_date: '2026-10-01', durable_objects: { bindings: [{ name: 'STAGE_TEST', class_name: 'StageTest' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['StageTest'] }] }));
let child;
async function call(path, body = {}) {
 const response = await fetch(`${base}/${path}`, { method: 'POST', body: JSON.stringify(body) });
 return { status: response.status, body: await response.json() };
}
async function start() {
 child = spawn(resolve('node_modules/.bin/wrangler'), ['dev', '--local', '--config', join(dir, 'wrangler.json'), '--persist-to', join(dir, 'state'), '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0'], { env: { ...process.env, XDG_CONFIG_HOME: dir, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
 let output = '';
 child.stdout.on('data', (chunk) => { output += chunk; });
 child.stderr.on('data', (chunk) => { output += chunk; });
 for (let i = 0; i < 150; i++) {
  if (child.exitCode !== null) throw new Error(`local runtime exited: ${output}`);
  try { await call('read', {scope:'none',page:0}); return; } catch { await delay(100); }
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
 const scope = randomBytes(16).toString('base64url');
 const attempt = randomBytes(16).toString('base64url');
 const sourceId = 'a'.repeat(64);
 const cursor = {scope, sourceId, generation:1, attempt, expiresAt:Date.now()+300000, nextPage:0, nextSequence:0, totalRecords:2, complete:false};
 const page = (n, payload, final = false) => ({scope, sourceId, generation:1, attempt, page:n, startSequence:n, endSequence:n+1, final, bytes:Buffer.from(payload).toString('base64')});
 assert.equal((await call('init',cursor)).body.ok,true);
 assert.equal((await call('init',cursor)).body.ok,false);
 assert.equal((await call('fail')).body.ok,true);
 assert.equal((await call('stage',page(0,'synthetic-a'))).status,409);
 const rolledBack = await call('read',{scope,page:0});
 assert.equal(rolledBack.body.page,false);
 assert.equal(rolledBack.body.cursor.nextPage,0);
 assert.equal((await call('unfail')).body.ok,true);
 assert.equal((await call('stage',page(0,'synthetic-a'))).body.result,'staged');
 assert.equal((await call('stage',page(0,'synthetic-a'))).body.result,'already-staged');
 assert.equal((await call('stage',page(0,'changed'))).status,409);
 assert.equal((await call('stage',{...page(1,'stale',true),attempt:randomBytes(16).toString('base64url')})).status,409);
 const oversized = page(1,'x'.repeat(64*1024+1),true);
 assert.equal((await call('stage',oversized)).status,409);
 await stop();
 await start();
 const restored = await call('read',{scope,page:0});
 assert.equal(restored.body.page,true);
 assert.equal(restored.body.cursor.nextPage,1);
 assert.equal((await call('stage',page(0,'synthetic-a'))).body.result,'already-staged');
 const race = await Promise.all([call('stage',page(1,'synthetic-b',true)),call('stage',page(1,'different',true))]);
 assert.equal(race.filter((r)=>r.status===200).length,1);
 assert.equal(race.filter((r)=>r.status===409).length,1);
 assert.equal((await call('read',{scope,page:1})).body.cursor.complete,true);
 console.log('Synthetic local SQLite runtime: atomic rollback, bounded staging, fencing, replay, concurrency and restart passed. No deployed CPU measurement.');
} finally { await stop(); await rm(dir,{recursive:true,force:true}); }
