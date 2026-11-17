// SYNTHETIC / UNWIRED. Durable bounded source copying; not an assembly projector. Every stored
// fragment is copied from authenticated coordinator inventory, never from a finalizer payload.
import type { TrustedAssemblySource, TrustedInventoryEntry } from './trusted-assembly-source';
import type { SyntheticSourceAuthority } from './synthetic-job-bound-stage';
const ID=/^[A-Za-z0-9_-]{22,128}$/, HASH=/^[a-f0-9]{64}$/;
const MAX_BYTES=32*1024*1024, MAX_ENTRIES=8192, MAX_CHUNK=65536;
type Input={scope:string;job:string;generation:string;attempt:string;sourceId:string};
type Head={scope:string;job:string;generation:string;attempt:string;source_id:string;versions:string;cursor:string|null;seq:number;bytes:number;complete:number};
async function sha(b:Uint8Array){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(b).buffer))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export class SyntheticTrustedInputStream {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly source:TrustedAssemblySource,private readonly authority:SyntheticSourceAuthority){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_input_stream (scope TEXT PRIMARY KEY,job TEXT NOT NULL,generation TEXT NOT NULL,attempt TEXT NOT NULL,source_id TEXT NOT NULL,versions TEXT NOT NULL,cursor TEXT,seq INTEGER NOT NULL,bytes INTEGER NOT NULL,complete INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_input_stream_chunk (scope TEXT NOT NULL,seq INTEGER NOT NULL,descriptor TEXT NOT NULL,data BLOB NOT NULL,PRIMARY KEY(scope,seq))');
 }
 private row(scope:string):Head|undefined{return this.sql.exec<Head>('SELECT * FROM synthetic_input_stream WHERE scope=?',scope).toArray()[0];}
 private valid(h:Head):boolean{
  const proof=this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM synthetic_packed_proof WHERE scope=? AND job=? AND generation=? AND attempt=? AND source_id=? AND complete=1',h.scope,h.job,h.generation,h.attempt,h.source_id).toArray()[0];
  return proof?.n===1&&this.source.validateInTransaction(this.sql,h.scope,h.attempt)&&this.authority(this.sql,h.job,h.generation,h.source_id,h.versions)===true;
 }
 begin(input:Input):boolean{
  if(!input||![input.scope,input.job,input.generation,input.attempt].every(x=>typeof x==='string'&&ID.test(x))||!HASH.test(input.sourceId))return false;
  const snap=this.source.describe(input.scope,input.attempt);if(!snap||snap.job!==input.job||snap.generation!==input.generation)return false;
  const versions=JSON.stringify(snap.versions.map(v=>({key:v.key,value:v.version})));
  return this.storage.transactionSync(()=>{
   const expected:Head={scope:input.scope,job:input.job,generation:input.generation,attempt:input.attempt,source_id:input.sourceId,versions,cursor:null,seq:0,bytes:0,complete:0};
   if(!this.valid(expected))return false;
   const existing=this.row(input.scope);if(existing)return existing.job===input.job&&existing.generation===input.generation&&existing.attempt===input.attempt&&existing.source_id===input.sourceId&&existing.versions===versions;
   this.sql.exec('INSERT INTO synthetic_input_stream VALUES (?,?,?,?,?,?,NULL,0,0,0)',input.scope,input.job,input.generation,input.attempt,input.sourceId,versions);return true;
  });
 }
 /** Read/hash at most one 64 KiB fragment, then atomically stage it with a CAS checkpoint. */
 async next(scope:string,attempt:string,expectedSeq:number):Promise<{next:number;complete:boolean;bytes:number}|null>{
  if(!ID.test(scope)||!ID.test(attempt)||!Number.isSafeInteger(expectedSeq)||expectedSeq<0||expectedSeq>=MAX_ENTRIES)return null;
  const before=this.storage.transactionSync(()=>{const h=this.row(scope);if(!h||h.attempt!==attempt||h.seq!==expectedSeq||h.complete||!this.valid(h))return null;const page=this.source.inventoryPageInTransaction(this.sql,scope,attempt,h.cursor,1);return page?{h,page}:null;});
  if(!before||before.page.entries.length!==1)return null;
  const e=before.page.entries[0]!,next=before.page.next;
  if(!this.validEntry(e)||next!==null&&next!==e.cursor||before.h.bytes+e.bytes>MAX_BYTES)return null;
  let data:Uint8Array;
  if(e.kind==='partial'){const raw=this.source.readPartial(scope,attempt,e.key,e.index);if(!raw)return null;data=raw;}
  else {const raw=this.source.readState(scope,attempt,e.key,e.index);if(e.kind==='missing'||e.kind==='tombstone'){if(raw.kind!==e.kind)return null;data=new Uint8Array();}else{if(raw.kind!=='value'||raw.expiresAt!==e.expiresAt||JSON.stringify(raw.metadata)!==JSON.stringify(e.metadata))return null;data=raw.bytes??new Uint8Array();}}
  if(data.byteLength!==e.bytes||data.byteLength>MAX_CHUNK||(data.length===0?e.hash!==null:await sha(data)!==e.hash))return null;
  const descriptor=JSON.stringify(e);
  return this.storage.transactionSync(()=>{
   const h=this.row(scope);if(!h||h.seq!==expectedSeq||h.cursor!==before.h.cursor||h.bytes!==before.h.bytes||h.complete||!this.valid(h))return null;
   const again=this.source.inventoryPageInTransaction(this.sql,scope,attempt,h.cursor,1);if(!again||JSON.stringify(again)!==JSON.stringify(before.page))return null;
   this.sql.exec('INSERT INTO synthetic_input_stream_chunk VALUES (?,?,?,?)',scope,h.seq,descriptor,new Uint8Array(data).buffer);
   this.sql.exec('UPDATE synthetic_input_stream SET cursor=?,seq=?,bytes=?,complete=? WHERE scope=?',e.cursor,h.seq+1,h.bytes+data.length,next===null?1:0,scope);
   return {next:h.seq+1,complete:next===null,bytes:h.bytes+data.length};
  });
 }
 /** Available only after the entire independently enumerated inventory has been copied. */
 infoInTransaction(sql:SqlStorage,scope:string,attempt:string,sourceId:string):{count:number}|null{
  if(sql!==this.sql)return null;const h=this.row(scope);
  return h&&h.attempt===attempt&&h.source_id===sourceId&&h.complete&&this.valid(h)?{count:h.seq}:null;
 }
 read(scope:string,attempt:string,seq:number):{descriptor:TrustedInventoryEntry;bytes:Uint8Array}|null{
  if(!ID.test(scope)||!ID.test(attempt)||!Number.isSafeInteger(seq)||seq<0||seq>=MAX_ENTRIES)return null;
  return this.storage.transactionSync(()=>this.readInTransaction(this.sql,scope,attempt,seq));
 }
 /** Caller must already hold this coordinator's transaction. */
 readInTransaction(sql:SqlStorage,scope:string,attempt:string,seq:number):{descriptor:TrustedInventoryEntry;bytes:Uint8Array}|null{
   if(sql!==this.sql||!ID.test(scope)||!ID.test(attempt)||!Number.isSafeInteger(seq)||seq<0||seq>=MAX_ENTRIES)return null;
   const h=this.row(scope);if(!h||h.attempt!==attempt||!h.complete||seq>=h.seq||!this.valid(h))return null;
   const row=this.sql.exec<{descriptor:string;data:ArrayBuffer}>('SELECT descriptor,data FROM synthetic_input_stream_chunk WHERE scope=? AND seq=?',scope,seq).toArray()[0];
   if(!row)return null;try{const descriptor=JSON.parse(row.descriptor) as TrustedInventoryEntry,bytes=new Uint8Array(row.data);return this.validEntry(descriptor)&&bytes.length===descriptor.bytes?{descriptor,bytes}:null;}catch{return null;}
 }
 private validEntry(e:TrustedInventoryEntry):boolean{return !!e&&typeof e.cursor==='string'&&e.cursor.length<=1024&&typeof e.key==='string'&&e.key.length<=360&&['partial','state','missing','tombstone'].includes(e.kind)&&Number.isSafeInteger(e.index)&&e.index>=0&&e.index<160&&Number.isSafeInteger(e.bytes)&&e.bytes>=0&&e.bytes<=MAX_CHUNK&&(e.hash===null||HASH.test(e.hash))&&(!(e.kind==='missing'||e.kind==='tombstone')||e.index===0&&e.bytes===0&&e.hash===null)&&(e.kind!=='partial'||e.bytes>0);}
}
