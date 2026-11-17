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
import { SyntheticTrustedInputStream } from ${JSON.stringify(resolve('src/synthetic-trusted-input-stream.ts'))};
import { SyntheticHistoryArrayDriver } from ${JSON.stringify(resolve('src/synthetic-history-array-driver.ts'))};
export class Test {
 constructor(state) {this.storage=state.storage;this.sql=state.storage.sql;this.lease=new RunCoordinator(state);new GenerationStore(state.storage);this.owner=new OwnerState(state.storage);this.gate=new DomainGenerationGate(state.storage);this.core=new JobStateCore(state.storage,undefined,this.gate.jobBinding());this.source=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:()=>null});this.proof=new SyntheticPackedSourceProof(state.storage,this.source,this.lease.syntheticSnapshots);this.stage=new SyntheticJobBoundStage(state.storage,this.proof.authority());this.stream=new SyntheticTrustedInputStream(state.storage,this.source,this.proof.authority());this.history=new SyntheticHistoryArrayDriver(state.storage,this.stream);}
 async alarm(){return this.lease.alarm();}
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json();let r;try{
  if(op==='lease'){const res=await this.lease.fetch(new Request('https://internal/acquire',{method:'POST',body:JSON.stringify({owner:d.generation,holder:{at:new Date().toISOString(),job:d.job,driver:'web'}})}));r=await res.json();}
  else if(op==='account')r=this.gate.changeAccount(d.alias,d.identity);
  else if(op==='bump')r=this.gate.bump(d.kind);
  else if(op==='done')r=this.owner.setDone([d.key],d.value);
  else if(op==='expire-done'){this.sql.exec('UPDATE owner_done SET expires_at=0 WHERE item=?',d.key);r=true;}
  else if(op==='create')r=this.core.create(d);
  else if(op==='claim')r=this.core.claim(d.job,d.generation,d.token);
  else if(op==='stage-partial')r=await this.core.stage(d.job,d.generation,d.alias,d.token,new TextEncoder().encode(d.data));
  else if(op==='accept')r=this.core.accept(d.job,d.generation,d.alias,d.token,d.hash);
  else if(op==='final')r=this.core.claimFinal(d.job,d.generation,d.token);
  else if(op==='capture')r=this.source.capture(d.scope,d.job,d.generation,d.attempt);
  else if(op==='inventory')r=this.storage.transactionSync(()=>this.source.inventoryPageInTransaction(this.sql,d.scope,d.attempt,d.after,d.limit||1));
  else if(op==='history-start')r=this.history.start(d.id,d.scope,d.attempt,d.sourceId,d.key,d.seq);
  else if(op==='history-step')r=this.history.step(d.id,d.revision);
  else if(op==='history-read')r=this.history.readPage(d.id,d.revision);
  else if(op==='stream-begin')r=this.stream.begin(d);
  else if(op==='stream-next')r=await this.stream.next(d.scope,d.attempt,d.seq);
  else if(op==='stream-read'){const v=this.stream.read(d.scope,d.attempt,d.seq);r=v?{descriptor:v.descriptor,bytes:v.bytes.length}:null;}
  else if(op==='seed-big'){const bytes=new TextEncoder().encode(JSON.stringify(Array.from({length:5000},(_,i)=>({id:i,text:'界'.repeat(630)}))));const chunks=[];for(let i=0;i<bytes.length;i+=65536){const v=bytes.slice(i,i+65536),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',v))].map(x=>x.toString(16).padStart(2,'0')).join(''),data=btoa(Array.from(v,x=>String.fromCharCode(x)).join(''));chunks.push({hash,data,bytes:v.length});}this.storage.transactionSync(()=>{this.sql.exec("INSERT INTO gen_key_heads (key,generation,preparation,kind,expires_at,metadata,chunks) VALUES (?,?,?,'put',NULL,NULL,?)",'history:mail',d.generation,d.preparation,chunks.length);for(let i=0;i<chunks.length;i++)this.sql.exec('INSERT INTO gen_chunks (generation,preparation,key,idx,hash,bytes,data) VALUES (?,?,?,?,?,?,?)',d.generation,d.preparation,'history:mail',i,chunks[i].hash,chunks[i].bytes,chunks[i].data);});r=true;}
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
async function setup(testCase, seedCount=0, done=false, big=false) {
 const job=id(),generation=id(),attempt=id(),scope=id(),identity='b'.repeat(64);
 assert.equal((await call(testCase,'lease',{job,generation})).ok,true);
 assert.equal(await call(testCase,'account',{alias:'mail',identity}),1);
 assert.equal((await call(testCase,'create',{job,generation,driver:'web',mailboxes:[{alias:'mail',identity}]})).ok,true);
 const step=id();assert.equal((await call(testCase,'claim',{job,generation,token:step})).kind,'claim');
 const digest=await call(testCase,'stage-partial',{job,generation,alias:'mail',token:step,data:'synthetic partial'});
 assert.equal(await call(testCase,'accept',{job,generation,alias:'mail',token:step,hash:digest}),true);
 assert.equal(await call(testCase,'final',{job,generation,token:attempt}),true);
 if(big){const chunk=Buffer.from('界'.repeat(21846)).subarray(0,65536);assert.equal(await call(testCase,'seed-big',{generation:id(),preparation:id(),count:145,hash:hash(chunk),bytes:chunk.length,data:chunk.toString('base64')}),true);}
 if(done)assert.equal((await call(testCase,'done',{key:'mail:m0',value:true})).revision,1);
 if(seedCount){const rows=Array.from({length:seedCount},(_,i)=>{const v=Buffer.from('synthetic cache '+i);return {key:'cls:mail:m'+i,hash:hash(v),bytes:v.length,data:v.toString('base64'),expiresAt:Date.now()+3600000,metadata:{arrived:i}}});assert.equal(await call(testCase,'seed',{generation:id(),preparation:id(),rows}),true);}
 assert.ok(await call(testCase,'capture',{scope,job,generation,attempt}));
 const entries=[];let after=null;
 do {const page=await call(testCase,'inventory',{scope,attempt,after,limit:64});assert(page);entries.push(...page.entries);after=page.next;} while(after!==null);
 const descriptors=entries.map(({cursor,...entry})=>entry);
 return {scope,job,generation,attempt,entries,descriptors};
}
async function makeSnapshot(testCase,context,descriptors){
 const packs=[];let pack=[],size=0;for(const d of descriptors){if(pack.length===16||size+d.bytes>65536){packs.push(pack);pack=[];size=0;}pack.push(d);size+=d.bytes;}if(pack.length)packs.push(pack);const fragments=packs.map(p=>Buffer.from(JSON.stringify(p)));
 const parts=fragments.map(v=>({sha256:hash(v),bytes:v.length})),totalBytes=parts.reduce((a,v)=>a+v.bytes,0);
 const manifest={version:1,id:hash(JSON.stringify([1,totalBytes,parts.map(v=>[v.sha256,v.bytes])])),totalBytes,fragments:parts};
 assert.equal(await call(testCase,'snapshot-create',{generation:context.generation,manifest}),true);
 for(let index=0;index<fragments.length;index++)assert.equal(await call(testCase,'snapshot-put',{generation:context.generation,sourceId:manifest.id,index,data:fragments[index].toString('base64')}),true);
 assert.equal(await call(testCase,'snapshot-seal',{generation:context.generation,sourceId:manifest.id}),true);
 return manifest;
}
try {
 await start();
 const c=await setup('large',0,false,true),manifest=await makeSnapshot('large',c,c.descriptors);
 assert(manifest.fragments.length<=160);assert.equal(await call('large','proof-begin',{...c,manifest}),true);
 for(let i=0;i<manifest.fragments.length;i++)assert.ok(await call('large','proof-next',{scope:c.scope,attempt:c.attempt,index:i}));
 const binding={scope:c.scope,job:c.job,generation:c.generation,attempt:c.attempt,sourceId:manifest.id};assert.equal(await call('large','stream-begin',binding),true);
 assert.equal(await call('large','stream-read',{scope:c.scope,attempt:c.attempt,seq:0}),null);
 let total=0;for(let i=0;i<c.descriptors.length;i++){if(i===70){await stop();await start();assert.equal(await call('large','stream-begin',binding),true);}const progress=await call('large','stream-next',{scope:c.scope,attempt:c.attempt,seq:i});assert(progress);assert.equal(progress.next,i+1);assert.equal(progress.complete,i===c.descriptors.length-1);total=progress.bytes;}
 assert(total>=9*1024*1024);const first=await call('large','stream-read',{scope:c.scope,attempt:c.attempt,seq:0});assert(first);assert.equal(await call('large','stream-next',{scope:c.scope,attempt:c.attempt,seq:0}),null);
 const startIndex=c.descriptors.findIndex(x=>x.key==='history:mail'&&x.index===0),driver=id();assert(startIndex>=0);assert.equal(await call('large','history-start',{id:driver,...binding,key:'history:mail',seq:startIndex}),true);
 let step=0,done=false;while(!done){const p=await call('large','history-step',{id:driver,revision:step});assert(p);step++;done=p.done;if(step===30){await stop();await start();}assert(step<5000);}let records=0;for(let i=0;i<step;i++){const page=await call('large','history-read',{id:driver,revision:i});assert(page);for(const v of page){assert.equal(v.id,records++);assert.equal(v.text,'界'.repeat(630));}}assert.equal(records,5000);console.log(`Decoded ${records} synthetic Unicode records across ${step} checkpointed steps with exact parity`);
 await call('large','bump',{kind:'done'});assert.equal(await call('large','stream-read',{scope:c.scope,attempt:c.attempt,seq:0}),null);assert.equal(await call('large','history-read',{id:driver,revision:0}),null);
 console.log(`Actual source + packed proof streamed ${total} synthetic CJK bytes in ${c.descriptors.length} bounded steps; restart, replay and revision fencing passed`);
}finally{await stop();await rm(dir,{recursive:true,force:true});}
