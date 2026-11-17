// Production AtomicGenerationAuthority adapter exercised in local workerd with synthetic values.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dir=await mkdtemp(join(tmpdir(),'atomic-generation-authority-'));
const port=24000+process.pid%16000,base=`http://127.0.0.1:${port}`;
const id=()=>randomBytes(16).toString('base64url');
const b64=value=>Buffer.from(value).toString('base64');
await writeFile(join(dir,'entry.ts'),`import { JobAuthority as Base } from ${JSON.stringify(resolve('src/job-authority.ts'))};
export class TestAuthority extends Base { constructor(state){super(state);this.s=state.storage;} async fetch(req){const u=new URL(req.url);if(u.pathname==='/test-expire'){const v=await req.json();this.s.sql.exec('UPDATE job_authority_steps SET deadline=0 WHERE owner=? AND step=?',v.owner,v.step);return Response.json({ok:true});}return super.fetch(req);} }
export default {fetch(req,env){return env.AUTH.get(env.AUTH.idFromName(new URL(req.url).searchParams.get('case')||'default')).fetch(req)}};`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'atomic-generation-authority',main:'entry.ts',compatibility_date:'2026-10-01',durable_objects:{bindings:[{name:'AUTH',class_name:'TestAuthority'}]},migrations:[{tag:'v1',new_sqlite_classes:['TestAuthority']}]}));
let child;
async function raw(c,op,body={}){const response=await fetch(`${base}/${op}?case=${c}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,data:await response.json().catch(()=>null)};}
async function call(c,op,body={}){const result=await raw(c,op,body);assert.equal(result.status,200,`${op}: ${JSON.stringify(result.data)}`);return result.data;}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(output);try{await call('health','state/head');return;}catch{await delay(100);}}throw new Error(output);}
async function stop(){if(!child||child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGINT');await exited;child=undefined;}
async function baseline(c,key,value){const stage=id(),capability=id(),generation=id();assert.equal((await call(c,'state/bootstrap',{stage,capability,generation})).ok,true);assert.equal((await call(c,'state/chunk',{stage,key,index:0,total:1,data:b64(value)})).ok,true);assert.equal((await call(c,'state/entry',{stage,key,kind:'put',chunks:1,bytes:Buffer.byteLength(value)})).ok,true);assert.equal((await call(c,'state/seal',{stage,entries:1,bytes:Buffer.byteLength(value)})).ok,true);const committed=await call(c,'state/commit',{stage});assert.equal(committed.ok,true);return committed;}
async function stage(c,{owner,attempt,parentSeq,key,value}){const stage=id(),generation=id();assert.equal((await call(c,'state/begin',{stage,owner,attempt,generation,parentSeq})).ok,true);assert.equal((await call(c,'state/chunk',{stage,key,index:0,total:1,data:b64(value)})).ok,true);assert.equal((await call(c,'state/entry',{stage,key,kind:'put',chunks:1,bytes:Buffer.byteLength(value)})).ok,true);assert.equal((await call(c,'state/seal',{stage,entries:1,bytes:Buffer.byteLength(value)})).ok,true);return {stage,generation};}
try{
 await start();
 const c='atomic',baseCommit=await baseline(c,'last-run','old');assert.equal(baseCommit.seq,1);
 const owners=Array.from({length:50},id),holderJob=id(),holder={at:'2026-11-14T06:30:00.000Z',job:holderJob,driver:'web'};
 const starts=await Promise.all(owners.map(owner=>call(c,'acquire',{owner,holder})));
 assert.equal(starts.filter(result=>result.ok).length,1,'50 starts admitted more than one owner');
 const owner=owners[starts.findIndex(result=>result.ok)],oldAttempt=id();
 assert.equal((await call(c,'claim',{owner,step:'final',attempt:oldAttempt,expectedGeneration:0,ttlMs:120000})).ok,true);
 const oldStage=await stage(c,{owner,attempt:oldAttempt,parentSeq:1,key:'last-run',value:'stale'});
 assert.equal((await call(c,'test-expire',{owner,step:'final'})).ok,true);
 assert.equal((await call(c,'failExpired',{owner,step:'final',expectedGeneration:1})).ok,true);
 const successor=id();assert.equal((await call(c,'claim',{owner,step:'final',attempt:successor,expectedGeneration:1,ttlMs:120000})).ok,true);
 const nextStage=await stage(c,{owner,attempt:successor,parentSeq:1,key:'last-run',value:'new'});
 const next=await call(c,'state/commit',{stage:nextStage.stage});assert.equal(next.ok,true);assert.equal(next.seq,2);
 assert.equal((await call(c,'state/commit',{stage:oldStage.stage})).ok,false,'stale finalizer committed');
 const before=await call(c,'state/read',{seq:1,key:'last-run'}),after=await call(c,'state/read',{seq:2,key:'last-run'});
 assert.equal(Buffer.from(before.data,'base64').toString(),'old');assert.equal(Buffer.from(after.data,'base64').toString(),'new');
 const many=await call(c,'state/read-many',{seq:2,keys:['last-run','done:mail:missing']});
 assert.equal(many.items.length,2);assert.equal(Buffer.from(many.items[0].data,'base64').toString(),'new');assert.equal(many.items[1].kind,'missing');
 await stop();await start();
 const restarted=await call(c,'state/read',{seq:2,key:'last-run'});assert.equal(Buffer.from(restarted.data,'base64').toString(),'new');
 console.log('Production atomic generation authority: 50-start admission, bootstrap, stale finalizer exclusion, pinned old/new reads, commit idempotence and restart passed.');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
