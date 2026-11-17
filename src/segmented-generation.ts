// SYNTHETIC, UNWIRED prototype. A head points to one immutable indexed segment stream. No real
// production domain verifier, authorization, masking, external retention proof or migration
// exists. A proof callback must independently certify the entire index and all output bytes.
import { SegmentCompaction } from './synthetic-segment-compaction';
import type {AtomicCommit} from './job-state-core';
import type {SegmentAuthority} from './segmented-output-store';
const ID=/^[A-Za-z0-9_-]{22,128}$/;
const MAX_BYTES=32*1024*1024, MAX_OPS=1000, MAX_DEPTH=16;
type Version={key:string;version:number};
type Op={key:string;kind:'put'|'delete';bytes:number;expiresAt?:number;metadata?:{arrived:number}};
type Build={scope:string;job:string;generation:string;attempt:string;source_id:string;previous:string|null;digest:string;versions:string;total_ops:number;total_bytes:number;next_page:number;next_ops:number;next_offset:number;complete:number};
/** A trusted same-transaction O(1) check of a previously completed independent semantic proof. */
export type SegmentedSemanticProof=(sql:SqlStorage,scope:string,job:string,generation:string,sourceId:string)=>boolean;
/** Must independently certify complete legacy key inventory, all bytes, TTLs and metadata. */
export type SegmentedMigrationProof=(sql:SqlStorage,legacyHead:string,scope:string)=>boolean;
export class SegmentedGeneration {
 private readonly sql:SqlStorage;
 readonly compaction:SegmentCompaction;
 constructor(private readonly storage:DurableObjectStorage,private readonly auth?:SegmentAuthority,private readonly proof?:SegmentedSemanticProof,private readonly cleanupAuth?:SegmentAuthority,private readonly migrationProof?:SegmentedMigrationProof){
  this.sql=storage.sql;
  this.compaction=new SegmentCompaction(storage);
  this.sql.exec('CREATE TABLE IF NOT EXISTS sgen_build (scope TEXT PRIMARY KEY,job TEXT NOT NULL,generation TEXT NOT NULL,attempt TEXT NOT NULL,source_id TEXT NOT NULL,previous TEXT,digest TEXT NOT NULL,versions TEXT NOT NULL,total_ops INTEGER NOT NULL,total_bytes INTEGER NOT NULL,next_page INTEGER NOT NULL,next_ops INTEGER NOT NULL,next_offset INTEGER NOT NULL,complete INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS sgen_index (scope TEXT NOT NULL,key TEXT NOT NULL,ordinal INTEGER NOT NULL,start INTEGER NOT NULL,bytes INTEGER NOT NULL,kind TEXT NOT NULL,expires_at INTEGER,metadata TEXT,PRIMARY KEY(scope,key),UNIQUE(scope,ordinal))');
  this.sql.exec('CREATE TABLE IF NOT EXISTS sgen_pages (scope TEXT NOT NULL,page INTEGER NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(scope,page))');
  this.sql.exec('CREATE TABLE IF NOT EXISTS sgen_committed (scope TEXT PRIMARY KEY,previous TEXT,digest TEXT NOT NULL)');
  // Shared authoritative pointer. Legacy stores must explicitly reject segmented heads until
  // migration/read support exists; a second head would permit divergent current generations.
  this.sql.exec('CREATE TABLE IF NOT EXISTS gen_head (singleton INTEGER PRIMARY KEY CHECK(singleton=1),generation TEXT NOT NULL)');
 }
 private row(scope:string):Build|undefined{return this.sql.exec<Build>('SELECT * FROM sgen_build WHERE scope=?',scope).toArray()[0];}
 private permitted(b:Build):boolean{return !!this.auth&&this.auth(this.sql,b.job,b.generation,b.attempt,b.source_id)===true;}
 private canClean(b:Build,attempt:string):boolean{const check=this.cleanupAuth??this.auth;return !!check&&check(this.sql,b.job,b.generation,attempt,b.source_id)===true;}
 head():string|null{return this.sql.exec<{generation:string}>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation??null;}
 begin(x:{scope:string;job:string;generation:string;attempt:string;sourceId:string;previous:string|null;digest:string;versions:Version[];totalOps:number;totalBytes:number}):boolean{
  if(!x||![x.scope,x.job,x.generation,x.attempt].every(v=>typeof v==='string'&&ID.test(v))||!(/^[a-f0-9]{64}$/).test(x.sourceId)||(x.previous!==null&&!ID.test(x.previous))||typeof x.digest!=='string'||!x.digest.length||x.digest.length>128||!Array.isArray(x.versions)||x.versions.length>52||!Number.isSafeInteger(x.totalOps)||x.totalOps<1||x.totalOps>MAX_OPS||!Number.isSafeInteger(x.totalBytes)||x.totalBytes<1||x.totalBytes>MAX_BYTES)return false;
  const keys=new Set<string>();for(const v of x.versions){if(!v||typeof v.key!=='string'||!v.key.length||v.key.length>256||keys.has(v.key)||!Number.isSafeInteger(v.version)||v.version<0)return false;keys.add(v.key);}
  const versions=JSON.stringify(x.versions.map(v=>({key:v.key,version:v.version})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0));
  return this.storage.transactionSync(()=>{
   const transport=this.sql.exec<{job:string;generation:string;attempt:string;source_id:string;state:string}>('SELECT job,generation,attempt,source_id,state FROM seg_outputs WHERE scope=?',x.scope).toArray()[0];
   if(!transport||!['staging','sealed'].includes(transport.state)||transport.job!==x.job||transport.generation!==x.generation||transport.attempt!==x.attempt||transport.source_id!==x.sourceId||!this.auth||this.auth(this.sql,x.job,x.generation,x.attempt,x.sourceId)!==true)return false;
   const old=this.row(x.scope);if(old)return old.job===x.job&&old.generation===x.generation&&old.attempt===x.attempt&&old.source_id===x.sourceId&&old.previous===x.previous&&old.digest===x.digest&&old.versions===versions&&old.total_ops===x.totalOps&&old.total_bytes===x.totalBytes;
   this.sql.exec('INSERT INTO sgen_build VALUES (?,?,?,?,?,?,?,?,?,?,0,0,0,0)',x.scope,x.job,x.generation,x.attempt,x.sourceId,x.previous,x.digest,versions,x.totalOps,x.totalBytes);return true;
  });
 }
 async indexPage(scope:string,attempt:string,page:number,ops:Op[]):Promise<boolean>{
  if(!ID.test(scope)||!ID.test(attempt)||!Number.isSafeInteger(page)||page<0||!Array.isArray(ops)||!ops.length||ops.length>16)return false;
  const pinned:Op[]=[];for(const c of ops){if(!c||typeof c.key!=='string'||!c.key.length||c.key.length>256||!['put','delete'].includes(c.kind)||!Number.isSafeInteger(c.bytes)||c.bytes<0||c.bytes>MAX_BYTES||(c.kind==='delete'&&(c.bytes!==0||c.expiresAt!==undefined||c.metadata!==undefined))||(c.expiresAt!==undefined&&(!Number.isSafeInteger(c.expiresAt)||c.expiresAt<=0))||(c.metadata!==undefined&&(!c.metadata||Object.keys(c.metadata).some(k=>k!=='arrived')||!Number.isSafeInteger(c.metadata.arrived))))return false;pinned.push({key:c.key,kind:c.kind,bytes:c.bytes,...(c.expiresAt===undefined?{}:{expiresAt:c.expiresAt}),...(c.metadata?{metadata:{arrived:c.metadata.arrived}}:{})});}
  const raw=new TextEncoder().encode(JSON.stringify(pinned));if(raw.length>64*1024)return false;
  if(new Set(pinned.map(op=>op.key)).size!==pinned.length)return false;
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',raw))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return this.storage.transactionSync(()=>{
   const b=this.row(scope);if(!b||b.attempt!==attempt||!this.permitted(b))return false;
   const transport=this.sql.exec<{state:string}>('SELECT state FROM seg_outputs WHERE scope=?',scope).toArray()[0];
   if(!transport||!['staging','sealed'].includes(transport.state))return false;
   const prior=this.sql.exec<{hash:string}>('SELECT hash FROM sgen_pages WHERE scope=? AND page=?',scope,page).toArray()[0];if(prior)return prior.hash===hash;
   if(b.complete||b.next_page!==page||b.next_ops+pinned.length>b.total_ops)return false;
   let offset=b.next_offset;for(const op of pinned){if(this.sql.exec('SELECT key FROM sgen_index WHERE scope=? AND key=?',scope,op.key).toArray().length)return false;offset+=op.bytes;if(offset>b.total_bytes)return false;}
   let start=b.next_offset;for(let i=0;i<pinned.length;i++){const op=pinned[i]!;this.sql.exec('INSERT INTO sgen_index VALUES (?,?,?,?,?,?,?,?)',scope,op.key,b.next_ops+i,start,op.bytes,op.kind,op.expiresAt??null,op.metadata?JSON.stringify(op.metadata):null);start+=op.bytes;}
   this.sql.exec('INSERT INTO sgen_pages VALUES (?,?,?)',scope,page,hash);this.sql.exec('UPDATE sgen_build SET next_page=next_page+1,next_ops=?,next_offset=? WHERE scope=?',b.next_ops+pinned.length,offset,scope);return true;
  });
 }
 sealIndex(scope:string,attempt:string):boolean{return this.storage.transactionSync(()=>{
  const b=this.row(scope),transport=this.sql.exec<{state:string;bytes:number;next:number}>('SELECT state,bytes,next FROM seg_outputs WHERE scope=?',scope).toArray()[0];
  if(!b||b.attempt!==attempt||!this.permitted(b)||!transport||transport.state!=='sealed'||transport.bytes!==b.total_bytes||b.next_ops!==b.total_ops||b.next_offset!==b.total_bytes)return false;
  if(transport.next!==Math.ceil(b.total_bytes/65536)||this.sql.exec('SELECT idx FROM seg_parts WHERE scope=? AND idx<? AND bytes<>65536 LIMIT 1',scope,transport.next-1).toArray().length)return false;
  if(b.complete)return true;this.sql.exec('UPDATE sgen_build SET complete=1 WHERE scope=?',scope);return true;
 });}
 /** Retire only unpublished data; a current trusted finalizer may then reclaim its segments. */
 retire(scope:string,attempt:string):boolean{return this.storage.transactionSync(()=>{
  const b=this.row(scope);if(!b||!this.canClean(b,attempt)||this.sql.exec('SELECT scope FROM sgen_committed WHERE scope=?',scope).toArray().length||this.head()===scope)return false;
  const transport=this.sql.exec<{state:string}>('SELECT state FROM seg_outputs WHERE scope=?',scope).toArray()[0];
  if(!transport||!['staging','sealed','abandoned'].includes(transport.state))return false;
  if(transport.state!=='abandoned')this.sql.exec("UPDATE seg_outputs SET state='abandoned' WHERE scope=?",scope);
  return true;
 });}
 /** Bounded metadata cleanup for a retired, never-published preparation. */
 cleanupRetired(scope:string,attempt:string,limit:number):{remaining:boolean}|null{
  if(!Number.isSafeInteger(limit)||limit<1||limit>16)return null;
  return this.storage.transactionSync(()=>{
   const b=this.row(scope),transport=this.sql.exec<{state:string}>('SELECT state FROM seg_outputs WHERE scope=?',scope).toArray()[0];
   if(!b||!transport||transport.state!=='abandoned'||!this.canClean(b,attempt)||this.sql.exec('SELECT scope FROM sgen_committed WHERE scope=?',scope).toArray().length)return null;
   this.sql.exec('DELETE FROM sgen_index WHERE rowid IN (SELECT rowid FROM sgen_index WHERE scope=? LIMIT ?)',scope,limit);
   this.sql.exec('DELETE FROM sgen_pages WHERE rowid IN (SELECT rowid FROM sgen_pages WHERE scope=? LIMIT ?)',scope,limit);
   const pending=this.sql.exec('SELECT key FROM sgen_index WHERE scope=? LIMIT 1',scope).toArray().length||this.sql.exec('SELECT page FROM sgen_pages WHERE scope=? LIMIT 1',scope).toArray().length;
   // Keep the scope row as an anti-reuse tombstone. No committed head is ever modified.
   return {remaining:!!pending};
  });
 }
 /** Same SQLite transaction as JobStateCore.finalize. The proof is mandatory, never inferred from producer progress. */
 atomicCommit():AtomicCommit{return(sql,job,generation,digest,preparation)=>{
  if(sql!==this.sql||!this.proof)throw new Error('semantic proof unavailable');
  const b=this.row(preparation);if(!b||!b.complete||b.job!==job||b.generation!==generation||b.digest!==digest||!this.permitted(b)||this.head()!==b.previous)throw new Error('stale or incomplete generation');
  const transport=sql.exec<{state:string;bytes:number}>('SELECT state,bytes FROM seg_outputs WHERE scope=?',preparation).toArray()[0];
  if(!transport||transport.state!=='sealed'||transport.bytes!==b.total_bytes)throw new Error('unavailable output segments');
  const versions=JSON.parse(b.versions) as Version[];for(const v of versions){const current=sql.exec<{version:number}>('SELECT version FROM gen_versions WHERE key=?',v.key).toArray()[0];if(!current||current.version!==v.version)throw new Error('stale version');}
  let cursor=b.previous,depth=0,committedPrevious=b.previous;
  while(cursor){
   if(++depth>=MAX_DEPTH)throw new Error('compaction required');
   if(this.compaction.complete(cursor))break;
   const prior=sql.exec<{previous:string|null}>('SELECT previous FROM sgen_committed WHERE scope=?',cursor).toArray()[0];
   if(!prior){
    // A single legacy-to-segmented transition is allowed only with a separate, independently
    // verified complete snapshot certificate. Missing intermediate ancestors are corruption.
    if(depth!==1||!this.migrationProof||this.migrationProof(sql,cursor,b.scope)!==true)throw new Error('verified migration required');
    committedPrevious=null;break;
   }
   cursor=prior.previous;
  }
  if(this.proof(sql,b.scope,job,generation,b.source_id)!==true)throw new Error('semantic proof unavailable');
  sql.exec('INSERT INTO sgen_committed (scope,previous,digest) VALUES (?,?,?)',b.scope,committedPrevious,digest);sql.exec('INSERT OR REPLACE INTO gen_head VALUES (1,?)',b.scope);return true;
 };}
 /** Reads a bounded piece from an immutable committed value. Pin head across calls; never returns provisional data. */
 async read(expectedHead:string|null,key:string,offset:number,pin?:string):Promise<{kind:'changed'|'missing'|'corrupt'}|{kind:'value';bytes:Uint8Array;next:number|null;expiresAt:number|null;metadata:unknown}>{
  if(typeof key!=='string'||key.length>256||!Number.isSafeInteger(offset)||offset<0)return {kind:'missing'};
  const readable=()=>pin===undefined?this.head()===expectedHead:this.compaction.pinned(expectedHead,pin);
  const selected=this.storage.transactionSync(()=>{
   if(!readable())return {kind:'changed' as const};let scope=expectedHead,depth=0;
   while(scope){if(++depth>MAX_DEPTH)return {kind:'corrupt' as const};const commit=this.sql.exec<{previous:string|null}>('SELECT previous FROM sgen_committed WHERE scope=?',scope).toArray()[0];if(!commit)return {kind:'corrupt' as const};
    const covered=this.compaction.complete(scope);
    if(covered){scope=this.compaction.source(scope,key);if(!scope)return {kind:'missing' as const};}
    const op=this.sql.exec<{start:number;bytes:number;kind:string;expires_at:number|null;metadata:string|null}>('SELECT start,bytes,kind,expires_at,metadata FROM sgen_index WHERE scope=? AND key=?',scope,key).toArray()[0];
    if(op){if(op.kind==='delete'||(op.expires_at!==null&&op.expires_at<=Date.now())||offset>op.bytes)return {kind:'missing' as const};if(offset===op.bytes)return {kind:'value' as const,bytes:new Uint8Array(),next:null,expiresAt:op.expires_at,metadata:op.metadata?JSON.parse(op.metadata):null};
     const absolute=op.start+offset,idx=Math.floor(absolute/65536),inner=absolute%65536,part=this.sql.exec<{data:ArrayBuffer;hash:string;bytes:number}>('SELECT data,hash,bytes FROM seg_parts WHERE scope=? AND idx=?',scope,idx).toArray()[0];if(!part)return {kind:'corrupt' as const};
     return {kind:'chunk' as const,part,inner,length:Math.min(op.bytes-offset,65536-inner),offset,total:op.bytes,expiresAt:op.expires_at,metadata:op.metadata?JSON.parse(op.metadata):null};}
    if(covered)return {kind:'corrupt' as const};
    scope=commit.previous;
   }return {kind:'missing' as const};
  });
  if(selected.kind!=='chunk')return selected;
  const raw=new Uint8Array(selected.part.data),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(raw).buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(raw.length!==selected.part.bytes||hash!==selected.part.hash||selected.inner+selected.length>raw.length)return {kind:'corrupt'};
  if(!readable())return {kind:'changed'};
  if(selected.expiresAt!==null&&selected.expiresAt<=Date.now())return {kind:'missing'};
  const bytes=raw.slice(selected.inner,selected.inner+selected.length),end=selected.offset+selected.length,next=end<selected.total?end:null;
  return {kind:'value',bytes,next,expiresAt:selected.expiresAt,metadata:selected.metadata};
 }
}
