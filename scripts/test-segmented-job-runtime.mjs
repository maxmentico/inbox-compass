// Synthetic local Workers/SQLite test. Proof of exact bytes only; no production or semantic projector.
import { strict as assert } from 'node:assert';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const dir=await mkdtemp(join(tmpdir(),'source-proof-')),port=20000+process.pid%20000,base=`http://127.0.0.1:${port}`;
const id=()=>randomBytes(16).toString('base64url');
const hash=(v)=>createHash('sha256').update(v).digest('hex');
await writeFile(join(dir,'entry.ts'), `import { RunCoordinator } from ${JSON.stringify(resolve('src/run-coordinator.ts'))};
import { JobStateCore } from ${JSON.stringify(resolve('src/job-state-core.ts'))};
import { GenerationStore } from ${JSON.stringify(resolve('src/generation-store.ts'))};
import { DomainGenerationGate } from ${JSON.stringify(resolve('src/domain-generation-gate.ts'))};
import { TrustedAssemblySource } from ${JSON.stringify(resolve('src/trusted-assembly-source.ts'))};
import { SyntheticSourceProof,missingSourceFragment,emptySourceFragment } from ${JSON.stringify(resolve('src/synthetic-source-proof.ts'))};
import { SyntheticJobBoundStage } from ${JSON.stringify(resolve('src/synthetic-job-bound-stage.ts'))};
import { stageVerifiedOutputPage } from ${JSON.stringify(resolve('src/atomic-stage-page.ts'))};
import { SyntheticSegmentedJob } from ${JSON.stringify(resolve('src/synthetic-segmented-job.ts'))};
import { OwnerState } from ${JSON.stringify(resolve('src/owner-state.ts'))};
export class Test {
 constructor(state) {this.storage=state.storage;this.sql=state.storage.sql;this.lease=new RunCoordinator(state);new GenerationStore(state.storage);new OwnerState(state.storage);this.gate=new DomainGenerationGate(state.storage);this.core=new JobStateCore(state.storage,undefined,this.gate.jobBinding());this.source=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:()=>null});this.proof=new SyntheticSourceProof(state.storage,this.source,this.lease.syntheticSnapshots);this.stage=new SyntheticJobBoundStage(state.storage,this.proof.authority());this.segmented=new SyntheticSegmentedJob(state.storage,this.gate,this.proof.authority()).store;}
 async alarm(){return this.lease.alarm();}
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json();let r;try{
  if(op==='lease'){const res=await this.lease.fetch(new Request('https://internal/acquire',{method:'POST',body:JSON.stringify({owner:d.generation,holder:{at:new Date().toISOString(),job:d.job,driver:'web'}})}));r=await res.json();}
  else if(op==='account')r=this.gate.changeAccount(d.alias,d.identity);
  else if(op==='bump')r=this.gate.bump(d.kind);
  else if(op==='create')r=this.core.create(d);
  else if(op==='claim')r=this.core.claim(d.job,d.generation,d.token);
  else if(op==='stage-partial')r=await this.core.stage(d.job,d.generation,d.alias,d.token,new TextEncoder().encode(d.data));
  else if(op==='accept')r=this.core.accept(d.job,d.generation,d.alias,d.token,d.hash);
  else if(op==='final')r=this.core.claimFinal(d.job,d.generation,d.token);
  else if(op==='capture')r=this.source.capture(d.scope,d.job,d.generation,d.attempt);
  else if(op==='inventory')r=this.storage.transactionSync(()=>this.source.inventoryPageInTransaction(this.sql,d.scope,d.attempt,d.after,1));
  else if(op==='bytes'){let b;if(d.entry.kind==='partial')b=this.source.readPartial(d.scope,d.attempt,d.entry.key,d.entry.index);else if(d.entry.kind==='missing'||d.entry.kind==='tombstone')b=missingSourceFragment(d.entry);else if(d.entry.kind==='state'&&d.entry.bytes===0)b=emptySourceFragment(d.entry);else {const v=this.source.readState(d.scope,d.attempt,d.entry.key,d.entry.index);b=v.kind==='value'?v.bytes:null;} r=b?btoa(String.fromCharCode(...b)):null;}
  else if(op==='snapshot-create')r=await this.lease.syntheticSnapshots.create(d.generation,d.manifest);
  else if(op==='snapshot-put')r=await this.lease.syntheticSnapshots.put(d.generation,d.sourceId,d.index,Uint8Array.from(atob(d.data),c=>c.charCodeAt(0)));
  else if(op==='snapshot-seal')r=this.lease.syntheticSnapshots.seal(d.generation,d.sourceId);
  else if(op==='proof-begin')r=await this.proof.begin(d);
  else if(op==='proof-next')r=await this.proof.verifyNext(d.scope,d.attempt,d.index);
  else if(op==='stage-init')r=this.stage.initialize(d);
  else if(op==='segment-begin')r=this.segmented.begin(d.outputScope,d.job,d.generation,d.attempt,d.sourceId);
  else if(op==='segment-append')r=await this.segmented.append(d.outputScope,d.attempt,d.index,new TextEncoder().encode(d.bytes));
  else if(op==='segment-seal')r=this.segmented.seal(d.outputScope,d.attempt,d.parts,d.bytes);
  else if(op==='segment-read'){const v=await this.segmented.read(d.outputScope,d.attempt,d.index);r=v?new TextDecoder().decode(v):null;}
  else if(op==='stage-output')r=await stageVerifiedOutputPage(this.stage,{...d,bytes:new TextEncoder().encode(d.bytes)});
  else if(op==='expire-final') {this.sql.exec('UPDATE core_final SET deadline=0 WHERE job=?',d.job);r=true;}
  else return new Response(null,{status:404});return Response.json({r});
 }catch(e){return Response.json({r:null,error:String(e)},{status:409});}}
}
export default {fetch(req,env){return env.TEST.get(env.TEST.idFromName(new URL(req.url).searchParams.get('case')||'main')).fetch(req);}};
`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'synthetic-source-proof',main:'entry.ts',compatibility_date:'2026-10-01',durable_objects:{bindings:[{name:'TEST',class_name:'Test'}]},migrations:[{tag:'v1',new_sqlite_classes:['Test']}]}));
let child;
async function call(testCase,op,body={}){const r=await fetch(`${base}/${op}?case=${testCase}`,{method:'POST',body:JSON.stringify(body)});const data=await r.json();if(!r.ok)throw new Error(`HTTP ${r.status} ${op}: ${JSON.stringify(data)}`);return data.r;}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>out+=v);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(out);try{await call('health','capture',{});return;}catch{await delay(100);}}throw new Error(out);}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await done;child=undefined;}
async function setup(testCase) {
 const job=id(),generation=id(),attempt=id(),scope=id(),identity='b'.repeat(64);
 assert.equal((await call(testCase,'lease',{job,generation})).ok,true);
 assert.equal(await call(testCase,'account',{alias:'mail',identity}),1);
 assert.equal((await call(testCase,'create',{job,generation,driver:'web',mailboxes:[{alias:'mail',identity}]})).ok,true);
 const step=id();assert.equal((await call(testCase,'claim',{job,generation,token:step})).kind,'claim');
 const digest=await call(testCase,'stage-partial',{job,generation,alias:'mail',token:step,data:'synthetic partial'});
 assert.equal(await call(testCase,'accept',{job,generation,alias:'mail',token:step,hash:digest}),true);
 assert.equal(await call(testCase,'final',{job,generation,token:attempt}),true);
 assert.ok(await call(testCase,'capture',{scope,job,generation,attempt}));
 const entries=[];let after=null;
 do {const page=await call(testCase,'inventory',{scope,attempt,after});assert(page);entries.push(...page.entries);after=page.next;} while(after!==null);
 const fragments=[];
 for(const entry of entries){const data=await call(testCase,'bytes',{scope,attempt,entry});assert.notEqual(data,null);fragments.push(Buffer.from(data,'base64'));}
 return {scope,job,generation,attempt,entries,fragments};
}
async function makeSnapshot(testCase,context,fragments){
 const parts=fragments.map(v=>({sha256:hash(v),bytes:v.length})),totalBytes=parts.reduce((a,v)=>a+v.bytes,0);
 const manifest={version:1,id:hash(JSON.stringify([1,totalBytes,parts.map(v=>[v.sha256,v.bytes])])),totalBytes,fragments:parts};
 assert.equal(await call(testCase,'snapshot-create',{generation:context.generation,manifest}),true);
 for(let index=0;index<fragments.length;index++)assert.equal(await call(testCase,'snapshot-put',{generation:context.generation,sourceId:manifest.id,index,data:fragments[index].toString('base64')}),true);
 assert.equal(await call(testCase,'snapshot-seal',{generation:context.generation,sourceId:manifest.id}),true);
 return manifest;
}
try {
 await start();
 const main=await setup('main');assert(main.fragments.length>1);
 const manifest=await makeSnapshot('main',main,main.fragments);
 const init={scope:main.scope,job:main.job,generation:main.generation,attempt:main.attempt,sourceId:manifest.id,totalRecords:1};
 assert.equal(await call('main','stage-init',init),false);
 const outputScope=id();
 assert.equal(await call('main','segment-begin',{outputScope,job:main.job,generation:main.generation,attempt:main.attempt,sourceId:manifest.id}),false);
 assert.equal(await call('main','proof-begin',{...main,manifest}),true);
 const first=await Promise.all([call('main','proof-next',{scope:main.scope,attempt:main.attempt,index:0}),call('main','proof-next',{scope:main.scope,attempt:main.attempt,index:0})]);
 assert.equal(first.filter(Boolean).length,1);
 await stop();await start();
 assert.equal(await call('main','proof-next',{scope:main.scope,attempt:main.attempt,index:0}),null);
 for(let index=1;index<main.fragments.length;index++){const r=await call('main','proof-next',{scope:main.scope,attempt:main.attempt,index});assert.deepEqual(r,{next:index+1,complete:index===main.fragments.length-1});}
 assert.equal(await call('main','segment-begin',{outputScope,job:main.job,generation:main.generation,attempt:main.attempt,sourceId:manifest.id}),true);
 assert.equal(await call('main','segment-append',{outputScope,attempt:main.attempt,index:0,bytes:'synthetic segmented output'}),'staged');
 assert.equal(await call('main','segment-seal',{outputScope,attempt:main.attempt,parts:1,bytes:26}),true);
 assert.equal(await call('main','segment-read',{outputScope,attempt:main.attempt,index:0}),'synthetic segmented output');
 assert.equal(await call('main','stage-init',init),true);
 assert.equal(await call('main','stage-output',{scope:main.scope,sourceId:manifest.id,generation:1,attempt:main.attempt,page:0,startSequence:0,endSequence:1,final:true,bytes:'synthetic output'}),'staged');
 assert.equal(await call('main','bump',{kind:'done'}),1);
 assert.equal(await call('main','segment-read',{outputScope,attempt:main.attempt,index:0}),null);
 const omitted=await setup('omitted');const short=await makeSnapshot('omitted',omitted,omitted.fragments.slice(0,-1));
 assert.equal(await call('omitted','proof-begin',{...omitted,manifest:short}),true);
 for(let index=0;index<short.fragments.length-1;index++)assert.ok(await call('omitted','proof-next',{scope:omitted.scope,attempt:omitted.attempt,index}));
 assert.equal(await call('omitted','proof-next',{scope:omitted.scope,attempt:omitted.attempt,index:short.fragments.length-1}),null);
 assert.equal(await call('omitted','stage-init',{scope:omitted.scope,job:omitted.job,generation:omitted.generation,attempt:omitted.attempt,sourceId:short.id,totalRecords:1}),false);
 const swapped=await setup('swapped');const shuffled=[...swapped.fragments];[shuffled[0],shuffled[1]]=[shuffled[1],shuffled[0]];const wrong=await makeSnapshot('swapped',swapped,shuffled);
 assert.equal(await call('swapped','proof-begin',{...swapped,manifest:wrong}),true);
 assert.equal(await call('swapped','proof-next',{scope:swapped.scope,attempt:swapped.attempt,index:0}),null);
 const revised=await setup('revised');const old=await makeSnapshot('revised',revised,revised.fragments);
 assert.equal(await call('revised','proof-begin',{...revised,manifest:old}),true);
 assert.equal(await call('revised','bump',{kind:'done'}),1);
 assert.equal(await call('revised','proof-next',{scope:revised.scope,attempt:revised.attempt,index:0}),null);
 console.log('Synthetic source-bound segmented transport: proof required, revision invalidation and restart passed. Output semantics remain unverified.');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
