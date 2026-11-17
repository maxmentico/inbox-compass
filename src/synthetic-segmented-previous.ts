// SYNTHETIC / UNWIRED. Prepare a small coordinator-owned previous-run proof by reading and hashing
// segmented values before job creation. Creation consumes only a currently pinned, unchanged head.
// This does not prove source migration or make segmented publication production-ready.
import { SegmentedGeneration } from './segmented-generation';
import type { AtomicPreviousDigestReader } from './synthetic-job-context';
const ID=/^[A-Za-z0-9_-]{22,128}$/,REAL=/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;
type Value={kind:'missing'}|{kind:'value';bytes:Uint8Array;expiresAt:number|null};
export class SyntheticSegmentedPrevious{
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly generation:SegmentedGeneration){this.sql=storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_previous_proof (id TEXT PRIMARY KEY,head TEXT NOT NULL,pin TEXT NOT NULL,previous TEXT,expires INTEGER NOT NULL,consumed INTEGER NOT NULL)');}
 private async read(head:string,pin:string,key:string,limit:number,firstOnly=false):Promise<Value|null>{
  let offset=0,total=0,expiry:number|null=null;const chunks:Uint8Array[]=[];
  for(;;){const value=await this.generation.read(head,key,offset,pin);if(value.kind==='missing')return {kind:'missing'};if(value.kind!=='value')return null;
   if(expiry!==null&&value.expiresAt!==expiry)return null;expiry=value.expiresAt;total+=value.bytes.length;if(total>limit)return null;chunks.push(value.bytes);
   if(firstOnly||value.next===null)break;if(value.next<=offset)return null;offset=value.next;
  }
  const bytes=new Uint8Array(total);let at=0;for(const part of chunks){bytes.set(part,at);at+=part.length;}return {kind:'value',bytes,expiresAt:expiry};
 }
 /** The coordinator issues the proof id and pin itself; callers cannot supply proof content. */
 async prepare():Promise<string|null>{
  const head=this.generation.head();if(!head||!ID.test(head))return null;
  const pin=this.generation.compaction.pin(head);if(!pin)return null;
  try{
   let expiry=Number.MAX_SAFE_INTEGER;
   const take=(value:Value)=>{if(value.kind==='value'&&value.expiresAt!==null)expiry=Math.min(expiry,value.expiresAt);};
   const pointer=await this.read(head,pin,'last-run',64);if(!pointer)return null;take(pointer);
   let previous:string|null|undefined;
   if(pointer.kind==='value'){
    const id=new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(pointer.bytes);
    if(REAL.test(id)){const digest=await this.read(head,pin,`digest:${id}`,65536,true);if(!digest)return null;take(digest);if(digest.kind==='value')previous=id;}
   }
   if(previous===undefined){
    const index=await this.read(head,pin,'runs-index',65536);if(!index||index.kind==='missing')return null;take(index);
    const values:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true,ignoreBOM:false}).decode(index.bytes));
    if(!Array.isArray(values)||values.length>1030||values.some(x=>typeof x!=='string'||x.length>128))return null;
    const first=values.find((v:string)=>!v.endsWith('-test')) as string|undefined;
    if(first===undefined)previous=null;
    else {if(!REAL.test(first))return null;const digest=await this.read(head,pin,`digest:${first}`,65536,true);if(!digest||digest.kind!=='value')return null;take(digest);previous=first;}
   }
   const proof=crypto.randomUUID();
   const stored=this.storage.transactionSync(()=>{
    if(this.generation.head()!==head||!this.generation.compaction.pinned(head,pin))return false;
    const lease=this.sql.exec<{expires_at:number}>('SELECT expires_at FROM seg_reader_pins WHERE id=? AND head=?',pin,head).toArray()[0];
    if(!lease)return false;expiry=Math.min(expiry,lease.expires_at);if(expiry<=Date.now())return false;
    this.sql.exec('INSERT INTO synthetic_previous_proof VALUES (?,?,?,?,?,0)',proof,head,pin,previous,expiry);return true;
   });return stored?proof:null;
  }catch{return null;}
  finally{
   // A stored proof keeps the pin until consumed or expired; unsuccessful preparation releases it.
   const retained=this.sql.exec('SELECT id FROM synthetic_previous_proof WHERE pin=?',pin).toArray().length;
   if(!retained)this.generation.compaction.release(pin);
  }
 }
 /** Install in SyntheticJobContextBinding; call only within its creation transaction. */
 reader(proof:string):AtomicPreviousDigestReader{return sql=>{
  if(sql!==this.sql||!ID.test(proof))return undefined;
  const row=sql.exec<{head:string;pin:string;previous:string|null;expires:number;consumed:number}>('SELECT head,pin,previous,expires,consumed FROM synthetic_previous_proof WHERE id=?',proof).toArray()[0];
  if(!row||row.consumed!==0||row.expires<=Date.now()||this.generation.head()!==row.head||!this.generation.compaction.pinned(row.head,row.pin)||!(row.previous===null||REAL.test(row.previous)))return undefined;
  sql.exec('UPDATE synthetic_previous_proof SET consumed=1 WHERE id=? AND consumed=0',proof);
  this.generation.compaction.release(row.pin);
  return row.previous;
 };}
 cleanup(limit=16):number{
  if(!Number.isSafeInteger(limit)||limit<1||limit>32)return 0;
  return this.storage.transactionSync(()=>{const rows=this.sql.exec<{id:string;pin:string}>('SELECT id,pin FROM synthetic_previous_proof WHERE consumed=1 OR expires<=? ORDER BY expires,id LIMIT ?',Date.now(),limit).toArray();for(const row of rows){this.generation.compaction.release(row.pin);this.sql.exec('DELETE FROM synthetic_previous_proof WHERE id=?',row.id);}return rows.length;});
 }
}
