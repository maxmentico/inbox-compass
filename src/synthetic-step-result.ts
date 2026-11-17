// SYNTHETIC / UNWIRED. Captures job-result presentation data with the terminal step update.
// Caller is trusted internal coordinator code, not an HTTP client. This stores a bounded summary,
// not mailbox content. It does not independently verify the semantic correctness of the summary.
import { z } from 'zod';
import type { AtomicClaimBinding,AtomicStepBinding } from './job-state-core';
const ID=/^[A-Za-z0-9_-]{22,128}$/,ALIAS=/^[A-Za-z0-9_-]{1,64}$/;
const reason=z.string().max(40).regex(/^(?:failed|took too long|needs re-linking|not linked any more|Gmail rate-limited|too many requests for one step|Gmail error [0-9]{3})$/);
const result=z.union([z.object({state:z.literal('done'),summary:z.object({fresh:z.number().int().min(0).max(5000),toAction:z.number().int().min(0).max(5000),estimated:z.number().int().min(0).max(5000)}).strict()}).strict().refine(x=>x.summary.toAction<=x.summary.fresh),z.object({state:z.literal('failed'),reason}).strict()]);
export type SyntheticStepResult=z.infer<typeof result>;
type Staged={token:string;payload:string};
export class SyntheticStepResultStore{
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage){this.sql=storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_step_result_staged (job TEXT NOT NULL,generation TEXT NOT NULL,alias TEXT NOT NULL,token TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(job,generation,alias,token))');this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_step_result_bound (job TEXT NOT NULL,generation TEXT NOT NULL,alias TEXT NOT NULL,token TEXT,step_state TEXT NOT NULL,hash TEXT,payload TEXT NOT NULL,PRIMARY KEY(job,generation,alias))');this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_step_settings_pin (job TEXT NOT NULL,generation TEXT NOT NULL,alias TEXT NOT NULL,token TEXT NOT NULL,attempt INTEGER NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(job,generation,alias,token))');}
 /** A caller must use the pinned revision when reading settings for collection. */
 claimBinding():AtomicClaimBinding{return (sql,job,generation,alias,token,attempt,retry)=>{
  if(sql!==this.sql)return false;const current=sql.exec<{version:number}>("SELECT version FROM gen_versions WHERE key='settings'").toArray()[0];if(!current||!Number.isSafeInteger(current.version)||current.version<0)return false;
  const pin=sql.exec<{attempt:number;revision:number}>('SELECT attempt,revision FROM synthetic_step_settings_pin WHERE job=? AND generation=? AND alias=? AND token=?',job,generation,alias,token).toArray()[0];
  if(retry)return !!pin&&pin.attempt===attempt&&pin.revision===current.version;
  if(pin)return false;sql.exec('INSERT INTO synthetic_step_settings_pin VALUES (?,?,?,?,?,?)',job,generation,alias,token,attempt,current.version);return true;
 };}
 private currentPin(job:string,generation:string,alias:string,token:string):boolean{
  const pin=this.sql.exec<{revision:number;version:number}>("SELECT p.revision,v.version FROM synthetic_step_settings_pin p JOIN gen_versions v ON v.key='settings' WHERE p.job=? AND p.generation=? AND p.alias=? AND p.token=?",job,generation,alias,token).toArray()[0];return !!pin&&pin.revision===pin.version;
 }
 /** Stage only for the live attempt; terminal acceptance pins its exact value atomically. */
 stage(job:string,generation:string,alias:string,token:string,input:unknown):boolean{
  if(!ID.test(job)||!ID.test(generation)||!ALIAS.test(alias)||!ID.test(token))return false;const parsed=result.safeParse(input);if(!parsed.success)return false;const payload=JSON.stringify(parsed.data);
  return this.storage.transactionSync(()=>{
   const live=this.sql.exec<{expires:number;deadline:number}>("SELECT j.expires,s.deadline FROM core_jobs j JOIN core_active a ON a.singleton=1 AND a.job=j.job JOIN core_steps s ON s.job=j.job WHERE j.job=? AND j.generation=? AND j.state='running' AND s.alias=? AND s.state='running' AND s.token=?",job,generation,alias,token).toArray()[0];if(!live||live.expires<=Date.now()||live.deadline<=Date.now()||!this.currentPin(job,generation,alias,token))return false;
   const prior=this.sql.exec<Staged>('SELECT token,payload FROM synthetic_step_result_staged WHERE job=? AND generation=? AND alias=? AND token=?',job,generation,alias,token).toArray()[0];if(prior)return prior.payload===payload;
   this.sql.exec('INSERT INTO synthetic_step_result_staged VALUES (?,?,?,?,?)',job,generation,alias,token,payload);return true;
  });
 }
 binding():AtomicStepBinding{return (sql,job,generation,alias,token,state,hash,retry,cause)=>{
  if(sql!==this.sql)return false;
  const bound=sql.exec<{token:string|null;step_state:string;hash:string|null;payload:string}>('SELECT token,step_state,hash,payload FROM synthetic_step_result_bound WHERE job=? AND generation=? AND alias=?',job,generation,alias).toArray()[0];
  if(retry)return !!bound&&bound.step_state===state&&bound.hash===hash&&(state==='failed'||bound.token===token);
  if(bound)return false;
  if(state==='done'&&(!token||!this.currentPin(job,generation,alias,token)))return false;
  const staged=token?sql.exec<Staged>('SELECT token,payload FROM synthetic_step_result_staged WHERE job=? AND generation=? AND alias=? AND token=?',job,generation,alias,token).toArray()[0]:undefined;
  const payload=state==='failed'&&cause==='timeout'?JSON.stringify({state:'failed',reason:'took too long'}):staged?.payload;if(!payload)return false;
  if(state==='failed'){try{if((JSON.parse(payload) as SyntheticStepResult).state!=='failed')return false;}catch{return false;}}
  sql.exec('INSERT INTO synthetic_step_result_bound VALUES (?,?,?,?,?,?,?)',job,generation,alias,token,state,hash,payload);return true;
 };}
 readInTransaction(sql:SqlStorage,job:string,generation:string,alias:string):SyntheticStepResult|null{
  if(sql!==this.sql)return null;const row=sql.exec<{payload:string}>('SELECT payload FROM synthetic_step_result_bound WHERE job=? AND generation=? AND alias=?',job,generation,alias).toArray()[0];if(!row)return null;try{const value=result.safeParse(JSON.parse(row.payload));return value.success?value.data:null;}catch{return null;}
 }
 /** Read the accepted attempt's settings revision, but only while it remains current. */
 settingsRevisionInTransaction(sql:SqlStorage,job:string,generation:string,alias:string):number|null{
  if(sql!==this.sql)return null;
  const row=sql.exec<{revision:number;version:number}>("SELECT p.revision,v.version FROM synthetic_step_result_bound b JOIN synthetic_step_settings_pin p ON p.job=b.job AND p.generation=b.generation AND p.alias=b.alias AND p.token=b.token JOIN gen_versions v ON v.key='settings' WHERE b.job=? AND b.generation=? AND b.alias=? AND b.step_state='done'",job,generation,alias).toArray()[0];
  return row&&row.revision===row.version?row.revision:null;
 }
 /** Independent authority for coordinator-generated terminal timeouts only. Callers must also
  * validate the captured source and account-identity fence in the same transaction. */
 timeoutAuthority(): (sql:SqlStorage,job:string,generation:string,alias:string,result:SyntheticStepResult)=>boolean{return (sql,job,generation,alias,value)=>{
  if(sql!==this.sql||value.state!=='failed'||value.reason!=='took too long')return false;
  const row=sql.exec<{step_state:string;hash:string|null;payload:string;state:string;partial:string|null}>("SELECT b.step_state,b.hash,b.payload,s.state,s.partial FROM synthetic_step_result_bound b JOIN core_steps s ON s.job=b.job AND s.alias=b.alias WHERE b.job=? AND b.generation=? AND b.alias=?",job,generation,alias).toArray()[0];
  return !!row&&row.step_state==='failed'&&row.hash===null&&row.state==='failed'&&row.partial===null&&row.payload===JSON.stringify({state:'failed',reason:'took too long'});
 };}
}
