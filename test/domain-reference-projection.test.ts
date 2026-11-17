import { afterEach, describe, expect, it, vi } from 'vitest';
import { _clearAccessTokenCache } from '../src/accounts';
import { collect, runContext, type AssemblyStateSnapshot } from '../src/digest';
import { startJob } from '../src/jobs';
import { matchesDomainReference, projectDomainReference, type TrustedAssemblySnapshot } from '../src/domain-reference-projection';
import type { Manifest } from '../src/generation-store';
import { fakeAi, fakeGmail } from './fakes';
import { redactMeta, redactSecrets } from '../src/secrets';
import { fullMessage, linkAccount, makeEnv, MESSAGE_TIME } from './helpers';

afterEach(()=>{_clearAccessTokenCache();vi.unstubAllGlobals();vi.restoreAllMocks();});
async function fixture() {
 const env=makeEnv({AI:{run:fakeAi()} as unknown as Ai});
 await linkAccount(env,'mail');
 vi.stubGlobal('fetch',vi.fn(fakeGmail({mail:[fullMessage('m1',{subject:'Invoice',ms:MESSAGE_TIME})]}).impl));
 vi.spyOn(console,'log').mockImplementation(()=>{});
 const now=new Date('2026-10-24T06:30:00Z');
 const job=await startJob(env,{},now,'web');
 const ctx=await runContext(env,{},now,false,job.aliases,job.previous);
 const partials=await collect(env,ctx,ctx.accounts);
 ctx.jobId=job.id;ctx.jobRunId=job.run;
 const state: AssemblyStateSnapshot={lastRun:null,indexedRuns:[],cursors:{mail:null},failureHolds:{mail:null},histories:{mail:[]}};
 const safe={...ctx,accounts:ctx.accounts.map(a=>({alias:a.alias,email:a.email}))};
 const generation='g'.repeat(22);
 const snapshot:TrustedAssemblySnapshot={job:job.id,generation,sourceId:'s'.repeat(22),previousHead:null,versions:[{key:'settings',version:1},{key:'done',version:2},{key:'account:mail',version:1}],context:safe,partials,marks:{doneKeys:new Set()},state,result:{job:job.id,digest:job.run,driver:'web',test:false,rows:[],started:now.getTime(),finished:now.getTime()},ttlBaseMs:now.getTime()};
 return {snapshot,ctx};
}
function candidate(ref:Awaited<ReturnType<typeof projectDomainReference>>):Manifest {
 return {job:ref.job,generation:ref.generation,sourceId:ref.sourceId,preparation:'p'.repeat(22),expectedPreparation:null,token:'t'.repeat(22),digest:ref.digest,previous:ref.previousHead,versions:structuredClone(ref.versions),changes:structuredClone(ref.changes)};
}
describe('independent domain reference projection',()=>{
 it('rejects omitted cursor and altered output instead of accepting the candidate as its own proof',async()=>{
  const {snapshot}=await fixture();
  const ref=await projectDomainReference({load:async()=>snapshot},snapshot.job,snapshot.generation);
  expect(ref.changes.some(c=>c.key==='cursor:mail')).toBe(true);
  expect(matchesDomainReference(ref,candidate(ref))).toBe(true);
  const omitted=candidate(ref);omitted.changes=omitted.changes.filter(c=>c.key!=='cursor:mail');
  expect(matchesDomainReference(ref,omitted)).toBe(false);
  const tampered=candidate(ref);const digest=tampered.changes.find(c=>c.key.startsWith('digest:'))!;digest.chunks![0]!.hash='0'.repeat(64);
  expect(matchesDomainReference(ref,tampered)).toBe(false);
  const relabeled=candidate(ref);relabeled.versions.find(v=>v.key==='done')!.version++;
  expect(matchesDomainReference(ref,relabeled)).toBe(false);
  const movedHead=candidate(ref);movedHead.previous='h'.repeat(22);
  expect(matchesDomainReference(ref,movedHead)).toBe(false);
  expect(await projectDomainReference({load:async()=>null},snapshot.job,snapshot.generation).catch(()=>null)).toBeNull();
 });
 it('requires each estimated seen mark to remain in recheck and rejects missing enrollment',async()=>{
  const {snapshot}=await fixture();
  const p=snapshot.partials[0]!;const [key,entry]=p.toCache[0]!;
  p.toCache=[[key,{...entry,estimated:true,triage:undefined}]];
  delete p.recheck;
  await expect(projectDomainReference({load:async()=>snapshot},snapshot.job,snapshot.generation)).rejects.toThrow(/missing its recheck/);
  p.recheck={before:[],settled:[],estimated:['m1']};
  const ref=await projectDomainReference({load:async()=>snapshot},snapshot.job,snapshot.generation);
  expect(ref.changes.map(c=>c.key)).toEqual(expect.arrayContaining(['cls:mail:m1','recheck:mail']));
  const omitted=candidate(ref);omitted.changes=omitted.changes.filter(c=>c.key!=='recheck:mail');
  expect(matchesDomainReference(ref,omitted)).toBe(false);
 });
 it('rejects full account records containing a refresh-token field',async()=>{
  const {snapshot,ctx}=await fixture();
  ctx.accounts[0]!.sealedRefreshToken='credential-sentinel-never-project';
  snapshot.context.accounts=ctx.accounts;
  await expect(projectDomainReference({load:async()=>snapshot},snapshot.job,snapshot.generation)).rejects.toThrow(/credential-free/);
 });
 it('redacts old cached verification codes before computing the expected write',async()=>{
  const {snapshot}=await fixture();
  const [key,value]=snapshot.partials[0]!.toCache[0]!;
  value.meta={...value.meta,subject:'Your verification code is 482913',snippet:'Use code 482913',security:true};
  if(value.triage)value.triage={...value.triage,summary:'Use code 482913',action:'Enter code 482913'};
  const meta=redactMeta(value.meta);
  const triage=value.triage && {...value.triage,summary:redactSecrets(value.triage.summary,true),action:redactSecrets(value.triage.action,true)};
  const masked={...value,meta,...(triage?{triage}:{})};
  const sha=async (v:unknown)=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(v))))].map(b=>b.toString(16).padStart(2,'0')).join('');
  expect(JSON.stringify(masked)).not.toContain('482913');
  const ref=await projectDomainReference({load:async()=>snapshot},snapshot.job,snapshot.generation);
  const cache=ref.changes.find(c=>c.key===`cls:${key}`)!;
  expect(cache.chunks?.[0]?.hash).toBe(await sha(masked));
  expect(cache.chunks?.[0]?.hash).not.toBe(await sha(value));
 });
 it('rejects an oversized trusted snapshot before materializing the assembly',async()=>{
  const {snapshot}=await fixture();
  snapshot.partials[0]!.items[0]!.text='x'.repeat(6*1024*1024);
  await expect(projectDomainReference({load:async()=>snapshot},snapshot.job,snapshot.generation)).rejects.toThrow(/input exceeds limits/);
 });
});
