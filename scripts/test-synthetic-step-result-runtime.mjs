// Synthetic local Workers/SQLite test. No production bindings or mailbox data.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const dir = await mkdtemp(join(tmpdir(), 'job-core-test-'));
const port = 20000 + process.pid % 20000;
const base = `http://127.0.0.1:${port}`;
const id = () => randomBytes(16).toString('base64url');
await writeFile(join(dir, 'entry.ts'), `import { JobStateCore } from ${JSON.stringify(resolve('src/job-state-core.ts'))};
import {SyntheticStepResultStore} from ${JSON.stringify(resolve('src/synthetic-step-result.ts'))};
export class TestJobCore {
 constructor(state) { this.sql=state.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_commits (job TEXT PRIMARY KEY, digest TEXT NOT NULL)'); this.core=new JobStateCore(state.storage, (sql,job,generation,digest)=>{ sql.exec('INSERT INTO synthetic_commits VALUES (?, ?)',job,digest); return true; }); this.bad=new JobStateCore(state.storage, async ()=>true);this.sql.exec("CREATE TABLE IF NOT EXISTS gen_versions (key TEXT PRIMARY KEY,version INTEGER NOT NULL)");this.sql.exec("INSERT OR IGNORE INTO gen_versions VALUES ('settings',0)");this.results=new SyntheticStepResultStore(state.storage);this.bound=new JobStateCore(state.storage,undefined,undefined,undefined,this.results.binding(),this.results.claimBinding()); }
 async fetch(req) { const op=new URL(req.url).pathname.slice(1), d=await req.json(); let r;
 if(op==='result-stage') r=this.results.stage(d.job,d.generation,d.alias,d.token,d.result);
 else if(op==='result-read')r=this.sql.exec('SELECT payload FROM synthetic_step_result_bound WHERE job=? AND generation=? AND alias=?',d.job,d.generation,d.alias).toArray()[0]?.payload??null;
 else if(op==='bound-accept')r=this.bound.accept(d.job,d.generation,d.alias,d.token,d.hash);
 else if(op==='bump-settings'){this.sql.exec("UPDATE gen_versions SET version=version+1 WHERE key='settings'");r=true;}
 else if(op==='bound-giveup')r=this.bound.giveUp(d.job,d.generation,d.alias);
 else if(op==='expire-claim') { this.sql.exec('UPDATE core_steps SET deadline = ? WHERE job = ? AND alias = ?',Date.now(),d.job,d.alias); r=true; }
 else if(op==='expire-job') { this.sql.exec('UPDATE core_jobs SET expires = ? WHERE job = ?',Date.now(),d.job); r=true; }
 else if(op==='inject') { this.sql.exec("CREATE TRIGGER inject_commit BEFORE UPDATE ON core_jobs WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'injected'); END"); r=true; }
 else if(op==='uninject') { this.sql.exec('DROP TRIGGER inject_commit'); r=true; }
 else if(op==='commits') r=this.sql.exec('SELECT COUNT(*) AS n FROM synthetic_commits').toArray()[0].n;
 else if(op==='create') r=this.core.create(d);
 else if(op==='observe') r=this.core.observe(d.job);
 else if(op==='renewJob') r=this.core.renewJob(d.job,d.generation);
 else if(op==='claim') r=this.bound.claim(d.job,d.generation,d.token);
 else if(op==='renewClaim') r=this.core.renewClaim(d.job,d.generation,d.alias,d.token);
 else if(op==='stage') r=await this.core.stage(d.job,d.generation,d.alias,d.token,new TextEncoder().encode(d.data));
 else if(op==='discard') r=this.core.discardAttempt(d.job,d.generation,d.alias,d.token,d.limit);
 else if(op==='budget') r=this.sql.exec('SELECT bytes FROM core_stage_budget WHERE job=?',d.job).toArray()[0]?.bytes;
 else if(op==='stageChunk') r=await this.core.stageChunk(d.job,d.generation,d.alias,d.token,d.index,d.total,new TextEncoder().encode(d.data));
 else if(op==='acceptChunks') r=await this.core.acceptChunks(d.job,d.generation,d.alias,d.token,d.refs);
 else if(op==='readAcceptedChunk') { const bytes=this.core.readAcceptedChunk(d.job,d.generation,d.alias,d.index); r=bytes ? new TextDecoder().decode(bytes) : null; }
 else if(op==='accept') r=this.core.accept(d.job,d.generation,d.alias,d.token,d.hash);
 else if(op==='fail') r=this.core.fail(d.job,d.generation,d.alias,d.token);
 else if(op==='giveUp') r=this.core.giveUp(d.job,d.generation,d.alias);
 else if(op==='claimFinal') r=this.core.claimFinal(d.job,d.generation,d.token);
 else if(op==='finalize') r=this.core.finalize(d.job,d.generation,d.token,d.digest,d.preparation);
 else if(op==='badfinalize') r=this.bad.finalize(d.job,d.generation,d.token,d.digest,d.preparation);
 else return new Response(null,{status:404}); return Response.json({r}); }
}
export default { fetch(req,env) { return env.TEST.get(env.TEST.idFromName('singleton')).fetch(req); } };
`);
await writeFile(join(dir, 'wrangler.json'), JSON.stringify({ name:'synthetic-job-core', main:'entry.ts', compatibility_date:'2026-10-01', durable_objects:{bindings:[{name:'TEST',class_name:'TestJobCore'}]}, migrations:[{tag:'v1',new_sqlite_classes:['TestJobCore']}] }));
let child;
async function request(op, body) { const res = await fetch(`${base}/${op}`, {method:'POST',body:JSON.stringify(body)}); if(!res.ok) throw new Error(`HTTP ${res.status} for ${op}`); return (await res.json()).r; }
async function start() {
  child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});
  let output=''; child.stdout.on('data',v=>output+=v); child.stderr.on('data',v=>output+=v);
  for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(output); try { await request('observe',{job:'none'}); return; } catch { await delay(100); }} throw new Error(output);
}
async function stop(){if(!child||child.exitCode!==null)return; const exited=new Promise(r=>child.once('exit',r)); child.kill('SIGINT'); await exited; child=undefined;}
try {
 await start();const job=id(),generation=id(),token=id(),alias='a',input={job,generation,driver:'web',mailboxes:[{alias,identity:'a'.repeat(64)}]};assert.equal((await request('create',input)).ok,true);assert.equal((await request('claim',{job,generation,token})).kind,'claim');
 const hash=await request('stage',{job,generation,alias,token,data:'synthetic'}),bound={job,generation,alias,token,hash};
 const rejected=await fetch(`${base}/bound-accept`,{method:'POST',body:JSON.stringify(bound)});assert.equal(rejected.ok,false);assert.equal((await request('observe',{job})).rows[0].state,'running');
 assert.equal(await request('result-stage',{...bound,result:{state:'done',summary:{fresh:2,toAction:1,estimated:0},sealedRefreshToken:'sentinel'}}),false);
 assert.equal(await request('result-stage',{...bound,token:id(),result:{state:'done',summary:{fresh:2,toAction:1,estimated:0}}}),false);
 assert.equal(await request('result-stage',{...bound,result:{state:'failed',reason:'raw provider secret'}}),false);
 assert.equal(await request('result-stage',{...bound,result:{state:'done',summary:{fresh:2,toAction:1,estimated:0}}}),true);
 assert.equal(await request('result-stage',{...bound,result:{state:'done',summary:{fresh:3,toAction:1,estimated:0}}}),false);
 assert.equal(await request('bound-accept',bound),true);assert.equal(await request('bound-accept',bound),true);const saved=await request('result-read',bound);assert.deepEqual(JSON.parse(saved),{state:'done',summary:{fresh:2,toAction:1,estimated:0}});
 await stop();await start();assert.equal(await request('result-read',bound),saved);assert.equal(await request('bound-accept',bound),true);
 await request('expire-job',{job});const second={job:id(),generation:id(),driver:'web',mailboxes:[{alias,identity:'a'.repeat(64)}]};assert.equal((await request('create',second)).ok,true);assert.equal(await request('bound-giveup',{...second,alias}),true);assert.equal(await request('bound-giveup',{...second,alias}),true);assert.deepEqual(JSON.parse(await request('result-read',{...second,alias})),{state:'failed',reason:'took too long'});
 await request('expire-job',{job:second.job});const third={job:id(),generation:id(),driver:'web',mailboxes:[{alias,identity:'a'.repeat(64)}]},thirdToken=id();assert.equal((await request('create',third)).ok,true);assert.equal((await request('claim',{...third,token:thirdToken})).kind,'claim');const thirdHash=await request('stage',{...third,alias,token:thirdToken,data:'synthetic'});await request('bump-settings',{});assert.equal(await request('result-stage',{...third,alias,token:thirdToken,result:{state:'done',summary:{fresh:1,toAction:1,estimated:0}}}),false);const stale=await fetch(`${base}/bound-accept`,{method:'POST',body:JSON.stringify({...third,alias,token:thirdToken,hash:thirdHash})});assert.equal(stale.ok,false);assert.equal((await request('observe',{job:third.job})).rows[0].state,'running');console.log('Synthetic step metadata rollback, settings fence, timeout, acceptance, retry and restart passed');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
