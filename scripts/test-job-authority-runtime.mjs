// Synthetic local Workers/SQLite authority tests; no production bindings, logs or mailbox data.
import { strict as assert } from 'node:assert';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dir=await mkdtemp(join(tmpdir(),'job-authority-runtime-'));
const port=20000+process.pid%20000,base=`http://127.0.0.1:${port}`;
const id=()=>randomBytes(16).toString('base64url');
await writeFile(join(dir,'entry.ts'), `import { JobAuthority as Base } from ${JSON.stringify(resolve('src/job-authority.ts'))};
export class TestAuthority extends Base {
 constructor(state){super(state);this.testStorage=state.storage;}
 async fetch(req){const url=new URL(req.url);if(url.pathname.startsWith('/test-')){const d=await req.json();return this.syntheticTest(url.pathname,d);}return super.fetch(req);}
 syntheticTest(path,d){if(path==='/test-expire-lease'){this.testStorage.sql.exec('UPDATE job_authority_lease SET expires=0 WHERE id=1');return Response.json({ok:true});}if(path==='/test-expire-step'){this.testStorage.sql.exec('UPDATE job_authority_steps SET deadline=0 WHERE owner=? AND step=?',d.owner,d.step);return Response.json({ok:true});}return new Response(null,{status:404});}
}
export default {fetch(req,env){return env.AUTH.get(env.AUTH.idFromName(new URL(req.url).searchParams.get('case')||'default')).fetch(req)}};
`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'synthetic-job-authority',main:'entry.ts',compatibility_date:'2026-10-01',durable_objects:{bindings:[{name:'AUTH',class_name:'TestAuthority'}]},migrations:[{tag:'v1',new_sqlite_classes:['TestAuthority']}]}));
let child;
async function raw(testCase,op,body={}){const res=await fetch(`${base}/${op}?case=${testCase}`,{method:'POST',body:JSON.stringify(body)});const data=await res.json().catch(()=>null);return {status:res.status,data};}
async function call(testCase,op,body={}){const r=await raw(testCase,op,body);assert.equal(r.status,200,`${op}: ${JSON.stringify(r.data)}`);return r.data;}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(output);try{await raw('health','inspect');return;}catch{await delay(100);}}throw new Error(output);}
async function stop(){if(!child||child.exitCode!==null)return;const exited=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await exited;child=undefined;}
try {
 await start();
 const c='lease',owners=Array.from({length:32},id),job=id(),holder={at:'2026-11-14T06:30:00.000Z',job,driver:'web'};
 const race=await Promise.all(owners.map(owner=>call(c,'acquire',{owner,holder})));
 assert.equal(race.filter(r=>r.ok).length,1);const owner=owners[race.findIndex(r=>r.ok)],outsiders=owners.filter(x=>x!==owner);
 for(const response of race)for(const secret of owners)assert(!JSON.stringify(response).includes(secret),'acquisition exposed bearer');
 const view=await call(c,'inspect');assert.equal(view.ok,true);assert.deepEqual(view.holder,holder);assert(!JSON.stringify(view).includes(owner));const originalExpiry=view.expiresAt;
 assert.equal((await call(c,'acquire',{owner,holder})).ok,true);assert.equal((await call(c,'inspect')).expiresAt,originalExpiry,'acquire retry extended lease');assert.equal((await call(c,'acquire',{owner,holder:{...holder,driver:'cron'}})).ok,false);
 const stale=outsiders[0];assert.equal((await call(c,'release',{owner:stale})).ok,false);
 const step='mailbox:example',a=id(),b=id(),ttlMs=120000;
 const claims=await Promise.all([a,b].map(attempt=>call(c,'claim',{owner,step,attempt,expectedGeneration:0,ttlMs})));
 assert.equal(claims.filter(x=>x.ok).length,1);const attempt=claims[0].ok?a:b,otherAttempt=claims[0].ok?b:a,claim=claims.find(x=>x.ok);assert.equal(claim.generation,1);
 assert.deepEqual(await call(c,'claim',{owner,step,attempt,expectedGeneration:0,ttlMs}),claim,'lost claim response retry changed claim');
 assert.equal((await call(c,'claim',{owner,step,attempt:otherAttempt,expectedGeneration:1,ttlMs})).ok,false,'active attempt superseded');
 assert.equal((await call(c,'failExpired',{owner,step,expectedGeneration:1})).ok,false,'active attempt falsely failed');
 for(const response of [await call(c,'snapshot',{owner}),await call(c,'inspect'),...claims])for(const secret of [owner,a,b])assert(!JSON.stringify(response).includes(secret),'observer exposed bearer');
 assert.equal((await call(c,'renew',{owner:stale,step,attempt})).ok,false);
 assert.equal((await call(c,'renew',{owner,step,attempt:otherAttempt})).ok,false);
 assert.equal((await call(c,'test-expire-step',{owner,step})).ok,true);
 assert.equal((await call(c,'renew',{owner,step,attempt})).ok,false);
 assert.equal((await call(c,'complete',{owner,step,attempt,resultKey:'result:old'})).ok,false);
 assert.equal((await call(c,'claim',{owner,step,attempt:otherAttempt,expectedGeneration:1,ttlMs})).ok,false,'expired claim must first transition to failed');
 assert.equal((await call(c,'failExpired',{owner,step,expectedGeneration:0})).ok,false);
 assert.equal((await call(c,'failExpired',{owner,step,expectedGeneration:1})).ok,true);
 assert.equal((await call(c,'failExpired',{owner,step,expectedGeneration:1})).ok,true,'ambiguous failure retry');
 const replacement=await call(c,'claim',{owner,step,attempt:otherAttempt,expectedGeneration:1,ttlMs});assert.equal(replacement.ok,true);assert.equal(replacement.generation,2);
 assert.equal((await call(c,'failExpired',{owner,step,expectedGeneration:1})).ok,false);
 assert.equal((await call(c,'complete',{owner,step,attempt,resultKey:'result:old'})).ok,false,'stale result accepted');
 assert.equal((await call(c,'complete',{owner,step,attempt:otherAttempt,resultKey:'result:new'})).ok,true);
 assert.equal((await call(c,'complete',{owner,step,attempt:otherAttempt,resultKey:'result:new'})).ok,true,'ambiguous completion retry');
 assert.equal((await call(c,'complete',{owner,step,attempt:otherAttempt,resultKey:'result:changed'})).ok,false);
 assert.deepEqual(await call(c,'resolve',{owner,step}),{ok:true,resultKey:'result:new'});
 const completedView=await call(c,'snapshot',{owner});assert.equal(completedView.ok,true);assert.deepEqual(completedView.steps.find(x=>x.step===step),{step,generation:2,state:'complete',deadline:null,resultKey:'result:new'});assert.equal((await call(c,'snapshot',{owner:stale})).ok,false);for(const secret of [owner,a,b])assert(!JSON.stringify(completedView).includes(secret));
 const final='finalize',f1=id(),f2=id();const finals=await Promise.all([f1,f2].map(token=>call(c,'claim',{owner,step:final,attempt:token,expectedGeneration:0,ttlMs})));assert.equal(finals.filter(x=>x.ok).length,1);const finalToken=finals[0].ok?f1:f2;
 assert.equal((await call(c,'complete',{owner,step:final,attempt:finalToken,resultKey:'result:new'})).ok,false,'result reference reused across steps');
 assert.equal((await call(c,'complete',{owner,step:final,attempt:finalToken,resultKey:'result:final'})).ok,true);
 await stop();await start();assert.deepEqual(await call(c,'resolve',{owner,step}),{ok:true,resultKey:'result:new'});
 assert.equal((await call(c,'test-expire-lease')).ok,true);const successor=id(),nextHolder={at:holder.at,job:id(),driver:'cron'};
 assert.equal((await call(c,'acquire',{owner:successor,holder:nextHolder})).ok,true);
 assert.equal((await call(c,'renew',{owner,step,attempt:otherAttempt})).ok,false);
 assert.equal((await call(c,'release',{owner})).ok,false,'expired owner released successor');assert.equal((await call(c,'resolve',{owner,step})).ok,false);
 assert.deepEqual((await call(c,'inspect')).holder,nextHolder);assert.equal((await call(c,'acquire',{owner,holder})).ok,false,'expired owner token reused');
 assert.equal((await call(c,'release',{owner:successor})).ok,true);assert.equal((await call(c,'release',{owner:successor})).ok,true,'ambiguous release retry');
 const third=id();assert.equal((await call(c,'acquire',{owner:third,holder:{...holder,job:id()}})).ok,true);assert.equal((await call(c,'release',{owner:successor})).ok,true,'old acknowledged release retry');assert.notEqual((await call(c,'inspect')).holder,null,'old retry erased successor');
 assert.equal((await raw('invalid','claim',{owner,step:'x',attempt:id(),expectedGeneration:0,ttlMs:119999})).status,400);
 assert.equal((await raw('invalid','inspect',{owner})).status,400);
 console.log('Synthetic job authority: concurrent starts/claims, bearer redaction, expiry, stale completion, finalizer fencing and restart passed. Does not fence KV writes.');
} finally { await stop(); await rm(dir,{recursive:true,force:true}); }
