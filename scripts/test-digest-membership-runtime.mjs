// SYNTHETIC local Workers/SQLite test. The expected reference is a test stub, not a real projector.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const dir=await mkdtemp(join(tmpdir(),'segment-cert-')),port=20000+process.pid%20000,base=`http://127.0.0.1:${port}`;
const id=()=>randomBytes(16).toString('base64url'),sourceId='a'.repeat(64);
await writeFile(join(dir,'entry.ts'),`import {SegmentedOutputStore} from ${JSON.stringify(resolve('src/segmented-output-store.ts'))};
import {SegmentedGeneration} from ${JSON.stringify(resolve('src/segmented-generation.ts'))};
import {SyntheticSegmentCertificate} from ${JSON.stringify(resolve('src/synthetic-segment-certificate.ts'))};
import {SyntheticDigestMembership} from ${JSON.stringify(resolve('src/synthetic-digest-membership.ts'))};
import {OwnerState} from ${JSON.stringify(resolve('src/owner-state.ts'))};
export class Test {
 constructor(state){this.sql=state.storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS ref_header (id TEXT PRIMARY KEY, value TEXT NOT NULL, active INTEGER NOT NULL)');this.sql.exec('CREATE TABLE IF NOT EXISTS ref_ops (id TEXT NOT NULL, ordinal INTEGER NOT NULL, meta TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(id,ordinal))');
  this.source={current:(sql,_scope,_attempt,id)=>!!sql.exec('SELECT id FROM ref_header WHERE id=? AND active=1',id).toArray().length,header:(sql,_scope,_attempt,id)=>{const row=sql.exec('SELECT value FROM ref_header WHERE id=? AND active=1',id).toArray()[0];return row?JSON.parse(row.value):null;},op:(sql,_scope,_attempt,id,index)=>{const row=sql.exec('SELECT meta FROM ref_ops WHERE id=? AND ordinal=?',id,index).toArray()[0];return row?JSON.parse(row.meta):null;},bytes:(sql,_scope,_attempt,id,index,offset,length)=>{const row=sql.exec('SELECT substr(value,?,?) AS part FROM ref_ops WHERE id=? AND ordinal=?',offset+1,length,id,index).toArray()[0];return row?new Uint8Array(row.part):null;}};
  this.transport=new SegmentedOutputStore(state.storage,()=>true);this.generation=new SegmentedGeneration(state.storage,()=>true);this.cert=new SyntheticSegmentCertificate(state.storage,this.source);this.withoutReference=new SyntheticSegmentCertificate(state.storage);this.members=new SyntheticDigestMembership(state.storage,this.source,this.cert.proof(),()=>true);this.owner=new OwnerState(state.storage,this.members.membership());this.publishing=new SegmentedGeneration(state.storage,()=>true,this.cert.proof());this.sql.exec('CREATE TABLE IF NOT EXISTS coordinated_accounts (alias TEXT PRIMARY KEY,value TEXT,purge_pending INTEGER NOT NULL)');this.sql.exec('CREATE TABLE IF NOT EXISTS coordinated_incarnations (alias TEXT PRIMARY KEY,version INTEGER NOT NULL)');this.sql.exec('CREATE TABLE IF NOT EXISTS domain_accounts (alias TEXT PRIMARY KEY,identity TEXT,epoch INTEGER NOT NULL)');this.sql.exec('CREATE TABLE IF NOT EXISTS domain_job_accounts (job TEXT,alias TEXT,identity TEXT,epoch INTEGER,PRIMARY KEY(job,alias))'); }
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json();let r;try{
  if(op==='account'){this.sql.exec('INSERT INTO coordinated_accounts VALUES (?,?,0)',d.alias,JSON.stringify({email:d.email,sealedRefreshToken:'synthetic-not-exposed'}));this.sql.exec('INSERT INTO coordinated_incarnations VALUES (?,1)',d.alias);this.sql.exec('INSERT INTO domain_accounts VALUES (?,?,1)',d.alias,d.identity);this.sql.exec('INSERT INTO domain_job_accounts VALUES (?,?,?,1)',d.job,d.alias,d.identity);r=true;}
  else if(op==='delete-digest'){this.sql.exec("DELETE FROM sgen_index WHERE scope=? AND key=?",d.head,'digest:'+d.digest);r=true;}
  else if(op==='expire-digest'){this.sql.exec("UPDATE synthetic_membership_heads SET expires_at=0 WHERE head=?",d.head);this.sql.exec("UPDATE sgen_index SET expires_at=0 WHERE scope=? AND key=?",d.head,'digest:'+d.digest);r=true;}
  else if(op==='set-head'){this.sql.exec('INSERT OR REPLACE INTO gen_head VALUES (1,?)',d.head);r=true;}
  else if(op==='rotate'){this.sql.exec('UPDATE domain_accounts SET epoch=epoch+1 WHERE alias=?',d.alias);r=true;}
  else if(op==='relink'){this.sql.exec('UPDATE coordinated_incarnations SET version=version+1 WHERE alias=?',d.alias);r=true;}
  else if(op==='membership-prepare')r=await this.members.prepare(d.scope,d.job,d.generation,d.attempt,d.sourceId,d.referenceId);
  else if(op==='membership-step')r=this.members.step(d.scope,d.attempt,d.next);
  else if(op==='membership-commit')r=this.storage.transactionSync(()=>this.members.wrap(this.publishing.atomicCommit())(this.sql,d.job,d.generation,d.digest,d.scope));
  else if(op==='done')r=this.owner.setDone([d.key],d.done,d.revision,{head:d.head,accounts:{mail:d.incarnation}});
  else if(op==='membership-get')r=this.storage.transactionSync(()=>this.members.membership()(this.sql,d.head,d.key));
  else if(op==='membership-tamper'){this.sql.exec('UPDATE synthetic_membership_items SET message=? WHERE scope=? AND message=?',d.to,d.scope,d.from);r=true;}
  else if(op==='ref'){this.sql.exec('INSERT INTO ref_header VALUES (?,?,1)',d.header.referenceId,JSON.stringify(d.header));for(let i=0;i<d.ops.length;i++){const v=new TextEncoder().encode(d.values[i]);this.sql.exec('INSERT INTO ref_ops VALUES (?,?,?,?)',d.header.referenceId,i,JSON.stringify(d.ops[i]),v.buffer);}r=true;}
  else if(op==='drop-ref-op'){this.sql.exec('DELETE FROM ref_ops WHERE id=? AND ordinal=?',d.id,d.ordinal);r=true;}
  else if(op==='invalidate'){this.sql.exec('UPDATE ref_header SET active=0 WHERE id=?',d.id);r=true;}
  else if(op==='transport-begin')r=this.transport.begin(d.scope,d.job,d.generation,d.attempt,d.sourceId);
  else if(op==='append')r=await this.transport.append(d.scope,d.attempt,d.index,new TextEncoder().encode(d.value));
  else if(op==='seal')r=this.transport.seal(d.scope,d.attempt,d.parts,d.bytes);
  else if(op==='gen-begin')r=this.generation.begin(d);
  else if(op==='index')r=await this.generation.indexPage(d.scope,d.attempt,d.page,d.ops);
  else if(op==='index-seal')r=this.generation.sealIndex(d.scope,d.attempt);
  else if(op==='begin')r=this.cert.begin(d);
  else if(op==='begin-without-reference')r=this.withoutReference.begin(d);
  else if(op==='next')r=await this.cert.verifyNext(d.scope,d.attempt,d.ordinal,d.offset);
  else if(op==='proof')r=this.storage.transactionSync(()=>this.cert.proof()(this.sql,d.scope,d.job,d.generation,d.sourceId));
  else if(op==='inject'){this.sql.exec("CREATE TRIGGER fail_cert BEFORE UPDATE ON synthetic_segment_certificate BEGIN SELECT RAISE(ABORT,'injected'); END");r=true;}
  else if(op==='uninject'){this.sql.exec('DROP TRIGGER fail_cert');r=true;}
  else if(op==='cursor')r=this.sql.exec('SELECT ordinal,offset,complete FROM synthetic_segment_certificate WHERE scope=?',d.scope).toArray()[0]??null;
  else return new Response(null,{status:404});return Response.json({r});}catch(e){return Response.json({r:null,error:String(e)},{status:409});}}
}
export default {fetch(req,env){return env.TEST.get(env.TEST.idFromName(new URL(req.url).searchParams.get('case')||'main')).fetch(req);}};
`);
// The test wrapper alone exposes raw synthetic SQL helpers. No such endpoint exists in the app.
// Save the storage pointer for invoking the same-transaction certificate callback.
let entry=await (await import('node:fs/promises')).readFile(join(dir,'entry.ts'),'utf8');
entry=entry.replace('constructor(state){this.sql=state.storage.sql;', 'constructor(state){this.storage=state.storage;this.sql=state.storage.sql;');
await writeFile(join(dir,'entry.ts'),entry);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'synthetic-certificate',main:'entry.ts',compatibility_date:'2026-10-01',durable_objects:{bindings:[{name:'TEST',class_name:'Test'}]},migrations:[{tag:'v1',new_sqlite_classes:['Test']}]}));
let child;
async function raw(testCase,op,body={}){const r=await fetch(`${base}/${op}?case=${testCase}`,{method:'POST',body:JSON.stringify(body)});return {status:r.status,...await r.json()};}
async function call(c,o,b={}){const r=await raw(c,o,b);if(r.status!==200)throw new Error(`${o}: ${JSON.stringify(r)}`);return r.r;}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>out+=v);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(out);try{await call('health','cursor',{scope:'none'});return;}catch{await delay(100);}}throw new Error(out);}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await done;child=undefined;}
async function setup(c,{tamper=false,forged=false,testDigest=false}={}){
 const scope=id(),job=id(),generation=id(),attempt=id(),referenceId=id(),versions=[],digest='2026-01-01T00:00:00Z'+(testDigest?'-test':''),identity='b'.repeat(64),email='mail@example.invalid';const content=JSON.stringify({id:digest,...(testDigest?{test:true}:{}),items:[{key:forged?'mail:wrong':'mail:m1',account:'mail',accountEmail:email,messageId:'m1'},{key:'mail:m2',account:'mail',accountEmail:email,messageId:'m2'}]}),bytes=Buffer.byteLength(content);
 await call(c,'account',{job,alias:'mail',identity,email});const op={key:`digest:${digest}`,kind:'put',bytes,expiresAt:null,metadata:null},header={referenceId,job,generation,sourceId,digest,previous:null,versions,totalOps:1,totalBytes:bytes};assert.equal(await call(c,'ref',{header,ops:[op],values:[content]}),true);assert.equal(await call(c,'transport-begin',{scope,job,generation,attempt,sourceId}),true);assert.equal(await call(c,'append',{scope,attempt,index:0,value:content}),'staged');assert.equal(await call(c,'seal',{scope,attempt,parts:1,bytes}),true);assert.equal(await call(c,'gen-begin',{scope,job,generation,attempt,sourceId,previous:null,digest,versions,totalOps:1,totalBytes:bytes}),true);assert.equal(await call(c,'index',{scope,attempt,page:0,ops:[{key:op.key,kind:'put',bytes}]}),true);assert.equal(await call(c,'index-seal',{scope,attempt}),true);const args={scope,job,generation,attempt,sourceId,referenceId,digest};assert.equal(await call(c,'membership-prepare',args),false);assert.equal(await call(c,'begin',args),true);let cursor={ordinal:0,offset:0,complete:false};while(!cursor.complete)cursor=await call(c,'next',{scope,attempt,ordinal:cursor.ordinal,offset:cursor.offset});const other=id();assert.equal(await call(c,'ref',{header:{...header,referenceId:other},ops:[op],values:[content]}),true);assert.equal(await call(c,'membership-prepare',{...args,referenceId:other}),false);if(forged||testDigest){assert.equal(await call(c,'membership-prepare',args),false);return args;}assert.equal(await call(c,'membership-prepare',args),true);assert.deepEqual(await call(c,'membership-step',{scope,attempt,next:0}),{next:2,complete:true});if(tamper)await call(c,'membership-tamper',{scope,from:'m1',to:'evil'});return args;
}
try{await start();const main=await setup('main');assert.equal(await call('main','membership-get',{head:main.scope,key:'mail:m1'}),null);await stop();await start();assert.equal(await call('main','membership-commit',main),true);assert.equal(await call('main','membership-get',{head:main.scope,key:'mail:m1'}),1);assert.equal(await call('main','membership-get',{head:main.scope,key:'mail:evil'}),null);assert.equal((await call('main','done',{head:main.scope,key:'mail:m1',done:true,revision:0,incarnation:1})).revision,1);await call('main','rotate',{alias:'mail'});assert.equal((await call('main','done',{head:main.scope,key:'mail:m1',done:false,revision:1,incarnation:1})).revision,2);await call('main','relink',{alias:'mail'});assert.equal((await raw('main','done',{head:main.scope,key:'mail:m1',done:true,revision:2,incarnation:2})).status,409);assert.equal((await raw('main','done',{head:main.scope,key:'mail:evil',done:true,revision:2,incarnation:2})).status,409);
 const stale=await setup('stale');await call('stale','relink',{alias:'mail'});assert.equal((await raw('stale','membership-commit',stale)).status,409);assert.equal(await call('stale','membership-get',{head:stale.scope,key:'mail:m1'}),null);
 const badHead=await setup('head');assert.equal(await call('head','membership-commit',badHead),true);await call('head','set-head',{head:id()});assert.equal((await raw('head','done',{head:badHead.scope,key:'mail:m1',done:true,revision:0,incarnation:1})).status,409);
 const deleted=await setup('deleted');assert.equal(await call('deleted','membership-commit',deleted),true);await call('deleted','delete-digest',{head:deleted.scope,digest:deleted.digest});assert.equal((await raw('deleted','done',{head:deleted.scope,key:'mail:m1',done:true,revision:0,incarnation:1})).status,409);
 const expired=await setup('expired');assert.equal(await call('expired','membership-commit',expired),true);await call('expired','expire-digest',{head:expired.scope,digest:expired.digest});assert.equal((await raw('expired','done',{head:expired.scope,key:'mail:m1',done:true,revision:0,incarnation:1})).status,409);
 const testDigest=await setup('testdigest',{testDigest:true});assert.equal((await raw('testdigest','membership-commit',testDigest)).status,409);
 const forged=await setup('forged',{forged:true});assert.equal((await raw('forged','membership-commit',forged)).status,409);
 const bad=await setup('tamper',{tamper:true});assert.equal((await raw('tamper','membership-commit',bad)).status,409);assert.equal(await call('tamper','membership-get',{head:bad.scope,key:'mail:evil'}),null);
 console.log('Synthetic digest membership: independent certificate, staged publication, restart, relink fence and tamper rejection passed. Reference fixture is synthetic.');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
