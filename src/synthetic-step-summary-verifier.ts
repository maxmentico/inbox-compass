// SYNTHETIC / UNWIRED. Independently recomputes an accepted successful step's summary from the
// trusted partial extractor, not from producer-staged summary values. The complete item set is
// bounded before grouping so conversations spanning pages are decided together. No real mail.
import { applySettings,type DigestItem } from './digest';
import { DEFAULT_SETTINGS,type Settings } from './rules';
import { SyntheticPartialDriver } from './synthetic-partial-driver';
import { SyntheticJobContextBinding } from './synthetic-job-context';
import { SyntheticStepResultStore,type SyntheticStepResult } from './synthetic-step-result';
const ID=/^[A-Za-z0-9_-]{22,128}$/,MAX_ITEMS=500,MAX_BYTES=512*1024;
type Row={id:string;driver:string;scope:string;attempt:string;source_id:string;job:string;generation:string;alias:string;pages:number;next:number;items:number;bytes:number;estimated:number|null;complete:number};
export class SyntheticStepSummaryVerifier{
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly driver:SyntheticPartialDriver,private readonly contexts:SyntheticJobContextBinding,private readonly results:SyntheticStepResultStore){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_summary_verifier (id TEXT PRIMARY KEY,driver TEXT NOT NULL,scope TEXT NOT NULL,attempt TEXT NOT NULL,source_id TEXT NOT NULL,job TEXT NOT NULL,generation TEXT NOT NULL,alias TEXT NOT NULL,pages INTEGER NOT NULL,next INTEGER NOT NULL,items INTEGER NOT NULL,bytes INTEGER NOT NULL,estimated INTEGER,complete INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_summary_item (id TEXT NOT NULL,ordinal INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,ordinal))');
 }
 private row(id:string):Row|undefined{return this.sql.exec<Row>('SELECT * FROM synthetic_summary_verifier WHERE id=?',id).toArray()[0];}
 private current(r:Row):boolean{
  const info=this.driver.completedInTransaction(this.sql,r.driver);if(!info||info.scope!==r.scope||info.attempt!==r.attempt||info.sourceId!==r.source_id||info.alias!==r.alias||info.pages!==r.pages)return false;
  const source=this.sql.exec<{job:string;generation:string}>('SELECT job,generation FROM trusted_source WHERE scope=? AND token=?',r.scope,r.attempt).toArray()[0];
  return !!source&&source.job===r.job&&source.generation===r.generation&&this.results.settingsRevisionInTransaction(this.sql,r.job,r.generation,r.alias)!==null&&!!this.contexts.readInTransaction(this.sql,r.job,r.generation);
 }
 start(id:string,driver:string):boolean{
  if(!ID.test(id)||!ID.test(driver))return false;
  return this.storage.transactionSync(()=>{
   if(this.row(id))return false;const info=this.driver.completedInTransaction(this.sql,driver);if(!info||info.pages<1||info.pages>10000)return false;
   const source=this.sql.exec<{job:string;generation:string}>('SELECT job,generation FROM trusted_source WHERE scope=? AND token=?',info.scope,info.attempt).toArray()[0];if(!source)return false;
   const r:Row={id,driver,scope:info.scope,attempt:info.attempt,source_id:info.sourceId,job:source.job,generation:source.generation,alias:info.alias,pages:info.pages,next:0,items:0,bytes:0,estimated:null,complete:0};
   if(!this.current(r))return false;this.sql.exec('INSERT INTO synthetic_summary_verifier VALUES (?,?,?,?,?,?,?,?,?,0,0,0,NULL,0)',id,driver,info.scope,info.attempt,info.sourceId,r.job,r.generation,r.alias,info.pages);return true;
  });
 }
 /** Consume exactly one driver page and atomically checkpoint its item rows. */
 step(id:string,expected:number):{next:number;ready:boolean}|null{
  if(!ID.test(id)||!Number.isSafeInteger(expected)||expected<0)return null;
  return this.storage.transactionSync(()=>{
   const r=this.row(id);if(!r||r.complete||r.next!==expected||r.next>=r.pages||!this.current(r))return null;
   const page=this.driver.pageInTransaction(this.sql,r.driver,r.next);if(!page)return null;let count=r.items,bytes=r.bytes,estimated=r.estimated;
   for(const unknownRecord of page){
    if(!unknownRecord||typeof unknownRecord!=='object'||Array.isArray(unknownRecord))throw Error('Invalid partial page');const record=unknownRecord as Record<string,unknown>;
    if(record.kind==='item'){
     if(record.collection!=='partial'||record.account!==r.alias)throw Error('Invalid summary item');
     // `applySettings` and `sortItems` need only these decision/grouping fields. In particular,
     // copying message bodies, snippets and model prose would make the bound depend on mail size.
     const item:Record<string,unknown>={};
     for(const key of ['account','threadId','classified','signals','category','from','subject','due','done','replied','estimated','decision','needsAction','urgency','carried','date'])if(Object.hasOwn(record,key))item[key]=record[key];
     if(item.estimated&&typeof item.estimated==='object')item.estimated={check:(item.estimated as {check?:unknown}).check===true};
     const payload=JSON.stringify(item),size=new TextEncoder().encode(payload).length;if(size>16384||++count>MAX_ITEMS||(bytes+=size)>MAX_BYTES)throw Error('Summary source exceeds limits');
     this.sql.exec('INSERT INTO synthetic_summary_item VALUES (?,?,?)',id,count-1,payload);
    }else if(record.kind==='mailbox-partial'){
     const status=record.status as {ok?:unknown}|undefined;if(estimated!==null||record.account!==r.alias||!status||status.ok!==true||!Number.isSafeInteger(record.estimated)||(record.estimated as number)<0)throw Error('Invalid summary metadata');estimated=record.estimated as number;
    }
   }
   if(!this.current(r))return null;
   this.sql.exec('UPDATE synthetic_summary_verifier SET next=?,items=?,bytes=?,estimated=? WHERE id=?',r.next+1,count,bytes,estimated,id);return {next:r.next+1,ready:r.next+1===r.pages};
  });
 }
 /** Final grouped computation is limited to 500 items and 512 KiB, inside the source fence. */
 finish(id:string):boolean{
  if(!ID.test(id))return false;
  return this.storage.transactionSync(()=>{
   const r=this.row(id);if(!r||r.complete||r.next!==r.pages||r.estimated===null||!this.current(r))return false;
   const expected=this.results.readInTransaction(this.sql,r.job,r.generation,r.alias),context=this.contexts.readInTransaction(this.sql,r.job,r.generation);if(!expected||expected.state!=='done'||!context)return false;
   const settingsRow=this.sql.exec<{value:string}>('SELECT value FROM owner_settings WHERE singleton=1').toArray()[0];let settings:Settings;
   try{settings=settingsRow?JSON.parse(settingsRow.value) as Settings:DEFAULT_SETTINGS;}catch{return false;}
   if(!Number.isInteger(settings.deadlineDays)||!Array.isArray(settings.important)||!Array.isArray(settings.muted))return false;
   const rows=this.sql.exec<{ordinal:number;payload:string}>('SELECT ordinal,payload FROM synthetic_summary_item WHERE id=? ORDER BY ordinal',id).toArray();if(rows.length!==r.items||rows.some((v,i)=>v.ordinal!==i))return false;
   let items:DigestItem[];try{items=rows.map(v=>JSON.parse(v.payload) as DigestItem);}catch{return false;}
   const decided=applySettings({id:context.run,date:context.date,generatedAt:context.now,model:'',query:'',items,accounts:[],modelErrors:[]},settings);
   const fresh=decided.items.filter(it=>!it.carried),actual={fresh:fresh.length,toAction:fresh.filter(it=>it.needsAction).length,estimated:r.estimated};
   if(JSON.stringify(actual)!==JSON.stringify(expected.summary)||!this.current(r))return false;
   this.sql.exec('UPDATE synthetic_summary_verifier SET complete=1 WHERE id=?',id);return true;
  });
 }
 /** Exact-match certificate; remains invalid if source, settings or identity changes. */
 authority(id:string):(sql:SqlStorage,job:string,generation:string,alias:string,result:SyntheticStepResult)=>boolean{return (sql,job,generation,alias,result)=>{
  if(sql!==this.sql)return false;const r=this.row(id);if(!r||!r.complete||r.job!==job||r.generation!==generation||r.alias!==alias||!this.current(r))return false;
  const bound=this.results.readInTransaction(sql,job,generation,alias);return !!bound&&JSON.stringify(bound)===JSON.stringify(result);
 };}
}
