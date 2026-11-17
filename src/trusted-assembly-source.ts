// SYNTHETIC/UNWIRED: coordinator-owned, transactionally pinned source descriptors. The caller is
// trusted internal code; do not expose these operations as public endpoints. No production retention,
// ownership edits, incremental input inventory or reference projector is connected here.
import { DomainGenerationGate } from './domain-generation-gate';
import { IncarnationIsolation, type OperationalKind } from './incarnation-isolation';
const ID=/^[A-Za-z0-9_-]{22,128}$/;
const SAFE_KEY=/^(?:cursor|failures|recheck|history|cls|digest|done):[A-Za-z0-9_:\-.]+$/;
const DONE_HASH='6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b'; // SHA-256 of UTF-8 "1".
const REAL_DIGEST=/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;
type Row={alias:string;identity:string;state:string;partial:string|null;partial_count:number|null};
type Namespace={incarnation:number;namespace:string};
type SegmentBinding={scope:string;source:string;pin:string};
type SegmentEntry={key:string;kind:'value'|'tombstone';index:number;bytes:number;hash:string|null;expiresAt:number|null;metadata:string|null};
/** Internal adapter over a separately verified, pinned committed inventory. */
export type SegmentSourceAdapter={pinned(sql:SqlStorage,head:string,pin:string):boolean;validInTransaction(sql:SqlStorage,scope:string,head:string,source:string,capturedAt:number):boolean;readInTransaction(sql:SqlStorage,scope:string,key:string,index:number):{entry:SegmentEntry;bytes:Uint8Array|null}|null};
type Snapshot={scope:string;job:string;generation:string;head:string|null;previousDigest:string|null;versions:{key:string;version:number}[];rows:Row[];at:number;mode:'legacy'|'scoped';namespaces:Record<string,Namespace>;segment?:SegmentBinding};
type Stored={payload:string;token:string};
/** Authorization must independently prove migration/quiescence; synthetic tests may inject a stub. */
type SourceAuthority={authorize:(sql:SqlStorage,job:string,generation:string)=>boolean;previous:(sql:SqlStorage,job:string,generation:string)=>string|null|undefined};
export type SourceAccess=SourceAuthority&({kind:'legacy'}|{kind:'scoped';isolation:IncarnationIsolation});
export type TrustedInventoryEntry={cursor:string;kind:'partial'|'state'|'missing'|'tombstone';key:string;index:number;bytes:number;hash:string|null;expiresAt?:number|null;metadata?:unknown};
export class TrustedAssemblySource {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly gate:DomainGenerationGate,private readonly access?:SourceAccess,private readonly segmentAdapter?:SegmentSourceAdapter){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS trusted_source (scope TEXT PRIMARY KEY, job TEXT NOT NULL, generation TEXT NOT NULL, token TEXT NOT NULL, payload TEXT NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS owner_settings (singleton INTEGER PRIMARY KEY CHECK(singleton=1), value TEXT NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS owner_settings_hash (singleton INTEGER PRIMARY KEY CHECK(singleton=1), hash TEXT NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS owner_settings_chunks (idx INTEGER PRIMARY KEY, bytes INTEGER NOT NULL, hash TEXT NOT NULL, data BLOB NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS owner_done_scoped (namespace TEXT NOT NULL,message_id TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(namespace,message_id))');
 }
 private claim(job:string,generation:string,token:string):boolean{
  const row=this.sql.exec<{expires:number;deadline:number}>("SELECT j.expires,f.deadline FROM core_jobs j JOIN core_final f ON f.job=j.job JOIN core_active a ON a.singleton=1 AND a.job=j.job WHERE j.job=? AND j.generation=? AND j.state='running' AND f.token=?",job,generation,token).toArray()[0];
  return !!row && row.expires>Date.now() && row.deadline>Date.now();
 }
 private head():string|null{return this.sql.exec<{generation:string}>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation??null;}
 private legacyHead():boolean{
  const head=this.head();return !head || !this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='sgen_committed'").toArray().length || !this.sql.exec('SELECT scope FROM sgen_committed WHERE scope=?',head).toArray().length;
 }
 /** A missing run index falls back to historical digest keys in the application. Until a
  * bounded repair has populated the index, refuse capture if any unexpired digest remains. */
 private runsIndexReady():boolean{
  const now=Date.now();
  const index=this.sql.exec<{kind:string;expires_at:number|null;chunks:number}>('SELECT kind,expires_at,chunks FROM gen_key_heads WHERE key=?','runs-index').toArray()[0];
  if(index&&!['put','delete'].includes(index.kind))return false;
  if(index?.kind==='put'&&(index.expires_at===null||index.expires_at>now))return Number.isSafeInteger(index.chunks)&&index.chunks>0;
  return !this.sql.exec("SELECT key FROM gen_key_heads WHERE key>=? AND key<? AND kind='put' AND (expires_at IS NULL OR expires_at>?) LIMIT 1",'digest:','digest;',now).toArray().length;
 }
 private previousDigest(job:string,generation:string):string|null|undefined{
  const value=this.access?.previous?.(this.sql,job,generation);
  return value===null||(typeof value==='string'&&REAL_DIGEST.test(value))?value:undefined;
 }
 private rows(job:string):Row[]{return this.sql.exec<Row>('SELECT alias,identity,state,partial,partial_count FROM core_steps WHERE job=? ORDER BY alias',job).toArray();}
 private allowed(job:string,generation:string):boolean{return !!this.access&&this.access.authorize(this.sql,job,generation)===true;}
 private namespaceMap(rows:Row[]):Record<string,Namespace>|null{
  if(this.access?.kind!=='scoped')return {};
  const namespaces:Record<string,Namespace>={};
  for(const row of rows){const incarnation=this.sql.exec<{version:number}>('SELECT version FROM coordinated_incarnations WHERE alias=?',row.alias).toArray()[0]?.version;if(!incarnation)return null;const namespace=this.access.isolation.namespaceInTransaction(this.sql,row.alias,incarnation);if(!namespace)return null;namespaces[row.alias]={incarnation,namespace};}
  return namespaces;
 }
 private physical(s:Snapshot,key:string):string|null{
  if(s.mode==='legacy')return key;
  const match=/^(cursor|failures|history|recheck|cls):([^:]+)(?::([A-Za-z0-9_-]+))?$/.exec(key);
  if(!match)return key;
  const scoped=s.namespaces[match[2]!];if(!scoped||this.access?.kind!=='scoped')return null;
  const kind=(match[1]==='cls'?'classification':match[1]) as OperationalKind;
  return this.access.isolation.keyInTransaction(this.sql,match[2]!,scoped.incarnation,kind,match[3]);
 }
 private settingsMeta():{kind:'missing'}|{kind:'corrupt'}|{kind:'value';chunks:number}{
  const value=this.sql.exec<{bytes:number}>('SELECT length(CAST(value AS BLOB)) AS bytes FROM owner_settings WHERE singleton=1').toArray()[0];
  const hash=this.sql.exec<{hash:string}>('SELECT hash FROM owner_settings_hash WHERE singleton=1').toArray()[0];
  const stats=this.sql.exec<{n:number;bytes:number}>('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes FROM owner_settings_chunks').toArray()[0];
  if(!value)return !hash&&stats?.n===0?{kind:'missing'}:{kind:'corrupt'};
  const chunks=Math.ceil(value.bytes/(64*1024));
  if(!hash||!/^[a-f0-9]{64}$/.test(hash.hash)||!stats||chunks<1||chunks>16||stats.n!==chunks||stats.bytes!==value.bytes)return {kind:'corrupt'};
  return {kind:'value',chunks};
 }
 private settingsChunk(index:number):{data:ArrayBuffer;bytes:number;hash:string}|null{
  return this.sql.exec<{data:ArrayBuffer;bytes:number;hash:string}>('SELECT c.data,c.bytes,c.hash FROM owner_settings_chunks c JOIN owner_settings s ON s.singleton=1 WHERE c.idx=? AND c.bytes>0 AND c.bytes<=65536 AND length(c.data)=c.bytes AND c.data=substr(CAST(s.value AS BLOB),c.idx*65536+1,c.bytes)',index).toArray()[0]??null;
 }
 /** Must be called on the coordinator after all expected mailbox attempts have resolved. */
 capture(scope:string,job:string,generation:string,token:string,segment?:SegmentBinding):Snapshot|null{
  if (![scope,job,generation,token].every(x=>typeof x==='string'&&ID.test(x))) return null;
  if(segment&&(!segment||typeof segment!=='object'||Object.keys(segment).length!==3||!Object.keys(segment).every(k=>['scope','source','pin'].includes(k))||typeof segment.scope!=='string'||typeof segment.pin!=='string'||typeof segment.source!=='string'||!ID.test(segment.scope)||!ID.test(segment.pin)||!/^[a-f0-9]{64}$/.test(segment.source)))return null;
  return this.storage.transactionSync(()=>{
   const head=this.head(),legacy=this.legacyHead();
   if(!this.claim(job,generation,token)||!this.allowed(job,generation)||(legacy?!!segment||!this.runsIndexReady():!segment||!head||!this.segmentAdapter||!this.segmentAdapter.pinned(this.sql,head,segment.pin)))return null;
   const versions=this.gate.captureInTransaction(this.sql,job,generation), rows=this.rows(job);
   if(!versions||rows.length>50||rows.some(r=>(r.state!=='done'&&r.state!=='failed')||(r.state==='done'&&(!r.partial||!/^[a-f0-9]{64}$/.test(r.partial)||r.partial_count===null||r.partial_count<1||r.partial_count>160))))return null;
   const existing=this.sql.exec<Stored>('SELECT payload,token FROM trusted_source WHERE scope=?',scope).toArray()[0];
   if(existing){const old=JSON.parse(existing.payload) as Snapshot; return existing.token===token&&old.job===job&&old.generation===generation&&JSON.stringify(old.segment??null)===JSON.stringify(segment??null)&&this.valid(old,token)?old:null;}
   const at=Date.now(), previousDigest=this.previousDigest(job,generation),namespaces=this.namespaceMap(rows);if(previousDigest===undefined||!namespaces)return null;
   const value:Snapshot={scope,job,generation,head,previousDigest,versions,rows,at,mode:this.access!.kind,namespaces,...(segment?{segment:{...segment}}:{})};
   this.sql.exec('INSERT INTO trusted_source (scope,job,generation,token,payload) VALUES (?,?,?,?,?)',scope,job,generation,token,JSON.stringify(value));return value;
  });
 }
 private valid(s:Snapshot,token:string):boolean{
  if(!this.claim(s.job,s.generation,token)||!this.allowed(s.job,s.generation)||s.mode!==this.access?.kind||this.head()!==s.head||this.previousDigest(s.job,s.generation)!==s.previousDigest)return false;
  if(s.segment){if(this.legacyHead()||!s.head||!this.segmentAdapter||!this.segmentAdapter.pinned(this.sql,s.head,s.segment.pin))return false;}
  else if(!this.legacyHead()||!this.runsIndexReady())return false;
  const versions=this.gate.captureInTransaction(this.sql,s.job,s.generation);
  const rows=this.rows(s.job),namespaces=this.namespaceMap(rows);
  return !!versions && !!namespaces && JSON.stringify(versions)===JSON.stringify(s.versions) && JSON.stringify(rows)===JSON.stringify(s.rows) && JSON.stringify(namespaces)===JSON.stringify(s.namespaces);
 }
 /** Internal, only valid while the originating finalizer and captured revisions remain current. */
 private load(scope:string,token:string):Snapshot|null{
  const found=this.sql.exec<Stored>('SELECT payload,token FROM trusted_source WHERE scope=?',scope).toArray()[0];
  if(!found||found.token!==token)return null;
  const s=JSON.parse(found.payload) as Snapshot;return this.valid(s,token)?s:null;
 }
 private segmentReady(s:Snapshot):boolean{
  const b=s.segment;if(!b||!s.head||!this.segmentAdapter||!this.segmentAdapter.validInTransaction(this.sql,b.scope,s.head,b.source,s.at))return false;
  const checkpoint=this.sql.exec<{pin:string;count:number}>('SELECT pin,count FROM sinv_checkpoints WHERE scope=?',b.scope).toArray()[0];if(!checkpoint||checkpoint.pin!==b.pin||!Number.isSafeInteger(checkpoint.count)||checkpoint.count<0||checkpoint.count>100000)return false;
  // Synthetic safety guard. This bounded full count detects a lost descriptor before any
  // point lookup can interpret it as absence. It is not approved for a Free-plan path.
  const stats=this.sql.exec<{n:number;lo:number|null;hi:number|null}>('SELECT COUNT(*) AS n,MIN(ordinal) AS lo,MAX(ordinal) AS hi FROM sinv_entries WHERE scope=?',b.scope).toArray()[0];
  if(!stats||stats.n!==checkpoint.count||(stats.n>0&&(stats.lo!==0||stats.hi!==stats.n-1)))return false;
  const index=this.segmentAdapter.readInTransaction(this.sql,b.scope,'runs-index',0);
  if(!index&&this.sql.exec('SELECT key FROM sinv_entries WHERE scope=? AND key=? LIMIT 1',b.scope,'runs-index').toArray().length)return false;
  if(index?.entry.kind==='value')return true;
  // Missing/deleted index requires repair while any unexpired historical digest is present.
  return !this.sql.exec("SELECT key FROM sinv_entries WHERE scope=? AND key>=? AND key<? AND kind='value' LIMIT 1",b.scope,'digest:','digest;').toArray().length;
 }
 /** Call only inside this coordinator's existing SQLite transaction. */
 validateCaptureInTransaction(sql:SqlStorage,scope:string,token:string):boolean{return sql===this.sql&&this.load(scope,token)!==null;}
 validateInTransaction(sql:SqlStorage,scope:string,token:string):boolean{if(sql!==this.sql)return false;const s=this.load(scope,token);return !!s&&(!s.segment||this.segmentReady(s));}
 /** The inventory builder may use this before completion; it binds its source to this capture. */
 segmentInventoryAuthority(scope:string,token:string):(sql:SqlStorage,head:string,source:string,capturedAt:number)=>boolean{return(sql,head,source,capturedAt)=>{if(sql!==this.sql)return false;const s=this.load(scope,token);return !!s?.segment&&s.head===head&&s.segment.source===source&&s.at===capturedAt;};}
 /** Extract only the bound mailbox address; never materialize the encrypted account record. */
 accountEmailInTransaction(sql:SqlStorage,scope:string,token:string,alias:string):string|null{
  if(sql!==this.sql)return null;
  const snapshot=this.load(scope,token),row=snapshot?.rows.find(r=>r.alias===alias);
  if(!snapshot||!row)return null;
  const tables=this.sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('coordinated_accounts','coordinated_identities')").toArray()[0]?.n;
  if(tables!==2)return null;
  const account=this.sql.exec<{email:string}>("SELECT json_extract(a.value,'$.email') AS email FROM coordinated_accounts a JOIN coordinated_identities i ON i.alias=a.alias AND i.identity=? WHERE a.alias=? AND a.purge_pending=0 AND json_valid(a.value)=1",row.identity,alias).toArray()[0];
  return account && typeof account.email==='string' && account.email.length<=254 && /^[^\s@]+@[^\s@]+$/.test(account.email)?account.email:null;
 }
 /**
  * Independently enumerate accepted partial chunks, fixed possibly-absent run state, and
  * all committed digest/cache/done keys for the captured mailboxes. Pages are bounded;
  * the caller must checkpoint the returned cursor and exhaust the inventory in order.
  * This intentionally over-enumerates, and is not yet measured for production workloads.
  */
 inventoryPageInTransaction(sql:SqlStorage,scope:string,token:string,after:string|null,limit:number):{entries:TrustedInventoryEntry[];next:string|null}|null{
  if(sql!==this.sql||!Number.isSafeInteger(limit)||limit<1||limit>64|| (after!==null&&(typeof after!=='string'||after.length>1024)))return null;
  const snapshot=this.load(scope,token);if(!snapshot||snapshot.segment&&!this.segmentReady(snapshot))return null;
  let cursor:{phase:'partial'|'state';key:string;index:number}|null=null;
  if(after!==null){try{cursor=JSON.parse(after);if(!cursor||!['partial','state'].includes(cursor.phase)||typeof cursor.key!=='string'||!Number.isSafeInteger(cursor.index)||cursor.index<0||cursor.index>=(cursor.phase==='state'&&snapshot.segment?512:160))return null;}catch{return null;}}
  const entries:TrustedInventoryEntry[]=[];
  const add=(kind:TrustedInventoryEntry['kind'],key:string,index:number,bytes:number,hash:string|null,phase:'partial'|'state',extra?:{expiresAt:number|null;metadata:unknown})=>{
   const itemCursor=JSON.stringify({phase,key,index});entries.push({cursor:itemCursor,kind,key,index,bytes,hash,...extra});
  };
  // Walk the captured, fixed mailbox set, not a producer-supplied list.
  if(!cursor||cursor.phase==='partial'){
   for(const row of snapshot.rows){
    if(row.state!=='done')continue;
    const start=cursor?.phase==='partial'?(row.alias<cursor.key?row.partial_count!:row.alias===cursor.key?cursor.index+1:0):0;
    for(let index=start;index<(row.partial_count??0);index++){
     const step=this.sql.exec<{token:string}>('SELECT token FROM core_steps WHERE job=? AND alias=?',snapshot.job,row.alias).toArray()[0];
     if(!step)return null;
     let part=this.sql.exec<{hash:string;bytes:number}>('SELECT hash,bytes FROM core_chunks WHERE job=? AND alias=? AND token=? AND idx=?',snapshot.job,row.alias,step.token,index).toArray()[0];
     if(!part&&index===0)part=this.sql.exec<{hash:string;bytes:number}>('SELECT hash,bytes FROM core_stages WHERE job=? AND alias=? AND token=? AND hash=?',snapshot.job,row.alias,step.token,row.partial).toArray()[0];
     if(!part)return null;
     add('partial',row.alias,index,part.bytes,part.hash,'partial');
     if(entries.length>limit)return {entries:entries.slice(0,limit),next:entries[limit-1]!.cursor};
    }
   }
  }
  const fixed=new Set(['last-run','runs-index','settings',...(snapshot.previousDigest?[`digest:${snapshot.previousDigest}`]:[])]);
  for(const row of snapshot.rows)for(const prefix of ['cursor','failures','history','recheck'])fixed.add(`${prefix}:${row.alias}`);
  const stateAfter=cursor?.phase==='state'?cursor.key:'';
  // One JSON argument avoids exceeding Workers SQLite's bind-parameter limit at 50 accounts.
  let variable:string[]=[],doneKeys:string[]=[];
  if(snapshot.mode==='legacy'){
   const prefixes=snapshot.rows.map(row=>`cls:${row.alias}:`);
   variable=snapshot.segment?this.sql.exec<{key:string}>("SELECT DISTINCT h.key FROM sinv_entries h WHERE h.scope=? AND h.key>=? AND EXISTS (SELECT 1 FROM json_each(?) p WHERE substr(h.key,1,length(p.value))=p.value) ORDER BY h.key LIMIT ?",snapshot.segment.scope,stateAfter,JSON.stringify(prefixes),limit+1).toArray().map(r=>r.key):this.sql.exec<{key:string}>("SELECT h.key FROM gen_key_heads h WHERE h.key>=? AND EXISTS (SELECT 1 FROM json_each(?) p WHERE substr(h.key,1,length(p.value))=p.value) ORDER BY h.key LIMIT ?",stateAfter,JSON.stringify(prefixes),limit+1).toArray().map(r=>r.key);
   const donePrefixes=snapshot.rows.map(row=>`${row.alias}:`),doneAfter=stateAfter.startsWith('done:')?stateAfter.slice(5):stateAfter>'done:'?'\uffff':'';
   doneKeys=this.sql.exec<{key:string}>("SELECT 'done:'||d.item AS key FROM owner_done d WHERE d.item>=? AND d.expires_at>? AND EXISTS (SELECT 1 FROM json_each(?) p WHERE substr(d.item,1,length(p.value))=p.value) ORDER BY d.item LIMIT ?",doneAfter,snapshot.at,JSON.stringify(donePrefixes),limit+1).toArray().map(r=>r.key);
  }else{
   // Physical namespace order differs from logical alias order. Seek within each mailbox,
   // then merge bounded candidates in logical order so pagination never skips an alias.
   for(const row of snapshot.rows){
    const ns=snapshot.namespaces[row.alias];if(!ns)return null;
    const logical=`cls:${row.alias}:`,physical=`mb:${ns.namespace}:classification:`;
    if(stateAfter<`${logical}\uffff`){const start=stateAfter.startsWith(logical)?stateAfter.slice(logical.length):'';const found=snapshot.segment?this.sql.exec<{key:string}>('SELECT DISTINCT key FROM sinv_entries WHERE scope=? AND key>=? AND key<? ORDER BY key LIMIT ?',snapshot.segment.scope,physical+start,`${physical}\uffff`,limit+1).toArray():this.sql.exec<{key:string}>('SELECT key FROM gen_key_heads WHERE key>=? AND key<? ORDER BY key LIMIT ?',physical+start,`${physical}\uffff`,limit+1).toArray();variable.push(...found.map(v=>logical+v.key.slice(physical.length)));}
    const logicalDone=`done:${row.alias}:`;
    if(stateAfter<`${logicalDone}\uffff`){const start=stateAfter.startsWith(logicalDone)?stateAfter.slice(logicalDone.length):'';const found=this.sql.exec<{message_id:string}>('SELECT message_id FROM owner_done_scoped WHERE namespace=? AND message_id>=? AND expires_at>? ORDER BY message_id LIMIT ?',ns.namespace,start,snapshot.at,limit+1).toArray();doneKeys.push(...found.map(v=>logicalDone+v.message_id));}
   }
  }
  const keys=[...new Set([...fixed,...variable,...doneKeys])].filter(k=>k>=stateAfter).sort();
  for(const key of keys){
   if(key==='settings'){
    const settings=this.settingsMeta();if(settings.kind==='corrupt')return null;
    const start=cursor?.phase==='state'&&key===cursor.key?cursor.index+1:0;
    const count=settings.kind==='missing'?1:settings.chunks;
    for(let index=start;index<count;index++){
     if(settings.kind==='missing')add('missing',key,0,0,null,'state');
     else {const part=this.settingsChunk(index);if(!part||!/^[a-f0-9]{64}$/.test(part.hash))return null;add('state',key,index,part.bytes,part.hash,'state',{expiresAt:null,metadata:null});}
     if(entries.length>limit)return {entries:entries.slice(0,limit),next:entries[limit-1]!.cursor};
    }
    continue;
   }
   if(key.startsWith('done:')){
    const split=key.indexOf(':',5),alias=key.slice(5,split),message=key.slice(split+1),ns=snapshot.namespaces[alias];
    const done=snapshot.mode==='scoped'?(ns?this.sql.exec<{expires_at:number}>('SELECT expires_at FROM owner_done_scoped WHERE namespace=? AND message_id=?',ns.namespace,message).toArray()[0]:undefined):this.sql.exec<{expires_at:number}>('SELECT expires_at FROM owner_done WHERE item=?',key.slice(5)).toArray()[0];
    if(!done || done.expires_at<=snapshot.at)return null;
    const start=cursor?.phase==='state'&&key===cursor.key?cursor.index+1:0;
    if(start===0)add('state',key,0,1,DONE_HASH,'state',{expiresAt:done.expires_at,metadata:null});
    if(entries.length>limit)return {entries:entries.slice(0,limit),next:entries[limit-1]!.cursor};
    continue;
   }
   const physical=this.physical(snapshot,key);if(!physical)return null;
   if(snapshot.segment){
    const rows=this.sql.exec<{kind:'value'|'tombstone';part:number;bytes:number;hash:string|null;expires_at:number|null;metadata:string|null}>('SELECT kind,part,bytes,hash,expires_at,metadata FROM sinv_entries WHERE scope=? AND key=? ORDER BY part LIMIT 513',snapshot.segment.scope,physical).toArray();
    if(rows.length>512||rows.some((r,i)=>r.part!==i||!['value','tombstone'].includes(r.kind)))return null;
    const start=cursor?.phase==='state'&&key===cursor.key?cursor.index+1:0;
    if(!rows.length){if(start===0)add('missing',key,0,0,null,'state');}
    else for(let i=start;i<rows.length;i++){const r=rows[i]!;if(r.kind==='tombstone'){if(rows.length!==1||r.bytes!==0||r.hash!==null)return null;add('tombstone',key,0,0,null,'state');}else{let metadata:unknown=null;try{if(r.metadata!==null)metadata=JSON.parse(r.metadata);}catch{return null;}if(r.bytes>0&&(!r.hash||!/^[a-f0-9]{64}$/.test(r.hash)))return null;add('state',key,i,r.bytes,r.bytes===0?null:r.hash,'state',{expiresAt:r.expires_at,metadata});}if(entries.length>limit)return {entries:entries.slice(0,limit),next:entries[limit-1]!.cursor};}
    if(entries.length>limit)return {entries:entries.slice(0,limit),next:entries[limit-1]!.cursor};continue;
   }
   const row=this.sql.exec<{generation:string;preparation:string;kind:string;expires_at:number|null;metadata:string|null;chunks:number}>('SELECT generation,preparation,kind,expires_at,metadata,chunks FROM gen_key_heads WHERE key=?',physical).toArray()[0];
   const absent=!row||(row.expires_at!==null&&row.expires_at<=snapshot.at);
   const count=absent||row!.kind==='delete'?1:Math.max(1,row!.chunks);
   const start=cursor?.phase==='state'&&key===cursor.key?cursor.index+1:0;
   for(let index=start;index<count;index++){
    if(absent)add('missing',key,index,0,null,'state');
    else if(row!.kind==='delete')add('tombstone',key,index,0,null,'state');
    else if(row!.chunks===0)add('state',key,index,0,null,'state',{expiresAt:row!.expires_at,metadata:row!.metadata?JSON.parse(row!.metadata):null});
    else{
     const part=this.sql.exec<{hash:string;bytes:number}>('SELECT hash,bytes FROM gen_chunks WHERE generation=? AND preparation=? AND key=? AND idx=?',row!.generation,row!.preparation,physical,index).toArray()[0];
     if(!part)return null;
     add('state',key,index,part.bytes,part.hash,'state',{expiresAt:row!.expires_at,metadata:row!.metadata?JSON.parse(row!.metadata):null});
    }
    if(entries.length>limit)return {entries:entries.slice(0,limit),next:entries[limit-1]!.cursor};
   }
  }
  return {entries,next:null};
 }
 describe(scope:string,token:string):Snapshot|null {return this.storage.transactionSync(()=>this.load(scope,token));}
 readPartial(scope:string,token:string,alias:string,index:number):Uint8Array|null{
  if(!Number.isSafeInteger(index)||index<0||index>=160)return null;
  return this.storage.transactionSync(()=>{
   const s=this.load(scope,token), expected=s?.rows.find(r=>r.alias===alias);
   if(!s||!expected||expected.state!=='done')return null;
   if(expected.partial_count===null||index>=expected.partial_count)return null;
   const step=this.sql.exec<{token:string;partial:string}>("SELECT token,partial FROM core_steps WHERE job=? AND alias=? AND state='done'",s.job,alias).toArray()[0];
   if(!step||step.partial!==expected.partial)return null;
   let part=this.sql.exec<{data:string}>('SELECT data FROM core_chunks WHERE job=? AND alias=? AND token=? AND idx=?',s.job,alias,step.token,index).toArray()[0];
   if(!part&&index===0)part=this.sql.exec<{data:string}>('SELECT data FROM core_stages WHERE job=? AND alias=? AND token=? AND hash=?',s.job,alias,step.token,step.partial).toArray()[0];
   if(!part)throw new Error('missing accepted partial chunk');
   return Uint8Array.from(atob(part.data),c=>c.charCodeAt(0));
  });
 }
 /** Point-read only non-credential run state; enumeration/inventory is not implemented. */
 readState(scope:string,token:string,key:string,index:number):{kind:'stale'|'missing'|'tombstone'|'corrupt'}|{kind:'value';bytes:Uint8Array|null;metadata:unknown;expiresAt:number|null}{
  if(!Number.isSafeInteger(index)||index<0||index>=512||typeof key!=='string'||key.length>360||(!(SAFE_KEY.test(key))&&!['last-run','runs-index','settings'].includes(key)))return {kind:'missing'};
  return this.storage.transactionSync(()=>{
   const s=this.load(scope,token);if(!s||s.segment&&!this.segmentReady(s))return {kind:'stale'};
   if(!s.segment&&index>=160)return {kind:'missing'};
   if(key.startsWith('digest:')&&key!==`digest:${s.previousDigest}`)return {kind:'missing'};
   if(key==='settings'){
    const settings=this.settingsMeta();if(settings.kind==='missing')return {kind:'missing'};if(settings.kind==='corrupt')return {kind:'corrupt'};
    if(index>=settings.chunks)return {kind:'value',bytes:null,metadata:null,expiresAt:null};
    const part=this.settingsChunk(index);if(!part||!/^[a-f0-9]{64}$/.test(part.hash))return {kind:'corrupt'};
    return {kind:'value',bytes:new Uint8Array(part.data),metadata:null,expiresAt:null};
   }
   const prefix=/^(cursor|failures|recheck|history|cls|done):([^:]+)(?::|$)/.exec(key);
   if(prefix && !s.rows.some(r=>r.alias===prefix[2]))return {kind:'missing'};
   if(key.startsWith('done:')){
    const split=key.indexOf(':',5),alias=key.slice(5,split),message=key.slice(split+1),ns=s.namespaces[alias];
    const done=s.mode==='scoped'?(ns?this.sql.exec<{expires_at:number}>('SELECT expires_at FROM owner_done_scoped WHERE namespace=? AND message_id=?',ns.namespace,message).toArray()[0]:undefined):this.sql.exec<{expires_at:number}>('SELECT expires_at FROM owner_done WHERE item=?',key.slice(5)).toArray()[0];
    if(!done || done.expires_at<=s.at)return {kind:'missing'};
    return {kind:'value',bytes:index===0?new TextEncoder().encode('1'):null,metadata:null,expiresAt:done.expires_at};
   }
   const physical=this.physical(s,key);if(!physical)return {kind:'stale'};
   if(s.segment){
    const stored=this.sql.exec<{kind:string;part:number}>('SELECT kind,part FROM sinv_entries WHERE scope=? AND key=? ORDER BY part LIMIT 513',s.segment.scope,physical).toArray();
    if(!stored.length)return {kind:'missing'};
    if(stored.length>512||stored.some((r,i)=>r.part!==i))return {kind:'corrupt'};
    if(index>=stored.length){const first=this.segmentAdapter!.readInTransaction(this.sql,s.segment.scope,physical,0);if(!first)return {kind:'corrupt'};if(first.entry.kind==='tombstone')return {kind:'tombstone'};let metadata:unknown=null;try{if(first.entry.metadata!==null)metadata=JSON.parse(first.entry.metadata);}catch{return {kind:'corrupt'};}return {kind:'value',bytes:null,metadata,expiresAt:first.entry.expiresAt};}
    const part=this.segmentAdapter!.readInTransaction(this.sql,s.segment.scope,physical,index);if(!part)return {kind:'corrupt'};
    if(part.entry.kind==='tombstone')return {kind:'tombstone'};
    let metadata:unknown=null;try{if(part.entry.metadata!==null)metadata=JSON.parse(part.entry.metadata);}catch{return {kind:'corrupt'};}
    return {kind:'value',bytes:part.entry.bytes===0?null:part.bytes,metadata,expiresAt:part.entry.expiresAt};
   }
   const row=this.sql.exec<{generation:string;preparation:string;kind:string;expires_at:number|null;metadata:string|null;chunks:number}>('SELECT generation,preparation,kind,expires_at,metadata,chunks FROM gen_key_heads WHERE key=?',physical).toArray()[0];
   if(!row || (row.expires_at!==null&&row.expires_at<=s.at))return {kind:'missing'};
   if(row.kind==='delete')return {kind:'tombstone'};
   const part=this.sql.exec<{data:string}>('SELECT data FROM gen_chunks WHERE generation=? AND preparation=? AND key=? AND idx=?',row.generation,row.preparation,physical,index).toArray()[0];
   if(!part&&index<row.chunks)return {kind:'corrupt'};
   return {kind:'value',bytes:part?Uint8Array.from(atob(part.data),c=>c.charCodeAt(0)):null,metadata:row.metadata?JSON.parse(row.metadata):null,expiresAt:row.expires_at};
  });
 }
}
