// SYNTHETIC / UNWIRED. Independent coordinator-owned reference input for supported bounded
// legacy captures. This loader rejects absent run indexes, oversized captures, malformed records,
// missing result metadata and unauthenticated/stale source state. It is NOT a production loader:
// the 4 MiB reader limit, segmented heads, account migration and independent step-summary proof
// remain unresolved; do not connect it to publication or live data.
import { type Digest,type MailboxPartial,applySettings,isOpen } from './digest';
import { featuresOf,historyEntry,HISTORY_MAX,type HistoryEntry } from './estimate';
import { loadSettings } from './rules';
import type { TrustedAssemblyLoader,TrustedAssemblySnapshot,CredentialFreeRunContext } from './domain-reference-projection';
import type { RunResult } from './jobs';
import { SyntheticTrustedInputReader,type TrustedRawValue } from './synthetic-trusted-input-reader';
import { SyntheticJobContextBinding } from './synthetic-job-context';
import { SyntheticStepResultStore,type SyntheticStepResult } from './synthetic-step-result';
import type { TrustedAssemblySource } from './trusted-assembly-source';
import { SyntheticPartialDriver } from './synthetic-partial-driver';
import { readSyntheticCompactPartial } from './synthetic-compact-partial';
const TTL=30*24*60*60;
type Binding={scope:string;attempt:string;sourceId:string};
/** Must independently verify step-time result semantics; producer-staged metadata is not proof. */
type StepResultAuthority=(sql:SqlStorage,job:string,generation:string,alias:string,result:SyntheticStepResult)=>boolean;
const decoder=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false});
function text(v:TrustedRawValue|undefined):string|null{if(!v||v.kind==='missing'||v.kind==='tombstone')return null;if(v.kind!=='state')throw Error('Invalid state');return decoder.decode(v.bytes);}
function json(v:TrustedRawValue|undefined):unknown{const s=text(v);return s===null?null:JSON.parse(s);}
function array(v:unknown):unknown[]{if(!Array.isArray(v))throw Error('Invalid array state');return v;}
function object(v:unknown):Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('Invalid object state');return v as Record<string,unknown>;}
/** The manifest emits at most 500 combined history entries. Keep only the first 500 old entries
 * not replaced by any learned id; all discarded entries are provably beyond that output prefix. */
export function compactManifestHistory(before:readonly HistoryEntry[],learned:readonly HistoryEntry[]):HistoryEntry[]{
 const ids=new Set(learned.map(entry=>entry.id)),out:HistoryEntry[]=[];
 for(const entry of before){if(!ids.has(entry.id))out.push(entry);if(out.length===HISTORY_MAX)break;}
 return out;
}

export class SyntheticBoundedReferenceLoader implements TrustedAssemblyLoader{
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly source:TrustedAssemblySource,private readonly reader:SyntheticTrustedInputReader,private readonly contexts:SyntheticJobContextBinding,private readonly results:SyntheticStepResultStore,private readonly binding:Binding,private readonly resultAuthority?:StepResultAuthority,private readonly compact?:{driver:SyntheticPartialDriver;ids:Readonly<Record<string,string>>}){this.sql=storage.sql;}
 async load(job:string,generation:string):Promise<TrustedAssemblySnapshot|null>{try{return await this.loadChecked(job,generation);}catch{return null;}}
 private async loadChecked(job:string,generation:string):Promise<TrustedAssemblySnapshot|null>{
  const {scope,attempt,sourceId}=this.binding;
  const skip=this.compact?(sql:SqlStorage,alias:string)=>{const id=this.compact!.ids[alias],info=id&&this.compact!.driver.completedInTransaction(sql,id);return !!info&&info.scope===scope&&info.attempt===attempt&&info.sourceId===sourceId&&info.alias===alias;}:undefined;
  const raw=await this.reader.read({scope,attempt,sourceId,job,generation},skip);if(!raw)return null;
  const capture=this.source.describe(scope,attempt);if(!capture||capture.job!==job||capture.generation!==generation)return null;
  const bound=this.storage.transactionSync(()=>{
   if(!this.source.validateInTransaction(this.sql,scope,attempt))return null;
   const context=this.contexts.readInTransaction(this.sql,job,generation),config=this.sql.exec<{config:string}>('SELECT config FROM core_jobs WHERE job=? AND generation=?',job,generation).toArray()[0];
   if(!context||!config||context.previous!==capture.previousDigest)return null;
   const accounts=raw.rows.map(row=>({alias:row.alias,email:this.source.accountEmailInTransaction(this.sql,scope,attempt,row.alias),result:this.results.readInTransaction(this.sql,job,generation,row.alias)}));
   if(accounts.some(a=>!a.email||!a.result||!this.resultAuthority||this.resultAuthority(this.sql,job,generation,a.alias,a.result)!==true))return null;
   return {context,config:JSON.parse(config.config) as {driver:'web'|'cron'},accounts};
  });if(!bound||!['web','cron'].includes(bound.config.driver))return null;
  if(['state:last-run','state:runs-index','state:settings'].some(key=>!raw.values.has(key)))return null;
  const lastRun=text(raw.values.get('state:last-run'));let indexed=json(raw.values.get('state:runs-index'));
  // A missing index requires history enumeration. The one safe exception is a transactionally
  // verified empty genesis: there is no head, no last run, and no live historical digest key.
  if(indexed===null){const genesis=this.storage.transactionSync(()=>this.source.validateInTransaction(this.sql,scope,attempt)&&raw.head===null&&lastRun===null&&bound.context.previous===null&&!this.sql.exec("SELECT key FROM gen_key_heads WHERE key>=? AND key<? AND kind='put' AND (expires_at IS NULL OR expires_at>?) LIMIT 1",'digest:','digest;',capture.at).toArray().length);if(!genesis)return null;indexed=[];}
  if(!Array.isArray(indexed)||indexed.some(v=>typeof v!=='string'))return null;
  const rawSettings=json(raw.values.get('state:settings'));
  const settings=await loadSettings({get:async()=>rawSettings} as unknown as KVNamespace);
  const doneKeys=new Set<string>();for(const [key,v] of raw.values){if(key.startsWith('state:done:')&&v.kind==='state')doneKeys.add(key.slice('state:done:'.length));}
  let previous:Digest|null=null;
  if(bound.context.previous){const key=`state:digest:${bound.context.previous}`;if(!raw.values.has(key))return null;const v=json(raw.values.get(key));if(v!==null){const o=object(v);if(o.id!==bound.context.previous||!Array.isArray(o.items)||!Array.isArray(o.accounts))return null;previous=o as unknown as Digest;previous.items=previous.items.map(it=>({...it,done:doneKeys.has(it.key)}));}}
  const ticked=new Set(previous?.items.filter(it=>it.done).map(it=>it.key));
  const openIfUnticked=previous?applySettings({...previous,items:previous.items.map(it=>({...it,done:false}))},settings).items.filter(isOpen):[];
  const open=previous?applySettings(previous,settings).items.filter(isOpen):[];
  const partials:MailboxPartial[]=[],rows:RunResult['rows']=[];
  for(const a of bound.accounts){
   const row=raw.rows.find(r=>r.alias===a.alias)!,email=a.email!,result=a.result!;
   if(row.state==='failed'){
    if(result.state!=='failed')return null;
    partials.push({alias:a.alias,status:{alias:a.alias,email,ok:false,found:0,newlyClassified:0,error:result.reason},items:[],toCache:[],learned:[],surfaced:[],replacedCarried:[],errors:[],estimated:0,fromHistory:0,carryOnly:true});rows.push({alias:a.alias,state:'failed',reason:result.reason});continue;
   }
   const value=raw.values.get(`partial:${a.alias}`);
   const p=this.compact?readSyntheticCompactPartial(this.storage,this.compact.driver,this.compact.ids[a.alias]??'',{scope,attempt,sourceId,alias:a.alias}):value?.kind==='partial'?object(JSON.parse(decoder.decode(value.bytes))) as unknown as MailboxPartial:null;
   if(!p)return null;
   if(p.alias!==a.alias||!p.status||!Array.isArray(p.items)||!Array.isArray(p.toCache)||!Array.isArray(p.learned)||!Array.isArray(p.surfaced)||!Array.isArray(p.replacedCarried)||!Array.isArray(p.errors)||p.errors.length||p.status.error)return null;
   partials.push(p);rows.push(result.state==='done'?{alias:a.alias,state:'done',summary:result.summary}:{alias:a.alias,state:'failed',reason:result.reason});
  }
  const cursors:Record<string,unknown>={},failureHolds:Record<string,unknown>={},histories:Record<string,HistoryEntry[]>={};
  for(const p of partials){
   const alias=p.alias;if(['cursor','failures','history','recheck'].some(prefix=>!raw.values.has(`state:${prefix}:${alias}`)))return null;cursors[alias]=json(raw.values.get(`state:cursor:${alias}`));failureHolds[alias]=json(raw.values.get(`state:failures:${alias}`));
   if(cursors[alias]!==null)object(cursors[alias]);if(failureHolds[alias]!==null)object(failureHolds[alias]);
   if(p.learned.length||p.history){
    if(p.history){p.history=compactManifestHistory(p.history,p.learned);histories[alias]=p.history;continue;}
    const before=json(raw.values.get(`state:history:${alias}`));if(before!==null){histories[alias]=compactManifestHistory(array(before) as HistoryEntry[],p.learned);continue;}
    const prefix=`state:cls:${alias}:`,email=bound.accounts.find(a=>a.alias===alias)!.email!.toLowerCase();
    const cache=[...raw.values].filter(([key,v])=>key.startsWith(prefix)&&v.kind==='state').slice(0,5000).map(([key,v])=>({key,v:v as {kind:'state';bytes:Uint8Array;metadata?:unknown;expiresAt?:number|null}}));
    cache.sort((a,b)=>{const at=(x:typeof a)=>{const meta=x.v.metadata as {arrived?:number}|null;return meta?.arrived??((Math.floor((x.v.expiresAt??0)/1000)-TTL)*1000);};return at(b)-at(a);});
    const seed:HistoryEntry[]=[];
    for(const entry of cache.slice(0,HISTORY_MAX)){
     const c=json(entry.v) as {v:number;triage?:Parameters<typeof historyEntry>[2];addressing?:Parameters<typeof featuresOf>[0]['addressing'];source?:string;mailbox?:string;meta?:Parameters<typeof historyEntry>[3]&{from:string;snippet:string}}|null;
     if(!c||c.v!==3||!c.triage||!c.addressing||c.source==='rule'||c.mailbox!==undefined&&c.mailbox!==email)continue;
     if(!c.meta)throw Error('Invalid cache metadata');const f=featuresOf({from:c.meta.from,subject:c.meta.subject,text:c.meta.snippet,addressing:c.addressing,conversation:false,attachments:[]});seed.push(historyEntry(entry.key.slice(prefix.length),f,c.triage,c.meta));
    }
    histories[alias]=compactManifestHistory(seed.sort((a,b)=>(b.date??'').localeCompare(a.date??'')),p.learned);
   }
  }
  const now=new Date(bound.context.now),share=Math.max(1,Math.min(bound.context.cfg.maxPerAccount,Math.floor(500/Math.max(1,raw.rows.length))));
  const context:CredentialFreeRunContext={opts:{window:bound.context.window,reclassify:false,test:false},window:bound.context.window,now,test:false,cfg:bound.context.cfg,date:bound.context.date,settings,accounts:bound.accounts.map(a=>({alias:a.alias,email:a.email!})),share,fullShare:share,open,openIfUnticked,ticked,jobId:job,jobRunId:bound.context.run};
  const result:RunResult={job,digest:bound.context.run,driver:bound.config.driver,test:false,rows,started:bound.context.started,finished:raw.at};
  if(!this.storage.transactionSync(()=>this.source.validateInTransaction(this.sql,scope,attempt)))return null;
  return {job,generation,sourceId,previousHead:raw.head,versions:raw.versions,context,partials,marks:{doneKeys},state:{lastRun,indexedRuns:indexed as string[],cursors:cursors as TrustedAssemblySnapshot['state']['cursors'],failureHolds:failureHolds as TrustedAssemblySnapshot['state']['failureHolds'],histories},result,ttlBaseMs:raw.at};
 }
}
