// Synthetic local Workers/SQLite test: no live state or mailbox content.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const dir=await mkdtemp(join(tmpdir(),'job-context-')),port=20000+process.pid%20000,base=`http://127.0.0.1:${port}`;
await writeFile(join(dir,'entry.ts'),`import {JobStateCore} from ${JSON.stringify(resolve('src/job-state-core.ts'))};
import {SyntheticJobContextBinding} from ${JSON.stringify(resolve('src/synthetic-job-context.ts'))};
import {GenerationStore} from ${JSON.stringify(resolve('src/generation-store.ts'))};
import {readSyntheticPreviousDigestInTransaction} from ${JSON.stringify(resolve('src/synthetic-job-previous.ts'))};
import {DomainGenerationGate} from ${JSON.stringify(resolve('src/domain-generation-gate.ts'))};
import {TrustedAssemblySource} from ${JSON.stringify(resolve('src/trusted-assembly-source.ts'))};
export class T {constructor(state){this.storage=state.storage;this.sql=state.storage.sql;new GenerationStore(state.storage);this.binding=new SyntheticJobContextBinding(state.storage);this.gate=new DomainGenerationGate(state.storage);this.source=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:(sql,job,generation)=>this.binding.readInTransaction(sql,job,generation)?.previous});this.noPrevious=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:()=>undefined});}
 async fetch(req){const d=await req.json(),op=new URL(req.url).pathname.slice(1);let r;
 if(op==='create'){const callbacks=this.binding.callbacks(d.context,d.inject?()=>{throw new Error('injected')}:this.gate.jobBinding(),readSyntheticPreviousDigestInTransaction);const core=new JobStateCore(this.storage,undefined,callbacks.bind,callbacks.checkExisting);try{r=core.create(d.job);}catch{r={ok:false};}}
 else if(op==='final'){r=new JobStateCore(this.storage).claimFinal(d.job,d.generation,d.token);}
 else if(op==='capture'){r=(d.noPrevious?this.noPrevious:this.source).capture(d.scope,d.job,d.generation,d.token);}
 else if(op==='previous'){r=this.storage.transactionSync(()=>readSyntheticPreviousDigestInTransaction(this.sql));if(r===undefined)r='unknown';}
 else if(op==='index'){const value=JSON.stringify(d.value);this.sql.exec("INSERT OR REPLACE INTO gen_head VALUES (1,'legacy')");this.sql.exec("INSERT OR REPLACE INTO gen_key_heads VALUES ('runs-index','legacy','prep','put',NULL,NULL,1)");this.sql.exec('INSERT OR REPLACE INTO gen_chunks VALUES (?,?,?,?,?,?,?)','legacy','prep','runs-index',0,'b'.repeat(64),value.length,btoa(value));r=true;}
 else if(op==='unpointer'){this.sql.exec("DELETE FROM gen_key_heads WHERE key='last-run'");r=true;}
 else if(op==='segmented'){this.sql.exec('CREATE TABLE IF NOT EXISTS sgen_committed (scope TEXT PRIMARY KEY)');this.sql.exec("INSERT OR REPLACE INTO sgen_committed VALUES ('legacy')");r=true;}
 else if(op==='unsegment'){this.sql.exec('DELETE FROM sgen_committed');r=true;}
 else if(op==='seed'){this.storage.transactionSync(()=>{this.sql.exec('INSERT OR REPLACE INTO gen_head VALUES (1,?)','legacy');this.sql.exec("INSERT OR REPLACE INTO gen_key_heads VALUES (?,'legacy','prep','put',NULL,NULL,1)",'last-run');this.sql.exec('INSERT OR REPLACE INTO gen_chunks VALUES (?,?,?,?,?,?,?)','legacy','prep','last-run',0,'a'.repeat(64),d.value.length,btoa(d.value));if(d.digest){this.sql.exec("INSERT OR REPLACE INTO gen_key_heads VALUES ('runs-index','legacy','prep','put',NULL,NULL,1)");this.sql.exec('INSERT OR REPLACE INTO gen_chunks VALUES (?,?,?,?,?,?,?)','legacy','prep','runs-index',0,'b'.repeat(64),2,btoa('[]'));const key='digest:'+d.value;this.sql.exec("INSERT OR REPLACE INTO gen_key_heads VALUES (?,'legacy','prep','put',NULL,NULL,1)",key);this.sql.exec('INSERT OR REPLACE INTO gen_chunks VALUES (?,?,?,?,?,?,?)','legacy','prep',key,0,'a'.repeat(64),2,btoa('{}'));}});r=true;}
 else if(op==='read')r=this.storage.transactionSync(()=>this.binding.readInTransaction(this.sql,d.job,d.generation));
 else if(op==='counts')r={jobs:this.sql.exec('SELECT COUNT(*) AS n FROM core_jobs').toArray()[0].n,contexts:this.sql.exec('SELECT COUNT(*) AS n FROM synthetic_job_context').toArray()[0].n};
 else r=true;return Response.json(r);}}
export default {fetch(req,env){return env.TEST.get(env.TEST.idFromName('one')).fetch(req)}};`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'synthetic-job-context',main:'entry.ts',compatibility_date:'2026-10-01',durable_objects:{bindings:[{name:'TEST',class_name:'T'}]},migrations:[{tag:'v1',new_sqlite_classes:['T']}]}));
let child;async function request(op,data){const res=await fetch(`${base}/${op}`,{method:'POST',body:JSON.stringify(data)});if(!res.ok)throw Error(`HTTP ${res.status}`);return res.json();}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);for(let i=0;i<150;i++){if(child.exitCode!==null)throw Error(output);try{await request('ping',{});return;}catch{await delay(100);}}throw Error(output);}
async function stop(){if(child&&child.exitCode===null){const exited=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await exited;}}
try{await start();const id=()=>randomBytes(16).toString('base64url');const job={job:id(),generation:id(),driver:'web',mailboxes:[]};const context={now:'2026-10-24T06:30:00.000Z',window:{kind:'since'},reclassify:false,test:false,cfg:{query:'in:inbox',maxPerAccount:300,model:'@cf/openai/gpt-oss-120b',fallbackModel:null,timeZone:'Europe/London'}};
 assert.equal(await request('previous',{}),null);await request('seed',{value:'2026-10-23T06:30:00Z'});await request('index',{value:['2026-10-23T06:30:00Z']});assert.equal(await request('previous',{}),'unknown');assert.equal((await request('create',{job,context})).ok,false);assert.deepEqual(await request('counts',{}),{jobs:0,contexts:0});
 await request('seed',{value:'2026-10-23T06:30:00Z',digest:true});assert.equal((await request('create',{job,context,inject:true})).ok,false);assert.deepEqual(await request('counts',{}),{jobs:0,contexts:0});assert.equal((await request('create',{job,context})).ok,true);const first=await request('read',job);assert.equal(first.run,'2026-10-24T06:30:00Z');assert.equal(first.previous,'2026-10-23T06:30:00Z');await request('seed',{value:'2026-10-24T06:30:00Z',digest:true});assert.equal((await request('create',{job,context})).ok,true);assert.equal((await request('read',job)).previous,'2026-10-23T06:30:00Z');
 await request('unpointer',{});await request('index',{value:['2026-10-24T06:30:00Z-test','2026-10-23T06:30:00Z']});assert.equal(await request('previous',{}),'2026-10-23T06:30:00Z');await request('index',{value:['invalid']});assert.equal(await request('previous',{}),'unknown');await request('segmented',{});assert.equal(await request('previous',{}),'unknown');await request('unsegment',{});await request('index',{value:['2026-10-23T06:30:00Z']});
 const token=id(),scope=id();assert.equal(await request('final',{...job,token}),true);assert.equal(await request('capture',{...job,token,scope,noPrevious:true}),null);assert.equal((await request('capture',{...job,token,scope})).previousDigest,'2026-10-23T06:30:00Z');
 assert.equal((await request('create',{job,context:{...context,cfg:{...context.cfg,query:'changed'}}})).ok,false);await stop();await start();assert.deepEqual(await request('read',job),first);assert.equal((await request('create',{job,context})).ok,true);
 console.log('Synthetic context transaction, rollback, retry and restart passed');
}finally{await stop();await rm(dir,{recursive:true,force:true});}
