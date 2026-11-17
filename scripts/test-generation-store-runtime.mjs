// Synthetic-only local Workers/SQLite integration; no production state or mailbox data.
import { strict as assert } from 'node:assert';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const dir=await mkdtemp(join(tmpdir(),'generation-test-')), port=20000+process.pid%20000, base=`http://127.0.0.1:${port}`;
const id=()=>randomBytes(16).toString('base64url'), hash=s=>createHash('sha256').update(s).digest('hex');
await writeFile(join(dir,'entry.ts'), `import { JobStateCore } from ${JSON.stringify(resolve('src/job-state-core.ts'))};
import { GenerationStore } from ${JSON.stringify(resolve('src/generation-store.ts'))};
export class TestGeneration {
 constructor(state){ this.sql=state.storage.sql; this.store=new GenerationStore(state.storage, (_sql,m)=>m.changes.some(c=>c.key==='digest:'+m.digest) && m.versions.some(v=>v.key==='account') && m.versions.some(v=>v.key==='settings')); this.core=new JobStateCore(state.storage,this.store.atomicCommit()); this.bad=new JobStateCore(state.storage,new GenerationStore(state.storage,async()=>true).atomicCommit()); }
 async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json(); let r;
 if(op==='version'){this.sql.exec('INSERT OR REPLACE INTO gen_versions (key,version) VALUES (?,?)',d.key,d.version);r=true;}
 else if(op==='expireFinal'){this.sql.exec('UPDATE core_final SET deadline=? WHERE job=?',Date.now(),d.job);r=true;}
 else if(op==='create') r=this.core.create(d);
 else if(op==='claimFinal') r=this.core.claimFinal(d.job,d.generation,d.token);
 else if(op==='prepare') r=this.store.prepare(d);
 else if(op==='stage') r=await this.store.stage(d.job,d.generation,d.token,d.preparation,d.key,d.index,new TextEncoder().encode(d.value));
 else if(op==='abandon') r=this.store.abandon(d.job,d.generation,d.token,d.preparation);
 else if(op==='reclaim') r=this.store.reclaim(d.job,d.generation,d.token,d.preparation,d.limit);
 else if(op==='finish') r=this.core.finalize(d.job,d.generation,d.token,d.digest,d.preparation);
 else if(op==='badFinish') r=this.bad.finalize(d.job,d.generation,d.token,d.digest,d.preparation);
 else if(op==='head') r=this.store.head();
 else if(op==='read'){const out=this.store.read(d.key,d.head,d.index);r=out.kind==='value'?{...out,bytes:out.bytes?new TextDecoder().decode(out.bytes):null}:out;}
 else return new Response(null,{status:404}); return Response.json({r});}
}
export default {fetch(req,env){return env.TEST.get(env.TEST.idFromName('singleton')).fetch(req);}};
`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'synthetic-generation',main:'entry.ts',compatibility_date:'2026-10-01',durable_objects:{bindings:[{name:'TEST',class_name:'TestGeneration'}]},migrations:[{tag:'v1',new_sqlite_classes:['TestGeneration']}]}));
let child;
async function call(op,body){const res=await fetch(`${base}/${op}`,{method:'POST',body:JSON.stringify(body)});if(!res.ok)throw new Error(`HTTP ${res.status} ${op}`);return (await res.json()).r;}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(output);try{await call('head',{});return;}catch{await delay(100);}}throw new Error(output);}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await done;child=undefined;}
try{
 await start(); await call('version',{key:'account',version:1}); await call('version',{key:'settings',version:4});
 const job=id(),generation=id(),digest='d1', data=['synthetic one','synthetic two']; let token=id();
 assert.equal((await call('create',{job,generation,driver:'web',mailboxes:[]})).ok,true);
 assert.equal(await call('claimFinal',{job,generation,token}),true);
 const manifest={job,generation,preparation:id(),expectedPreparation:null,token,digest,previous:null,versions:[{key:'account',version:1},{key:'settings',version:4}],changes:[{key:'digest:d1',kind:'put',chunks:data.map(x=>({hash:hash(x),bytes:Buffer.byteLength(x)})),metadata:{arrived:123}},{key:'kept',kind:'put',chunks:[{hash:hash('retained'),bytes:8}]}]};
 assert.equal(await call('prepare',manifest),true); assert.equal(await call('prepare',manifest),true);
 assert.equal(await call('stage',{job,generation,token,preparation:manifest.preparation,key:'digest:d1',index:0,value:data[0]}),true);
 assert.equal((await call('read',{key:'digest:d1',head:null,index:0})).kind,'missing');
 await assert.rejects(call('finish',{job,generation,token,digest,preparation:manifest.preparation})); assert.equal(await call('head',{}),null);
 await call('expireFinal',{job}); const oldToken=token; token=id();
 assert.equal(await call('claimFinal',{job,generation,token}),true);
 assert.equal(await call('stage',{job,generation,token:oldToken,preparation:manifest.preparation,key:'digest:d1',index:1,value:data[1]}),false);
 manifest.token=token; assert.equal(await call('prepare',manifest),true);
 assert.equal(await call('stage',{job,generation,token,preparation:manifest.preparation,key:'digest:d1',index:1,value:data[1]}),true);
 assert.equal(await call('stage',{job,generation,token,preparation:manifest.preparation,key:'kept',index:0,value:'retained'}),true);
 await call('version',{key:'account',version:2}); await assert.rejects(call('finish',{job,generation,token,digest,preparation:manifest.preparation})); assert.equal(await call('head',{}),null);
 const revised={...manifest,preparation:id(),expectedPreparation:manifest.preparation,versions:[{key:'account',version:2},{key:'settings',version:4}]};
 assert.equal(await call('prepare',revised),true);
 assert.equal(await call('prepare',manifest),false);
 assert.equal(await call('stage',{job,generation,token,preparation:revised.preparation,key:'digest:d1',index:0,value:data[0]}),true);
 assert.equal(await call('stage',{job,generation,token,preparation:revised.preparation,key:'digest:d1',index:1,value:data[1]}),true);
 assert.equal(await call('stage',{job,generation,token,preparation:revised.preparation,key:'kept',index:0,value:'retained'}),true);
 await assert.rejects(call('finish',{job,generation,token,digest,preparation:manifest.preparation}));
 await assert.rejects(call('badFinish',{job,generation,token,digest,preparation:revised.preparation}));
 assert.equal(await call('head',{}),null);
 assert.equal(await call('finish',{job,generation,token,digest,preparation:revised.preparation}),true);
 assert.equal(await call('finish',{job,generation,token,digest,preparation:revised.preparation}),true);
 assert.equal((await call('read',{key:'digest:d1',head:generation,index:1})).bytes,data[1]);
 await stop();await start();assert.equal(await call('head',{}),generation);
 const next={job:id(),generation:id(),preparation:id(),expectedPreparation:null,token:id(),digest:'d2',previous:generation,versions:revised.versions,changes:[{key:'digest:d2',kind:'put',chunks:[{hash:hash('new'),bytes:3}]}]};
 assert.equal((await call('create',{job:next.job,generation:next.generation,driver:'cron',mailboxes:[]})).ok,true);
 assert.equal(await call('claimFinal',next),true);
 const large='z'.repeat(64*1024), largeRef={hash:hash(large),bytes:large.length};
 const abandoned={...next,preparation:id(),changes:[{key:'digest:d2',kind:'put',chunks:Array.from({length:128},()=>largeRef)}]};
 assert.equal(await call('prepare',abandoned),true);
 for(let index=0;index<2;index++)assert.equal(await call('stage',{...abandoned,key:'digest:d2',index,value:large}),true);
 assert.equal(await call('reclaim',{...abandoned,limit:1}).then(r=>r.ok),false);
 assert.equal(await call('abandon',abandoned),true);
 assert.equal(await call('stage',{...abandoned,key:'digest:d2',index:2,value:large}),false);
 assert.equal(await call('prepare',next),false);
 assert.deepEqual(await call('reclaim',{...abandoned,limit:1}),{ok:true,remaining:1});
 assert.equal(await call('prepare',next),false);
 assert.deepEqual(await call('reclaim',{...abandoned,limit:1}),{ok:true,remaining:0});
 assert.equal(await call('prepare',abandoned),false);
 assert.equal(await call('prepare',next),true);
 assert.equal(await call('stage',{job,generation,token,preparation:manifest.preparation,key:'digest:d1',index:0,value:data[0]}),false);
 assert.equal(await call('stage',{...next,key:'digest:d2',index:0,value:'new'}),true);
 assert.equal(await call('finish',next),true);
 assert.equal((await call('read',{key:'kept',head:next.generation,index:0})).bytes,'retained');
 assert.equal((await call('read',{key:'kept',head:generation,index:0})).kind,'changed');
 console.log('Synthetic SQLite: staged visibility, stale identity, atomic head, overlays and restart passed.');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
