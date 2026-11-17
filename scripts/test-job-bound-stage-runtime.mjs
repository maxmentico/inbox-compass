// Synthetic local Workers/SQLite test. No production bindings or real mailbox data.
import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dir = await mkdtemp(join(tmpdir(), 'job-bound-stage-'));
const port = 20000 + process.pid % 20000, base = `http://127.0.0.1:${port}`;
const id = () => randomBytes(16).toString('base64url');
const hash = (s) => createHash('sha256').update(s).digest('hex');
const source = 'synthetic source ✓';
const fragmentHash = hash(source);
const sourceId = hash(JSON.stringify([1, Buffer.byteLength(source), [[fragmentHash, Buffer.byteLength(source)]]]));
const manifest = {version:1,id:sourceId,totalBytes:Buffer.byteLength(source),fragments:[{sha256:fragmentHash,bytes:Buffer.byteLength(source)}]};
await writeFile(join(dir, 'entry.ts'), `import { RunCoordinator } from ${JSON.stringify(resolve('src/run-coordinator.ts'))};
import { JobStateCore } from ${JSON.stringify(resolve('src/job-state-core.ts'))};
import { GenerationStore } from ${JSON.stringify(resolve('src/generation-store.ts'))};
import { DomainGenerationGate } from ${JSON.stringify(resolve('src/domain-generation-gate.ts'))};
import { SyntheticJobBoundStage } from ${JSON.stringify(resolve('src/synthetic-job-bound-stage.ts'))};
import { stageVerifiedOutputPage } from ${JSON.stringify(resolve('src/atomic-stage-page.ts'))};
export class Test {
 constructor(state) {
  this.sql=state.storage.sql; this.lease=new RunCoordinator(state); new GenerationStore(state.storage);
  this.gate=new DomainGenerationGate(state.storage); this.core=new JobStateCore(state.storage,undefined,this.gate.jobBinding());
  this.stage=new SyntheticJobBoundStage(state.storage,(_sql,_job,_gen,source,versions)=>source==='${sourceId}' && JSON.parse(versions).every(v=>v.key.startsWith('account:') ? v.value===1 : v.value===0));
  this.noAuthority=new SyntheticJobBoundStage(state.storage);
 }
 async alarm(){return this.lease.alarm();}
 async fetch(req) {const op=new URL(req.url).pathname.slice(1),d=await req.json(); let r;
  try {
   if(op==='lease') {const res=await this.lease.fetch(new Request('https://internal/acquire',{method:'POST',body:JSON.stringify({owner:d.generation,holder:{at:new Date().toISOString(),job:d.job,driver:'web'}})})); r=await res.json();}
   else if(op==='account')r=this.gate.changeAccount(d.alias,d.identity);
   else if(op==='bump')r=this.gate.bump(d.kind);
   else if(op==='create')r=this.core.create(d);
   else if(op==='claim')r=this.core.claim(d.job,d.generation,d.token);
   else if(op==='fail')r=this.core.fail(d.job,d.generation,d.alias,d.token);
   else if(op==='final')r=this.core.claimFinal(d.job,d.generation,d.token);
   else if(op==='source-create')r=await this.lease.syntheticSnapshots.create(d.generation,d.manifest);
   else if(op==='source-put')r=await this.lease.syntheticSnapshots.put(d.generation,d.sourceId,0,new TextEncoder().encode(d.data));
   else if(op==='source-seal')r=this.lease.syntheticSnapshots.seal(d.generation,d.sourceId);
   else if(op==='init')r=this.stage.initialize(d);
   else if(op==='no-authority')r=this.noAuthority.initialize(d);
   else if(op==='stage')r=await stageVerifiedOutputPage(this.stage,{...d,bytes:new TextEncoder().encode(d.bytes)});
   else if(op==='raw')r={pages:this.sql.exec('SELECT COUNT(*) AS n FROM synthetic_stage_page WHERE scope=?',d.scope).toArray()[0].n,cursor:this.sql.exec('SELECT next_page,complete FROM synthetic_stage_cursor WHERE scope=?',d.scope).toArray()[0]??null};
   else if(op==='inject') {this.sql.exec("CREATE TRIGGER bound_stage_fail BEFORE UPDATE ON synthetic_stage_cursor BEGIN SELECT RAISE(ABORT,'injected'); END");r=true;}
   else if(op==='uninject') {this.sql.exec('DROP TRIGGER bound_stage_fail');r=true;}
   else return new Response(null,{status:404}); return Response.json({r});
  } catch(e) {return Response.json({r:null,error:String(e)},{status:409});}
 }
}
export default {fetch(req,env){const key=new URL(req.url).searchParams.get('case')||'main';return env.TEST.get(env.TEST.idFromName(key)).fetch(req);}};
`);
await writeFile(join(dir, 'wrangler.json'), JSON.stringify({name:'synthetic-job-stage',main:'entry.ts',compatibility_date:'2026-10-01',durable_objects:{bindings:[{name:'TEST',class_name:'Test'}]},migrations:[{tag:'v1',new_sqlite_classes:['Test']}]}));
let child;
async function call(testCase, op, body = {}) { const r=await fetch(`${base}/${op}?case=${testCase}`,{method:'POST',body:JSON.stringify(body)}); return {status:r.status,body:await r.json()}; }
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>out+=v);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(out);try{await call('health','raw',{scope:'none'});return;}catch{await delay(100);}}throw new Error(out);}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await done;child=undefined;}
async function setup(testCase) {
 const job=id(),generation=id(),attempt=id(),scope=id(),identity='b'.repeat(64);
 const acquired=await call(testCase,'lease',{job,generation}); assert.equal(acquired.status,200,JSON.stringify(acquired.body)); assert.equal(acquired.body.r.ok,true);
 assert.equal((await call(testCase,'account',{alias:'mail',identity})).body.r,1);
 assert.equal((await call(testCase,'create',{job,generation,driver:'web',mailboxes:[{alias:'mail',identity}]})).body.r.ok,true);
 const step=id(); assert.equal((await call(testCase,'claim',{job,generation,token:step})).body.r.kind,'claim');
 assert.equal((await call(testCase,'fail',{job,generation,alias:'mail',token:step})).body.r,true);
 assert.equal((await call(testCase,'final',{job,generation,token:attempt})).body.r,true);
 assert.equal((await call(testCase,'source-create',{generation,manifest})).body.r,true);
 assert.equal((await call(testCase,'source-put',{generation,sourceId,data:source})).body.r,true);
 const init={scope,job,generation,attempt,sourceId,totalRecords:2};
 assert.equal((await call(testCase,'init',init)).body.r,false);
 assert.equal((await call(testCase,'source-seal',{generation,sourceId})).body.r,true);
 assert.equal((await call(testCase,'source-put',{generation,sourceId,data:source})).body.r,false);
 assert.equal((await call(testCase,'no-authority',init)).body.r,false);
 assert.equal((await call(testCase,'init',init)).body.r,true);
 const page=(n,final=false)=>({scope,sourceId,generation:1,attempt,page:n,startSequence:n,endSequence:n+1,final,bytes:`synthetic-output-${n}`});
 return {init,page};
}
try {
 await start();
 const main=await setup('main');
 assert.equal((await call('main','inject')).body.r,true);
 assert.equal((await call('main','stage',main.page(0))).status,409);
 assert.deepEqual((await call('main','raw',{scope:main.init.scope})).body.r,{pages:0,cursor:{next_page:0,complete:0}});
 assert.equal((await call('main','uninject')).body.r,true);
 assert.equal((await call('main','stage',{...main.page(0),attempt:id()})).status,409);
 assert.equal((await call('main','stage',{...main.page(0),bytes:'✓'.repeat(22000)})).status,409);
 assert.deepEqual((await call('main','raw',{scope:main.init.scope})).body.r,{pages:0,cursor:{next_page:0,complete:0}});
 assert.equal((await call('main','stage',main.page(0))).body.r,'staged');
 await stop(); await start();
 assert.equal((await call('main','stage',main.page(0))).body.r,'already-staged');
 assert.equal((await call('main','bump',{kind:'done'})).body.r,1);
 assert.equal((await call('main','stage',main.page(1,true))).status,409);
 assert.equal((await call('main','init',{...main.init,scope:id()})).body.r,false);
 const relink=await setup('relink');
 assert.equal((await call('relink','account',{alias:'mail',identity:'b'.repeat(64)})).body.r,2);
 assert.equal((await call('relink','stage',relink.page(0))).status,409);
 console.log('Synthetic local SQLite: sealed-source authority, job/finalizer fences, revision and same-address relink invalidation, atomic rollback and restart passed. Output semantic correctness remains unverified.');
} finally {await stop();await rm(dir,{recursive:true,force:true});}
