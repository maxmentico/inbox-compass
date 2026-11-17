// SYNTHETIC / UNWIRED. Reconstruct a bounded reference partial from independently verified,
// completed DTO pages. Two passes avoid holding the full original history in JS memory.
import type { MailboxPartial } from './digest';
import { HISTORY_MAX,type HistoryEntry } from './estimate';
import { SyntheticPartialDriver } from './synthetic-partial-driver';
const MAX_PROJECTED_BYTES=12*1024*1024,MAX_PAGES=10000;
type Obj=Record<string,any>;
export function readSyntheticCompactPartial(storage:DurableObjectStorage,driver:SyntheticPartialDriver,id:string,binding:{scope:string;attempt:string;sourceId:string;alias:string}):MailboxPartial|null{
 try{
  const sql=storage.sql,info=storage.transactionSync(()=>driver.completedInTransaction(sql,id));
  if(!info||info.scope!==binding.scope||info.attempt!==binding.attempt||info.sourceId!==binding.sourceId||info.alias!==binding.alias||info.pages<1||info.pages>MAX_PAGES)return null;
  const page=(i:number)=>storage.transactionSync(()=>driver.pageInTransaction(sql,id,i));
  const ids=new Set<string>();
  // Learned ids can occur after history in the original JSON; do not infer completeness from order.
  for(let i=0;i<info.pages;i++){const records=page(i);if(!records)return null;for(const v of records){const r=v as Obj;if(r.kind==='history'&&r.list==='learned'){if(!r.value||typeof r.value.id!=='string')return null;ids.add(r.value.id);}}}
  let metadata:Obj|null=null,run:Obj|null=null,bytes=0;
  const lists=new Map<string,{present:boolean;count:number}>(),counts=new Map<string,number>();
  const items:Obj[]=[],cache:[string,unknown][]=[],learned:HistoryEntry[]=[],history:HistoryEntry[]=[],before:Obj[]=[],settled:string[]=[],estimated:string[]=[],seenTimes:number[]=[],surfaced:string[]=[],replacedCarried:string[]=[];
  const count=(key:string)=>counts.set(key,(counts.get(key)??0)+1);
  for(let i=0;i<info.pages;i++){
   const records=page(i);if(!records)return null;
   for(const v of records){
    if(!v||typeof v!=='object'||Array.isArray(v))return null;const r=v as Obj;
    if(r.kind==='partial-list'){if(r.account!==binding.alias||lists.has(r.list)||typeof r.present!=='boolean'||!Number.isSafeInteger(r.count))return null;lists.set(r.list,{present:r.present,count:r.count});continue;}
    if(r.kind==='mailbox-partial'){if(metadata||r.account!==binding.alias)return null;metadata=r;continue;}
    if(r.kind==='mailbox-run'){if(run||r.account!==binding.alias)return null;run=r;continue;}
    let retained:unknown;
    if(r.kind==='item'){
     if(r.collection!=='partial'||r.account!==binding.alias||items.length>=500)return null;
     const {kind:_k,version:_v,scope:_s,sequence:_q,collection:_c,...item}=r;items.push(item);retained=item;count('items');
    }else if(r.kind==='cache'){
     if(r.account!==binding.alias)return null;const entry:[string,unknown]=[`${binding.alias}:${r.messageId}`,r.value];cache.push(entry);retained=entry;count('toCache');
    }else if(r.kind==='history'){
     if(r.account!==binding.alias||!r.value||typeof r.value.id!=='string')return null;
     if(r.list==='learned'){learned.push(r.value);retained=r.value;count('learned');}
     else if(r.list==='before'){count('history');if(!ids.has(r.value.id)&&history.length<HISTORY_MAX){history.push(r.value);retained=r.value;}}
     else return null;
    }else if(r.kind==='recheck'){
     if(r.account!==binding.alias)return null;const key=`recheck.${r.list}`;count(key);
     if(r.list==='before'){const x={id:r.messageId,added:r.added};before.push(x);retained=x;}
     else if(r.list==='settled'){settled.push(r.messageId);retained=r.messageId;}
     else if(r.list==='estimated'){estimated.push(r.messageId);retained=r.messageId;}else return null;
    }else if(r.kind==='seen-times'){
     if(r.account!==binding.alias||!Array.isArray(r.values)||r.values.length!==1||r.chunk!==seenTimes.length)return null;seenTimes.push(r.values[0]);retained=r.values[0];count('run.seenTimes');
    }else if(r.kind==='item-flag'){
     if(r.list==='surfaced'){surfaced.push(r.key);count('surfaced');}else if(r.list==='replaced-carried'){replacedCarried.push(r.key);count('replacedCarried');}else return null;retained=r.key;
    }else return null;
    if(retained!==undefined){bytes+=new TextEncoder().encode(JSON.stringify(retained)).length;if(bytes>MAX_PROJECTED_BYTES)return null;}
   }
  }
  if(!metadata||!['items','toCache','learned','surfaced','replacedCarried','errors'].every(k=>lists.get(k)?.present))return null;
  for(const [key,value] of lists){if((counts.get(key)??0)!==value.count)return null;}
  if(lists.get('recheck')?.present&&!['recheck.before','recheck.settled','recheck.estimated'].every(k=>lists.get(k)?.present))return null;
  if(lists.get('run')?.present&&(!run||!lists.get('run.seenTimes')?.present))return null;
  const m=metadata;
  const p={alias:binding.alias,status:m.status,items,toCache:cache,learned,surfaced,replacedCarried,errors:[],estimated:m.estimated,fromHistory:m.fromHistory,
   ...(m.windowStart===undefined?{}:{windowStart:m.windowStart}),...(m.carryOnly===undefined?{}:{carryOnly:m.carryOnly}),...(m.unavailable===undefined?{}:{unavailable:m.unavailable}),
   ...(lists.get('history')?.present?{history}:{}),
   ...(lists.get('recheck')?.present?{recheck:{before,settled,estimated}}:{}),
   ...(run?{run:{before:run.before,seenTimes,backlog:run.backlog,...(run.share===undefined?{}:{share:run.share}),...(run.full===undefined?{}:{full:run.full})}}:{})} as unknown as MailboxPartial;
  const last=storage.transactionSync(()=>driver.completedInTransaction(sql,id));if(!last||JSON.stringify(last)!==JSON.stringify(info))return null;
  return p;
 }catch{return null;}
}
