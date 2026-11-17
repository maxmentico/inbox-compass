// Synthetic-only local workerd Durable Object capacity probe. No production data or bindings.
// Run: node scripts/test-whole-assembly-do-runtime.mjs. Local wall time is not deployed CPU/memory.
import { strict as assert } from 'node:assert';
import { mkdtemp,rm,writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join,resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const dir=await mkdtemp(join(tmpdir(),'whole-assembly-do-')),port=20000+process.pid%20000,base=`http://127.0.0.1:${port}`;
await writeFile(join(dir,'entry.ts'),`import { buildAssemblyManifest,ASSEMBLY_MANIFEST_LIMITS } from ${JSON.stringify(resolve('src/digest.ts'))};
export class Probe {
 async fetch(req){const mode=new URL(req.url).searchParams.get('mode');const cjk=mode==='cjk'||mode==='cjk32',now=new Date('2026-10-24T06:30:00Z'),t=now.toISOString(),items=[],caches=new Map(),histories={},learned=new Map(),lists=new Map(),historyAliases=[];
  for(let m=0;m<10;m++){
   const alias='mail'+m;historyAliases.push(alias);
   const h=i=>({id:alias+'-h'+i,address:'sender@example.com',domain:'example.com',name:'Sender',subject:(cjk?'信':'a').repeat(120),shape:Array.from({length:10},()=>cjk?'测试词':'token'),addressing:'only_you',tab:'primary',important:false,starred:false,conversation:false,attachment:false,flags:[],answers:{sender:'person',request:'direct',stakes:'some',category:'task'},date:t});
   histories[alias]=Array.from({length:500},(_,i)=>h(i));learned.set(alias,Array.from({length:50},(_,i)=>h(500+i)));lists.set(alias,{changed:true,next:Array.from({length:500},(_,i)=>({id:alias+'-r'+i,added:now.getTime()}))});
   for(let i=0;i<50;i++){const id=alias+'-m'+i,meta={threadId:id,from:'sender@example.com',subject:'Synthetic invoice',date:t,snippet:'synthetic'};items.push({...meta,key:alias+':'+id,account:alias,accountEmail:alias+'@example.com',messageId:id,needsAction:true,action:'Review',urgency:'medium',category:'task',due:null,summary:'Review',classified:true,done:false,text:(cjk?'信':'a').repeat(3000)});caches.set(alias+':'+id,{v:3,meta,arrived:now.getTime(),classifiedAt:t});}
  }
  const digest={id:'2026-10-24T06:30:00Z',date:'2026-10-24',generatedAt:t,model:'synthetic',query:'in:inbox',items,accounts:[],modelErrors:[]};
  const prepared={digest,lists,toCache:caches,historyAliases,historyBefore:new Map(),learned,statuses:[],mailboxes:new Map()};
  try{if(mode==='cjk32')ASSEMBLY_MANIFEST_LIMITS.bytes=32*1024*1024;const result=buildAssemblyManifest({now,test:false},[],prepared,{lastRun:null,indexedRuns:[],cursors:{},failureHolds:{},histories});return Response.json({ok:true,encodedBytes:result.encodedBytes,writes:result.writes.length});}catch(e){return Response.json({ok:false,error:String(e)});}finally{ASSEMBLY_MANIFEST_LIMITS.bytes=8*1024*1024;}
 }
}
export default {fetch(req,env){return env.PROBE.get(env.PROBE.idFromName('synthetic')).fetch(req);}};
`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'whole-assembly-probe',main:'entry.ts',compatibility_date:'2026-10-01',compatibility_flags:['nodejs_compat'],durable_objects:{bindings:[{name:'PROBE',class_name:'Probe'}]},migrations:[{tag:'v1',new_sqlite_classes:['Probe']}]}));
let child;
async function run(mode){const started=performance.now(),response=await fetch(`${base}/?mode=${mode}`),body=await response.json();return {...body,wallMs:performance.now()-started};}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>out+=v);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(out);try{await run('ascii');return;}catch{await delay(100);}}throw new Error(out);}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await done;child=undefined;}
try{await start();const ascii=await run('ascii'),cjk=await run('cjk'),cjk32=await run('cjk32');assert.equal(ascii.ok,true);assert.equal(cjk.ok,false);console.log(JSON.stringify({fixture:'500 messages, 10 x 500 prior history records, 10 x 500 rechecks, 3000-character bodies',ascii,cjk,cjk32,note:'cjk32 changes the cap ONLY in this temporary synthetic Worker; local HTTP wall time is not deployed CPU or isolate peak-memory measurement'}));}finally{await stop();await rm(dir,{recursive:true,force:true});}
