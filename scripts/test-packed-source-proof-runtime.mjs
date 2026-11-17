// Synthetic local Workers/SQLite test of packed keyed proofs. No production or semantic projector.
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
import { missingSourceFragment,emptySourceFragment } from ${JSON.stringify(resolve('src/synthetic-source-proof.ts'))};
import { SyntheticPackedSourceProof } from ${JSON.stringify(resolve('src/synthetic-packed-source-proof.ts'))};
import { SyntheticJobBoundStage } from ${JSON.stringify(resolve('src/synthetic-job-bound-stage.ts'))};
import { stageVerifiedOutputPage } from ${JSON.stringify(resolve('src/atomic-stage-page.ts'))};
import { OwnerState } from ${JSON.stringify(resolve('src/owner-state.ts'))};
export class Test {
 constructor(state) {this.storage=state.storage;this.sql=state.storage.sql;this.lease=new RunCoordinator(state);new GenerationStore(state.storage);this.owner=new OwnerState(state.storage,()=>1);this.gate=new DomainGenerationGate(state.storage);this.core=new JobStateCore(state.storage,undefined,this.gate.jobBinding());this.source=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:()=>null});this.proof=new SyntheticPackedSourceProof(state.storage,this.source,this.lease.syntheticSnapshots);this.stage=new SyntheticJobBoundStage(state.storage,this.proof.authority());}
 async alarm(){return this.lease.alarm();}
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json();let r;try{
  if(op==='lease'){const res=await this.lease.fetch(new Request('https://internal/acquire',{method:'POST',body:JSON.stringify({owner:d.generation,holder:{at:new Date().toISOString(),job:d.job,driver:'web'}})}));r=await res.json();}
  else if(op==='account')r=this.gate.changeAccount(d.alias,d.identity);
  else if(op==='bump')r=this.gate.bump(d.kind);
  else if(op==='prepare-done'){this.sql.exec('CREATE TABLE IF NOT EXISTS coordinated_incarnations (alias TEXT PRIMARY KEY,version INTEGER NOT NULL)');this.sql.exec("INSERT OR REPLACE INTO coordinated_incarnations VALUES ('mail',1)");this.sql.exec("INSERT OR REPLACE INTO gen_head VALUES (1,'fixture-head')");r=true;}
  else if(op==='done'){const revision=this.sql.exec("SELECT version FROM gen_versions WHERE key='done'").toArray()[0].version;r=this.owner.setDone([d.key],d.value,revision,{head:'fixture-head',accounts:{mail:1}});}
  else if(op==='expire-done'){this.sql.exec('UPDATE owner_done SET expires_at=0 WHERE item=?',d.key);r=true;}
  else if(op==='create')r=this.core.create(d);
  else if(op==='claim')r=this.core.claim(d.job,d.generation,d.token);
  else if(op==='stage-partial')r=await this.core.stage(d.job,d.generation,d.alias,d.token,new TextEncoder().encode(d.data));
  else if(op==='accept')r=this.core.accept(d.job,d.generation,d.alias,d.token,d.hash);
  else if(op==='final')r=this.core.claimFinal(d.job,d.generation,d.token);
  else if(op==='capture')r=this.source.capture(d.scope,d.job,d.generation,d.attempt);
  else if(op==='inventory')r=this.storage.transactionSync(()=>this.source.inventoryPageInTransaction(this.sql,d.scope,d.attempt,d.after,d.limit||1));
  else if(op==='seed') {this.storage.transactionSync(()=>{for(const row of d.rows){this.sql.exec("INSERT INTO gen_key_heads (key,generation,preparation,kind,expires_at,metadata,chunks) VALUES (?,?,?,'put',?,?,1)",row.key,d.generation,d.preparation,row.expiresAt,JSON.stringify(row.metadata));this.sql.exec('INSERT INTO gen_chunks (generation,preparation,key,idx,hash,bytes,data) VALUES (?,?,?,0,?,?,?)',d.generation,d.preparation,row.key,row.hash,row.bytes,row.data);}});r=true;}
  else if(op==='corrupt-source') {this.sql.exec('UPDATE gen_chunks SET data=? WHERE key=?',btoa('corrupted source'),d.key);r=true;}
  else if(op==='bytes'){let b;if(d.entry.kind==='partial')b=this.source.readPartial(d.scope,d.attempt,d.entry.key,d.entry.index);else if(d.entry.kind==='missing'||d.entry.kind==='tombstone')b=missingSourceFragment(d.entry);else if(d.entry.kind==='state'&&d.entry.bytes===0)b=emptySourceFragment(d.entry);else {const v=this.source.readState(d.scope,d.attempt,d.entry.key,d.entry.index);b=v.kind==='value'?v.bytes:null;} r=b?btoa(String.fromCharCode(...b)):null;}
  else if(op==='snapshot-create')r=await this.lease.syntheticSnapshots.create(d.generation,d.manifest);
  else if(op==='snapshot-put')r=await this.lease.syntheticSnapshots.put(d.generation,d.sourceId,d.index,Uint8Array.from(atob(d.data),c=>c.charCodeAt(0)));
  else if(op==='snapshot-seal')r=this.lease.syntheticSnapshots.seal(d.generation,d.sourceId);
  else if(op==='proof-begin')r=await this.proof.begin(d);
  else if(op==='proof-next')r=await this.proof.verifyNext(d.scope,d.attempt,d.index);
  else if(op==='stage-init')r=this.stage.initialize(d);
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
async function setup(testCase, seedCount=0, done=false) {
 const job=id(),generation=id(),attempt=id(),scope=id(),identity='b'.repeat(64);
 assert.equal((await call(testCase,'lease',{job,generation})).ok,true);
 assert.equal(await call(testCase,'account',{alias:'mail',identity}),1);
 assert.equal((await call(testCase,'create',{job,generation,driver:'web',mailboxes:[{alias:'mail',identity}]})).ok,true);
 const step=id();assert.equal((await call(testCase,'claim',{job,generation,token:step})).kind,'claim');
 const digest=await call(testCase,'stage-partial',{job,generation,alias:'mail',token:step,data:'synthetic partial'});
 assert.equal(await call(testCase,'accept',{job,generation,alias:'mail',token:step,hash:digest}),true);
 assert.equal(await call(testCase,'final',{job,generation,token:attempt}),true);
 if(done){await call(testCase,'prepare-done');assert.equal((await call(testCase,'done',{key:'mail:m0',value:true})).revision,1);}
 if(seedCount){const rows=Array.from({length:seedCount},(_,i)=>{const v=Buffer.from('synthetic cache '+i);return {key:'cls:mail:m'+i,hash:hash(v),bytes:v.length,data:v.toString('base64'),expiresAt:Date.now()+3600000,metadata:{arrived:i}}});assert.equal(await call(testCase,'seed',{generation:id(),preparation:id(),rows}),true);}
 assert.ok(await call(testCase,'capture',{scope,job,generation,attempt}));
 const entries=[];let after=null;
 do {const page=await call(testCase,'inventory',{scope,attempt,after,limit:64});assert(page);entries.push(...page.entries);after=page.next;} while(after!==null);
 const descriptors=entries.map(({cursor,...entry})=>entry);
 return {scope,job,generation,attempt,entries,descriptors};
}
async function makeSnapshot(testCase,context,descriptors){
 const fragments=Array.from({length:Math.ceil(descriptors.length/16)},(_,i)=>Buffer.from(JSON.stringify(descriptors.slice(i*16,i*16+16))));
 const parts=fragments.map(v=>({sha256:hash(v),bytes:v.length})),totalBytes=parts.reduce((a,v)=>a+v.bytes,0);
 const manifest={version:1,id:hash(JSON.stringify([1,totalBytes,parts.map(v=>[v.sha256,v.bytes])])),totalBytes,fragments:parts};
 assert.equal(await call(testCase,'snapshot-create',{generation:context.generation,manifest}),true);
 for(let index=0;index<fragments.length;index++)assert.equal(await call(testCase,'snapshot-put',{generation:context.generation,sourceId:manifest.id,index,data:fragments[index].toString('base64')}),true);
 assert.equal(await call(testCase,'snapshot-seal',{generation:context.generation,sourceId:manifest.id}),true);
 return manifest;
}
try {
 await start();
 const main=await setup('main',500);assert(main.descriptors.length>=500);
 const manifest=await makeSnapshot('main',main,main.descriptors);assert(manifest.fragments.length<160);
 const init={scope:main.scope,job:main.job,generation:main.generation,attempt:main.attempt,sourceId:manifest.id,totalRecords:1};
 assert.equal(await call('main','stage-init',init),false);
 assert.equal(await call('main','proof-begin',{...main,manifest}),true);
 const first=await Promise.all([call('main','proof-next',{scope:main.scope,attempt:main.attempt,index:0}),call('main','proof-next',{scope:main.scope,attempt:main.attempt,index:0})]);
 assert.equal(first.filter(Boolean).length,1);
 await stop();await start();
 assert.equal(await call('main','proof-next',{scope:main.scope,attempt:main.attempt,index:0}),null);
 const wall=[];for(let index=1;index<manifest.fragments.length;index++){const started=performance.now(),r=await call('main','proof-next',{scope:main.scope,attempt:main.attempt,index});wall.push(performance.now()-started);assert.deepEqual(r,{next:index+1,complete:index===manifest.fragments.length-1});}wall.sort((a,b)=>a-b);console.log('Synthetic 500-key packed proof page wall time, local HTTP + Workers: p50='+wall[Math.floor(wall.length*.5)].toFixed(2)+'ms p95='+wall[Math.floor(wall.length*.95)].toFixed(2)+'ms; not a deployed CPU measurement.');
 assert.equal(await call('main','stage-init',init),true);
 assert.equal(await call('main','stage-output',{scope:main.scope,sourceId:manifest.id,generation:1,attempt:main.attempt,page:0,startSequence:0,endSequence:1,final:true,bytes:'synthetic output'}),'staged');
 const omitted=await setup('omitted',20);const short=await makeSnapshot('omitted',omitted,omitted.descriptors.slice(0,-1));
 assert.equal(await call('omitted','proof-begin',{...omitted,manifest:short}),true);
 for(let index=0;index<short.fragments.length-1;index++)assert.ok(await call('omitted','proof-next',{scope:omitted.scope,attempt:omitted.attempt,index}));
 assert.equal(await call('omitted','proof-next',{scope:omitted.scope,attempt:omitted.attempt,index:short.fragments.length-1}),null);
 assert.equal(await call('omitted','stage-init',{scope:omitted.scope,job:omitted.job,generation:omitted.generation,attempt:omitted.attempt,sourceId:short.id,totalRecords:1}),false);
 const swapped=await setup('swapped');const shuffled=[...swapped.descriptors];[shuffled[0],shuffled[1]]=[shuffled[1],shuffled[0]];const wrong=await makeSnapshot('swapped',swapped,shuffled);
 assert.equal(await call('swapped','proof-begin',{...swapped,manifest:wrong}),true);
 assert.equal(await call('swapped','proof-next',{scope:swapped.scope,attempt:swapped.attempt,index:0}),null);
 const revised=await setup('revised');const old=await makeSnapshot('revised',revised,revised.descriptors);
 assert.equal(await call('revised','proof-begin',{...revised,manifest:old}),true);
 assert.equal(await call('revised','bump',{kind:'done'}),1);
 assert.equal(await call('revised','proof-next',{scope:revised.scope,attempt:revised.attempt,index:0}),null);
 const metadata=await setup('metadata',1);const altered=structuredClone(metadata.descriptors);const changed=altered.find(v=>v.kind==='state');assert(changed);changed.metadata={arrived:999};const tampered=await makeSnapshot('metadata',metadata,altered);assert.equal(await call('metadata','proof-begin',{...metadata,manifest:tampered}),true);assert.equal(await call('metadata','proof-next',{scope:metadata.scope,attempt:metadata.attempt,index:0}),null);
 const expiry=await setup('expiry',1);const expiryRows=structuredClone(expiry.descriptors);const changedExpiry=expiryRows.find(v=>v.kind==='state');assert(changedExpiry);changedExpiry.expiresAt+=1;const wrongExpiry=await makeSnapshot('expiry',expiry,expiryRows);assert.equal(await call('expiry','proof-begin',{...expiry,manifest:wrongExpiry}),true);assert.equal(await call('expiry','proof-next',{scope:expiry.scope,attempt:expiry.attempt,index:0}),null);
 const corrupt=await setup('corrupt',1);const good=await makeSnapshot('corrupt',corrupt,corrupt.descriptors);assert.equal(await call('corrupt','proof-begin',{...corrupt,manifest:good}),true);assert.equal(await call('corrupt','corrupt-source',{key:'cls:mail:m0'}),true);assert.equal(await call('corrupt','proof-next',{scope:corrupt.scope,attempt:corrupt.attempt,index:0}),null);
 const done=await setup('done',0,true);const mark=done.descriptors.find(v=>v.key==='done:mail:m0');assert(mark);assert.equal(mark.kind,'state');assert.equal(mark.bytes,1);assert(mark.expiresAt>Date.now());const doneManifest=await makeSnapshot('done',done,done.descriptors);assert.equal(await call('done','proof-begin',{...done,manifest:doneManifest}),true);for(let index=0;index<doneManifest.fragments.length;index++)assert.ok(await call('done','proof-next',{scope:done.scope,attempt:done.attempt,index}));const doneInit={scope:done.scope,job:done.job,generation:done.generation,attempt:done.attempt,sourceId:doneManifest.id,totalRecords:1};assert.equal(await call('done','stage-init',doneInit),true);assert.equal((await call('done','done',{key:'mail:m0',value:false})).revision,2);assert.equal((await fetch(`${base}/stage-output?case=done`,{method:'POST',body:JSON.stringify({scope:done.scope,sourceId:doneManifest.id,generation:1,attempt:done.attempt,page:0,startSequence:0,endSequence:1,final:true,bytes:'synthetic'})})).status,409);
 const expired=await setup('expired-done',0,true);const expiredManifest=await makeSnapshot('expired-done',expired,expired.descriptors);assert.equal(await call('expired-done','proof-begin',{...expired,manifest:expiredManifest}),true);assert.equal(await call('expired-done','expire-done',{key:'mail:m0'}),true);assert.equal(await call('expired-done','proof-next',{scope:expired.scope,attempt:expired.attempt,index:0}),null);
 console.log('Synthetic packed source proof: 500 keyed values, omission/reorder/metadata rejection, CAS, restart and revision fencing passed. Output semantics remain unverified.');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
