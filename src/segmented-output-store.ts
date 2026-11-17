// SYNTHETIC, UNWIRED storage prerequisite. No content masking, semantic verification, publication,
// retention, or authorization boundary exists here. Never stage real email in this component.
const TOKEN=/^[A-Za-z0-9_-]{22,128}$/, HASH=/^[a-f0-9]{64}$/;
const MAX_CHUNK=64*1024, MAX_CHUNKS=512, MAX_JOB_BYTES=32*1024*1024;
export type SegmentAuthority=(sql:SqlStorage,job:string,generation:string,attempt:string,sourceId:string)=>boolean;
type Row={job:string;generation:string;attempt:string;source_id:string;next:number;bytes:number;state:string};
export class SegmentedOutputStore {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly authority?:SegmentAuthority,private readonly cleanupAuthority?:SegmentAuthority){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS seg_outputs (scope TEXT PRIMARY KEY,job TEXT NOT NULL,generation TEXT NOT NULL,attempt TEXT NOT NULL,source_id TEXT NOT NULL,next INTEGER NOT NULL,bytes INTEGER NOT NULL,state TEXT NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS seg_parts (scope TEXT NOT NULL,idx INTEGER NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(scope,idx))');
  this.sql.exec('CREATE TABLE IF NOT EXISTS seg_budget (job TEXT PRIMARY KEY,bytes INTEGER NOT NULL)');
 }
 private allowed(job:string,generation:string,attempt:string,sourceId:string):boolean{return !!this.authority&&this.authority(this.sql,job,generation,attempt,sourceId)===true;}
 private canClean(job:string,generation:string,attempt:string,sourceId:string):boolean{return this.cleanupAuthority?this.cleanupAuthority(this.sql,job,generation,attempt,sourceId)===true:this.allowed(job,generation,attempt,sourceId);}
 private row(scope:string):Row|undefined{return this.sql.exec<Row>('SELECT job,generation,attempt,source_id,next,bytes,state FROM seg_outputs WHERE scope=?',scope).toArray()[0];}
 begin(scope:string,job:string,generation:string,attempt:string,sourceId:string):boolean{
  if(![scope,job,generation,attempt].every(x=>typeof x==='string'&&TOKEN.test(x))||!HASH.test(sourceId))return false;
  return this.storage.transactionSync(()=>{
   if(!this.allowed(job,generation,attempt,sourceId))return false;
   const old=this.row(scope);if(old)return old.job===job&&old.generation===generation&&old.attempt===attempt&&old.source_id===sourceId&&old.state==='staging';
   this.sql.exec('INSERT OR IGNORE INTO seg_budget (job,bytes) VALUES (?,0)',job);
   this.sql.exec("INSERT INTO seg_outputs (scope,job,generation,attempt,source_id,next,bytes,state) VALUES (?,?,?,?,?,0,0,'staging')",scope,job,generation,attempt,sourceId);return true;
  });
 }
 async append(scope:string,attempt:string,index:number,input:Uint8Array):Promise<'staged'|'already-staged'|'capacity'|'rejected'>{
  if(!TOKEN.test(scope)||!TOKEN.test(attempt)||!Number.isSafeInteger(index)||index<0||index>=MAX_CHUNKS||!(input instanceof Uint8Array)||!input.byteLength||input.byteLength>MAX_CHUNK)return 'rejected';
  const bytes=new Uint8Array(input), hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes.buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return this.storage.transactionSync(()=>{
   const row=this.row(scope);if(!row||row.attempt!==attempt||!this.allowed(row.job,row.generation,attempt,row.source_id))return 'rejected';
   if(row.state==='abandoned')return 'rejected';
   const prior=this.sql.exec<{hash:string;bytes:number}>('SELECT hash,bytes FROM seg_parts WHERE scope=? AND idx=?',scope,index).toArray()[0];
   if(prior)return prior.hash===hash&&prior.bytes===bytes.length?'already-staged':'rejected';
   if(row.state!=='staging'||row.next!==index)return 'rejected';
   const budget=this.sql.exec<{bytes:number}>('SELECT bytes FROM seg_budget WHERE job=?',row.job).toArray()[0];
   if(!budget||budget.bytes+bytes.length>MAX_JOB_BYTES)return 'capacity';
   this.sql.exec('INSERT INTO seg_parts (scope,idx,hash,bytes,data) VALUES (?,?,?,?,?)',scope,index,hash,bytes.length,bytes.buffer);
   this.sql.exec('UPDATE seg_outputs SET next=next+1,bytes=bytes+? WHERE scope=?',bytes.length,scope);
   this.sql.exec('UPDATE seg_budget SET bytes=bytes+? WHERE job=?',bytes.length,row.job);
   return 'staged';
  });
 }
 seal(scope:string,attempt:string,expectedParts:number,expectedBytes:number):boolean{
  if(!Number.isSafeInteger(expectedParts)||expectedParts<1||expectedParts>MAX_CHUNKS||!Number.isSafeInteger(expectedBytes)||expectedBytes<1||expectedBytes>MAX_JOB_BYTES)return false;
  return this.storage.transactionSync(()=>{
   const row=this.row(scope);if(!row||row.attempt!==attempt||!this.allowed(row.job,row.generation,attempt,row.source_id)||row.next!==expectedParts||row.bytes!==expectedBytes)return false;
   if(row.state!=='sealed'&&row.state!=='staging')return false;
   const stats=this.sql.exec<{n:number;bytes:number;first:number|null;last:number|null}>('SELECT COUNT(*) AS n,COALESCE(SUM(bytes),0) AS bytes,MIN(idx) AS first,MAX(idx) AS last FROM seg_parts WHERE scope=?',scope).toArray()[0];
   if(!stats||stats.n!==expectedParts||stats.bytes!==expectedBytes||stats.first!==0||stats.last!==expectedParts-1)return false;
   if(row.state==='sealed')return true;
   this.sql.exec("UPDATE seg_outputs SET state='sealed' WHERE scope=?",scope);return true;
  });
 }
 /** Internal reads only. Sealing establishes transport completeness, not semantic validity. */
 async read(scope:string,attempt:string,index:number):Promise<Uint8Array|null>{
  if(!Number.isSafeInteger(index)||index<0||index>=MAX_CHUNKS)return null;
  const selected=this.storage.transactionSync(()=>{
   const row=this.row(scope);if(!row||row.state!=='sealed'||row.attempt!==attempt||!this.allowed(row.job,row.generation,attempt,row.source_id)||index>=row.next)return null;
   const part=this.sql.exec<{data:ArrayBuffer;hash:string;bytes:number}>('SELECT data,hash,bytes FROM seg_parts WHERE scope=? AND idx=?',scope,index).toArray()[0];
   if(!part)throw new Error('missing sealed segment');return {bytes:new Uint8Array(part.data),hash:part.hash,size:part.bytes};
  });
  if(!selected)return null;
  const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(selected.bytes).buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(hash!==selected.hash||selected.bytes.length!==selected.size)throw new Error('corrupt sealed segment');
  const valid=this.storage.transactionSync(()=>{const row=this.row(scope);return !!row&&row.state==='sealed'&&row.attempt===attempt&&index<row.next&&this.allowed(row.job,row.generation,attempt,row.source_id);});
  return valid?selected.bytes:null;
 }
 /** Abandon provisional output before reclaim. Sealed values are never discarded here. */
 abandon(scope:string,attempt:string):boolean{
  return this.storage.transactionSync(()=>{
   const row=this.row(scope);if(!row||!this.canClean(row.job,row.generation,attempt,row.source_id))return false;
   if(row.state==='abandoned')return true;if(row.state!=='staging')return false;
   this.sql.exec("UPDATE seg_outputs SET state='abandoned' WHERE scope=?",scope);return true;
  });
 }
 reclaim(scope:string,attempt:string,limit:number):{remaining:number}|null{
  if(!Number.isSafeInteger(limit)||limit<1||limit>16)return null;
  return this.storage.transactionSync(()=>{
   const row=this.row(scope);if(!row||row.state!=='abandoned'||!this.canClean(row.job,row.generation,attempt,row.source_id))return null;
   const selected=this.sql.exec<{idx:number;bytes:number}>('SELECT idx,bytes FROM seg_parts WHERE scope=? ORDER BY idx LIMIT ?',scope,limit).toArray();let freed=0;
   for(const part of selected){this.sql.exec('DELETE FROM seg_parts WHERE scope=? AND idx=?',scope,part.idx);freed+=part.bytes;}
   const budget=this.sql.exec<{bytes:number}>('SELECT bytes FROM seg_budget WHERE job=?',row.job).toArray()[0];if(!budget||budget.bytes<freed)throw new Error('invalid segment budget');
   this.sql.exec('UPDATE seg_budget SET bytes=bytes-? WHERE job=?',freed,row.job);
   this.sql.exec('UPDATE seg_outputs SET bytes=bytes-? WHERE scope=?',freed,scope);
   const remaining=this.sql.exec<{n:number}>('SELECT COUNT(*) AS n FROM seg_parts WHERE scope=?',scope).toArray()[0]?.n??0;
   return {remaining};
  });
 }
}
