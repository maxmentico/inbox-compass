// Singleton coordination and atomic generation authority. Do not expose this API publicly.
// Owner and attempt capabilities must be fresh, unguessable and never logged or put in URLs.

import { AtomicGenerationAuthority } from "./atomic-generation-authority";

export const JOB_AUTHORITY_LEASE_MS = 10 * 60_000;
export const JOB_AUTHORITY_CLAIM_MIN_MS = 2 * 60_000;
export const JOB_AUTHORITY_CLAIM_MAX_MS = 10 * 60_000;
const MAX_BODY = 8192, MAX_STAGE_BODY = 160 * 1024, MAX_STEPS = 64;
const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const STEP = /^[A-Za-z0-9:_-]{1,128}$/;
const KEY = /^[A-Za-z0-9:_.-]{1,256}$/;

export type JobAuthorityHolder = { at: string; job: string; driver: 'web' | 'cron' };
export type JobAuthorityStep = { step: string; generation: number; state: 'running' | 'failed' | 'complete'; deadline: number | null; resultKey?: string };
export type JobAuthorityReply = { ok: boolean; reason?: 'busy' | 'stale' | 'expired' | 'capacity' | 'conflict' };
export type JobAuthorityClaim = JobAuthorityReply & { generation?: number; deadline?: number };
export type JobAuthorityView = JobAuthorityReply & { holder?: JobAuthorityHolder | null; expiresAt?: number | null; steps?: JobAuthorityStep[] };
export type JobAuthorityResult = JobAuthorityReply & { resultKey?: string };
type Lease = { owner: string; holder: string; expires: number };
type StoredStep = { owner: string; step: string; generation: number; attempt: string; state: 'running' | 'failed' | 'complete'; deadline: number | null; ttl: number; result_key: string | null };

function holderValid(value: unknown): value is JobAuthorityHolder {
 if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
 const v=value as Record<string,unknown>;
 return Object.keys(v).length===3 && Object.keys(v).every(k=>['at','job','driver'].includes(k)) && typeof v.at==='string' && v.at.length<=40 && Number.isFinite(Date.parse(v.at)) && typeof v.job==='string' && TOKEN.test(v.job) && (v.driver==='web'||v.driver==='cron');
}
function validKeys(v:Record<string,unknown>,keys:readonly string[]):boolean{return Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));}
function ttlValid(v:unknown):v is number{return Number.isSafeInteger(v) && (v as number)>=JOB_AUTHORITY_CLAIM_MIN_MS && (v as number)<=JOB_AUTHORITY_CLAIM_MAX_MS;}
async function bodyJson(req:Request,max=MAX_BODY):Promise<unknown>{
 const declared=req.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>max))throw new Error('invalid body');
 if(!req.body)throw new Error('missing body');const reader=req.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});let size=0,text='';
 for(;;){const part=await reader.read();if(part.done)break;size+=part.value.length;if(size>max){void reader.cancel().catch(()=>{});throw new Error('body too large');}text+=decoder.decode(part.value,{stream:true});}
 text+=decoder.decode();return JSON.parse(text) as unknown;
}

/** SQLite transactions serialize lease and step transitions across all Worker invocations. */
export class JobAuthority {
 private readonly storage:DurableObjectStorage;
 private readonly sql:SqlStorage;
 private readonly atomic:AtomicGenerationAuthority;
 constructor(state:DurableObjectState){
  this.storage=state.storage;this.sql=state.storage.sql;
  this.atomic=new AtomicGenerationAuthority(state.storage);
  this.sql.exec('CREATE TABLE IF NOT EXISTS job_authority_lease (id INTEGER PRIMARY KEY CHECK(id=1),owner TEXT NOT NULL,holder TEXT NOT NULL,expires INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS job_authority_owners (owner TEXT PRIMARY KEY,released INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS job_authority_attempts (attempt TEXT PRIMARY KEY)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS job_authority_steps (owner TEXT NOT NULL,step TEXT NOT NULL,generation INTEGER NOT NULL,attempt TEXT NOT NULL,state TEXT NOT NULL,deadline INTEGER,ttl INTEGER NOT NULL,result_key TEXT,PRIMARY KEY(owner,step))');
  this.sql.exec('CREATE TABLE IF NOT EXISTS job_authority_result_keys (result_key TEXT PRIMARY KEY)');
 }
 private lease(now:number):Lease|null{const row=this.sql.exec<Lease>('SELECT owner,holder,expires FROM job_authority_lease WHERE id=1').toArray()[0];return row&&row.expires>now?row:null;}
 private step(owner:string,step:string):StoredStep|undefined{return this.sql.exec<StoredStep>('SELECT owner,step,generation,attempt,state,deadline,ttl,result_key FROM job_authority_steps WHERE owner=? AND step=?',owner,step).toArray()[0];}
 async fetch(request:Request):Promise<Response>{
  const op=new URL(request.url).pathname.slice(1),allowed=['acquire','inspect','claim','renew','complete','failExpired','release','snapshot','resolve'];
  if(op.startsWith('state/'))return this.atomicFetch(op.slice(6),request);
  if(request.method!=='POST'||!allowed.includes(op))return new Response(null,{status:404});
  let input:unknown;try{input=await bodyJson(request);}catch{return new Response(null,{status:400});}
  if(!input||typeof input!=='object'||Array.isArray(input))return new Response(null,{status:400});const v=input as Record<string,unknown>;
  const keys:Record<string,string[]>={acquire:['owner','holder'],inspect:[],claim:['owner','step','attempt','expectedGeneration','ttlMs'],renew:['owner','step','attempt'],complete:['owner','step','attempt','resultKey'],failExpired:['owner','step','expectedGeneration'],release:['owner'],snapshot:['owner'],resolve:['owner','step']};
  if(!validKeys(v,keys[op]!))return new Response(null,{status:400});
  if('owner'in v&&(typeof v.owner!=='string'||!TOKEN.test(v.owner)))return new Response(null,{status:400});
  if('step'in v&&(typeof v.step!=='string'||!STEP.test(v.step)))return new Response(null,{status:400});
  if('attempt'in v&&(typeof v.attempt!=='string'||!TOKEN.test(v.attempt)))return new Response(null,{status:400});
  if('expectedGeneration'in v&&(!Number.isSafeInteger(v.expectedGeneration)||(v.expectedGeneration as number)<0))return new Response(null,{status:400});
  if(op==='claim'&&(!ttlValid(v.ttlMs)||(v.step as string).includes(v.owner as string)||(v.step as string).includes(v.attempt as string))||op==='acquire'&&(!holderValid(v.holder)||(v.holder as JobAuthorityHolder).job.includes(v.owner as string))||op==='complete'&&(typeof v.resultKey!=='string'||!KEY.test(v.resultKey)||v.resultKey.includes(v.owner as string)||v.resultKey.includes(v.attempt as string)))return new Response(null,{status:400});
  return this.storage.transactionSync(()=>{
   const now=Date.now(),lease=this.lease(now),owner=v.owner as string,step=v.step as string,attempt=v.attempt as string;
   if(op==='inspect'){
    const holder=lease?JSON.parse(lease.holder) as JobAuthorityHolder:null;
    return Response.json({ok:true,holder,expiresAt:lease?.expires??null});
   }
   if(op==='acquire'){
    const h=v.holder as JobAuthorityHolder,holder=JSON.stringify({at:h.at,job:h.job,driver:h.driver});
    if(lease){if(lease.owner!==owner)return Response.json({ok:false,reason:'busy'});return Response.json({ok:lease.holder===holder,...(lease.holder===holder?{}:{reason:'conflict'})});}
    if(this.sql.exec('SELECT owner FROM job_authority_owners WHERE owner=?',owner).toArray().length)return Response.json({ok:false,reason:'stale'});
    this.sql.exec('INSERT INTO job_authority_owners VALUES (?,0)',owner);
    this.sql.exec('INSERT OR REPLACE INTO job_authority_lease VALUES (1,?,?,?)',owner,holder,now+JOB_AUTHORITY_LEASE_MS);return Response.json({ok:true});
   }
   if(op==='release'){
    if(!lease||lease.owner!==owner){const prior=this.sql.exec<{released:number}>('SELECT released FROM job_authority_owners WHERE owner=?',owner).toArray()[0];return Response.json({ok:prior?.released===1,...(prior?.released===1?{}:{reason:'stale'})});}
    this.sql.exec('UPDATE job_authority_owners SET released=1 WHERE owner=?',owner);this.sql.exec('DELETE FROM job_authority_lease WHERE id=1');return Response.json({ok:true});
   }
   if(!lease||lease.owner!==owner)return Response.json({ok:false,reason:'stale'});
   if(op==='snapshot'){
    const steps=this.sql.exec<{step:string;generation:number;state:JobAuthorityStep['state'];deadline:number|null;result_key:string|null}>('SELECT step,generation,state,deadline,result_key FROM job_authority_steps WHERE owner=? ORDER BY step',owner).toArray().map(row=>({step:row.step,generation:row.generation,state:row.state,deadline:row.deadline,...(row.state==='complete'&&row.result_key?{resultKey:row.result_key}:{})}));
    return Response.json({ok:true,holder:JSON.parse(lease.holder) as JobAuthorityHolder,expiresAt:lease.expires,steps});
   }
   const current=this.step(owner,step);
   if(op==='claim'){
    const expected=v.expectedGeneration as number;
    if((JSON.parse(lease.holder) as JobAuthorityHolder).job.includes(attempt)||this.sql.exec('SELECT step FROM job_authority_steps WHERE owner=? AND (instr(step,?)>0 OR instr(COALESCE(result_key,\'\'),?)>0) LIMIT 1',owner,attempt,attempt).toArray().length)return Response.json({ok:false,reason:'conflict'});
    if(current?.state==='running'&&current.attempt===attempt&&current.generation===expected+1&&current.deadline!==null&&current.deadline>now&&current.ttl===v.ttlMs){this.sql.exec('UPDATE job_authority_lease SET expires=? WHERE id=1',now+JOB_AUTHORITY_LEASE_MS);return Response.json({ok:true,generation:current.generation,deadline:current.deadline});}
    if((current?.generation??0)!==expected||current?.state==='complete'||current?.state==='running')return Response.json({ok:false,reason:'conflict'});
    if(!current&&(this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM job_authority_steps WHERE owner=?',owner).toArray()[0]?.n??0)>=MAX_STEPS)return Response.json({ok:false,reason:'capacity'});
    if(this.sql.exec('SELECT attempt FROM job_authority_attempts WHERE attempt=?',attempt).toArray().length)return Response.json({ok:false,reason:'stale'});
    if(expected>=Number.MAX_SAFE_INTEGER)return Response.json({ok:false,reason:'capacity'});
    const generation=expected+1,deadline=now+(v.ttlMs as number);this.sql.exec('INSERT INTO job_authority_attempts VALUES (?)',attempt);
    this.sql.exec("INSERT OR REPLACE INTO job_authority_steps VALUES (?,?,?,?,'running',?,?,NULL)",owner,step,generation,attempt,deadline,v.ttlMs as number);
    this.sql.exec('UPDATE job_authority_lease SET expires=? WHERE id=1',now+JOB_AUTHORITY_LEASE_MS);
    return Response.json({ok:true,generation,deadline});
   }
   if(op==='renew'){
    if(!current||current.state!=='running'||current.attempt!==attempt||current.deadline===null||current.deadline<=now)return Response.json({ok:false,reason:'stale'});
    const deadline=now+current.ttl;this.sql.exec('UPDATE job_authority_steps SET deadline=? WHERE owner=? AND step=?',deadline,owner,step);this.sql.exec('UPDATE job_authority_lease SET expires=? WHERE id=1',now+JOB_AUTHORITY_LEASE_MS);return Response.json({ok:true,generation:current.generation,deadline});
   }
   if(op==='complete'){
    if(!current||current.attempt!==attempt)return Response.json({ok:false,reason:'stale'});
    const key=v.resultKey as string;
    if(current.state==='complete')return Response.json({ok:current.result_key===key,...(current.result_key===key?{}:{reason:'conflict'})});
    if(current.state!=='running'||current.deadline===null||current.deadline<=now)return Response.json({ok:false,reason:'expired'});
    if(this.sql.exec('SELECT step FROM job_authority_steps WHERE owner=? AND instr(?,attempt)>0 LIMIT 1',owner,key).toArray().length)return Response.json({ok:false,reason:'conflict'});
    if(this.sql.exec('SELECT result_key FROM job_authority_result_keys WHERE result_key=?',key).toArray().length)return Response.json({ok:false,reason:'conflict'});
    this.sql.exec('INSERT INTO job_authority_result_keys VALUES (?)',key);this.sql.exec("UPDATE job_authority_steps SET state='complete',deadline=NULL,result_key=? WHERE owner=? AND step=?",key,owner,step);return Response.json({ok:true});
   }
   if(op==='failExpired'){
    if(!current||current.generation!==v.expectedGeneration)return Response.json({ok:false,reason:'stale'});
    if(current.state==='failed')return Response.json({ok:true});
    if(current.state!=='running'||current.deadline===null||current.deadline>now)return Response.json({ok:false,reason:'conflict'});
    this.sql.exec("UPDATE job_authority_steps SET state='failed',deadline=NULL WHERE owner=? AND step=?",owner,step);return Response.json({ok:true});
   }
   if(op==='resolve')return current?.state==='complete'&&current.result_key?Response.json({ok:true,resultKey:current.result_key}):Response.json({ok:false,reason:'stale'});
   return new Response(null,{status:404});
  });
 }
 async alarm():Promise<void>{if(this.atomic.cleanup())await this.storage.setAlarm(Date.now()+1_000);else await this.storage.setAlarm(Date.now()+60*60_000);}
 private async atomicFetch(op:string,request:Request):Promise<Response>{
  if(request.method!=='POST')return new Response(null,{status:404});
  let input:unknown;try{input=await bodyJson(request,['chunk','batch','mutate','read-many'].includes(op)?MAX_STAGE_BODY:MAX_BODY);}catch{return new Response(null,{status:400});}
  if(!input||typeof input!=='object'||Array.isArray(input))return new Response(null,{status:400});
  const v=input as Record<string,unknown>;
  try{
   if(!['head','read','read-many','list','pin'].includes(op))await this.storage.setAlarm(Date.now()+60*60_000);
   if(op==='head')return Response.json({head:this.atomic.getHead()});
   if(op==='bootstrap')return Response.json({ok:this.atomic.beginBootstrap(v as Parameters<AtomicGenerationAuthority['beginBootstrap']>[0])});
   if(op==='begin')return Response.json({ok:this.atomic.begin(v as Parameters<AtomicGenerationAuthority['begin']>[0])});
   if(op==='chunk')return Response.json({ok:await this.atomic.putChunk(v as Parameters<AtomicGenerationAuthority['putChunk']>[0])});
   if(op==='batch')return Response.json({ok:await this.atomic.putBatch(v as Parameters<AtomicGenerationAuthority['putBatch']>[0])});
   if(op==='entry')return Response.json({ok:this.atomic.setEntry(v as Parameters<AtomicGenerationAuthority['setEntry']>[0])});
   if(op==='seal')return Response.json({ok:this.atomic.seal(v.stage as string,v.entries as number,v.bytes as number)});
   if(op==='commit')return Response.json(this.atomic.commit(v.stage as string));
   if(op==='mutate')return Response.json(await this.atomic.mutate(v as Parameters<AtomicGenerationAuthority['mutate']>[0]));
   if(op==='list'){
    const result=this.atomic.list(v.seq as number,v.prefix as string,(v.after as string|null)??null,v.limit as number);return result?Response.json(result):new Response(null,{status:400});
   }
   if(op==='barrier-begin')return Response.json(this.atomic.barrierBegin(v.operation as string,v.generation as string,v.kind as string));
   if(op==='barrier-end')return Response.json(this.atomic.barrierEnd(v.operation as string,v.generation as string));
   if(op==='bridge-begin')return Response.json({ok:this.atomic.bridgeBegin(v.operation as string,v.kind as string)});
   if(op==='bridge-end')return Response.json({ok:this.atomic.bridgeEnd(v.operation as string)});
   if(op==='pin'){
    const result=this.atomic.pin(v.pin as string,v.seq as number|undefined);return result?Response.json(result):new Response(null,{status:404});
   }
   if(op==='read'){
    const result=this.atomic.read(v.seq as number,v.key as string);
    if(result.kind!=='value')return Response.json(result);
    let raw='';for(const part of result.chunks){const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',part.data.slice().buffer as ArrayBuffer))].map(b=>b.toString(16).padStart(2,'0')).join('');if(digest!==part.hash||part.data.length!==part.bytes)return new Response(null,{status:409});for(let i=0;i<part.data.length;i+=0x8000)raw+=String.fromCharCode(...part.data.subarray(i,i+0x8000));}
    return Response.json({kind:'value',data:btoa(raw),metadata:result.metadata,expiresAt:result.expiresAt});
   }
   if(op==='read-many'){
    if(!Number.isSafeInteger(v.seq)||(v.seq as number)<1||!Array.isArray(v.keys)||v.keys.length<1||v.keys.length>100||v.keys.some(key=>typeof key!=='string'))return new Response(null,{status:400});
    const keys=v.keys as string[];if(new Set(keys).size!==keys.length)return new Response(null,{status:400});
    const items=[];
    for(const key of keys){
     const result=this.atomic.read(v.seq as number,key);
     if(result.kind!=='value'){items.push({key,...result});continue;}
     let raw='';for(const part of result.chunks){const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',part.data.slice().buffer as ArrayBuffer))].map(b=>b.toString(16).padStart(2,'0')).join('');if(digest!==part.hash||part.data.length!==part.bytes)return new Response(null,{status:409});for(let i=0;i<part.data.length;i+=0x8000)raw+=String.fromCharCode(...part.data.subarray(i,i+0x8000));}
     items.push({key,kind:'value',data:btoa(raw),metadata:result.metadata,expiresAt:result.expiresAt});
    }
    return Response.json({items});
   }
  }catch{return new Response(null,{status:409});}
  return new Response(null,{status:404});
 }
}

/** Typed internal-only client. `null` means unavailable/invalid response: never fall back to KV. */
export class JobAuthorityClient {
 constructor(private readonly namespace:DurableObjectNamespace,private readonly singleton='owner'){}
 private async call<T extends JobAuthorityReply>(op:string,data:unknown,valid?:(v:Record<string,unknown>)=>boolean):Promise<T|null>{
  try{const stub=this.namespace.get(this.namespace.idFromName(this.singleton)),response=await stub.fetch(new Request(`https://job-authority.internal/${op}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(data)}));if(!response.ok)return null;const raw:unknown=await response.json();if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;const v=raw as Record<string,unknown>;if(typeof v.ok!=='boolean')return null;if(!v.ok){if(!validKeys(v,['ok','reason'])||typeof v.reason!=='string'||!['busy','stale','expired','capacity','conflict'].includes(v.reason))return null;}else if(valid?!valid(v):!validKeys(v,['ok']))return null;return raw as T;}catch{return null;}
 }
 acquire(owner:string,holder:JobAuthorityHolder){return this.call<JobAuthorityReply>('acquire',{owner,holder});}
 inspect(){return this.call<JobAuthorityView>('inspect',{},v=>v.ok===false||validKeys(v,['ok','holder','expiresAt'])&&(v.holder===null||holderValid(v.holder))&&(v.expiresAt===null||Number.isSafeInteger(v.expiresAt)));}
 claim(owner:string,step:string,attempt:string,expectedGeneration:number,ttlMs:number){return this.call<JobAuthorityClaim>('claim',{owner,step,attempt,expectedGeneration,ttlMs},v=>validKeys(v,['ok','generation','deadline'])&&Number.isSafeInteger(v.generation)&&Number.isSafeInteger(v.deadline));}
 renew(owner:string,step:string,attempt:string){return this.call<JobAuthorityClaim>('renew',{owner,step,attempt},v=>validKeys(v,['ok','generation','deadline'])&&Number.isSafeInteger(v.generation)&&Number.isSafeInteger(v.deadline));}
 complete(owner:string,step:string,attempt:string,resultKey:string){return this.call<JobAuthorityReply>('complete',{owner,step,attempt,resultKey});}
 failExpired(owner:string,step:string,expectedGeneration:number){return this.call<JobAuthorityReply>('failExpired',{owner,step,expectedGeneration});}
 release(owner:string){return this.call<JobAuthorityReply>('release',{owner});}
 snapshot(owner:string){return this.call<JobAuthorityView>('snapshot',{owner},v=>v.ok===false||validKeys(v,['ok','holder','expiresAt','steps'])&&(v.holder===null||holderValid(v.holder))&&(v.expiresAt===null||Number.isSafeInteger(v.expiresAt))&&Array.isArray(v.steps)&&v.steps.length<=MAX_STEPS&&v.steps.every(s=>s&&typeof s==='object'&&validKeys(s,s.state==='complete'?['step','generation','state','deadline','resultKey']:['step','generation','state','deadline'])&&typeof s.step==='string'&&STEP.test(s.step)&&Number.isSafeInteger(s.generation)&&['running','failed','complete'].includes(s.state)&&(s.deadline===null||Number.isSafeInteger(s.deadline))&&(s.state!=='complete'||typeof s.resultKey==='string'&&KEY.test(s.resultKey))));}
 resolve(owner:string,step:string){return this.call<JobAuthorityResult>('resolve',{owner,step},v=>validKeys(v,['ok','resultKey'])&&typeof v.resultKey==='string'&&KEY.test(v.resultKey));}
}

export { JobAuthority as InboxJobAuthority };
