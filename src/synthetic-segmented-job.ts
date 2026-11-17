// SYNTHETIC ONLY. This adapter binds segmented transport to the current job and a separately
// proven source. It does not verify output semantics or publish an authoritative generation.
import { SegmentedOutputStore, type SegmentAuthority } from './segmented-output-store';
import { DomainGenerationGate } from './domain-generation-gate';
import type { SyntheticSourceAuthority } from './synthetic-job-bound-stage';

export class SyntheticSegmentedJob {
 readonly store:SegmentedOutputStore;
 private readonly sql:SqlStorage;
 constructor(storage:DurableObjectStorage,gate:DomainGenerationGate,sourceAuthority?:SyntheticSourceAuthority){
  this.sql=storage.sql;
  const active:SegmentAuthority=(sql,job,generation,attempt)=>{
   if(sql!==this.sql)return false;
   const row=sql.exec<{expires:number;deadline:number}>("SELECT j.expires,f.deadline FROM core_jobs j JOIN core_active a ON a.singleton=1 AND a.job=j.job JOIN core_final f ON f.job=j.job WHERE j.job=? AND j.generation=? AND j.state='running' AND f.token=?",job,generation,attempt).toArray()[0];
   return !!row && row.expires>Date.now() && row.deadline>Date.now();
  };
  const proven:SegmentAuthority=(sql,job,generation,attempt,sourceId)=>{
   if(!active(sql,job,generation,attempt,sourceId)||!sourceAuthority)return false;
   const revisions=gate.captureInTransaction(sql,job,generation);
   if(!revisions)return false;
   return sourceAuthority(sql,job,generation,sourceId,JSON.stringify(revisions.map(v=>({key:v.key,value:v.version}))))===true;
  };
  // Cleanup is allowed for the current valid finalizer even when an old source proof was
  // invalidated; it can only abandon/delete provisional data, never publish it.
  this.store=new SegmentedOutputStore(storage,proven,active);
 }
}
