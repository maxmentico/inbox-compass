// SYNTHETIC ONLY. Internal job creation input, never an account record or public endpoint.
// This freezes the inputs required by an independent reference before any mailbox work starts.
// It does not authenticate source state or make the reference projector production-ready.
import { z } from 'zod';
import { isCloudflareModelId, localDate } from './config';
import { runId } from './digest';
import type { AtomicExistingJobCheck, AtomicJobBinding } from './job-state-core';

const model=z.string().max(200).refine(isCloudflareModelId);
const contextSchema=z.object({
  now:z.string().max(24).refine(v=>{const n=new Date(v);return Number.isFinite(n.getTime())&&n.toISOString()===v;}),
  window:z.object({kind:z.literal('since')}).strict(),
  reclassify:z.literal(false), test:z.literal(false),
  cfg:z.object({query:z.string().min(1).max(2048),maxPerAccount:z.number().int().min(1).max(300),model,fallbackModel:model.nullable(),timeZone:z.string().min(1).max(100).refine(v=>{try{new Intl.DateTimeFormat('en-GB',{timeZone:v});return true;}catch{return false;}})}).strict(),
}).strict();
export type SyntheticJobContextInput=z.infer<typeof contextSchema>;
export type SyntheticJobContext=SyntheticJobContextInput & {run:string;date:string;started:number;previous:string|null};
/** Trusted callback reads the authoritative previous real digest inside the creation transaction.
 * Return undefined when that value cannot be proven; do not substitute caller-provided data. */
export type AtomicPreviousDigestReader=(sql:SqlStorage)=>string|null|undefined;
const REAL_DIGEST=/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;
const MAX_CONTEXT_BYTES=4096;

/** Validate and copy before binding: unknown fields, including credentials, are rejected. */
export function validateSyntheticJobContext(input:unknown):SyntheticJobContextInput|null{
 const parsed=contextSchema.safeParse(input);if(!parsed.success)return null;
 const value=parsed.data;
 if(new TextEncoder().encode(JSON.stringify(value)).byteLength>MAX_CONTEXT_BYTES)return null;
 return value;
}

export class SyntheticJobContextBinding {
 private readonly sql:SqlStorage;
 constructor(storage:DurableObjectStorage){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_job_context (job TEXT PRIMARY KEY,generation TEXT NOT NULL,input TEXT NOT NULL,run TEXT NOT NULL,date TEXT NOT NULL,started INTEGER NOT NULL,previous TEXT)');
 }
 /** Create once per request with trusted run options. Both callbacks must be installed together. */
 callbacks(input:unknown, other?:AtomicJobBinding, readPrevious?:AtomicPreviousDigestReader):{bind:AtomicJobBinding;checkExisting:AtomicExistingJobCheck}{
  const value=validateSyntheticJobContext(input);if(!value)throw new Error('Invalid synthetic job context');
  const canonical=JSON.stringify(value),now=new Date(value.now),run=runId(now,false),date=localDate(now,value.cfg.timeZone);
  return {
   bind:(sql,job,generation)=>{
    if(sql!==this.sql)throw new Error('wrong storage');
    const previous=readPrevious?.(sql);if(previous===undefined||(previous!==null&&!REAL_DIGEST.test(previous)))throw new Error('missing previous digest authority');
    if(other&&other(sql,job,generation)!==true)throw new Error('job binding failed');
    sql.exec('INSERT INTO synthetic_job_context (job,generation,input,run,date,started,previous) VALUES (?,?,?,?,?,?,?)',job,generation,canonical,run,date,Date.now(),previous);return true;
   },
   checkExisting:(sql,job,generation)=>{
    if(sql!==this.sql)return false;
    const row=sql.exec<{generation:string;input:string;run:string;date:string}>('SELECT generation,input,run,date FROM synthetic_job_context WHERE job=?',job).toArray()[0];
    return !!row&&row.generation===generation&&row.input===canonical&&row.run===run&&row.date===date;
   },
  };
 }
 /** Use only within an already source-authorized coordinator transaction. */
 readInTransaction(sql:SqlStorage,job:string,generation:string):SyntheticJobContext|null{
  if(sql!==this.sql)return null;
  const row=sql.exec<{input:string;run:string;date:string;started:number;previous:string|null}>('SELECT input,run,date,started,previous FROM synthetic_job_context WHERE job=? AND generation=?',job,generation).toArray()[0];
  if(!row||!Number.isSafeInteger(row.started)||row.started<0||(row.previous!==null&&(typeof row.previous!=='string'||!REAL_DIGEST.test(row.previous))))return null;
  try{
   const value=validateSyntheticJobContext(JSON.parse(row.input));if(!value)return null;
   const now=new Date(value.now);if(row.run!==runId(now,false)||row.date!==localDate(now,value.cfg.timeZone))return null;
   return {...value,run:row.run,date:row.date,started:row.started,previous:row.previous};
  }catch{return null;}
 }
}
