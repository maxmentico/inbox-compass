import { expect,it } from 'vitest';
import { SyntheticBoundedReferenceLoader,compactManifestHistory } from '../src/synthetic-bounded-reference-loader';
import type { HistoryEntry } from '../src/estimate';
import { projectDomainReference } from '../src/domain-reference-projection';
import { digestConfig } from '../src/config';
import type { SyntheticTrustedInputReader } from '../src/synthetic-trusted-input-reader';
import type { TrustedAssemblySource } from '../src/trusted-assembly-source';
import type { SyntheticJobContextBinding } from '../src/synthetic-job-context';
import type { SyntheticStepResultStore } from '../src/synthetic-step-result';
const job='A'.repeat(22),generation='B'.repeat(22),scope='C'.repeat(22),attempt='D'.repeat(22),sourceId='a'.repeat(64);
function fixture(){
 const values=new Map<string,any>([['state:last-run',{kind:'missing'}],['state:settings',{kind:'missing'}],['state:runs-index',{kind:'state',bytes:new TextEncoder().encode('[]'),metadata:null,expiresAt:null}]]);
 const sql={exec:()=>({toArray:()=>[{config:'{"driver":"web"}'}]})} as unknown as SqlStorage,storage={sql,transactionSync:(f:()=>unknown)=>f()} as unknown as DurableObjectStorage;
 const source={describe:()=>({job,generation,previousDigest:null}),validateInTransaction:()=>true} as unknown as TrustedAssemblySource;
 const reader={read:async()=>({job,generation,sourceId,head:null,versions:[],at:1,rows:[],values})} as unknown as SyntheticTrustedInputReader;
 const contexts={readInTransaction:()=>({now:'2026-10-24T06:30:00.000Z',window:{kind:'since'},reclassify:false,test:false,cfg:digestConfig({}),run:'2026-10-24T06:30:00Z',date:'2026-10-24',started:1,previous:null})} as unknown as SyntheticJobContextBinding;
 const results={} as SyntheticStepResultStore;
 return {values,loader:new SyntheticBoundedReferenceLoader(storage,source,reader,contexts,results,{scope,attempt,sourceId})};
}
it('projects bounded empty authenticated input and fails closed when required inventory is absent',async()=>{
 const f=fixture();const reference=await projectDomainReference(f.loader,job,generation);expect(reference.digest).toBe('2026-10-24T06:30:00Z');expect(reference.changes.some(x=>x.key===`job-done:${job}`)).toBe(true);
 f.values.delete('state:runs-index');expect(await f.loader.load(job,generation)).toBeNull();
});
it('preserves the emitted history prefix even when learned entries replace old ids',()=>{
 const before=Array.from({length:5000},(_,i)=>({id:`h${i}`,date:null} as HistoryEntry));
 for(const n of [0,1,100,499,500,700]){
  const learned=Array.from({length:n},(_,i)=>({id:i%2?`new${i}`:`h${i}`,date:null} as HistoryEntry));
  const ids=new Set(learned.map(x=>x.id));
  const expected=[...learned,...before.filter(x=>!ids.has(x.id))].slice(0,500);
  const actual=[...learned,...compactManifestHistory(before,learned).filter(x=>!ids.has(x.id))].slice(0,500);
  expect(actual).toEqual(expected);
 }
});
