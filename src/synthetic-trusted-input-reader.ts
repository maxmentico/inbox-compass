// SYNTHETIC ONLY. Bounded independent read of a coordinator-authenticated source inventory.
// This is an input reader, not an assembly loader or proof of semantic completeness. In particular
// it does not yet reconstruct job-start previous state, mailbox result rows or seeded histories.
import type { TrustedAssemblySource, TrustedInventoryEntry } from './trusted-assembly-source';
import type { SyntheticSourceAuthority } from './synthetic-job-bound-stage';

const DEFAULT_BYTES=4*1024*1024, EXPERIMENTAL_MAX_BYTES=12*1024*1024, MAX_KEYS=4096, PAGE=32;
const TOKEN=/^[A-Za-z0-9_-]{22,128}$/;
const HASH=/^[a-f0-9]{64}$/;
const sha=async (bytes:Uint8Array)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(v=>v.toString(16).padStart(2,'0')).join('');
export type TrustedRawValue={kind:'partial'|'state';bytes:Uint8Array;expiresAt?:number|null;metadata?:unknown}|{kind:'missing'|'tombstone'};
export type TrustedRawInput={job:string;generation:string;sourceId:string;head:string|null;versions:{key:string;version:number}[];at:number;rows:{alias:string;identity:string;state:string;partial:string|null;partial_count:number|null}[];values:Map<string,TrustedRawValue>};

export class SyntheticTrustedInputReader {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly source:TrustedAssemblySource,private readonly authority:SyntheticSourceAuthority,private readonly maxBytes=DEFAULT_BYTES){this.sql=storage.sql;if(!Number.isSafeInteger(maxBytes)||maxBytes<1||maxBytes>EXPERIMENTAL_MAX_BYTES)throw Error('Invalid synthetic input byte cap');}
 /** The default 4 MiB cap is encoded input, not a JS heap limit. A larger opt-in is experimental. */
 async read(input:{scope:string;job:string;generation:string;attempt:string;sourceId:string},skipPartial?:(sql:SqlStorage,alias:string)=>boolean):Promise<TrustedRawInput|null>{
  if(!input||![input.scope,input.job,input.generation,input.attempt].every(x=>typeof x==='string'&&TOKEN.test(x))||!HASH.test(input.sourceId))return null;
  const snap=this.source.describe(input.scope,input.attempt);
  if(!snap||snap.job!==input.job||snap.generation!==input.generation||snap.rows.some(r=>r.state!=='done'&&r.state!=='failed'))return null;
  const versions=JSON.stringify(snap.versions.map(v=>({key:v.key,value:v.version})));
  const current=()=>this.storage.transactionSync(()=>{
   const p=this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM synthetic_packed_proof WHERE scope=? AND job=? AND generation=? AND attempt=? AND source_id=? AND complete=1',input.scope,input.job,input.generation,input.attempt,input.sourceId).toArray()[0];
   return p?.n===1&&this.source.validateInTransaction(this.sql,input.scope,input.attempt)&&this.authority(this.sql,input.job,input.generation,input.sourceId,versions)===true;
  });
  if(!current())return null;
  const values=new Map<string,TrustedRawValue>(),parts=new Map<string,Uint8Array[]>(),meta=new Map<string,string>(),skipped=new Map<string,number>();
  let total=0,count=0,after:string|null=null;
  for(;;){
   const page=this.storage.transactionSync(()=>this.source.inventoryPageInTransaction(this.sql,input.scope,input.attempt,after,PAGE));
   if(!page||page.entries.length>PAGE||page.next!==null&&(!page.entries.length||page.next!==page.entries.at(-1)?.cursor))return null;
   for(const entry of page.entries){
    if(++count>MAX_KEYS||!this.validEntry(entry))return null;
    if(entry.kind==='partial'&&skipPartial){
     if(!this.storage.transactionSync(()=>skipPartial(this.sql,entry.key))||entry.index!==(skipped.get(entry.key)??0)||entry.bytes<1||entry.hash===null)return null;
     skipped.set(entry.key,entry.index+1);continue;
    }
    const id=`${entry.kind==='partial'?'partial':'state'}:${entry.key}`;
    if(entry.kind==='missing'||entry.kind==='tombstone'){
     if(entry.index!==0||entry.bytes!==0||entry.hash!==null||values.has(id)||parts.has(id))return null;
     const read=this.source.readState(input.scope,input.attempt,entry.key,0);if(read.kind!==entry.kind)return null;
     values.set(id,{kind:entry.kind});continue;
    }
    if(values.has(id))return null;
    const chunks=parts.get(id)??[];if(entry.index!==chunks.length)return null;
    let bytes:Uint8Array;
    if(entry.kind==='partial'){
     const read=this.source.readPartial(input.scope,input.attempt,entry.key,entry.index);if(!read)return null;bytes=read;
    }else{
     const read=this.source.readState(input.scope,input.attempt,entry.key,entry.index);
     if(read.kind!=='value'||read.expiresAt!==entry.expiresAt||JSON.stringify(read.metadata)!==JSON.stringify(entry.metadata))return null;
     bytes=read.bytes??new Uint8Array();
    }
    total+=bytes.length;if(bytes.length!==entry.bytes||total>this.maxBytes||chunks.reduce((n,c)=>n+c.length,0)+bytes.length>this.maxBytes)return null;
    if((entry.kind==='partial'&&bytes.length===0)||(bytes.length===0&&entry.hash!==null)||(bytes.length>0&&await sha(bytes)!==entry.hash))return null;
    chunks.push(bytes);parts.set(id,chunks);
    // Preserve one copy of metadata; chunks must agree.
    const metadataKey=`metadata:${id}`;
    const metadata=JSON.stringify({kind:entry.kind,expiresAt:entry.expiresAt,metadata:entry.metadata});
    const prior=meta.get(metadataKey);if(prior!==undefined&&prior!==metadata)return null;meta.set(metadataKey,metadata);
   }
   if(page.next===null)break;
   if(page.next===after)return null;after=page.next;
  }
  if(!current()||snap.rows.some(row=>skipPartial&&row.state==='done'&&skipped.get(row.alias)!==row.partial_count))return null;
  for(const [id,chunks] of parts){
   const size=chunks.reduce((n,c)=>n+c.length,0),bytes=new Uint8Array(size);let offset=0;
   for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
   const m=JSON.parse(meta.get(`metadata:${id}`)!) as {kind:'partial'|'state';expiresAt?:number|null;metadata?:unknown};
   values.set(id,m.kind==='partial'?{kind:'partial',bytes}:{kind:'state',bytes,expiresAt:m.expiresAt,metadata:m.metadata});
  }
  if(!current())return null;
  return {job:input.job,generation:input.generation,sourceId:input.sourceId,head:snap.head,versions:snap.versions,at:snap.at,rows:snap.rows,values};
 }
 private validEntry(e:TrustedInventoryEntry):boolean{return !!e&&typeof e.cursor==='string'&&e.cursor.length<=1024&&typeof e.key==='string'&&e.key.length<=360&&['partial','state','missing','tombstone'].includes(e.kind)&&Number.isSafeInteger(e.index)&&e.index>=0&&e.index<160&&Number.isSafeInteger(e.bytes)&&e.bytes>=0&&e.bytes<=65536&&(e.hash===null||HASH.test(e.hash));}
}
