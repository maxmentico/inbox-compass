// Local-only production-path integration. Synthetic empty mailbox; no Gmail, AI or production data.
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dir=await mkdtemp(join(tmpdir(),'job-integration-'));
const port=20000+process.pid%20000,base=`http://127.0.0.1:${port}`;
await writeFile(join(dir,'entry.ts'),`import {startJob,planStep} from ${JSON.stringify(resolve('src/jobs.ts'))};
import {InboxJobAuthority} from ${JSON.stringify(resolve('src/job-authority.ts'))};
import {sha256Hex} from ${JSON.stringify(resolve('src/crypto.ts'))};
export class TestAuthority extends InboxJobAuthority {
 constructor(state){super(state);this.testStorage=state.storage;}
 async fetch(req){if(new URL(req.url).pathname==='/test-summary'){
  const rows=this.testStorage.sql.exec("SELECT step,generation,state FROM job_authority_steps WHERE step='final' ORDER BY generation").toArray();
  return Response.json({rows});
 }return super.fetch(req);}
}
export default {async fetch(req,bindings){
 if(new URL(req.url).pathname==='/health')return new Response('ok');
 if(new URL(req.url).pathname!=='/exercise')return new Response(null,{status:404});
 const counts={digest:0,result:0,done:0};const raw=bindings.MAILBOX_KV;
 const kv={get:(...args)=>raw.get(...args),getWithMetadata:(...args)=>raw.getWithMetadata(...args),list:(...args)=>raw.list(...args),delete:(...args)=>raw.delete(...args),put:async(key,...args)=>{if(key.startsWith('digest:'))counts.digest++;if(key.startsWith('job-result:'))counts.result++;if(key.startsWith('job-done:'))counts.done++;return raw.put(key,...args);}};
 const secret='synthetic-job-integration-key';const env={...bindings,MAILBOX_KV:kv,TOKEN_ENCRYPTION_KEY:secret,AI:{run:async()=>{throw new Error('unexpected AI call');}}};
 const now=new Date();const starts=await Promise.allSettled(Array.from({length:20},()=>startJob(env,{},now,'web')));
 const winners=starts.filter(x=>x.status==='fulfilled').map(x=>x.value);if(winners.length!==1)return Response.json({stage:'starts',successes:winners.length,rejected:starts.length-winners.length});
 const job=winners[0];const stub=bindings.JOB_AUTHORITY.get(bindings.JOB_AUTHORITY.idFromName('owner'));
 const inspect=async()=>{const r=await stub.fetch(new Request('https://job-authority.internal/inspect',{method:'POST',body:'{}'}));return r.json();};
 const before=await inspect(),owner=await sha256Hex('job-authority-v1|'+secret+'|'+job.id);
 const plans=await Promise.all([planStep(env,job.id,{now}),planStep(env,job.id,{now})]);
 if(plans.some(p=>p.kind!=='finish'))return Response.json({stage:'plans',kinds:plans.map(p=>p.kind),successes:winners.length});
 const outputs=await Promise.allSettled(plans.map(p=>p.work()));
 const list=await kv.list();const after=await inspect();const summary=await (await stub.fetch(new Request('https://job-authority.internal/test-summary',{method:'POST',body:'{}'}))).json();
 return Response.json({stage:'done',starts:winners.length,rejected:starts.length-winners.length,empty:job.aliases.length===0,preHolderMatches:before.holder?.job===job.id,preLeaked:JSON.stringify(before).includes(owner),afterHolder:after.holder??null,finalized:outputs.filter(x=>x.status==='fulfilled').length,counts,keys:{digest:list.keys.filter(k=>k.name.startsWith('digest:')).length,result:list.keys.filter(k=>k.name.startsWith('job-result:')).length,done:list.keys.filter(k=>k.name.startsWith('job-done:')).length},summary});
}};
`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'synthetic-job-integration',main:'entry.ts',compatibility_date:'2026-10-01',compatibility_flags:['nodejs_compat'],kv_namespaces:[{binding:'MAILBOX_KV',id:'a'.repeat(32)}],durable_objects:{bindings:[{name:'JOB_AUTHORITY',class_name:'TestAuthority'}]},migrations:[{tag:'v1',new_sqlite_classes:['TestAuthority']}]}));
let child;
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>out+=x);for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(out);try{if((await fetch(`${base}/health`)).ok)return;}catch{}await delay(100);}throw Error(out);}
async function stop(){if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await exited;}}
try{
 await start();const response=await fetch(`${base}/exercise`,{method:'POST'});assert.equal(response.status,200,await response.clone().text());const result=await response.json();assert.equal(result.stage,'done',JSON.stringify(result));assert.equal(result.starts,1);assert.equal(result.rejected,19);assert.equal(result.empty,true);assert.equal(result.preHolderMatches,true);assert.equal(result.preLeaked,false);assert.equal(result.afterHolder,null);assert.equal(result.finalized,1);assert.deepEqual(result.counts,{digest:1,result:1,done:1});assert.deepEqual(result.keys,{digest:1,result:1,done:1});assert.deepEqual(result.summary.rows,[{step:'final',generation:1,state:'complete'}]);
 console.log('Synthetic real job integration: 20 concurrent starts, competing finalizers, one digest/result and redacted released authority passed. KV writes are not atomically fenced.');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
