// SYNTHETIC / UNWIRED. Namespaced mailbox operational state and immutable digest membership.
// Real safety requires every reader/writer, purge, migration and generation commit to use this
// contract. Retained digest text is deliberately not deleted. Never expose namespaces publicly.
import type { AccountPurgeProof } from './coordinated-accounts';
import type { DoneMembership } from './owner-state';
const ALIAS=/^[a-z0-9][a-z0-9-]{0,31}$/,TOKEN=/^[A-Za-z0-9_-]{22,128}$/,MESSAGE=/^[A-Za-z0-9_-]{1,256}$/;
export type OperationalKind='cursor'|'failures'|'history'|'recheck'|'checked'|'classification'|'done';
/** Must independently prove migration, legacy-key removal, stopped writers and all other paths. */
export type LegacyIsolationProof=(sql:SqlStorage,alias:string,incarnation:number)=>boolean;
/** Must validate that membership comes from the complete, verified generation being committed. */
export type MembershipAuthority=(sql:SqlStorage,head:string,alias:string,incarnation:number,messageId:string)=>boolean;
export class IncarnationIsolation {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly legacyProof?:LegacyIsolationProof,private readonly membershipAuthority?:MembershipAuthority){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS mailbox_namespace (alias TEXT NOT NULL,incarnation INTEGER NOT NULL,namespace TEXT NOT NULL UNIQUE,PRIMARY KEY(alias,incarnation))');
  this.sql.exec('CREATE TABLE IF NOT EXISTS digest_membership (head TEXT NOT NULL,alias TEXT NOT NULL,message_id TEXT NOT NULL,incarnation INTEGER NOT NULL,PRIMARY KEY(head,alias,message_id))');
 }
 /** Trusted link hook, inside the SAME SQLite transaction as the account/incarnation mutation. */
 bindInTransaction(sql:SqlStorage,alias:string,incarnation:number,namespace:string):boolean{
  if(sql!==this.sql||!ALIAS.test(alias)||!Number.isSafeInteger(incarnation)||incarnation<1||!TOKEN.test(namespace))return false;
  const current=sql.exec<{version:number;identity:string|null;purge_pending:number}>('SELECT i.version,d.identity,c.purge_pending FROM coordinated_incarnations i JOIN domain_accounts d ON d.alias=i.alias JOIN coordinated_accounts c ON c.alias=i.alias WHERE i.alias=?',alias).toArray()[0];
  if(!current||current.version!==incarnation||!current.identity||current.purge_pending)return false;
  const existing=sql.exec<{namespace:string}>('SELECT namespace FROM mailbox_namespace WHERE alias=? AND incarnation=?',alias,incarnation).toArray()[0];
  if(existing)return existing.namespace===namespace;
  if(sql.exec('SELECT namespace FROM mailbox_namespace WHERE namespace=?',namespace).toArray().length)return false;
  sql.exec('INSERT INTO mailbox_namespace VALUES (?,?,?)',alias,incarnation,namespace);return true;
 }
 /** Verify only; never creates a namespace for a previously unscoped account. */
 verifyBindingInTransaction(sql:SqlStorage,alias:string,incarnation:number,namespace:string):boolean{
  return sql===this.sql&&TOKEN.test(namespace)&&this.namespaceInTransaction(sql,alias,incarnation)===namespace;
 }
 /** Return only keys in the currently linked incarnation. Old keys cannot be selected on relink. */
 keyInTransaction(sql:SqlStorage,alias:string,incarnation:number,kind:OperationalKind,messageId?:string):string|null{
  if(sql!==this.sql||!ALIAS.test(alias)||!Number.isSafeInteger(incarnation)||incarnation<1||!['cursor','failures','history','recheck','checked','classification','done'].includes(kind))return null;
  if((kind==='classification'||kind==='done')?typeof messageId!=='string'||!MESSAGE.test(messageId):messageId!==undefined)return null;
  const row=sql.exec<{namespace:string}>('SELECT n.namespace FROM mailbox_namespace n JOIN coordinated_incarnations i ON i.alias=n.alias AND i.version=n.incarnation JOIN domain_accounts d ON d.alias=n.alias JOIN coordinated_accounts c ON c.alias=n.alias WHERE n.alias=? AND n.incarnation=? AND d.identity IS NOT NULL AND c.value IS NOT NULL AND c.purge_pending=0',alias,incarnation).toArray()[0];
  return row?`mb:${row.namespace}:${kind}${messageId===undefined?'':`:${messageId}`}`:null;
 }
 namespaceInTransaction(sql:SqlStorage,alias:string,incarnation:number):string|null{
  const key=this.keyInTransaction(sql,alias,incarnation,'cursor');
  return key ? key.slice(3,-':cursor'.length) : null;
 }
 /** Historical membership is append-only; only a trusted commit authority can create it. */
 recordMembershipInTransaction(sql:SqlStorage,head:string,alias:string,incarnation:number,messageId:string):boolean{
  if(sql!==this.sql||!TOKEN.test(head)||!ALIAS.test(alias)||!Number.isSafeInteger(incarnation)||incarnation<1||!MESSAGE.test(messageId)||!this.membershipAuthority||this.membershipAuthority(sql,head,alias,incarnation,messageId)!==true)return false;
  if(!sql.exec('SELECT namespace FROM mailbox_namespace WHERE alias=? AND incarnation=?',alias,incarnation).toArray().length)return false;
  const prior=sql.exec<{incarnation:number}>('SELECT incarnation FROM digest_membership WHERE head=? AND alias=? AND message_id=?',head,alias,messageId).toArray()[0];
  if(prior)return prior.incarnation===incarnation;
  sql.exec('INSERT INTO digest_membership VALUES (?,?,?,?)',head,alias,messageId,incarnation);return true;
 }
 /** OwnerState rechecks this incarnation against the currently linked account atomically. */
 doneMembership():DoneMembership{return(sql,head,key)=>{
  if(sql!==this.sql||!TOKEN.test(head)||typeof key!=='string')return null;
  const split=key.indexOf(':');if(split<1)return null;const alias=key.slice(0,split),message=key.slice(split+1);
  if(!ALIAS.test(alias)||!MESSAGE.test(message))return null;
  return sql.exec<{incarnation:number}>('SELECT incarnation FROM digest_membership WHERE head=? AND alias=? AND message_id=?',head,alias,message).toArray()[0]?.incarnation??null;
 };}
 /** Retained digest content is allowed only after an independently verified migration proves that
  * no live reader, stale writer, legacy unscoped key or pending artifact can affect a new link. */
 isolationProof():AccountPurgeProof{return(sql,alias)=>{
  if(sql!==this.sql||!ALIAS.test(alias)||!this.legacyProof)return false;
  const current=sql.exec<{version:number;identity:string|null;purge_pending:number}>('SELECT i.version,d.identity,c.purge_pending FROM coordinated_incarnations i JOIN domain_accounts d ON d.alias=i.alias JOIN coordinated_accounts c ON c.alias=i.alias WHERE i.alias=?',alias).toArray()[0];
  return !!current&&current.identity===null&&current.purge_pending===1&&this.legacyProof(sql,alias,current.version)===true;
 };}
}
