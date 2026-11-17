// SYNTHETIC / UNWIRED. Independently reprojects a trusted source into bounded expected-value
// rows for SyntheticSegmentCertificate. This is NOT safe until the loader is authenticated and
// complete, source/revision authorization is real, memory/CPU budgets are measured, and retention
// exists. No candidate index or candidate bytes are read by this module.
import { projectDomainReferenceWithWrites, type TrustedAssemblyLoader } from './domain-reference-projection';
import type { IndependentReferenceSource, ReferenceHeader, ReferenceOp } from './synthetic-segment-certificate';
import type { SyntheticSourceAuthority } from './synthetic-job-bound-stage';
const ID=/^[A-Za-z0-9_-]{22,128}$/;
const MAX_TOTAL=32*1024*1024, CHUNK=64*1024;
type Build={job:string;generation:string;attempt:string;source_id:string;previous:string|null;digest:string;versions:string;total_ops:number;total_bytes:number;complete:number};
type HeaderRow={scope:string;attempt:string;header:string;complete:number};
export class SyntheticMaterializedReference implements IndependentReferenceSource {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly loader?:TrustedAssemblyLoader,private readonly sourceAuthority?:SyntheticSourceAuthority){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_reference_header (id TEXT PRIMARY KEY,scope TEXT NOT NULL,attempt TEXT NOT NULL,header TEXT NOT NULL,complete INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_reference_op (id TEXT NOT NULL,ordinal INTEGER NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,bytes INTEGER NOT NULL,expires_at INTEGER,metadata TEXT,PRIMARY KEY(id,ordinal))');
  this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_reference_chunk (id TEXT NOT NULL,ordinal INTEGER NOT NULL,idx INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(id,ordinal,idx))');
 }
 private build(scope:string):Build|undefined{return this.sql.exec<Build>('SELECT job,generation,attempt,source_id,previous,digest,versions,total_ops,total_bytes,complete FROM sgen_build WHERE scope=?',scope).toArray()[0];}
 private row(id:string):HeaderRow|undefined{return this.sql.exec<HeaderRow>('SELECT scope,attempt,header,complete FROM synthetic_reference_header WHERE id=?',id).toArray()[0];}
 private authorized(scope:string,attempt:string,expectedHeader:string):boolean{
  const b=this.build(scope);if(!b||b.attempt!==attempt||!this.sourceAuthority)return false;
  const versions=JSON.parse(b.versions) as {key:string;version:number}[];
  if(this.sourceAuthority(this.sql,b.job,b.generation,b.source_id,JSON.stringify(versions.map(v=>({key:v.key,value:v.version}))))!==true)return false;
  const h=JSON.parse(expectedHeader) as ReferenceHeader;
  return h.job===b.job&&h.generation===b.generation&&h.sourceId===b.source_id&&h.previous===b.previous&&h.digest===b.digest&&JSON.stringify(h.versions)===b.versions&&h.totalOps===b.total_ops&&h.totalBytes===b.total_bytes;
 }
 /** Independently derive and persist expected records. Retry recomputes and verifies all existing
  * rows; each BLOB write is at most 64 KiB and each transaction rechecks the source fence. */
 async materialize(scope:string,attempt:string,referenceId:string):Promise<boolean>{
  if(![scope,attempt,referenceId].every(v=>typeof v==='string'&&ID.test(v))||!this.loader||!this.sourceAuthority)return false;
  const b=this.storage.transactionSync(()=>this.build(scope));if(!b||b.attempt!==attempt)return false;
  const projected=await projectDomainReferenceWithWrites(this.loader,b.job,b.generation);
  const ref=projected.reference;
  const total=projected.writes.reduce((n,w)=>n+(w.kind==='put'?new TextEncoder().encode(w.value).length:0),0);
  if(total<1||total>MAX_TOTAL||projected.writes.length<1||projected.writes.length>1000)return false;
  const versions=[...ref.versions].sort((a,c)=>a.key<c.key?-1:a.key>c.key?1:0);
  const header:ReferenceHeader={referenceId,job:ref.job,generation:ref.generation,sourceId:ref.sourceId,digest:ref.digest,previous:ref.previousHead,versions,totalOps:projected.writes.length,totalBytes:total};
  const encoded=JSON.stringify(header);
  const begin=this.storage.transactionSync(()=>{
   if(!this.authorized(scope,attempt,encoded))return false;
   const row=this.row(referenceId);if(row)return row.scope===scope&&row.attempt===attempt&&row.header===encoded;
   this.sql.exec('INSERT INTO synthetic_reference_header VALUES (?,?,?,?,0)',referenceId,scope,attempt,encoded);return true;
  });if(!begin)return false;
  for(let ordinal=0;ordinal<projected.writes.length;ordinal++){
   const write=projected.writes[ordinal]!,change=ref.changes[ordinal]!;
   const bytes=write.kind==='put'?new TextEncoder().encode(write.value):new Uint8Array();
   const metadata=change.kind==='put'&&change.metadata?JSON.stringify(change.metadata):null;
   const expires=change.kind==='put'?change.expiresAt??null:null;
   const ok=this.storage.transactionSync(()=>{
    const row=this.row(referenceId);if(!row||row.scope!==scope||row.attempt!==attempt||row.header!==encoded||!this.authorized(scope,attempt,encoded))return false;
    const old=this.sql.exec<{key:string;kind:string;bytes:number;expires_at:number|null;metadata:string|null}>('SELECT key,kind,bytes,expires_at,metadata FROM synthetic_reference_op WHERE id=? AND ordinal=?',referenceId,ordinal).toArray()[0];
    if(old)return old.key===write.key&&old.kind===write.kind&&old.bytes===bytes.length&&old.expires_at===expires&&old.metadata===metadata;
    if(row.complete)return false;
    this.sql.exec('INSERT INTO synthetic_reference_op VALUES (?,?,?,?,?,?,?)',referenceId,ordinal,write.key,write.kind,bytes.length,expires,metadata);return true;
   });if(!ok)return false;
   for(let offset=0,index=0;offset<bytes.length;offset+=CHUNK,index++){
    const part=bytes.slice(offset,Math.min(bytes.length,offset+CHUNK));
    const written=this.storage.transactionSync(()=>{
     const row=this.row(referenceId);if(!row||row.header!==encoded||!this.authorized(scope,attempt,encoded))return false;
     const old=this.sql.exec<{data:ArrayBuffer}>('SELECT data FROM synthetic_reference_chunk WHERE id=? AND ordinal=? AND idx=?',referenceId,ordinal,index).toArray()[0];
     if(old){const saved=new Uint8Array(old.data);return saved.length===part.length&&!saved.some((v,i)=>v!==part[i]);}
     if(row.complete)return false;
     this.sql.exec('INSERT INTO synthetic_reference_chunk VALUES (?,?,?,?)',referenceId,ordinal,index,part.buffer);return true;
    });if(!written)return false;
   }
  }
  return this.storage.transactionSync(()=>{
   const row=this.row(referenceId);if(!row||row.header!==encoded||!this.authorized(scope,attempt,encoded))return false;
   const count=this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM synthetic_reference_op WHERE id=?',referenceId).toArray()[0]?.n;
   if(count!==header.totalOps)return false;
   this.sql.exec('UPDATE synthetic_reference_header SET complete=1 WHERE id=?',referenceId);return true;
  });
 }
 current(sql:SqlStorage,scope:string,attempt:string,referenceId:string):boolean{
  if(sql!==this.sql)return false;const row=this.row(referenceId);
  return !!row&&row.complete===1&&row.scope===scope&&row.attempt===attempt&&this.authorized(scope,attempt,row.header);
 }
 header(sql:SqlStorage,scope:string,attempt:string,referenceId:string):ReferenceHeader|null{
  if(!this.current(sql,scope,attempt,referenceId))return null;return JSON.parse(this.row(referenceId)!.header) as ReferenceHeader;
 }
 op(sql:SqlStorage,scope:string,attempt:string,referenceId:string,ordinal:number):ReferenceOp|null{
  if(!Number.isSafeInteger(ordinal)||ordinal<0||!this.current(sql,scope,attempt,referenceId))return null;
  const r=sql.exec<{key:string;kind:'put'|'delete';bytes:number;expires_at:number|null;metadata:string|null}>('SELECT key,kind,bytes,expires_at,metadata FROM synthetic_reference_op WHERE id=? AND ordinal=?',referenceId,ordinal).toArray()[0];
  return r?{key:r.key,kind:r.kind,bytes:r.bytes,expiresAt:r.expires_at,metadata:r.metadata?JSON.parse(r.metadata):null}:null;
 }
 bytes(sql:SqlStorage,scope:string,attempt:string,referenceId:string,ordinal:number,offset:number,length:number):Uint8Array|null{
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(length)||length<1||length>4096||!this.current(sql,scope,attempt,referenceId))return null;
  const op=this.op(sql,scope,attempt,referenceId,ordinal);if(!op||op.kind!=='put'||offset+length>op.bytes)return null;
  const out=new Uint8Array(length);let filled=0;
  while(filled<length){const absolute=offset+filled,index=Math.floor(absolute/CHUNK),inner=absolute%CHUNK,take=Math.min(length-filled,CHUNK-inner);
   const part=sql.exec<{data:ArrayBuffer}>('SELECT substr(data,?,?) AS data FROM synthetic_reference_chunk WHERE id=? AND ordinal=? AND idx=?',inner+1,take,referenceId,ordinal,index).toArray()[0];
   if(!part)return null;const bytes=new Uint8Array(part.data);if(bytes.length!==take)return null;out.set(bytes,filled);filled+=take;
  }
  return out;
 }
}
