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
export class TestJobCore {
 constructor(state) { this.sql=state.storage.sql; this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_commits (job TEXT PRIMARY KEY, digest TEXT NOT NULL)'); this.core=new JobStateCore(state.storage, (sql,job,generation,digest)=>{ sql.exec('INSERT INTO synthetic_commits VALUES (?, ?)',job,digest); return true; }); this.bad=new JobStateCore(state.storage, async ()=>true); }
 async fetch(req) { const op=new URL(req.url).pathname.slice(1), d=await req.json(); let r;
 if(op==='expire-claim') { this.sql.exec('UPDATE core_steps SET deadline = ? WHERE job = ? AND alias = ?',Date.now(),d.job,d.alias); r=true; }
 else if(op==='expire-job') { this.sql.exec('UPDATE core_jobs SET expires = ? WHERE job = ?',Date.now(),d.job); r=true; }
 else if(op==='inject') { this.sql.exec("CREATE TRIGGER inject_commit BEFORE UPDATE ON core_jobs WHEN NEW.state = 'committed' BEGIN SELECT RAISE(ABORT, 'injected'); END"); r=true; }
 else if(op==='uninject') { this.sql.exec('DROP TRIGGER inject_commit'); r=true; }
 else if(op==='commits') r=this.sql.exec('SELECT COUNT(*) AS n FROM synthetic_commits').toArray()[0].n;
 else if(op==='create') r=this.core.create(d);
 else if(op==='observe') r=this.core.observe(d.job);
 else if(op==='renewJob') r=this.core.renewJob(d.job,d.generation);
 else if(op==='claim') r=this.core.claim(d.job,d.generation,d.token);
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
 await start();
 const job=id(), generation=id(), other=id(), otherGeneration=id();
 const input={job,generation,driver:'web',mailboxes:[{alias:'a',identity:'a'.repeat(64)},{alias:'b',identity:'b'.repeat(64)}]};
 const created=await Promise.all([request('create',input),request('create',{...input,job:other,generation:otherGeneration})]);
 assert.equal(created.filter(x=>x.ok).length,1);
 const winner=created[0].ok?input:{...input,job:other,generation:otherGeneration};
 const context={job:winner.job,generation:winner.generation};
 assert.equal((await request('create',winner)).ok,true);
 const t1=id(), t2=id(), race=await Promise.all([t1,t2].map(token=>request('claim',{...context,token})));
 assert.equal(race.filter(x=>x.kind==='claim').length,1);
 const first=race[0].kind==='claim'?t1:t2, claim=race.find(x=>x.kind==='claim');
 assert.equal(claim.identity, claim.alias.repeat(64));
 assert.equal((await request('claim',{...context,token:first})).attempt,1);
 assert.equal(typeof await request('stage',{...context,alias:claim.alias,token:first,data:'temporary'}),'string');
 assert.deepEqual(await request('discard',{...context,alias:claim.alias,token:first,limit:1}),{ok:false,remaining:0});
 assert.equal(await request('giveUp',{...context,alias:claim.alias}),false);
 const visible=await request('observe',{job:winner.job}); assert(!JSON.stringify(visible).includes(first));
 assert.equal(await request('claimFinal',{...context,token:id()}),false);
 await request('expire-claim',{...context,alias:claim.alias});
 assert.equal(await request('renewClaim',{...context,alias:claim.alias,token:first}),false);
 assert.equal(await request('stage',{...context,alias:claim.alias,token:first,data:'stale'}),null);
 const replacement=id(), next=await request('claim',{...context,token:replacement});
 assert.equal(next.attempt,2); assert.equal(next.alias,claim.alias);
 assert.equal(await request('budget',context),9);
 assert.deepEqual(await request('discard',{...context,alias:claim.alias,token:first,limit:1}),{ok:true,remaining:0});
 assert.equal(await request('budget',context),0);
 const refs=[]; const chunk='x'.repeat(64*1024);
 for(let index=0;index<24;index++) refs.push(await request('stageChunk',{...context,alias:next.alias,token:replacement,index,total:25,data:chunk}));
 assert.equal(await request('acceptChunks',{...context,alias:next.alias,token:replacement,refs}),null);
 refs.push(await request('stageChunk',{...context,alias:next.alias,token:replacement,index:24,total:25,data:'tail'}));
 assert.equal(await request('stageChunk',{...context,alias:next.alias,token:replacement,index:24,total:25,data:'changed'}),null);
 assert.equal(await request('acceptChunks',{...context,alias:next.alias,token:first,refs}),null);
 const hash=await request('acceptChunks',{...context,alias:next.alias,token:replacement,refs}); assert.equal(typeof hash,'string');
 assert.equal(await request('acceptChunks',{...context,alias:next.alias,token:replacement,refs}),hash);
 assert.deepEqual(await request('discard',{...context,alias:next.alias,token:replacement,limit:16}),{ok:false,remaining:0});
 await stop(); await start();
 const later=await request('observe',{job:winner.job}); assert.equal(later.rows.find(r=>r.alias===next.alias).partial,hash);
 assert.equal((await request('readAcceptedChunk',{...context,alias:next.alias,index:0})).length,64*1024);
 assert.equal(await request('readAcceptedChunk',{...context,alias:next.alias,index:24}),'tail');
 const lastToken=id(), last=await request('claim',{...context,token:lastToken}); assert.equal(last.kind,'claim');
 assert.equal(await request('fail',{...context,alias:last.alias,token:lastToken}),true);
 assert.equal(await request('fail',{...context,alias:last.alias,token:lastToken}),true);
 const finalPreparation=id(), finalToken=id(); assert.equal(await request('claimFinal',{...context,token:finalToken}),true);
 assert.equal(await request('claimFinal',{...context,token:id()}),false);
 await assert.rejects(request('badfinalize',{...context,token:finalToken,preparation:finalPreparation,digest:'synthetic-digest'}));
 await request('inject',{});
 await assert.rejects(request('finalize',{...context,token:finalToken,preparation:finalPreparation,digest:'synthetic-digest'}));
 assert.equal(await request('commits',{}),0); assert.equal((await request('observe',{job:winner.job})).state,'running');
 await request('uninject',{});
 assert.equal(await request('finalize',{...context,token:finalToken,preparation:finalPreparation,digest:'synthetic-digest'}),true);
 assert.equal(await request('finalize',{...context,token:finalToken,preparation:finalPreparation,digest:'synthetic-digest'}),true);
 assert.equal(await request('finalize',{...context,token:id(),preparation:finalPreparation,digest:'synthetic-digest'}),false);
 assert.equal(await request('commits',{}),1);
 const finalJob=id(), finalGeneration=id(), finalContext={job:finalJob,generation:finalGeneration};
 assert.equal((await request('create',{...input,...finalContext})).ok,true);
 assert.equal(await request('giveUp',{...finalContext,alias:'a'}),true);
 assert.equal(await request('giveUp',{...finalContext,alias:'a'}),true);
 const expiring=id(); assert.equal((await request('claim',{...finalContext,token:expiring})).alias,'b');
 await request('expire-claim',{...finalContext,alias:'b'});
 assert.equal(await request('giveUp',{...finalContext,alias:'b'}),true);
 assert.equal(await request('stage',{...finalContext,alias:'b',token:expiring,data:'late'}),null);
 await request('expire-job',finalContext);
 const empty={job:id(),generation:id(),driver:'cron',mailboxes:[]};
 assert.equal((await request('create',empty)).ok,true);
 assert.equal((await request('claim',{job:empty.job,generation:empty.generation,token:id()})).kind,'ready');
 assert.equal(await request('renewJob',finalContext),false);
 assert.equal(await request('claimFinal',{...finalContext,token:id()}),false);
 const emptyFinal=id();
 assert.equal(await request('claimFinal',{job:empty.job,generation:empty.generation,token:emptyFinal}),true);
 assert.equal(await request('finalize',{job:empty.job,generation:empty.generation,token:emptyFinal,preparation:id(),digest:'empty-synthetic'}),true);
 assert.equal(await request('commits',{}),2);
 console.log('Synthetic local SQLite: starts, claims, stale attempts, restart and transactional finalization passed.');
} finally { await stop(); await rm(dir,{recursive:true,force:true}); }
