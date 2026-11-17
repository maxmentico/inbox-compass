// Isolated synthetic SQLite runtime test; no production bindings or mailbox data.
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dir = await mkdtemp(join(tmpdir(), 'owner-state-test-'));
const port = 20000 + process.pid % 20000;
const base = `http://127.0.0.1:${port}`;
await writeFile(join(dir, 'entry.ts'), `import {OwnerState} from ${JSON.stringify(resolve('src/owner-state.ts'))}; import {CoordinatedAccounts} from ${JSON.stringify(resolve('src/coordinated-accounts.ts'))};
export class Test { constructor(state) { this.sql=state.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS gen_head (singleton INTEGER PRIMARY KEY,generation TEXT NOT NULL)'); this.sql.exec("INSERT OR IGNORE INTO gen_head (singleton,generation) VALUES (1,'head1')"); this.accounts=new CoordinatedAccounts(state.storage); this.sql.exec("INSERT OR IGNORE INTO domain_accounts (alias,identity,epoch) VALUES ('inbox','synthetic',1)"); this.sql.exec("INSERT OR IGNORE INTO coordinated_incarnations (alias,version) VALUES ('inbox',1)"); this.owner=new OwnerState(state.storage,(_sql,head,key)=>head==='head1' && ['inbox:message1','inbox:message2'].includes(key) ? 1 : null); }
async fetch(req) { const d=await req.json(), op=new URL(req.url).pathname.slice(1); const real=Date.now; if (d.now) Date.now=()=>d.now; try {
let result; if(op==='settings')result=await this.owner.setSettings(d.value,d.expected); else if(op==='getSettings')result=this.owner.getSettings(); else if(op==='getSettingsHash')result=this.owner.getSettingsHash(); else if(op==='settingsChunks')result=this.sql.exec('SELECT idx,bytes,hash,data FROM owner_settings_chunks ORDER BY idx').toArray().map(r=>({...r,data:Array.from(new Uint8Array(r.data))})); else if(op==='done')result=this.owner.setDone(d.keys,d.done,d.expected,d.authorization); else if(op==='getDone')result=this.owner.getDone(d.keys); else if(op==='cleanup')result=this.owner.cleanupDone(d.limit); else if(op==='inboxEpoch'){this.sql.exec("UPDATE coordinated_incarnations SET version=? WHERE alias='inbox'",d.epoch);result=true;} else if(op==='incarnation')result=this.sql.exec('SELECT version FROM coordinated_incarnations WHERE alias=?',d.alias).toArray()[0]?.version??null; else if(op==='link')result=await this.accounts.link(d.account,d.identity,d.expected,d.barrier); else if(op==='rotate')result=await this.accounts.rotate(d.account,d.identity,d.expected,d.barrier); else if(op==='flowBarrier')result=this.accounts.flowBarrier(); else if(op==='getAccount')result=this.accounts.get(d.alias); else if(op==='unlink')result=this.accounts.unlink(d.alias,d.expected); else if(op==='purge')result=this.accounts.finishPurge(d.alias,d.expected,()=>d.proof); else if(op==='claimRevocation')result=this.accounts.claimRevocation(d.alias,d.epoch,d.claimToken); else if(op==='revocationStatus')result=this.accounts.revocationStatus(d.alias,d.epoch); else if(op==='cleanupRevocations')result=this.accounts.cleanupRevocations(d.limit); else if(op==='finishRevocation')result=this.accounts.finishRevocation(d.alias,d.epoch,d.confirmed,d.claimToken); else if(op==='failSettings') {this.sql.exec("CREATE TRIGGER reject_chunk BEFORE INSERT ON owner_settings_chunks BEGIN SELECT RAISE(ABORT,'injected'); END");result=true;} else if(op==='clearSettings') {this.sql.exec('DROP TRIGGER reject_chunk');result=true;} else if(op==='fail') {this.sql.exec("CREATE TRIGGER reject_rev BEFORE UPDATE ON gen_versions WHEN NEW.key='done' BEGIN SELECT RAISE(ABORT,'injected'); END");result=true;} else if(op==='clear') {this.sql.exec('DROP TRIGGER reject_rev');result=true;} else return new Response(null,{status:404}); return Response.json({result});
} catch(e) {return Response.json({error:String(e.message)},{status:400});} finally {Date.now=real;} } }
export default {fetch(req,env){return env.TEST.get(env.TEST.idFromName('one')).fetch(req);}};`);
await writeFile(join(dir, 'wrangler.json'), JSON.stringify({ name: 'synthetic-owner-state', main: 'entry.ts', compatibility_date: '2026-10-01', durable_objects: { bindings: [{ name: 'TEST', class_name: 'Test' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Test'] }] }));
let child;
async function call(op, value = {}) { const response = await fetch(`${base}/${op}`, { method: 'POST', body: JSON.stringify(value) }); return { status: response.status, body: await response.json() }; }
async function start() {
	child = spawn(resolve('node_modules/.bin/wrangler'), ['dev', '--local', '--config', join(dir, 'wrangler.json'), '--persist-to', join(dir, 'state'), '--port', String(port), '--ip', '127.0.0.1', '--inspector-port', '0'], { env: { ...process.env, XDG_CONFIG_HOME: dir, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
	let output = ''; child.stdout.on('data', (v) => output += v); child.stderr.on('data', (v) => output += v);
	for (let i = 0; i < 150; i++) { if (child.exitCode !== null) throw new Error(output); try { if ((await call('getSettings')).status === 200) return; } catch {} await delay(100); }
	throw new Error(output);
}
async function stop() { if (!child || child.exitCode !== null) return; const stopped = new Promise((r) => child.once('exit', r)); child.kill('SIGINT'); await stopped; child = undefined; }
try {
	await start();
	const settings = { deadlineDays: 3, important: ['@example.com'], muted: [] };
	assert.deepEqual((await call('settings', { value: settings, expected: 0 })).body.result, { revision: 1, changed: true });
	assert.deepEqual((await call('settings', { value: settings, expected: 0 })).body.result, { revision: 1, changed: false });
	assert.match((await call('getSettingsHash')).body.result.hash, /^[a-f0-9]{64}$/);
	assert.equal((await call('settings', { value: { ...settings, important: ['bad'] }, expected: 1 })).status, 400);
	const now = Date.now(), keys = ['inbox:message1', 'inbox:message2'], authorization = { head: 'head1', accounts: { inbox: 1 } };
	assert.equal((await call('done', { keys, done: true, now, expected: 0, authorization: { ...authorization, head: 'old' } })).status, 400);
	assert.equal((await call('done', { keys, done: true, now, expected: 0, authorization: { ...authorization, accounts: { inbox: 2 } } })).status, 400);
	await call('inboxEpoch', { epoch: 2 });
	assert.equal((await call('done', { keys, done: true, now, expected: 0, authorization: { ...authorization, accounts: { inbox: 2 } } })).status, 400);
	await call('inboxEpoch', { epoch: 1 });
	assert.equal((await call('done', { keys: ['inbox:other'], done: true, now, expected: 0, authorization })).status, 400);
	assert.deepEqual((await call('done', { keys, done: true, now, expected: 0, authorization })).body.result, { revision: 1, changed: keys });
	assert.equal((await call('done', { keys, done: true, now, expected: 0, authorization })).status, 400);
	assert.deepEqual((await call('done', { keys, done: true, now, expected: 1, authorization })).body.result, { revision: 1, changed: [] });
	assert.equal((await call('fail')).status, 200);
	assert.equal((await call('done', { keys: [keys[0]], done: false, now, expected: 1, authorization })).status, 400);
	assert.deepEqual((await call('getDone', { keys, now })).body.result, { revision: 1, done: keys });
	await call('clear'); await stop(); await start();
	assert.deepEqual((await call('getSettings')).body.result, { settings, revision: 1 });
	const largeSettings = { deadlineDays: 4, important: Array.from({length: 500}, (_, i) => `${'a'.repeat(220)}${i}@example.com`), muted: [] };
	assert.equal((await call('settings', { value: largeSettings, expected: 1 })).body.result.revision, 2);
	assert.equal((await call('settings', { value: settings, expected: 0 })).status, 400);
	const parts = (await call('settingsChunks')).body.result;
	assert(parts.length > 1);
	const bytes = Buffer.concat(parts.map((part, index) => {
		const data = Buffer.from(part.data);
		assert.equal(part.idx, index); assert.equal(part.bytes, data.length); assert(data.length <= 64 * 1024);
		assert.equal(part.hash, createHash('sha256').update(data).digest('hex')); return data;
	}));
	assert.deepEqual(JSON.parse(bytes.toString('utf8')), largeSettings);
	assert.equal((await call('getSettingsHash')).body.result.hash, createHash('sha256').update(bytes).digest('hex'));
	await call('failSettings');
	assert.equal((await call('settings', { value: settings, expected: 2 })).status, 400);
	assert.deepEqual((await call('getSettings')).body.result, { settings: largeSettings, revision: 2 });
	assert.equal((await call('getSettingsHash')).body.result.hash, createHash('sha256').update(bytes).digest('hex'));
	await call('clearSettings');
	const settingRace = await Promise.all([
		call('settings', { value: { ...settings, deadlineDays: 5 }, expected: 2 }),
		call('settings', { value: { ...settings, deadlineDays: 6 }, expected: 2 }),
	]);
	assert.deepEqual(settingRace.map((entry) => entry.status).sort(), [200, 400]);
	assert.equal((await call('getSettings')).body.result.revision, 3);
	const expiry = now + 61 * 24 * 60 * 60 * 1000;
	assert.equal((await call('getDone', { keys, now: expiry })).status, 400);
	assert.deepEqual((await call('cleanup', { limit: 1, now: expiry })).body.result, { removed: 1, remaining: true, revision: 2 });
	assert.equal((await call('getDone', { keys, now: expiry })).status, 400);
	assert.deepEqual((await call('cleanup', { limit: 1, now: expiry })).body.result, { removed: 1, remaining: false, revision: 3 });
	assert.deepEqual((await call('getDone', { keys, now: expiry })).body.result, { revision: 3, done: [] });
	const account = { alias: 'mail', email: 'mail@example.invalid', scopes: ['synthetic'], sealedRefreshToken: `v1.${'a'.repeat(16)}.${'b'.repeat(24)}`, linkedAt: '2026-01-01T00:00:00Z' }, identity = createHash('sha256').update(account.email).digest('hex');
	assert.equal((await call('link', { account, identity, expected: 0, barrier: 0 })).body.result, 1);
	assert.equal((await call('link', { account, identity, expected: 0, barrier: 0 })).body.result, 1);
	assert.equal((await call('link', { account: { ...account, alias: 'other' }, identity, expected: 0, barrier: 0 })).status, 400);
	assert.equal((await call('link', { account: { ...account, alias: null }, identity, expected: 0, barrier: 0 })).status, 400);
	assert.equal((await call('link', { account, identity: 'b'.repeat(64), expected: 0, barrier: 0 })).status, 400);
	assert.deepEqual((await call('getAccount', { alias: 'mail' })).body.result, account);
	assert.deepEqual((await call('unlink', { alias: 'mail', expected: 1 })).body.result, { epoch: 2, removed: true });
	assert.equal((await call('getAccount', { alias: 'mail' })).body.result, null);
	assert.equal((await call('flowBarrier')).body.result, 1);
	assert.equal((await call('link', { account: { ...account, alias: 'other' }, identity, expected: 0, barrier: 1 })).status, 400);
	assert.equal((await call('link', { account, identity, expected: 0, barrier: 0 })).status, 400);
	assert.equal((await call('purge', { alias: 'mail', expected: 2, proof: false })).body.result, false);
	assert.equal((await call('purge', { alias: 'mail', expected: 2, proof: true })).body.result, true);
	assert.equal((await call('link', { account, identity, expected: 2, barrier: 1 })).status, 400);
	assert.equal((await call('finishRevocation', { alias: 'mail', epoch: 2, confirmed: false })).body.result, false);
	assert.equal((await call('finishRevocation', { alias: 'mail', epoch: 2, confirmed: true })).body.result, false);
	const claimToken = 'q'.repeat(22);
	assert.equal((await call('claimRevocation', { alias: 'mail', epoch: 2, claimToken })).body.result.sealed, account.sealedRefreshToken);
	assert.equal((await call('claimRevocation', { alias: 'mail', epoch: 2, claimToken })).body.result, null);
	assert.equal((await call('revocationStatus', { alias: 'mail', epoch: 2 })).body.result.state, 'uncertain');
	assert.equal((await call('cleanupRevocations', { now: Date.now() + 2 * 24 * 60 * 60 * 1000 })).body.result.uncertain, true);
	assert.equal((await call('finishRevocation', { alias: 'mail', epoch: 2, confirmed: false, now: Date.now() + 2 * 24 * 60 * 60 * 1000 })).body.result, false);
	assert.equal((await call('finishRevocation', { alias: 'mail', epoch: 2, confirmed: true, claimToken: 'r'.repeat(22) })).body.result, false);
	assert.equal((await call('finishRevocation', { alias: 'mail', epoch: 2, confirmed: true, claimToken })).body.result, true);
	assert.equal((await call('flowBarrier')).body.result, 2);
	assert.equal((await call('link', { account: { ...account, alias: 'other' }, identity, expected: 0, barrier: 0 })).status, 400);
	assert.equal((await call('link', { account, identity, expected: 2, barrier: 1 })).status, 400);
	assert.equal((await call('link', { account, identity, expected: 2, barrier: 2 })).body.result, 3);
	const incarnation = (await call('incarnation', { alias: 'mail' })).body.result;
	const rotated = { ...account, sealedRefreshToken: `v1.${'c'.repeat(16)}.${'d'.repeat(24)}` };
	assert.equal((await call('rotate', { account: rotated, identity, expected: 3, barrier: 2 })).body.result, 4);
	assert.equal((await call('incarnation', { alias: 'mail' })).body.result, incarnation);
	assert.equal((await call('rotate', { account: rotated, identity, expected: 3, barrier: 2 })).body.result, 4);
	assert.equal((await call('claimRevocation', { alias: 'mail', epoch: 4, claimToken })).body.result, null);
	assert.deepEqual((await call('getAccount', { alias: 'mail' })).body.result, rotated);
	const otherIdentity = createHash('sha256').update('other@example.invalid').digest('hex');
	const concurrentAccounts = await Promise.all(['other-a', 'other-b'].map((alias) => call('link', { account: { ...account, alias, email: 'other@example.invalid' }, identity: otherIdentity, expected: 0, barrier: 2 })));
	assert.deepEqual(concurrentAccounts.map((entry) => entry.status).sort(), [200, 400]);
	assert.equal((await call('unlink', { alias: 'mail', expected: 1 })).status, 400);
	assert.equal((await call('link', { account, identity, expected: 0, barrier: 0 })).status, 400);
	console.log('Synthetic owner state: revisions, expiry, rollback, account purge fencing and restart passed.');
} finally { await stop(); await rm(dir, { recursive: true, force: true }); }
