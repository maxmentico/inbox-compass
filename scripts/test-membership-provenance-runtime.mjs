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
import { CoordinatedAccounts } from ${JSON.stringify(resolve('src/coordinated-accounts.ts'))};
import { SyntheticPartialDriver } from ${JSON.stringify(resolve('src/synthetic-partial-driver.ts'))};
import { SyntheticMembershipProvenance } from ${JSON.stringify(resolve('src/synthetic-membership-provenance.ts'))};
export class Test {
 constructor(state) {this.storage=state.storage;this.sql=state.storage.sql;this.lease=new RunCoordinator(state);new GenerationStore(state.storage);this.accounts=new CoordinatedAccounts(state.storage);this.owner=new OwnerState(state.storage);this.gate=new DomainGenerationGate(state.storage);this.core=new JobStateCore(state.storage,undefined,this.gate.jobBinding());this.source=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:()=>null});this.proof=new SyntheticPackedSourceProof(state.storage,this.source,this.lease.syntheticSnapshots);this.stage=new SyntheticJobBoundStage(state.storage,this.proof.authority());this.driver=new SyntheticPartialDriver(state.storage,this.source,this.proof);this.provenance=new SyntheticMembershipProvenance(state.storage,this.driver,this.source,()=>null);}
 async alarm(){return this.lease.alarm();}
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json();let r;try{
  if(op==='lease'){const res=await this.lease.fetch(new Request('https://internal/acquire',{method:'POST',body:JSON.stringify({owner:d.generation,holder:{at:new Date().toISOString(),job:d.job,driver:'web'}})}));r=await res.json();}
  else if(op==='account')r=this.gate.changeAccount(d.alias,d.identity);
  else if(op==='link')r=await this.accounts.link(d.record,d.identity,0,0);
  else if(op==='bump')r=this.gate.bump(d.kind);
  else if(op==='done')r=this.owner.setDone([d.key],d.value);
  else if(op==='expire-done'){this.sql.exec('UPDATE owner_done SET expires_at=0 WHERE item=?',d.key);r=true;}
  else if(op==='create')r=this.core.create(d);
  else if(op==='claim')r=this.core.claim(d.job,d.generation,d.token);
  else if(op==='stage-partial')r=await this.core.stage(d.job,d.generation,d.alias,d.token,new TextEncoder().encode(d.data));
  else if(op==='stage-chunk')r=await this.core.stageChunk(d.job,d.generation,d.alias,d.token,d.index,d.total,Uint8Array.from(atob(d.data),c=>c.charCodeAt(0)));
  else if(op==='accept-chunks')r=await this.core.acceptChunks(d.job,d.generation,d.alias,d.token,d.refs);
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
  else if(op==='origin-index')r=this.provenance.indexPartialPage(d.id,d.page);
  else if(op==='origin')r=this.storage.transactionSync(()=>this.provenance.authority()(this.sql,d.job,d.generation,d.attempt,d.sourceId,d.alias,d.message,d.incarnation));
  else if(op==='change-incarnation'){this.sql.exec('UPDATE coordinated_incarnations SET version=? WHERE alias=?',d.value,d.alias);r=true;}
  else if(op==='tamper-origin-page'){const row=this.sql.exec("SELECT driver,page FROM membership_partial_origin WHERE job=? AND alias=? AND message=?",d.job,d.alias,d.message).toArray()[0];this.sql.exec("UPDATE synthetic_partial_pages SET payload='[]' WHERE id=? AND revision=?",row.driver,row.page);r=true;}
  else if(op==='driver-start')r=this.driver.start(d.id,d.scope,d.attempt,d.sourceId,d.alias);
  else if(op==='driver-step')r=await this.driver.step(d.id,d.revision);
  else if(op==='driver-loop'){let rev=d.revision,done=false;for(let i=0;i<d.limit;i++){const x=await this.driver.step(d.id,rev);if(!x){r=null;break;}rev=x.revision;done=x.elementsDone;if(done)break;}if(r!==null)r={revision:rev,elementsDone:done};}
  else if(op==='driver-counts'){const rows=this.sql.exec("SELECT json_extract(j.value,'$.kind') AS kind, COUNT(*) AS n FROM synthetic_partial_pages p,json_each(p.payload) j WHERE p.id=? GROUP BY kind",d.id).toArray();r=rows;}
  else if(op==='driver-inject'){this.sql.exec("CREATE TRIGGER fail_driver BEFORE UPDATE ON synthetic_partial_driver BEGIN SELECT RAISE(ABORT,'injected'); END");r=true;}
  else if(op==='driver-uninject'){this.sql.exec('DROP TRIGGER fail_driver');r=true;}
  else if(op==='driver-raw')r={pages:this.sql.exec('SELECT COUNT(*) AS n FROM synthetic_partial_pages WHERE id=?',d.id).toArray()[0].n,revision:this.sql.exec('SELECT revision FROM synthetic_partial_driver WHERE id=?',d.id).toArray()[0]?.revision??null};
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
async function setup(testCase, partial) {
 const job=id(),generation=id(),attempt=id(),scope=id(),identity=hash('mail@example.com');
 assert.equal((await call(testCase,'lease',{job,generation})).ok,true);
 const record={alias:'mail',email:'mail@example.com',scopes:[],sealedRefreshToken:'v1.'+'a'.repeat(16)+'.'+'b'.repeat(22),linkedAt:'2026-10-24T06:00:00Z'};
 assert.equal(await call(testCase,'link',{record,identity}),1);
 assert.equal((await call(testCase,'create',{job,generation,driver:'web',mailboxes:[{alias:'mail',identity}]})).ok,true);
 const step=id();assert.equal((await call(testCase,'claim',{job,generation,token:step})).kind,'claim');
 const raw=Buffer.from(JSON.stringify(partial)),chunks=Array.from({length:Math.ceil(raw.length/(48*1024))},(_,i)=>raw.subarray(i*48*1024,(i+1)*48*1024));assert(chunks.length<=160);
 const refs=[];for(let index=0;index<chunks.length;index++)refs.push(await call(testCase,'stage-chunk',{job,generation,alias:'mail',token:step,index,total:chunks.length,data:chunks[index].toString('base64')}));
 assert(await call(testCase,'accept-chunks',{job,generation,alias:'mail',token:step,refs}));
 assert.equal(await call(testCase,'final',{job,generation,token:attempt}),true);
 assert.ok(await call(testCase,'capture',{scope,job,generation,attempt}));
 const entries=[];let after=null;
 do {const page=await call(testCase,'inventory',{scope,attempt,after,limit:64});assert(page);entries.push(...page.entries);after=page.next;} while(after!==null);
 const descriptors=entries.map(({cursor,...entry})=>entry);
 return {scope,job,generation,attempt,entries,descriptors};
}
async function makeSnapshot(testCase,context,descriptors){
 const groups=[];let group=[],sourceBytes=0;for(const entry of descriptors){if(group.length&&(group.length===16||sourceBytes+entry.bytes>64*1024)){groups.push(group);group=[];sourceBytes=0;}group.push(entry);sourceBytes+=entry.bytes;}if(group.length)groups.push(group);const fragments=groups.map(group=>Buffer.from(JSON.stringify(group)));
 const parts=fragments.map(v=>({sha256:hash(v),bytes:v.length})),totalBytes=parts.reduce((a,v)=>a+v.bytes,0);
 const manifest={version:1,id:hash(JSON.stringify([1,totalBytes,parts.map(v=>[v.sha256,v.bytes])])),totalBytes,fragments:parts};
 assert.equal(await call(testCase,'snapshot-create',{generation:context.generation,manifest}),true);
 for(let index=0;index<fragments.length;index++)assert.equal(await call(testCase,'snapshot-put',{generation:context.generation,sourceId:manifest.id,index,data:fragments[index].toString('base64')}),true);
 assert.equal(await call(testCase,'snapshot-seal',{generation:context.generation,sourceId:manifest.id}),true);
 return manifest;
}
const item=(i)=>({key:`mail:m${i}`,account:'mail',accountEmail:'mail@example.com',messageId:`m${i}`,threadId:`t${i}`,from:'sender@example.com',subject:`消息 ${i}`,snippet:'摘要',date:'2026-10-24T06:00:00Z',needsAction:true,action:'Review',urgency:'medium',category:'task',due:null,summary:'Summary',classified:true,done:false});
const history=(i)=>({id:`h${i}`,address:'sender@example.com',domain:'example.com',name:'Sender',subject:`历史记录 ${i}`,shape:[],addressing:'only_you',tab:'primary',important:false,starred:false,conversation:false,attachment:false,flags:[],answers:{sender:'person',request:'direct',stakes:'some',category:'task'},date:null});
const partial=(items,histories)=>({alias:'mail',status:{alias:'mail',email:'mail@example.com',ok:true,found:items,newlyClassified:items},items:Array.from({length:items},(_,i)=>item(i)),toCache:[],learned:[],history:Array.from({length:histories},(_,i)=>history(i)),recheck:{before:[],settled:[],estimated:[]},run:{before:null,seenTimes:[],backlog:false},surfaced:[],replacedCarried:[],errors:[],estimated:0,fromHistory:0});
try{await start();const main=await setup('main',partial(2,0)),manifest=await makeSnapshot('main',main,main.descriptors);assert(await call('main','proof-begin',{...main,manifest}));for(let i=0;i<manifest.fragments.length;i++)assert(await call('main','proof-next',{scope:main.scope,attempt:main.attempt,index:i}));const driver=id();assert(await call('main','driver-start',{id:driver,scope:main.scope,attempt:main.attempt,sourceId:manifest.id,alias:'mail'}));let revision=0,done=false;while(!done){const r=await call('main','driver-loop',{id:driver,revision,limit:16});assert(r);revision=r.revision;done=r.elementsDone;}for(let page=0;page<revision;page++)assert(await call('main','origin-index',{id:driver,page}));const args={job:main.job,generation:main.generation,attempt:main.attempt,sourceId:manifest.id,alias:'mail',message:'m0',incarnation:1};assert.equal(await call('main','origin',args),true);assert.equal(await call('main','origin',{...args,message:'unknown'}),false);assert.equal(await call('main','origin',{...args,incarnation:2}),false);await stop();await start();assert.equal(await call('main','origin',args),true);await call('main','tamper-origin-page',args);assert.equal(await call('main','origin',args),false);await call('main','change-incarnation',{alias:'mail',value:2});assert.equal(await call('main','origin',{...args,message:'m1',incarnation:2}),false);console.log('Synthetic membership provenance: actual accepted partial, restart, unknown message, tamper and relink rejected; prior membership not yet tested.');}finally{await stop();await rm(dir,{recursive:true,force:true});}
