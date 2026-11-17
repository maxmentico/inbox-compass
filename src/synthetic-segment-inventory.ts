// SYNTHETIC, UNWIRED. Internal resumable inventory of a committed segmented overlay.
// The authority must independently fence the captured job, identity, revisions and retention.
// This inventory proves storage bytes only; it does not prove domain semantics or migration.
import { SegmentCompaction } from './synthetic-segment-compaction';
const ID=/^[A-Za-z0-9_-]{22,128}$/;
const HASH=/^[a-f0-9]{64}$/;
const CHUNK=65536, MAX_DEPTH=16, MAX_ENTRIES=100000;
export type SegmentInventoryAuthority=(sql:SqlStorage,head:string,source:string,capturedAt:number)=>boolean;
type Check={captured_at:number|null;head:string;source:string;pin:string;after_key:string|null;part:number;revision:number;complete:number;min_expiry:number|null;count:number};
export type SegmentInventoryEntry={key:string;kind:'value'|'tombstone';index:number;bytes:number;hash:string|null;expiresAt:number|null;metadata:string|null};
type Entry=SegmentInventoryEntry;
type InventoryCursor={key:string;index:number};
type StoredEntry={key:string;kind:'value'|'tombstone';part:number;bytes:number;hash:string|null;expires_at:number|null;metadata:string|null};
const toEntry=(r:StoredEntry):Entry=>({key:r.key,kind:r.kind,index:r.part,bytes:r.bytes,hash:r.hash,expiresAt:r.expires_at,metadata:r.metadata});
type Index={scope:string;key:string;start:number;bytes:number;kind:string;expires_at:number|null;metadata:string|null};
type Part={data:ArrayBuffer;hash:string;bytes:number};
async function hash(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(x=>x.toString(16).padStart(2,'0')).join('');}
export class SyntheticSegmentInventory {
 private sql:SqlStorage;
 private compaction:SegmentCompaction;
 constructor(private storage:DurableObjectStorage,private authority?:SegmentInventoryAuthority){
  this.sql=storage.sql;
  this.compaction=new SegmentCompaction(storage);
  this.sql.exec('CREATE TABLE IF NOT EXISTS sinv_checkpoints (scope TEXT PRIMARY KEY,head TEXT NOT NULL,source TEXT NOT NULL,pin TEXT NOT NULL,after_key TEXT,part INTEGER NOT NULL,revision INTEGER NOT NULL,complete INTEGER NOT NULL,min_expiry INTEGER,count INTEGER NOT NULL,captured_at INTEGER)');
  if(!this.sql.exec<{name:string}>('PRAGMA table_info(sinv_checkpoints)').toArray().some(c=>c.name==='captured_at')){
   this.sql.exec('ALTER TABLE sinv_checkpoints ADD COLUMN captured_at INTEGER');
  }
  this.sql.exec('CREATE TABLE IF NOT EXISTS sinv_entries (scope TEXT NOT NULL,ordinal INTEGER NOT NULL,key TEXT NOT NULL,kind TEXT NOT NULL,part INTEGER NOT NULL,bytes INTEGER NOT NULL,hash TEXT,expires_at INTEGER,metadata TEXT,PRIMARY KEY(scope,ordinal),UNIQUE(scope,key,part))');
 }
 private head():string|null{return this.sql.exec<{generation:string}>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation??null;}
 private row(scope:string):Check|undefined{return this.sql.exec<Check>('SELECT head,source,pin,after_key,part,revision,complete,min_expiry,count,captured_at FROM sinv_checkpoints WHERE scope=?',scope).toArray()[0];}
 private valid(c:Check):boolean{return c.captured_at!==null && Number.isSafeInteger(c.captured_at) && c.captured_at>=0 && c.captured_at<=Date.now() && this.head()===c.head&&this.compaction.pinned(c.head,c.pin)&&(c.min_expiry===null||c.min_expiry>Date.now())&&!!this.authority&&this.authority(this.sql,c.head,c.source,c.captured_at)===true;}
 private chain(head:string):{overlays:string[];base:string|null}|null {
  const overlays:string[]=[];
  let current:string|null=head;
  while(current){
   if(overlays.length>=MAX_DEPTH || overlays.includes(current))return null;
   const row:{previous:string|null}|undefined=this.sql.exec<{previous:string|null}>('SELECT previous FROM sgen_committed WHERE scope=?',current).toArray()[0];
   if(!row)return null;
   if(this.compaction.complete(current))return {overlays,base:current};
   overlays.push(current);
   current=row.previous;
  }
  return {overlays,base:null};
 }
 /** One ordered key seek per overlay plus the nearest complete covering index. SQLite orders UTF-8 keys. */
 private nextKey(overlays:string[],base:string|null,after:string):string|null {
  const sources=overlays.map(scope=>({table:'sgen_index',column:'scope',scope}));
  if(base)sources.push({table:'seg_flat_keys',column:'head',scope:base});
  if(!sources.length)return null;
  const candidates:string[]=[];
  for(const s of sources){
   const row=this.sql.exec<{key:string}>(`SELECT key FROM ${s.table} WHERE ${s.column}=? AND key>? ORDER BY key LIMIT 1`,s.scope,after).toArray()[0];
   if(row)candidates.push(row.key);
  }
  return this.sql.exec<{key:string|null}>('SELECT MIN(value) AS key FROM json_each(?)',JSON.stringify(candidates)).toArray()[0]?.key??null;
 }
 private resolve(overlays:string[],base:string|null,key:string):Index|undefined {
  const lookup=(scope:string)=>this.sql.exec<Index>('SELECT scope,key,start,bytes,kind,expires_at,metadata FROM sgen_index WHERE scope=? AND key=?',scope,key).toArray()[0];
  for(const scope of overlays){
   const hit=lookup(scope);
   if(hit)return hit;
  }
  if(!base)return undefined;
  const item=this.sql.exec<{source:string|null;tombstone_expiry:number|null}>('SELECT source,tombstone_expiry FROM seg_flat_keys WHERE head=? AND key=?',base,key).toArray()[0];
  if(!item)return undefined;
  if(item.source!==null)return lookup(item.source);
  if(item.tombstone_expiry!==null && (!Number.isSafeInteger(item.tombstone_expiry)||item.tombstone_expiry<1))return undefined;
  return {scope:base,key,start:0,bytes:0,kind:item.tombstone_expiry===null?'delete':'put',expires_at:item.tombstone_expiry,metadata:null};
 }
 begin(scope:string,head:string,source:string,pin:string,capturedAt:number):boolean {
  if(!ID.test(scope)||!ID.test(head)||!HASH.test(source)||!ID.test(pin)||!Number.isSafeInteger(capturedAt)||capturedAt<0||capturedAt>Date.now())return false;
  return this.storage.transactionSync(()=>{
   const old=this.row(scope);
   if(old)return old.head===head && old.source===source && old.pin===pin && old.captured_at===capturedAt && this.valid(old);
   if(this.head()!==head || !this.compaction.pinned(head,pin) || !this.authority || this.authority(this.sql,head,source,capturedAt)!==true || !this.chain(head))return false;
   this.sql.exec('INSERT INTO sinv_checkpoints (scope,head,source,pin,after_key,part,revision,complete,min_expiry,count,captured_at) VALUES (?,?,?,?,NULL,0,0,0,NULL,0,?)',scope,head,source,pin,capturedAt);
   return true;
  });
 }
 /** One bounded chunk per call. Concurrent callers compete on revision; a loser must retry. */
 async next(scope:string,expectedRevision:number):Promise<{revision:number;complete:boolean}|null>{
  if(!ID.test(scope)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)return null;
  const work=this.storage.transactionSync(()=>{
   const c=this.row(scope);if(!c||!this.valid(c)||c.revision!==expectedRevision)return null;
   if(c.complete)return {finished:true as const,revision:c.revision};
   const chain=this.chain(c.head);if(!chain)return null;
   // The selected key is the first key after the cursor across every ancestor. The newest
   // matching row wins; tombstones and expired values mask all older versions.
   const key=c.part>0?c.after_key:this.nextKey(chain.overlays,chain.base,c.after_key??'');
   if(!key)return {end:true as const,c};
   if(c.count>=MAX_ENTRIES)return null;
   const op=this.resolve(chain.overlays,chain.base,key);
   if(!op||!['put','delete'].includes(op.kind)||!Number.isSafeInteger(op.start)||op.start<0||!Number.isSafeInteger(op.bytes)||op.bytes<0||op.bytes>32*1024*1024||(op.expires_at!==null&&(!Number.isSafeInteger(op.expires_at)||op.expires_at<=0)))return null;
   if(op.expires_at!==null && op.expires_at>c.captured_at! && op.expires_at<=Date.now())return null;
   if(op.kind==='delete'||(op.expires_at!==null&&op.expires_at<=c.captured_at!))return {c,op,entry:{key,kind:'tombstone' as const,index:0,bytes:0,hash:null,expiresAt:null,metadata:null},parts:[] as Part[],nextPart:0};
   const offset=c.part*CHUNK;if(offset>op.bytes)return null;const length=Math.min(CHUNK,op.bytes-offset),absolute=op.start+offset,first=Math.floor(absolute/CHUNK),last=length?Math.floor((absolute+length-1)/CHUNK):first-1,parts:Part[]=[];
   for(let n=first;n<=last;n++){const p=this.sql.exec<Part>('SELECT data,hash,bytes FROM seg_parts WHERE scope=? AND idx=?',op.scope,n).toArray()[0];if(!p)return null;parts.push(p);}
   return {c,op,entry:{key,kind:'value' as const,index:c.part,bytes:length,hash:null,expiresAt:op.expires_at,metadata:op.metadata},parts,segmentScope:op.scope,first,inner:absolute%CHUNK,nextPart:offset+length<op.bytes?c.part+1:0};
  });
  if(!work)return null;if('finished' in work&&work.finished)return {revision:expectedRevision,complete:true};
  if('end' in work)return this.storage.transactionSync(()=>{const c=this.row(scope);if(!c||!this.valid(c)||c.revision!==expectedRevision)return null;this.sql.exec('UPDATE sinv_checkpoints SET complete=1,revision=revision+1 WHERE scope=?',scope);return {revision:c.revision+1,complete:true};});
  const chunks:Uint8Array[]=[];for(const p of work.parts){const raw=new Uint8Array(p.data);if(!Number.isSafeInteger(p.bytes)||p.bytes!==raw.length||p.bytes<1||p.bytes>CHUNK||!HASH.test(p.hash)||await hash(raw)!==p.hash)return null;chunks.push(raw);}
  let valueHash:string|null=null;
  if(work.entry.kind==='value'){
   const joined=new Uint8Array(chunks.reduce((n,p)=>n+p.length,0));let pos=0;for(const p of chunks){joined.set(p,pos);pos+=p.length;}const start=work.inner??0;if(start+work.entry.bytes>joined.length&&work.entry.bytes!==0)return null;valueHash=await hash(joined.slice(start,start+work.entry.bytes));
  }
  return this.storage.transactionSync(()=>{const c=this.row(scope);if(!c||!this.valid(c)||c.revision!==expectedRevision||JSON.stringify(c)!==JSON.stringify(work.c))return null;const e=work.entry;if(e.expiresAt!==null&&e.expiresAt<=Date.now())return null;
   const chain=this.chain(c.head);if(!chain)return null;
   const current=this.resolve(chain.overlays,chain.base,work.op.key);
   if(JSON.stringify(current)!==JSON.stringify(work.op))return null;
   if(e.kind==='value')for(let i=0;i<work.parts.length;i++){const p=work.parts[i]!;if(!this.sql.exec('SELECT idx FROM seg_parts WHERE scope=? AND idx=? AND hash=? AND bytes=? AND data=?',work.segmentScope,work.first!+i,p.hash,p.bytes,p.data).toArray().length)return null;}
   this.sql.exec('INSERT INTO sinv_entries VALUES (?,?,?,?,?,?,?,?,?)',scope,c.count,e.key,e.kind,e.index,e.bytes,valueHash,e.expiresAt,e.metadata);
   const min=e.expiresAt===null?c.min_expiry:c.min_expiry===null?e.expiresAt:Math.min(c.min_expiry,e.expiresAt);
   this.sql.exec('UPDATE sinv_checkpoints SET after_key=?,part=?,revision=revision+1,min_expiry=?,count=count+1 WHERE scope=?',e.key,work.nextPart,min,scope);return {revision:c.revision+1,complete:false};});
 }
 /** Internal adapter methods run inside the caller's SQLite transaction. */
 validInTransaction(sql:SqlStorage,scope:string,head:string,source:string,capturedAt:number):boolean {
  if(sql!==this.sql || !ID.test(scope) || !ID.test(head) || !HASH.test(source))return false;
  const c=this.row(scope);
  return !!c && !!c.complete && c.head===head && c.source===source && c.captured_at===capturedAt && this.valid(c);
 }
 entriesInTransaction(sql:SqlStorage,scope:string,after:InventoryCursor|null,limit:number):{entries:Entry[];next:InventoryCursor|null}|null {
  if(sql!==this.sql || !ID.test(scope) || !Number.isSafeInteger(limit) || limit<1 || limit>64 || (after!==null && (!after || typeof after.key!=='string' || after.key.length>256 || !Number.isSafeInteger(after.index) || after.index<0)))return null;
  const c=this.row(scope);
  if(!c || !c.complete || !this.valid(c))return null;
  const prior=after?this.sql.exec<{ordinal:number}>('SELECT ordinal FROM sinv_entries WHERE scope=? AND (key,part)<=(?,?) ORDER BY key DESC,part DESC LIMIT 1',scope,after.key,after.index).toArray()[0]:undefined;
  const first=(prior?.ordinal??-1)+1;
  const records=this.sql.exec<StoredEntry & {ordinal:number}>('SELECT ordinal,key,kind,part,bytes,hash,expires_at,metadata FROM sinv_entries WHERE scope=? AND (key,part)>(?,?) ORDER BY key,part LIMIT ?',scope,after?.key??'',after?.index??-1,limit+1).toArray();
  if(records.length!==Math.min(limit+1,c.count-first) || records.some((r,i)=>r.ordinal!==first+i))return null;
  const entries=records.slice(0,limit).map(toEntry);
  const last=entries[entries.length-1];
  return {entries,next:records.length>limit && last?{key:last.key,index:last.index}:null};
 }
 /** The consumer must verify the returned bytes against the independent descriptor hash before using them. */
 readInTransaction(sql:SqlStorage,scope:string,key:string,index:number):{entry:Entry;bytes:Uint8Array|null}|null {
  if(sql!==this.sql || !ID.test(scope) || typeof key!=='string' || !key.length || key.length>256 || !Number.isSafeInteger(index) || index<0 || index>=512)return null;
  const c=this.row(scope);
  if(!c || !c.complete || !this.valid(c))return null;
  const record=this.sql.exec<StoredEntry>('SELECT key,kind,part,bytes,hash,expires_at,metadata FROM sinv_entries WHERE scope=? AND key=? AND part=?',scope,key,index).toArray()[0];
  const chain=this.chain(c.head);
  if(!record || !chain)return null;
  const entry=toEntry(record), op=this.resolve(chain.overlays,chain.base,key);
  if(!op)return null;
  if(op.expires_at!==null && op.expires_at>c.captured_at! && op.expires_at<=Date.now())return null;
  const tombstone=op.kind==='delete'||(op.expires_at!==null && op.expires_at<=c.captured_at!);
  if(tombstone)return entry.kind==='tombstone' && index===0 && entry.bytes===0 && entry.hash===null && entry.expiresAt===null && entry.metadata===null?{entry,bytes:null}:null;
  const offset=index*CHUNK;
  if(op.kind!=='put' || entry.kind!=='value' || !entry.hash || !HASH.test(entry.hash) || entry.expiresAt!==op.expires_at || entry.metadata!==op.metadata || !Number.isSafeInteger(op.start) || op.start<0 || !Number.isSafeInteger(op.bytes) || op.bytes<0 || op.bytes>32*1024*1024 || offset>op.bytes || (offset===op.bytes && index>0) || entry.bytes!==Math.min(CHUNK,op.bytes-offset))return null;
  const bytes=new Uint8Array(entry.bytes);
  let written=0;
  while(written<bytes.length){
   const absolute=op.start+offset+written, part=Math.floor(absolute/CHUNK), inner=absolute%CHUNK, take=Math.min(bytes.length-written,CHUNK-inner);
   const slice=this.sql.exec<{data:ArrayBuffer;size:number;bytes:number;hash:string}>('SELECT substr(data,?,?) AS data,length(data) AS size,bytes,hash FROM seg_parts WHERE scope=? AND idx=?',inner+1,take,op.scope,part).toArray()[0];
   if(!slice || !HASH.test(slice.hash) || slice.size!==slice.bytes || slice.bytes<inner+take || slice.bytes>CHUNK)return null;
   const chunk=new Uint8Array(slice.data);
   if(chunk.length!==take)return null;
   bytes.set(chunk,written);written+=take;
  }
  return {entry,bytes};
 }
 /** Read only completed inventories while head, revisions, source and all expiries remain valid. */
 page(scope:string,after:number,limit:number):{entries:Entry[];next:number|null}|null{
  if(!ID.test(scope)||!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>32)return null;
  return this.storage.transactionSync(()=>{const c=this.row(scope);if(!c||!c.complete||!this.valid(c)||after>c.count)return null;const rows=this.sql.exec<{key:string;kind:'value'|'tombstone';part:number;bytes:number;hash:string|null;expires_at:number|null;metadata:string|null}>('SELECT key,kind,part,bytes,hash,expires_at,metadata FROM sinv_entries WHERE scope=? AND ordinal>=? ORDER BY ordinal LIMIT ?',scope,after,limit).toArray();if(rows.length!==Math.min(limit,c.count-after))return null;return {entries:rows.map(r=>({key:r.key,kind:r.kind,index:r.part,bytes:r.bytes,hash:r.hash,expiresAt:r.expires_at,metadata:r.metadata})),next:after+rows.length<c.count?after+rows.length:null};});
 }
}
