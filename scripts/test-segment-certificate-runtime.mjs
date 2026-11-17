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
export class Test {
 constructor(state){this.sql=state.storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS ref_header (id TEXT PRIMARY KEY, value TEXT NOT NULL, active INTEGER NOT NULL)');this.sql.exec('CREATE TABLE IF NOT EXISTS ref_ops (id TEXT NOT NULL, ordinal INTEGER NOT NULL, meta TEXT NOT NULL, value BLOB NOT NULL, PRIMARY KEY(id,ordinal))');
  this.source={current:(sql,_scope,_attempt,id)=>!!sql.exec('SELECT id FROM ref_header WHERE id=? AND active=1',id).toArray().length,header:(sql,_scope,_attempt,id)=>{const row=sql.exec('SELECT value FROM ref_header WHERE id=? AND active=1',id).toArray()[0];return row?JSON.parse(row.value):null;},op:(sql,_scope,_attempt,id,index)=>{const row=sql.exec('SELECT meta FROM ref_ops WHERE id=? AND ordinal=?',id,index).toArray()[0];return row?JSON.parse(row.meta):null;},bytes:(sql,_scope,_attempt,id,index,offset,length)=>{const row=sql.exec('SELECT substr(value,?,?) AS part FROM ref_ops WHERE id=? AND ordinal=?',offset+1,length,id,index).toArray()[0];return row?new Uint8Array(row.part):null;}};
  this.transport=new SegmentedOutputStore(state.storage,()=>true);this.generation=new SegmentedGeneration(state.storage,()=>true);this.cert=new SyntheticSegmentCertificate(state.storage,this.source);this.withoutReference=new SyntheticSegmentCertificate(state.storage); }
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json();let r;try{
  if(op==='ref'){this.sql.exec('INSERT INTO ref_header VALUES (?,?,1)',d.header.referenceId,JSON.stringify(d.header));for(let i=0;i<d.ops.length;i++){const v=new TextEncoder().encode(d.values[i]);this.sql.exec('INSERT INTO ref_ops VALUES (?,?,?,?)',d.header.referenceId,i,JSON.stringify(d.ops[i]),v.buffer);}r=true;}
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
async function setup(c,{candidate='✓'.repeat(2500),reference=candidate,expiry=123456789,missing=false}={}){
 const scope=id(),job=id(),generation=id(),attempt=id(),referenceId=id(),versions=[],digest='synthetic-digest';
 const ops=[{key:'digest:test',kind:'put',bytes:Buffer.byteLength(candidate),expiresAt:expiry,metadata:{arrived:3}},{key:'recheck:mail',kind:'delete',bytes:0,expiresAt:null,metadata:null}];
 const h={referenceId,job,generation,sourceId,digest,previous:null,versions,totalOps:2,totalBytes:Buffer.byteLength(candidate)};
 const expected=[{...ops[0],bytes:Buffer.byteLength(reference)},ops[1]];
 assert.equal(await call(c,'ref',{header:h,ops:expected,values:[reference,'']}),true);
 if(missing)assert.equal(await call(c,'drop-ref-op',{id:referenceId,ordinal:1}),true);
 assert.equal(await call(c,'transport-begin',{scope,job,generation,attempt,sourceId}),true);
 assert.equal(await call(c,'append',{scope,attempt,index:0,value:candidate}),'staged');
 assert.equal(await call(c,'seal',{scope,attempt,parts:1,bytes:Buffer.byteLength(candidate)}),true);
 assert.equal(await call(c,'gen-begin',{scope,job,generation,attempt,sourceId,previous:null,digest,versions,totalOps:2,totalBytes:Buffer.byteLength(candidate)}),true);
 const index=ops.map(o=>o.kind==='delete'?{key:o.key,kind:o.kind,bytes:0}:{key:o.key,kind:o.kind,bytes:o.bytes,expiresAt:o.expiresAt,metadata:o.metadata});
 assert.equal(await call(c,'index',{scope,attempt,page:0,ops:index}),true);
 assert.equal(await call(c,'index-seal',{scope,attempt}),true);
 return {scope,job,generation,attempt,sourceId,referenceId};
}
try{
 await start();const main=await setup('main');
 assert.equal(await call('main','begin-without-reference',main),false);assert.equal(await call('main','begin',main),true);
 assert.equal(await call('main','proof',main),false);
 assert.equal(await call('main','inject'),true);assert.equal((await raw('main','next',{scope:main.scope,attempt:main.attempt,ordinal:0,offset:0})).status,409);
 assert.deepEqual(await call('main','cursor',{scope:main.scope}),{ordinal:0,offset:0,complete:0});assert.equal(await call('main','uninject'),true);
 const races=await Promise.all([call('main','next',{scope:main.scope,attempt:main.attempt,ordinal:0,offset:0}),call('main','next',{scope:main.scope,attempt:main.attempt,ordinal:0,offset:0})]);assert.equal(races.filter(Boolean).length,1);let cursor=races.find(Boolean);
 await stop();await start();assert.equal(await call('main','next',{scope:main.scope,attempt:main.attempt,ordinal:0,offset:0}),null);
 while(!cursor.complete){cursor=await call('main','next',{scope:main.scope,attempt:main.attempt,ordinal:cursor.ordinal,offset:cursor.offset});assert(cursor);}
 assert.equal(await call('main','proof',main),true);assert.equal(await call('main','invalidate',{id:main.referenceId}),true);assert.equal(await call('main','proof',main),false);
 const wrong=await setup('wrong',{candidate:'aaa',reference:'bbb'});assert.equal(await call('wrong','begin',wrong),true);assert.equal(await call('wrong','next',{scope:wrong.scope,attempt:wrong.attempt,ordinal:0,offset:0}),null);assert.equal(await call('wrong','proof',wrong),false);
 const missing=await setup('missing',{candidate:'abc',missing:true});assert.equal(await call('missing','begin',missing),true);const first=await call('missing','next',{scope:missing.scope,attempt:missing.attempt,ordinal:0,offset:0});assert(first);assert.equal(await call('missing','next',{scope:missing.scope,attempt:missing.attempt,ordinal:first.ordinal,offset:first.offset}),null);assert.equal(await call('missing','proof',missing),false);
 console.log('Synthetic local certificate: independent-byte mismatch, omission, rollback, concurrent CAS, restart and revision invalidation passed. Reference is a stub; no production proof.');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
