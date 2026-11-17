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
import { SyntheticSegmentInventory } from ${JSON.stringify(resolve('src/synthetic-segment-inventory.ts'))};
import { SegmentCompaction } from ${JSON.stringify(resolve('src/synthetic-segment-compaction.ts'))};
import { SegmentedGeneration } from ${JSON.stringify(resolve('src/segmented-generation.ts'))};
import { SegmentedOutputStore } from ${JSON.stringify(resolve('src/segmented-output-store.ts'))};
import { SyntheticLargeSourceProof } from ${JSON.stringify(resolve('src/synthetic-large-source-proof.ts'))};
import { SyntheticSegmentedPrevious } from ${JSON.stringify(resolve('src/synthetic-segmented-previous.ts'))};
import { SyntheticJobContextBinding } from ${JSON.stringify(resolve('src/synthetic-job-context.ts'))};
import { readSyntheticPreviousDigestInTransaction } from ${JSON.stringify(resolve('src/synthetic-job-previous.ts'))};
export class Test {
 constructor(state) {this.storage=state.storage;this.sql=state.storage.sql;this.lease=new RunCoordinator(state);new GenerationStore(state.storage);this.owner=new OwnerState(state.storage);this.gate=new DomainGenerationGate(state.storage);this.binding=new SyntheticJobContextBinding(state.storage);this.compaction=new SegmentCompaction(state.storage);this.segmented=new SegmentedGeneration(state.storage);this.previous=new SyntheticSegmentedPrevious(state.storage,this.segmented);new SegmentedOutputStore(state.storage);const adapter={pinned:(sql,head,pin)=>this.compaction.pinned(head,pin),validInTransaction:(...args)=>this.inventory.validInTransaction(...args),readInTransaction:(...args)=>this.inventory.readInTransaction(...args)};this.source=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:(sql,job,generation)=>this.binding.readInTransaction(sql,job,generation)?.previous},adapter);this.inventory=new SyntheticSegmentInventory(state.storage,(sql,head,source,capturedAt)=>{for(const row of sql.exec('SELECT scope,token FROM trusted_source').toArray())if(this.source.segmentInventoryAuthority(row.scope,row.token)(sql,head,source,capturedAt))return true;return false;});this.large=new SyntheticLargeSourceProof(state.storage,this.source);this.largeStage=new SyntheticJobBoundStage(state.storage,this.large.authority(),'coordinator');this.proof=new SyntheticPackedSourceProof(state.storage,this.source,this.lease.syntheticSnapshots);this.stage=new SyntheticJobBoundStage(state.storage,this.proof.authority());}
 async alarm(){return this.lease.alarm();}
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json();let r;try{
  if(op==='lease'){const res=await this.lease.fetch(new Request('https://internal/acquire',{method:'POST',body:JSON.stringify({owner:d.generation,holder:{at:new Date().toISOString(),job:d.job,driver:'web'}})}));r=await res.json();}
  else if(op==='account')r=this.gate.changeAccount(d.alias,d.identity);
  else if(op==='bump')r=this.gate.bump(d.kind);
  else if(op==='prepare-done'){this.sql.exec('CREATE TABLE IF NOT EXISTS coordinated_incarnations (alias TEXT PRIMARY KEY,version INTEGER NOT NULL)');this.sql.exec("INSERT OR REPLACE INTO coordinated_incarnations VALUES ('mail',1)");this.sql.exec("INSERT OR REPLACE INTO gen_head VALUES (1,'fixture-head')");r=true;}
  else if(op==='done'){const revision=this.sql.exec("SELECT version FROM gen_versions WHERE key='done'").toArray()[0].version;r=this.owner.setDone([d.key],d.value,revision,{head:'fixture-head',accounts:{mail:1}});}
  else if(op==='expire-done'){this.sql.exec('UPDATE owner_done SET expires_at=0 WHERE item=?',d.key);r=true;}
  else if(op==='create'){const context={now:'2026-10-24T06:30:00.000Z',window:{kind:'since'},reclassify:false,test:false,cfg:{query:'in:inbox',maxPerAccount:300,model:'@cf/openai/gpt-oss-120b',fallbackModel:null,timeZone:'Europe/London'}};const b=this.binding.callbacks(context,this.gate.jobBinding(),d.previousProof?this.previous.reader(d.previousProof):readSyntheticPreviousDigestInTransaction);r=new JobStateCore(this.storage,undefined,b.bind,b.checkExisting).create(d);}
  else if(op==='claim')r=new JobStateCore(this.storage).claim(d.job,d.generation,d.token);
  else if(op==='stage-partial')r=await new JobStateCore(this.storage).stage(d.job,d.generation,d.alias,d.token,new TextEncoder().encode(d.data));
  else if(op==='accept')r=new JobStateCore(this.storage).accept(d.job,d.generation,d.alias,d.token,d.hash);
  else if(op==='final')r=new JobStateCore(this.storage).claimFinal(d.job,d.generation,d.token);
  else if(op==='capture')r=this.source.capture(d.scope,d.job,d.generation,d.attempt,d.segment);
  else if(op==='segment-seed'){this.storage.transactionSync(()=>{this.sql.exec('INSERT INTO sgen_committed VALUES (?,NULL,?)',d.head,'digest');this.sql.exec('INSERT OR REPLACE INTO gen_head VALUES (1,?)',d.head);const raw=Uint8Array.from(atob(d.data),c=>c.charCodeAt(0));this.sql.exec('INSERT INTO seg_parts VALUES (?,0,?,?,?)',d.head,d.hash,raw.length,raw.buffer);for(const x of d.index)this.sql.exec('INSERT INTO sgen_index VALUES (?,?,?,?,?,?,?,?)',d.head,x.key,x.ordinal,x.start,x.bytes,x.kind,null,null);});r=true;}
  else if(op==='previous-prepare')r=await this.previous.prepare();
  else if(op==='large-seed') {const mid=new Uint8Array(65536);mid.fill(65);const first=mid.slice();first[0]=91;first[1]=93;const digest=async b=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',b.buffer))].map(n=>n.toString(16).padStart(2,'0')).join('');const hmid=await digest(mid),hfirst=await digest(first);this.storage.transactionSync(()=>{this.sql.exec('INSERT INTO sgen_committed VALUES (?,NULL,?)',d.head,'digest');this.sql.exec('INSERT OR REPLACE INTO gen_head VALUES (1,?)',d.head);for(let i=0;i<512;i++)this.sql.exec('INSERT INTO seg_parts VALUES (?,?,?,?,?)',d.head,i,i===0?hfirst:hmid,65536,i===0?first.buffer:mid.buffer);this.sql.exec("INSERT INTO sgen_index VALUES (?,'runs-index',0,0,2,'put',NULL,NULL)",d.head);this.sql.exec("INSERT INTO sgen_index VALUES (?,'history:mail',1,2,33554430,'put',NULL,NULL)",d.head);});r=true;}
  else if(op==='large-stage-init')r=this.largeStage.initialize(d);
  else if(op==='large-stage-output')r=await stageVerifiedOutputPage(this.largeStage,{...d,bytes:new TextEncoder().encode(d.bytes)});
  else if(op==='large-begin')r=this.large.begin(d.scope,d.job,d.generation,d.attempt);
  else if(op==='large-next')r=await this.large.next(d.scope,d.attempt,d.revision);
  else if(op==='large-root')r=this.large.root(d.scope,d.attempt);
  else if(op==='pin')r=this.compaction.pin(d.head);
  else if(op==='segment-begin')r=this.inventory.begin(d.inventory,d.head,d.source,d.pin,d.capturedAt);
  else if(op==='segment-next')r=await this.inventory.next(d.inventory,d.revision);
  else if(op==='remove-descriptor'){this.sql.exec('DELETE FROM sinv_entries WHERE scope=? AND key=?',d.inventory,d.key);r=true;}
  else if(op==='revoke-pin'){this.compaction.release(d.pin);r=true;}
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
try{await start();const test='large',job=id(),generation=id(),attempt=id(),scope=id(),identity='c'.repeat(64),head=id();await call(test,'large-seed',{head});const previousProof=await call(test,'previous-prepare');assert(previousProof);assert.equal((await call(test,'lease',{job,generation})).ok,true);assert.equal(await call(test,'account',{alias:'mail',identity}),1);assert.equal((await call(test,'create',{job,generation,driver:'web',mailboxes:[{alias:'mail',identity}],previousProof})).ok,true);const step=id();assert.equal((await call(test,'claim',{job,generation,token:step})).kind,'claim');const part=await call(test,'stage-partial',{job,generation,alias:'mail',token:step,data:'partial'});assert.equal(await call(test,'accept',{job,generation,alias:'mail',token:step,hash:part}),true);assert.equal(await call(test,'final',{job,generation,token:attempt}),true);
 const inventory=id(),source=hash('large source'),pinKey={scope:inventory,source};const pin=await call(test,'pin',{head});assert(pin);const captured=await call(test,'capture',{scope,job,generation,attempt,segment:{...pinKey,pin}});assert(captured);assert(await call(test,'segment-begin',{inventory,head,source,pin,capturedAt:captured.at}));let revision=0;while(true){const x=await call(test,'segment-next',{inventory,revision});assert(x);revision=x.revision;if(x.complete)break;}assert(revision>=513);assert(await call(test,'large-begin',{scope,job,generation,attempt}));const stageScope=id();assert.equal(await call(test,'large-stage-init',{scope:stageScope,job,generation,attempt,sourceId:'f'.repeat(64),totalRecords:2}),false);const race=await Promise.all([call(test,'large-next',{scope,attempt,revision:0}),call(test,'large-next',{scope,attempt,revision:0})]);assert.equal(race.filter(Boolean).length,1);revision=1;let root;const wall=[];for(;;){if(revision===200){await stop();await start();}const started=performance.now(),x=await call(test,'large-next',{scope,attempt,revision});wall.push(performance.now()-started);assert(x);revision=x.revision;root=x.root;if(x.complete)break;}assert(revision>=517);assert.equal(await call(test,'large-root',{scope,attempt}),root);assert.equal(await call(test,'large-stage-init',{scope:stageScope,job,generation,attempt,sourceId:root,totalRecords:2}),true);const first=await call(test,'large-stage-output',{scope:stageScope,sourceId:root,generation:1,attempt,page:0,startSequence:0,endSequence:1,final:false,bytes:'synthetic'});assert(first);await call(test,'bump',{kind:'settings'});assert.equal(await call(test,'large-root',{scope,attempt}),null);const rejected=await fetch(`${base}/large-stage-output?case=${test}`,{method:'POST',body:JSON.stringify({scope:stageScope,sourceId:root,generation:1,attempt,page:1,startSequence:1,endSequence:2,final:true,bytes:'synthetic'})});assert.equal(rejected.status,409);
 wall.sort((a,b)=>a-b);console.log('32 MiB proof checkpoint wall time, local HTTP + Workers: p50='+wall[Math.floor(wall.length*.5)].toFixed(2)+'ms p95='+wall[Math.floor(wall.length*.95)].toFixed(2)+'ms; not deployed CPU.');
 console.log('Synthetic 32 MiB segmented source: >512 bounded proof checkpoints, authorized staging, segmented job-start, restart and owner revision fence passed; no production CPU claim.');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
