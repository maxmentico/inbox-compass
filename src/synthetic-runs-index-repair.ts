// SYNTHETIC / UNWIRED legacy coordinator repair. The authority must prove that all writes are
// routed through the pinned head, legacy migration is complete, and repair is authorized.
// No production binding, automatic scheduling, expiry cleanup or schema migration is provided.
const ID=/^[A-Za-z0-9_-]{22,128}$/;
const PAGE=32, MAX_REAL=1000, MAX_TEST=30;
export type RunsRepairAuthority=(sql:SqlStorage,head:string|null)=>boolean;
type State={head:string|null;next_head:string;settings_version:number;done_version:number;cursor:string;revision:number;complete:number;real:number;test:number;min_expiry:number|null};
export class SyntheticRunsIndexRepair {
 private sql:SqlStorage;
 constructor(private storage:DurableObjectStorage,private authority?:RunsRepairAuthority){this.sql=storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS runs_repair (id TEXT PRIMARY KEY,head TEXT,next_head TEXT NOT NULL,settings_version INTEGER NOT NULL,done_version INTEGER NOT NULL,cursor TEXT NOT NULL,revision INTEGER NOT NULL,complete INTEGER NOT NULL,real INTEGER NOT NULL,test INTEGER NOT NULL,min_expiry INTEGER)');this.sql.exec('CREATE TABLE IF NOT EXISTS runs_repair_ids (id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(id,value))');this.sql.exec('CREATE TABLE IF NOT EXISTS runs_repair_commits (id TEXT PRIMARY KEY,next_head TEXT NOT NULL,revision INTEGER NOT NULL)');}
 private head():string|null{return this.sql.exec<{generation:string}>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation??null;}
 private row(id:string):State|undefined{return this.sql.exec<State>('SELECT head,next_head,settings_version,done_version,cursor,revision,complete,real,test,min_expiry FROM runs_repair WHERE id=?',id).toArray()[0];}
 private version(key:string):number|undefined{const value=this.sql.exec<{version:number}>('SELECT version FROM gen_versions WHERE key=?',key).toArray()[0]?.version;return Number.isSafeInteger(value)&&value!>=0?value:undefined;}
 private allowed(s:State):boolean{
  if(this.head()!==s.head||this.version('settings')!==s.settings_version||this.version('done')!==s.done_version||!this.authority||this.authority(this.sql,s.head)!==true||(s.min_expiry!==null&&s.min_expiry<=Date.now()))return false;
  if(this.sql.exec('SELECT job FROM core_active LIMIT 1').toArray().length)return false;
  if(s.head&&this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='sgen_committed'").toArray().length&&this.sql.exec('SELECT scope FROM sgen_committed WHERE scope=?',s.head).toArray().length)return false;
  const idx=this.sql.exec<{kind:string;expires_at:number|null}>('SELECT kind,expires_at FROM gen_key_heads WHERE key=?','runs-index').toArray()[0];
  return !idx||idx.kind==='delete'||(idx.kind==='put'&&idx.expires_at!==null&&idx.expires_at<=Date.now());
 }
 begin(id:string,expectedHead:string|null,nextHead:string):boolean{
  if(!ID.test(id)||!ID.test(nextHead)||id===nextHead||(expectedHead!==null&&!ID.test(expectedHead)))return false;
  return this.storage.transactionSync(()=>{const prior=this.row(id);if(prior)return prior.head===expectedHead&&prior.next_head===nextHead&&this.allowed(prior);const settings=this.version('settings'),done=this.version('done');if(settings===undefined||done===undefined)return false;const state:State={head:expectedHead,next_head:nextHead,settings_version:settings,done_version:done,cursor:'digest;',revision:0,complete:0,real:0,test:0,min_expiry:null};if(!this.allowed(state)||this.sql.exec('SELECT token FROM core_tokens WHERE token IN (?,?) LIMIT 1',id,nextHead).toArray().length)return false;this.sql.exec('INSERT INTO core_tokens VALUES (?)',id);this.sql.exec('INSERT INTO core_tokens VALUES (?)',nextHead);this.sql.exec('INSERT INTO runs_repair VALUES (?,?,?,?,?,?,0,0,0,0,NULL)',id,expectedHead,nextHead,settings,done,'digest;');return true;});
 }
 /** Examine at most 32 keys; checkpoint cursor and selected IDs atomically. */
 next(id:string,revision:number):{revision:number;complete:boolean}|null{
  if(!ID.test(id)||!Number.isSafeInteger(revision)||revision<0)return null;
  return this.storage.transactionSync(()=>{const s=this.row(id);if(!s||s.revision!==revision||!this.allowed(s))return null;if(s.complete)return {revision,complete:true};
   const now=Date.now(),rows=this.sql.exec<{key:string;kind:string;expires_at:number|null}>('SELECT key,kind,expires_at FROM gen_key_heads WHERE key>=? AND key<? ORDER BY key DESC LIMIT ?', 'digest:',s.cursor,PAGE).toArray();let real=s.real,test=s.test,min=s.min_expiry;
   // SQLite binary order matches the application's JS ordering for ASCII keys. Reject other
   // historical names instead of silently selecting the wrong capped subset.
   if(rows.some(row=>!['put','delete'].includes(row.kind)||(row.expires_at!==null&&(!Number.isSafeInteger(row.expires_at)||row.expires_at<=0))||row.key.length>256||row.key.length<=7||!/^digest:[\x20-\x7e]+$/.test(row.key)))return null;
   for(const row of rows){if(row.kind!=='put'||(row.expires_at!==null&&row.expires_at<=now))continue;const value=row.key.slice(7);const isTest=value.endsWith('-test');if(isTest?test>=MAX_TEST:real>=MAX_REAL)continue;this.sql.exec('INSERT INTO runs_repair_ids VALUES (?,?)',id,value);if(isTest)test++;else real++;if(row.expires_at!==null)min=min===null?row.expires_at:Math.min(min,row.expires_at);}
   const complete=rows.length<PAGE||(real===MAX_REAL&&test===MAX_TEST);this.sql.exec('UPDATE runs_repair SET cursor=?,revision=revision+1,complete=?,real=?,test=?,min_expiry=? WHERE id=?',rows.at(-1)?.key??s.cursor,complete?1:0,real,test,min,id);return {revision:revision+1,complete};});
 }
 /** Hash the bounded result outside the transaction, then recheck head, authority and checkpoint. */
 async publish(id:string,revision:number):Promise<boolean>{
  if(!ID.test(id)||!Number.isSafeInteger(revision)||revision<0)return false;
  const committed=this.sql.exec<{revision:number}>('SELECT revision FROM runs_repair_commits WHERE id=?',id).toArray()[0];if(committed)return committed.revision===revision;
  const candidate=this.storage.transactionSync(()=>{const s=this.row(id);if(!s||!s.complete||s.revision!==revision||!this.allowed(s))return null;const rows=this.sql.exec<{value:string}>('SELECT value FROM runs_repair_ids WHERE id=? ORDER BY value DESC',id).toArray();if(rows.length!==s.real+s.test||rows.length>MAX_REAL+MAX_TEST)return null;return {s,values:rows.map(x=>x.value)};});if(!candidate)return false;
  const bytes=new TextEncoder().encode(JSON.stringify(candidate.values));if(bytes.length>512*1024)return false;const parts:{hash:string;bytes:number;data:string}[]=[];for(let offset=0;offset<bytes.length;offset+=65536){const slice=bytes.slice(offset,offset+65536);const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',slice.buffer))].map(x=>x.toString(16).padStart(2,'0')).join('');let raw='';for(const b of slice)raw+=String.fromCharCode(b);parts.push({hash,bytes:slice.length,data:btoa(raw)});}
  return this.storage.transactionSync(()=>{const s=this.row(id);if(!s||JSON.stringify(s)!==JSON.stringify(candidate.s)||!this.allowed(s))return false;
   for(let i=0;i<parts.length;i++){const p=parts[i]!;this.sql.exec('INSERT INTO gen_chunks VALUES (?,?,?,?,?,?,?)',s.next_head,id,'runs-index',i,p.hash,p.bytes,p.data);}
   this.sql.exec("INSERT OR REPLACE INTO gen_key_heads (key,generation,preparation,kind,expires_at,metadata,chunks) VALUES ('runs-index',?,?,'put',NULL,NULL,?)",s.next_head,id,parts.length);
   this.sql.exec('INSERT OR REPLACE INTO gen_head VALUES (1,?)',s.next_head);this.sql.exec('INSERT INTO runs_repair_commits VALUES (?,?,?)',id,s.next_head,revision);return true;});
 }
}
