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
import { SyntheticJobContextBinding } from ${JSON.stringify(resolve('src/synthetic-job-context.ts'))};
import { SyntheticStepResultStore } from ${JSON.stringify(resolve('src/synthetic-step-result.ts'))};
import { readSyntheticPreviousDigestInTransaction } from ${JSON.stringify(resolve('src/synthetic-job-previous.ts'))};
import { SyntheticTrustedInputReader } from ${JSON.stringify(resolve('src/synthetic-trusted-input-reader.ts'))};
import { SyntheticBoundedReferenceLoader } from ${JSON.stringify(resolve('src/synthetic-bounded-reference-loader.ts'))};
import { projectDomainReferenceWithWrites } from ${JSON.stringify(resolve('src/domain-reference-projection.ts'))};
import { digestConfig } from ${JSON.stringify(resolve('src/config.ts'))};
import { SyntheticStepSummaryVerifier } from ${JSON.stringify(resolve('src/synthetic-step-summary-verifier.ts'))};
import { prepareAssembly,buildAssemblyManifest,applySettings } from ${JSON.stringify(resolve('src/digest.ts'))};
import { DEFAULT_SETTINGS } from ${JSON.stringify(resolve('src/rules.ts'))};
export class Test {
 constructor(state) {this.storage=state.storage;this.sql=state.storage.sql;this.lease=new RunCoordinator(state);new GenerationStore(state.storage);this.accounts=new CoordinatedAccounts(state.storage);this.owner=new OwnerState(state.storage);this.gate=new DomainGenerationGate(state.storage);this.contexts=new SyntheticJobContextBinding(state.storage);this.results=new SyntheticStepResultStore(state.storage);this.core=new JobStateCore(state.storage,undefined,undefined,undefined,this.results.binding(),this.results.claimBinding());this.source=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:(sql,job,generation)=>this.contexts.readInTransaction(sql,job,generation)?.previous});this.proof=new SyntheticPackedSourceProof(state.storage,this.source,this.lease.syntheticSnapshots);this.stage=new SyntheticJobBoundStage(state.storage,this.proof.authority());this.driver=new SyntheticPartialDriver(state.storage,this.source,this.proof);this.verifier=new SyntheticStepSummaryVerifier(state.storage,this.driver,this.contexts,this.results);}
 async alarm(){return this.lease.alarm();}
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json();let r;try{
  if(op==='lease'){const res=await this.lease.fetch(new Request('https://internal/acquire',{method:'POST',body:JSON.stringify({owner:d.generation,holder:{at:new Date().toISOString(),job:d.job,driver:'web'}})}));r=await res.json();}
  else if(op==='account')r=this.gate.changeAccount(d.alias,d.identity);
  else if(op==='link')r=await this.accounts.link(d.record,d.identity,0,0);
  else if(op==='bump')r=this.gate.bump(d.kind);
  else if(op==='done')r=this.owner.setDone([d.key],d.value);
  else if(op==='expire-done'){this.sql.exec('UPDATE owner_done SET expires_at=0 WHERE item=?',d.key);r=true;}
  else if(op==='create'){const callbacks=this.contexts.callbacks({now:'2026-10-24T06:30:00.000Z',window:{kind:'since'},reclassify:false,test:false,cfg:digestConfig({})},this.gate.jobBinding(),readSyntheticPreviousDigestInTransaction);r=new JobStateCore(this.storage,undefined,callbacks.bind,callbacks.checkExisting,this.results.binding()).create(d);}
  else if(op==='summary-start')r=this.verifier.start(d.id,d.driver);
  else if(op==='summary-step')r=this.verifier.step(d.id,d.revision);
  else if(op==='summary-finish')r=this.verifier.finish(d.id);
  else if(op==='summary-compute'){const items=structuredClone(d.partial.items),decided=applySettings({id:'2026-10-24T06:30:00Z',date:'2026-10-24',generatedAt:'2026-10-24T06:30:00.000Z',model:'',query:'',items,accounts:[],modelErrors:[]},DEFAULT_SETTINGS),fresh=decided.items.filter(x=>!x.carried);r={fresh:fresh.length,toAction:fresh.filter(x=>x.needsAction).length,estimated:d.partial.estimated};}
  else if(op==='result-stage')r=this.results.stage(d.job,d.generation,d.alias,d.token,d.result);
  else if(op==='project'){const reader=new SyntheticTrustedInputReader(this.storage,this.source,this.proof.authority(),d.largeInput?12*1024*1024:undefined);const loader=new SyntheticBoundedReferenceLoader(this.storage,this.source,reader,this.contexts,this.results,{scope:d.scope,attempt:d.attempt,sourceId:d.sourceId},(sql,job,generation,alias,value)=>(!!d.verifier&&this.verifier.authority(d.verifier)(sql,job,generation,alias,value))||this.results.timeoutAuthority()(sql,job,generation,alias,value),d.compact?{driver:this.driver,ids:{mail:d.driver}}:undefined);const p=await projectDomainReferenceWithWrites(loader,d.job,d.generation);r=p.writes;}
  else if(op==='reference'){const saved=this.storage.transactionSync(()=>this.contexts.readInTransaction(this.sql,d.job,d.generation)),captured=this.source.describe(d.scope,d.attempt);const context={opts:{window:{kind:'since'},reclassify:false,test:false},window:{kind:'since'},now:new Date(saved.now),test:false,cfg:saved.cfg,date:saved.date,settings:DEFAULT_SETTINGS,accounts:[{alias:'mail',email:'mail@example.com'}],share:300,fullShare:300,open:[],openIfUnticked:[],ticked:new Set(),jobId:d.job,jobRunId:saved.run};const partial=d.partial;const summaryItems=structuredClone(partial.items),summaryDecided=applySettings({id:saved.run,date:saved.date,generatedAt:saved.now,model:'',query:'',items:summaryItems,accounts:[],modelErrors:[]},DEFAULT_SETTINGS),fresh=summaryDecided.items.filter(x=>!x.carried),summary={fresh:fresh.length,toAction:fresh.filter(x=>x.needsAction).length,estimated:partial.estimated};const prepared=await prepareAssembly({},context,[partial],{doneKeys:new Set()});const result={job:d.job,digest:saved.run,driver:'web',test:false,rows:[{alias:'mail',state:'done',summary}],started:saved.started,finished:captured.at};r=buildAssemblyManifest(context,[partial],prepared,{lastRun:'2026-10-23T06:30:00Z',indexedRuns:['2026-10-23T06:30:00Z'],cursors:{mail:null},failureHolds:{mail:null},histories:{mail:partial.history}},{id:d.job,result},{operations:1000,bytes:32*1024*1024}).writes;}
  else if(op==='genhead'){this.sql.exec('INSERT OR REPLACE INTO gen_head VALUES (1,?)',d.generation);r=true;}
  else if(op==='claim')r=this.core.claim(d.job,d.generation,d.token);
  else if(op==='stage-partial')r=await this.core.stage(d.job,d.generation,d.alias,d.token,new TextEncoder().encode(d.data));
  else if(op==='stage-chunk')r=await this.core.stageChunk(d.job,d.generation,d.alias,d.token,d.index,d.total,Uint8Array.from(atob(d.data),c=>c.charCodeAt(0)));
  else if(op==='accept-chunks')r=await this.core.acceptChunks(d.job,d.generation,d.alias,d.token,d.refs);
  else if(op==='accept')r=this.core.accept(d.job,d.generation,d.alias,d.token,d.hash);
  else if(op==='giveup')r=this.core.giveUp(d.job,d.generation,d.alias);
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
  else if(op==='driver-start')r=this.driver.start(d.id,d.scope,d.attempt,d.sourceId,d.alias);
  else if(op==='driver-step')r=await this.driver.step(d.id,d.revision);
  else if(op==='driver-loop'){let rev=d.revision,done=false;for(let i=0;i<d.limit;i++){const x=await this.driver.step(d.id,rev);if(!x){r=null;break;}rev=x.revision;done=x.elementsDone;if(done)break;}if(r!==null)r={revision:rev,elementsDone:done};}
  else if(op==='driver-counts'){const rows=this.sql.exec("SELECT json_extract(j.value,'$.kind') AS kind, COUNT(*) AS n FROM synthetic_partial_pages p,json_each(p.payload) j WHERE p.id=? GROUP BY kind",d.id).toArray();r=rows;}
  else if(op==='driver-item-page')r=this.sql.exec("SELECT p.revision FROM synthetic_partial_pages p,json_each(p.payload) j WHERE p.id=? AND json_extract(j.value,'$.kind')='item' AND json_extract(j.value,'$.messageId')=?",d.id,d.messageId).toArray()[0]?.revision??null;
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
 const seedRows=partial._fixtureState??[];delete partial._fixtureState;if(seedRows.length){const gen=id(),prep=id();await call(testCase,'genhead',{generation:gen});await call(testCase,'seed',{generation:gen,preparation:prep,rows:seedRows.map(([key,value])=>{const v=Buffer.from(value);return {key,hash:hash(v),bytes:v.length,data:v.toString('base64'),expiresAt:null,metadata:null};})});}assert.equal((await call(testCase,'create',{job,generation,driver:'web',mailboxes:[{alias:'mail',identity}]})).ok,true);
 const step=id();assert.equal((await call(testCase,'claim',{job,generation,token:step})).kind,'claim');
 const summary=await call(testCase,'summary-compute',{partial});assert.equal(await call(testCase,'result-stage',{job,generation,alias:'mail',token:step,result:{state:'done',summary}}),true);const raw=Buffer.from(JSON.stringify(partial)),chunks=Array.from({length:Math.ceil(raw.length/(64*1024))},(_,i)=>raw.subarray(i*64*1024,(i+1)*64*1024));assert(chunks.length<=160);
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
async function certify(testCase,context,manifest){const driver=id();assert.equal(await call(testCase,'driver-start',{id:driver,scope:context.scope,attempt:context.attempt,sourceId:manifest.id,alias:'mail'}),true);let revision=0,done=false;while(!done){const p=await call(testCase,'driver-loop',{id:driver,revision,limit:16});assert(p);revision=p.revision;done=p.elementsDone;}const a=await call(testCase,'driver-item-page',{id:driver,messageId:'m0'}),b=await call(testCase,'driver-item-page',{id:driver,messageId:'m17'});assert.notEqual(a,b);const verifier=id();assert.equal(await call(testCase,'summary-start',{id:verifier,driver}),true);for(let page=0;page<revision;page++)assert(await call(testCase,'summary-step',{id:verifier,revision:page}));assert.equal(await call(testCase,'summary-finish',{id:verifier}),true);return {verifier,driver};}
async function setupTimeout(testCase){const job=id(),generation=id(),attempt=id(),scope=id(),identity=hash('mail@example.com');assert.equal((await call(testCase,'lease',{job,generation})).ok,true);const record={alias:'mail',email:'mail@example.com',scopes:[],sealedRefreshToken:'v1.'+'a'.repeat(16)+'.'+'b'.repeat(22),linkedAt:'2026-10-24T06:00:00Z'};assert.equal(await call(testCase,'link',{record,identity}),1);assert.equal((await call(testCase,'create',{job,generation,driver:'web',mailboxes:[{alias:'mail',identity}]})).ok,true);assert.equal(await call(testCase,'giveup',{job,generation,alias:'mail'}),true);assert.equal(await call(testCase,'final',{job,generation,token:attempt}),true);assert.ok(await call(testCase,'capture',{scope,job,generation,attempt}));const entries=[];let after=null;do{const p=await call(testCase,'inventory',{scope,attempt,after,limit:64});assert(p);entries.push(...p.entries);after=p.next;}while(after!==null);return{scope,job,generation,attempt,descriptors:entries.map(({cursor,...v})=>v)};}
const item=(i)=>({key:`mail:m${i}`,account:'mail',accountEmail:'mail@example.com',messageId:`m${i}`,threadId:`t${i}`,from:'sender@example.com',subject:`消息 ${i}`,snippet:'摘要',date:'2026-10-24T06:00:00Z',needsAction:true,action:'Review',urgency:'medium',category:'task',due:null,summary:'Summary',classified:true,done:false});
const history=(i)=>({id:`h${i}`,address:'sender@example.com',domain:'example.com',name:'Sender',subject:`历史记录 ${i}`,shape:[],addressing:'only_you',tab:'primary',important:false,starred:false,conversation:false,attachment:false,flags:[],answers:{sender:'person',request:'direct',stakes:'some',category:'task'},date:null});
const partial=(items,histories)=>({alias:'mail',status:{alias:'mail',email:'mail@example.com',ok:true,found:items,newlyClassified:items},items:Array.from({length:items},(_,i)=>item(i)),toCache:[],learned:[],history:Array.from({length:histories},(_,i)=>history(i)),recheck:{before:[],settled:[],estimated:[]},run:{before:null,seenTimes:[],backlog:false},surfaced:[],replacedCarried:[],errors:[],estimated:0,fromHistory:0});
try {
 await start();const old='2026-10-23T06:30:00Z';const prev={id:old,date:'2026-10-23',generatedAt:'2026-10-23T06:30:00.000Z',model:'synthetic',query:'in:inbox',items:[],accounts:[],modelErrors:[]};const fixture=partial(20,3);fixture.items[1].classified=false;for(const i of [0,17]){fixture.items[i].threadId='shared';fixture.items[i].decision={outcome:'action',because:[],urgency:'medium'};}fixture._fixtureState=[['last-run',old],['runs-index',JSON.stringify([old])],['digest:'+old,JSON.stringify(prev)]];
 const main=await setup('main',fixture),manifest=await makeSnapshot('main',main,main.descriptors);assert.equal(await call('main','proof-begin',{...main,manifest}),true);for(let index=0;index<manifest.fragments.length;index++)assert.ok(await call('main','proof-next',{scope:main.scope,attempt:main.attempt,index}));
 const cert=await certify('main',main,manifest);const input={...main,sourceId:manifest.id,...cert};const writes=await call('main','project',input);assert(Array.isArray(writes));assert(writes.some(x=>x.key==='digest:2026-10-24T06:30:00Z'));assert(writes.some(x=>x.key==='job-result:'+main.job));assert(writes.some(x=>x.key==='job-done:'+main.job));assert(writes.some(x=>x.key==='failures:mail'));const expected=await call('main','reference',{...input,partial:fixture});assert.deepEqual(writes,expected);
 await stop();await start();assert.deepEqual(await call('main','project',input),writes);await call('main','bump',{kind:'settings'});const stale=await fetch(`${base}/project?case=main`,{method:'POST',body:JSON.stringify(input)});assert.equal(stale.status,409);
 const large=partial(500,5000);large.items[1].classified=false;for(const i of [0,17]){large.items[i].threadId='shared';large.items[i].decision={outcome:'action',because:[],urgency:'medium'};}large._fixtureState=[['last-run',old],['runs-index',JSON.stringify([old])],['digest:'+old,JSON.stringify(prev)]];const big=await setup('large',large),bigManifest=await makeSnapshot('large',big,big.descriptors);assert.equal(await call('large','proof-begin',{...big,manifest:bigManifest}),true);for(let index=0;index<bigManifest.fragments.length;index++)assert.ok(await call('large','proof-next',{scope:big.scope,attempt:big.attempt,index}));const bigCert=await certify('large',big,bigManifest);const bigInput={...big,sourceId:bigManifest.id,...bigCert},bigWrites=await call('large','project',bigInput),bigExpected=await call('large','reference',{...bigInput,partial:large});assert.deepEqual(bigWrites,bigExpected);assert(bigWrites.some(x=>x.key==='failures:mail'));
 const full=partial(500,5000);full.learned=[full.history[0],full.history[4999],{...full.history[7],id:'new-history'}];for(const entry of full.history)entry.subject='史'.repeat(150);for(const it of full.items){it.text='界'.repeat(3000);it.snippet='界'.repeat(1000);}for(const i of [0,17]){full.items[i].threadId='shared';full.items[i].decision={outcome:'action',because:[],urgency:'medium'};}full._fixtureState=[['last-run',old],['runs-index',JSON.stringify([old])],['digest:'+old,JSON.stringify(prev)]];const fullCase=await setup('full-unicode',full),fullManifest=await makeSnapshot('full-unicode',fullCase,fullCase.descriptors);assert.equal(await call('full-unicode','proof-begin',{...fullCase,manifest:fullManifest}),true);for(let index=0;index<fullManifest.fragments.length;index++)assert.ok(await call('full-unicode','proof-next',{scope:fullCase.scope,attempt:fullCase.attempt,index}));const fullCert=await certify('full-unicode',fullCase,fullManifest),fullInput={...fullCase,sourceId:fullManifest.id,...fullCert};const defaultLimit=await fetch(`${base}/project?case=full-unicode`,{method:'POST',body:JSON.stringify(fullInput)});assert.equal(defaultLimit.status,409);const fullWrites=await call('full-unicode','project',{...fullInput,compact:true}),fullExpected=await call('full-unicode','reference',{...fullInput,partial:full});assert.deepEqual(fullWrites,fullExpected);
 const timed=await setupTimeout('timeout'),timedManifest=await makeSnapshot('timeout',timed,timed.descriptors);assert.equal(await call('timeout','proof-begin',{...timed,manifest:timedManifest}),true);for(let i=0;i<timedManifest.fragments.length;i++)assert.ok(await call('timeout','proof-next',{scope:timed.scope,attempt:timed.attempt,index:i}));const timedWrites=await call('timeout','project',{...timed,sourceId:timedManifest.id});const timedResult=JSON.parse(timedWrites.find(w=>w.key==='job-result:'+timed.job).value);assert.deepEqual(timedResult.rows,[{alias:'mail',state:'failed',reason:'took too long'}]);
 console.log(`Synthetic source-bound reference parity: ${Buffer.byteLength(JSON.stringify(full))} bytes for 500 Unicode messages and 5000 history entries, with source-proven bounded history reduction. This experiment does not establish a JS heap limit.`);
}finally{await stop();await rm(dir,{recursive:true,force:true});}
