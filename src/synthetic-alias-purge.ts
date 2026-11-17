// SYNTHETIC ONLY. Not bound to production. Deletes bounded alias-scoped rows after unlink.
// Retained multi-account digests/snapshots/output need independent redaction or deletion; the
// mandatory residue inspector must prove those and every other non-keyed artifact are safe.
const ALIAS=/^[a-z0-9][a-z0-9-]{0,31}$/, TOKEN=/^[A-Za-z0-9_-]{22,128}$/;
/** Must independently check retained digests, snapshots, staged outputs, tombstones, external
 * projections and any other schema not handled below; no implementation exists for real data. */
export type ResidueInspector=(sql:SqlStorage,alias:string)=>boolean;
type PurgeStep={kind:'progress';removed:number}|{kind:'ready'}|{kind:'blocked'};
export class SyntheticAliasPurge {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly inspect?:ResidueInspector){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS purge_head_ids (id TEXT PRIMARY KEY)');
  this.sql.exec('CREATE INDEX IF NOT EXISTS purge_gen_chunks_key ON gen_chunks (key)');
  this.sql.exec('CREATE INDEX IF NOT EXISTS purge_core_chunks_alias ON core_chunks (alias)');
  this.sql.exec('CREATE INDEX IF NOT EXISTS purge_core_stages_alias ON core_stages (alias)');
  this.sql.exec('CREATE INDEX IF NOT EXISTS purge_job_accounts_alias ON domain_job_accounts (alias)');
 }
 private permitted(alias:string,epoch:number):boolean{
  const a=this.sql.exec<{identity:string|null;epoch:number;value:string|null;purge_pending:number}>("SELECT d.identity,d.epoch,c.value,c.purge_pending FROM domain_accounts d JOIN coordinated_accounts c ON c.alias=d.alias WHERE d.alias=?",alias).toArray()[0];
  return !!a && a.identity===null && a.epoch===epoch && a.value===null && a.purge_pending===1;
 }
 private keys(alias:string):{fixed:string[];lo:string;hi:string;doneLo:string;doneHi:string}{
  return {fixed:[`cursor:${alias}`,`history:${alias}`,`recheck:${alias}`,`failures:${alias}`,`checked:${alias}`],lo:`cls:${alias}:`,hi:`cls:${alias};`,doneLo:`done:${alias}:`,doneHi:`done:${alias};`};
 }
 private keyPredicate():string{return '(key IN (?,?,?,?,?) OR (key>=? AND key<?) OR (key>=? AND key<?))';}
 private releaseBudget(job:string,bytes:number):void{
  const budget=this.sql.exec<{bytes:number}>('SELECT bytes FROM core_stage_budget WHERE job=?',job).toArray()[0];
  if(!budget||!Number.isSafeInteger(bytes)||bytes<0||budget.bytes<bytes)throw new Error('invalid stage budget');
  this.sql.exec('UPDATE core_stage_budget SET bytes=bytes-? WHERE job=?',bytes,job);
 }
 /** One bounded transaction. A fresh `headId` is required if visible keys are removed. */
 step(alias:string,epoch:number,headId:string,limit:number):PurgeStep{
  if(!ALIAS.test(alias)||!Number.isSafeInteger(epoch)||epoch<1||!TOKEN.test(headId)||!Number.isSafeInteger(limit)||limit<1||limit>16)return {kind:'blocked'};
  return this.storage.transactionSync(()=>{
   if(!this.permitted(alias,epoch))return {kind:'blocked'};
   const head=this.sql.exec<{generation:string}>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation;
   if(head && this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='sgen_committed'").toArray().length && this.sql.exec('SELECT scope FROM sgen_committed WHERE scope=?',head).toArray().length)return {kind:'blocked'};
   // Stop all old jobs containing the alias before touching their provisional partials.
   const jobs=this.sql.exec<{job:string}>("SELECT j.job FROM core_jobs j JOIN core_steps s ON s.job=j.job WHERE s.alias=? AND j.state='running' LIMIT ?",alias,limit).toArray();
   if(jobs.length){for(const {job} of jobs){this.sql.exec("UPDATE core_jobs SET state='stopped' WHERE job=?",job);this.sql.exec('DELETE FROM core_active WHERE job=?',job);}return {kind:'progress',removed:jobs.length};}
   const chunks=this.sql.exec<{job:string;token:string;idx:number;bytes:number}>('SELECT job,token,idx,bytes FROM core_chunks WHERE alias=? LIMIT ?',alias,limit).toArray();
   if(chunks.length){for(const c of chunks){this.releaseBudget(c.job,c.bytes);this.sql.exec('DELETE FROM core_chunks WHERE job=? AND alias=? AND token=? AND idx=?',c.job,alias,c.token,c.idx);}return {kind:'progress',removed:chunks.length};}
   const stages=this.sql.exec<{job:string;token:string;bytes:number}>('SELECT job,token,bytes FROM core_stages WHERE alias=? LIMIT ?',alias,limit).toArray();
   if(stages.length){for(const c of stages){this.releaseBudget(c.job,c.bytes);this.sql.exec('DELETE FROM core_stages WHERE job=? AND alias=? AND token=?',c.job,alias,c.token);}return {kind:'progress',removed:stages.length};}
   const steps=this.sql.exec<{job:string}>('SELECT job FROM core_steps WHERE alias=? LIMIT ?',alias,limit).toArray();
   if(steps.length){for(const s of steps)this.sql.exec('DELETE FROM core_steps WHERE job=? AND alias=?',s.job,alias);return {kind:'progress',removed:steps.length};}
   const bindings=this.sql.exec<{job:string}>('SELECT job FROM domain_job_accounts WHERE alias=? LIMIT ?',alias,limit).toArray();
   if(bindings.length){for(const b of bindings)this.sql.exec('DELETE FROM domain_job_accounts WHERE job=? AND alias=?',b.job,alias);return {kind:'progress',removed:bindings.length};}
   const done=this.sql.exec<{item:string}>('SELECT item FROM owner_done WHERE item>=? AND item<? ORDER BY item LIMIT ?',`${alias}:`,`${alias};`,limit).toArray();
   if(done.length){for(const d of done)this.sql.exec('DELETE FROM owner_done WHERE item=?',d.item);const rev=this.sql.exec<{version:number}>("SELECT version FROM gen_versions WHERE key='done'").toArray()[0];if(!rev||!Number.isSafeInteger(rev.version+1))throw new Error('done revision unavailable');this.sql.exec("UPDATE gen_versions SET version=? WHERE key='done'",rev.version+1);return {kind:'progress',removed:done.length};}
   const k=this.keys(alias),args=[...k.fixed,k.lo,k.hi,k.doneLo,k.doneHi];
   const heads=this.sql.exec<{key:string}>(`SELECT key FROM gen_key_heads WHERE ${this.keyPredicate()} ORDER BY key LIMIT ?`,...args,limit).toArray();
   if(heads.length){
    if(this.sql.exec('SELECT token FROM core_tokens WHERE token=?',headId).toArray().length || this.sql.exec('SELECT id FROM purge_head_ids WHERE id=?',headId).toArray().length || this.sql.exec('SELECT generation FROM core_jobs WHERE generation=?',headId).toArray().length || this.sql.exec('SELECT generation FROM gen_head WHERE generation=?',headId).toArray().length)return {kind:'blocked'};
    // Share the never-reused job/attempt token ledger: a later generation cannot recycle
    // an old purge head and make a reader mistake changed state for the same snapshot.
    this.sql.exec('INSERT INTO core_tokens (token) VALUES (?)',headId);
    this.sql.exec('INSERT INTO purge_head_ids (id) VALUES (?)',headId);
    for(const h of heads)this.sql.exec('DELETE FROM gen_key_heads WHERE key=?',h.key);
    this.sql.exec('INSERT OR REPLACE INTO gen_head (singleton,generation) VALUES (1,?)',headId);
    return {kind:'progress',removed:heads.length};
   }
   const values=this.sql.exec<{generation:string;preparation:string;key:string;idx:number}>(`SELECT generation,preparation,key,idx FROM gen_chunks WHERE ${this.keyPredicate()} LIMIT ?`,...args,limit).toArray();
   if(values.length){for(const v of values)this.sql.exec('DELETE FROM gen_chunks WHERE generation=? AND preparation=? AND key=? AND idx=?',v.generation,v.preparation,v.key,v.idx);return {kind:'progress',removed:values.length};}
   return {kind:'ready'};
  });
 }
 /** Call from CoordinatedAccounts.finishPurge in its existing transaction. */
 proof(sql:SqlStorage,alias:string):boolean{
  if(sql!==this.sql||!ALIAS.test(alias)||!this.inspect)return false;
  const account=this.sql.exec<{epoch:number}>('SELECT epoch FROM domain_accounts WHERE alias=?',alias).toArray()[0];
  if(!account||!this.permitted(alias,account.epoch))return false;
  const k=this.keys(alias),args=[...k.fixed,k.lo,k.hi,k.doneLo,k.doneHi];
  if(this.sql.exec('SELECT job FROM core_steps WHERE alias=? LIMIT 1',alias).toArray().length || this.sql.exec('SELECT job FROM domain_job_accounts WHERE alias=? LIMIT 1',alias).toArray().length || this.sql.exec('SELECT job FROM core_chunks WHERE alias=? LIMIT 1',alias).toArray().length || this.sql.exec('SELECT job FROM core_stages WHERE alias=? LIMIT 1',alias).toArray().length || this.sql.exec('SELECT item FROM owner_done WHERE item>=? AND item<? LIMIT 1',`${alias}:`,`${alias};`).toArray().length || this.sql.exec(`SELECT key FROM gen_key_heads WHERE ${this.keyPredicate()} LIMIT 1`,...args).toArray().length || this.sql.exec(`SELECT key FROM gen_chunks WHERE ${this.keyPredicate()} LIMIT 1`,...args).toArray().length)return false;
  return this.inspect(sql,alias)===true;
 }
}
