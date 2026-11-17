// SYNTHETIC, UNWIRED read adapter. It chooses the format from the single gen_head. It does not
// authenticate callers, migrate data, provide inventory/purge, or make either store production-ready.
import type { SegmentedGeneration } from './segmented-generation';
type Cursor={kind:'legacy';index:number}|{kind:'segmented';offset:number};
type Result={kind:'changed'|'missing'|'corrupt'}|{kind:'value';bytes:Uint8Array;next:Cursor|null;expiresAt:number|null;metadata:unknown};
export class UnifiedGenerationReader {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly segmented:SegmentedGeneration){this.sql=storage.sql;}
 private head():string|null{return this.sql.exec<{generation:string}>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation??null;}
 async read(head:string|null,key:string,cursor:Cursor|null=null):Promise<Result>{
  if(typeof key!=='string'||!key.length||key.length>256)return {kind:'missing'};
  const mode=this.storage.transactionSync(()=>{
   if(this.head()!==head)return 'changed' as const;
   return head&&this.sql.exec('SELECT scope FROM sgen_committed WHERE scope=?',head).toArray().length?'segmented' as const:'legacy' as const;
  });
  if(mode==='changed'||(cursor&&cursor.kind!==mode))return {kind:'changed'};
  if(mode==='segmented'){
   const offset=cursor?.kind==='segmented'?cursor.offset:0;
   const result=await this.segmented.read(head,key,offset);
   if(result.kind!=='value')return result;
   return {...result,next:result.next===null?null:{kind:'segmented',offset:result.next}};
  }
  const index=cursor?.kind==='legacy'?cursor.index:0;
  if(!Number.isSafeInteger(index)||index<0||index>=160)return {kind:'missing'};
  const selected=this.storage.transactionSync(()=>{
   if(this.head()!==head)return {kind:'changed' as const};
   const row=this.sql.exec<{generation:string;preparation:string;kind:string;expires_at:number|null;metadata:string|null;chunks:number}>('SELECT generation,preparation,kind,expires_at,metadata,chunks FROM gen_key_heads WHERE key=?',key).toArray()[0];
   if(!row||row.kind==='delete'||(row.expires_at!==null&&row.expires_at<=Date.now())||index>=Math.max(1,row.chunks))return {kind:'missing' as const};
   if(row.chunks===0)return {kind:'empty' as const,row};
   const part=this.sql.exec<{data:string;hash:string;bytes:number}>('SELECT data,hash,bytes FROM gen_chunks WHERE generation=? AND preparation=? AND key=? AND idx=?',row.generation,row.preparation,key,index).toArray()[0];
   return part?{kind:'chunk' as const,row,part}:{kind:'corrupt' as const};
  });
  if(selected.kind==='changed'||selected.kind==='missing'||selected.kind==='corrupt')return selected;
  if(selected.kind==='empty')return {kind:'value',bytes:new Uint8Array(),next:null,expiresAt:selected.row.expires_at,metadata:selected.row.metadata?JSON.parse(selected.row.metadata):null};
  let bytes:Uint8Array;try{bytes=Uint8Array.from(atob(selected.part.data),c=>c.charCodeAt(0));}catch{return {kind:'corrupt'};}
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(bytes.length!==selected.part.bytes||hash!==selected.part.hash)return {kind:'corrupt'};
  if(this.head()!==head)return {kind:'changed'};
  if(selected.row.expires_at!==null&&selected.row.expires_at<=Date.now())return {kind:'missing'};
  return {kind:'value',bytes,next:index+1<selected.row.chunks?{kind:'legacy',index:index+1}:null,expiresAt:selected.row.expires_at,metadata:selected.row.metadata?JSON.parse(selected.row.metadata):null};
 }
}
