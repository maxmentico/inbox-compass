// Production migration/rollback adapters with local synthetic KV and SQLite bindings only.
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const dir=await mkdtemp(join(tmpdir(),'production-migration-')),port=26000+process.pid%14000,base=`http://127.0.0.1:${port}`;
await writeFile(join(dir,'entry.ts'),`import { JobAuthority } from ${JSON.stringify(resolve('src/job-authority.ts'))};
import { ensureAtomicBaseline,resolveAtomicMode } from ${JSON.stringify(resolve('src/atomic-migration.ts'))};
import { withAtomicState } from ${JSON.stringify(resolve('src/atomic-kv.ts'))};
import { listAccounts } from ${JSON.stringify(resolve('src/accounts.ts'))};
export {JobAuthority};
const digest={id:'2026-11-14T06:30:00Z',date:'2026-11-14',generatedAt:'2026-11-14T06:30:00.000Z',model:'synthetic',query:'',items:[{key:'mail:m1'}],accounts:[],modelErrors:[]};
export default {async fetch(req,env){const p=new URL(req.url).pathname;if(p==='/seed'){await env.MAILBOX_KV.put('last-run',digest.id);await env.MAILBOX_KV.put('runs-index',JSON.stringify([digest.id]));await env.MAILBOX_KV.put('digest:'+digest.id,JSON.stringify(digest));await env.MAILBOX_KV.put('digest:2026-11-13T06:30:00Z',JSON.stringify({...digest,id:'2026-11-13T06:30:00Z'}));await env.MAILBOX_KV.put('done:mail:m1','1');await env.MAILBOX_KV.put('settings',JSON.stringify({deadlineDays:7,importantSenders:[],mutedSenders:[]}));await env.MAILBOX_KV.put('accounts-index',JSON.stringify(['mail']));await env.MAILBOX_KV.put('account:mail',JSON.stringify({alias:'mail',email:'owner@example.test',scopes:[],sealedRefreshToken:'sealed-a',linkedAt:'2026-11-14T00:00:00Z'}));return Response.json({ok:true});}
if(p==='/migrate'){await ensureAtomicBaseline({...env,ATOMIC_STATE_MODE:'migrate'});const active=withAtomicState({...env,ATOMIC_STATE_MODE:'active'});return Response.json({last:await active.MAILBOX_KV.get('last-run'),done:await active.MAILBOX_KV.get('done:mail:m1'),cursor:await active.MAILBOX_KV.get('cursor:mail'),accounts:(await listAccounts(active.MAILBOX_KV)).length});}
if(p==='/stale'){await env.MAILBOX_KV.put('last-run','stale');await env.MAILBOX_KV.delete('done:mail:m1');await env.MAILBOX_KV.put('account:mail',JSON.stringify({alias:'mail',email:'owner@example.test',scopes:[],sealedRefreshToken:'sealed-stale',linkedAt:'2026-11-14T00:00:00Z'}));return Response.json({ok:true});}
if(p==='/rollback'){const bridge=await resolveAtomicMode({...env,ATOMIC_STATE_MODE:'bridge'});const active=withAtomicState(bridge);return Response.json({mode:bridge.ATOMIC_STATE_MODE,last:await active.MAILBOX_KV.get('last-run'),done:await active.MAILBOX_KV.get('done:mail:m1'),accounts:(await listAccounts(active.MAILBOX_KV)).length,listed:(await active.MAILBOX_KV.list({prefix:'digest:'})).keys.length});}
return new Response(null,{status:404});}};`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'production-migration-test',main:'entry.ts',compatibility_date:'2026-10-01',kv_namespaces:[{binding:'MAILBOX_KV',id:'local'}],durable_objects:{bindings:[{name:'JOB_AUTHORITY',class_name:'JobAuthority'}]},migrations:[{tag:'v1',new_sqlite_classes:['JobAuthority']}]}));
let child;
async function call(path){const response=await fetch(base+path);assert.equal(response.status,200,path);return response.json();}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',v=>output+=v);child.stderr.on('data',v=>output+=v);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(output);try{await fetch(base+'/missing');return;}catch{await delay(100);}}throw new Error(output);}
async function stop(){if(!child||child.exitCode!==null)return;const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGINT');await exited;child=undefined;}
try{await start();await call('/seed');const [migrated,concurrent]=await Promise.all([call('/migrate'),call('/migrate')]);assert.deepEqual(migrated,{last:'2026-11-14T06:30:00Z',done:'1',cursor:null,accounts:1});assert.deepEqual(concurrent,migrated);await call('/stale');const rollback=await call('/rollback');assert.deepEqual(rollback,{mode:'active',last:'2026-11-14T06:30:00Z',done:'1',accounts:0,listed:2});await stop();await start();assert.deepEqual(await call('/rollback'),rollback);console.log('Production migration rehearsal: concurrent import, conservative cursor reset, stale KV exclusion, account identity fence, bridge rollback and restart passed.');}finally{await stop();await rm(dir,{recursive:true,force:true});}
