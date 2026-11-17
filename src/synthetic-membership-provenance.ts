// SYNTHETIC / UNWIRED. A final digest item must originate from a verified accepted partial for
// this incarnation, or an earlier committed digest membership for the same incarnation.
// This is not a migration proof, cleanup policy, or authorization boundary.
import type {SyntheticPartialDriver} from './synthetic-partial-driver';
import type {TrustedAssemblySource} from './trusted-assembly-source';
import type {DoneMembership} from './owner-state';
import type {MembershipOrigin} from './synthetic-digest-membership';
const ID=/^[A-Za-z0-9_-]{22,128}$/,ALIAS=/^[a-z0-9][a-z0-9-]{0,31}$/,MESSAGE=/^[A-Za-z0-9_-]{1,256}$/;
type RecordItem={kind?:unknown;collection?:unknown;account?:unknown;messageId?:unknown;key?:unknown};
export class SyntheticMembershipProvenance {
 private sql:SqlStorage;
 constructor(private storage:DurableObjectStorage,private driver:SyntheticPartialDriver,private source:TrustedAssemblySource,private previous:DoneMembership){this.sql=storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS membership_partial_origin (job TEXT NOT NULL,generation TEXT NOT NULL,source TEXT NOT NULL,alias TEXT NOT NULL,message TEXT NOT NULL,incarnation INTEGER NOT NULL,driver TEXT NOT NULL,page INTEGER NOT NULL,PRIMARY KEY(job,generation,source,alias,message,incarnation))');}
 /** Index only coordinator-extracted pages of a fully authenticated accepted partial. */
 indexPartialPage(driverId:string,page:number):boolean{
  if(!ID.test(driverId)||!Number.isSafeInteger(page)||page<0)return false;
  return this.storage.transactionSync(()=>{
   const info=this.driver.completedInTransaction(this.sql,driverId);if(!info||page>=info.pages)return false;
   const capture=this.sql.exec<{job:string;generation:string;token:string}>('SELECT job,generation,token FROM trusted_source WHERE scope=?',info.scope).toArray()[0];
   const account=this.sql.exec<{identity:string;epoch:number;incarnation:number}>('SELECT d.identity,d.epoch,i.version AS incarnation FROM domain_accounts d JOIN coordinated_incarnations i ON i.alias=d.alias WHERE d.alias=?',info.alias).toArray()[0];
   const bound=capture&&this.sql.exec<{identity:string;epoch:number}>('SELECT identity,epoch FROM domain_job_accounts WHERE job=? AND alias=?',capture.job,info.alias).toArray()[0];
   if(!capture||capture.token!==info.attempt||!account||!bound||account.identity!==bound.identity||account.epoch!==bound.epoch||!Number.isSafeInteger(account.incarnation)||account.incarnation<1)return false;
   const records=this.driver.pageInTransaction(this.sql,driverId,page);if(!records)return false;const messages:string[]=[];
   for(const value of records){if(!value||typeof value!=='object'||Array.isArray(value))return false;const x=value as RecordItem;if(x.kind!=='item')continue;if(x.collection!=='partial'||x.account!==info.alias||typeof x.messageId!=='string'||!MESSAGE.test(x.messageId)||x.key!==`${info.alias}:${x.messageId}`)return false;messages.push(x.messageId);}
   for(const message of messages)this.sql.exec('INSERT OR IGNORE INTO membership_partial_origin VALUES (?,?,?,?,?,?,?,?)',capture.job,capture.generation,info.sourceId,info.alias,message,account.incarnation,driverId,page);return true;
  });
 }
 /** May be called only in the generation's existing verified transaction. */
 authority():MembershipOrigin{return(sql,job,generation,attempt,source,alias,message,incarnation)=>{
  if(sql!==this.sql||!ID.test(job)||!ID.test(generation)||!ID.test(attempt)||!/^[a-f0-9]{64}$/.test(source)||!ALIAS.test(alias)||!MESSAGE.test(message)||!Number.isSafeInteger(incarnation)||incarnation<1)return false;
  const row=sql.exec<{driver:string;page:number}>('SELECT driver,page FROM membership_partial_origin WHERE job=? AND generation=? AND source=? AND alias=? AND message=? AND incarnation=?',job,generation,source,alias,message,incarnation).toArray()[0];
  if(row){const info=this.driver.completedInTransaction(sql,row.driver);if(info&&info.attempt===attempt&&info.sourceId===source&&info.alias===alias){const cap=sql.exec<{job:string;generation:string}>('SELECT job,generation FROM trusted_source WHERE scope=? AND token=?',info.scope,attempt).toArray()[0];const records=this.driver.pageInTransaction(sql,row.driver,row.page);if(cap?.job===job&&cap.generation===generation&&records?.some(value=>{const x=value as RecordItem;return !!x&&x.kind==='item'&&x.collection==='partial'&&x.account===alias&&x.messageId===message&&x.key===`${alias}:${message}`;}))return true;}}
  const captures=sql.exec<{scope:string;payload:string}>('SELECT scope,payload FROM trusted_source WHERE job=? AND generation=? AND token=?',job,generation,attempt).toArray();
  for(const cap of captures){if(!this.source.validateInTransaction(sql,cap.scope,attempt))continue;
   const names=sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('synthetic_packed_proof','large_source_proof')").toArray().map(x=>x.name);
   const packed=names.includes('synthetic_packed_proof')&&sql.exec('SELECT scope FROM synthetic_packed_proof WHERE scope=? AND source_id=? AND attempt=? AND complete=1',cap.scope,source,attempt).toArray().length;
   const large=names.includes('large_source_proof')&&sql.exec('SELECT scope FROM large_source_proof WHERE scope=? AND root=? AND token=? AND complete=1',cap.scope,source,attempt).toArray().length;
   if(!packed&&!large)continue;let state:{head:string|null;previousDigest:string|null};try{state=JSON.parse(cap.payload);}catch{continue;}if(!state.head||!state.previousDigest)continue;const prior=sql.exec<{digest:string}>('SELECT digest FROM synthetic_membership_heads WHERE head=?',state.head).toArray()[0];if(prior?.digest===state.previousDigest&&this.previous(sql,state.head,`${alias}:${message}`)===incarnation)return true;}
  return false;
 };}
}
