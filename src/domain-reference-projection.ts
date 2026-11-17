// EXPERIMENTAL: independent bounded reference projection; not a live coordinator adapter.
// The loader MUST read coordinator-owned accepted partials and a strongly consistent snapshot,
// not records supplied by the finalizer. No such production loader exists yet. This implementation
// materializes the result and is not designed for a single Workers Free invocation.
import { buildAssemblyManifest, prepareAssembly, type AssemblySnapshot, type AssemblyStateSnapshot, type AssemblyWrite, type MailboxPartial, type RunContext, type RunEnv } from './digest';
import type { RunResult } from './jobs';
import type { Change, Manifest } from './generation-store';
import { isSecurityEmail, redactMeta, redactSecrets } from './secrets';

type SafeAccount = { alias: string; email: string };
export type CredentialFreeRunContext = Omit<RunContext, 'accounts'> & { accounts: SafeAccount[] };
export type TrustedAssemblySnapshot = {
  job: string;
  generation: string;
  /** Authenticated immutable capture identifier and version vector, not candidate-supplied. */
  sourceId: string;
  previousHead: string | null;
  versions: { key: string; version: number }[];
  context: CredentialFreeRunContext;
  partials: MailboxPartial[];
  marks: AssemblySnapshot;
  state: AssemblyStateSnapshot;
  result: RunResult;
  /** A fixed, coordinator-recorded time used to convert TTLs to absolute expiry. */
  ttlBaseMs: number;
};
export interface TrustedAssemblyLoader {
  /** Independent of the candidate. Must authenticate source completeness and all input revisions. */
  load(job: string, generation: string): Promise<TrustedAssemblySnapshot | null>;
}
export type DomainReference = { job: string; generation: string; sourceId: string; previousHead: string | null; versions: { key: string; version: number }[]; digest: string; changes: Change[] };
const ID=/^[A-Za-z0-9_-]{22,128}$/;
const encoder=new TextEncoder();
// Conservative encoded-size/node bound before structuredClone. This is not a V8 heap guarantee;
// deployed peak memory and CPU must still be measured before the experiment can be enabled.
function checkInputBudget(value:unknown):void {
  const pending:{value:unknown;depth:number}[]=[{value,depth:0}],seen=new Set<object>();
  let estimate=0,nodes=0;
  while(pending.length){
    const item=pending.pop()!;if(++nodes>200_000||item.depth>64)throw new Error('Trusted assembly input exceeds limits');
    estimate+=64;
    if(typeof item.value==='string')estimate+=item.value.length*3;
    else if(item.value&&typeof item.value==='object'){
      if(seen.has(item.value))continue;seen.add(item.value);
      if(item.value instanceof Date){}
      else if(item.value instanceof Set){for(const v of item.value)pending.push({value:v,depth:item.depth+1});}
      else if(item.value instanceof Map){for(const [k,v] of item.value){pending.push({value:k,depth:item.depth+1},{value:v,depth:item.depth+1});}}
      else for(const key of Object.keys(item.value)){estimate+=key.length*3;pending.push({value:(item.value as Record<string,unknown>)[key],depth:item.depth+1});}
    }
    if(estimate>16*1024*1024)throw new Error('Trusted assembly input exceeds limits');
  }
}
async function sha(bytes: Uint8Array): Promise<string> { return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(b=>b.toString(16).padStart(2,'0')).join(''); }

/** Generate authoritative expected changes independently of the submitted generation manifest. */
export async function projectDomainReferenceWithWrites(loader: TrustedAssemblyLoader, job: string, generation: string): Promise<{ reference: DomainReference; writes: AssemblyWrite[] }> {
  if (!ID.test(job) || !ID.test(generation)) throw new Error('Invalid trusted job identity');
  const supplied=await loader.load(job,generation);
  if (!supplied || supplied.job!==job || supplied.generation!==generation || !ID.test(supplied.sourceId) || (supplied.previousHead!==null && !ID.test(supplied.previousHead)) || !Array.isArray(supplied.versions) || supplied.versions.length>52 || supplied.versions.some(v=>!v || typeof v.key!=='string' || !Number.isSafeInteger(v.version) || v.version<0) || new Set(supplied.versions.map(v=>v.key)).size!==supplied.versions.length || !Number.isSafeInteger(supplied.ttlBaseMs) || supplied.ttlBaseMs<0) throw new Error('Missing trusted assembly snapshot');
  // Project only the public fields needed by assembly; never serialize a stored credential.
  // Reject unexpected account properties rather than accidentally accepting a full RunContext.
  if (!Array.isArray(supplied.context?.accounts) || supplied.context.accounts.some(a=>!a || Object.keys(a).some(k=>k!=='alias'&&k!=='email') || typeof a.alias!=='string' || typeof a.email!=='string')) throw new Error('Account snapshot must be credential-free');
  checkInputBudget(supplied);
  const input=structuredClone(supplied);
  // Old accepted state may predate masking. Reapply it before producing cache/history writes;
  // digest items are separately redacted by buildAssemblyManifest.
  for (const partial of input.partials) {
    partial.toCache=partial.toCache.map(([key,value])=>{
      const meta=redactMeta(value.meta);
      const triage=value.triage ? {...value.triage,summary:redactSecrets(value.triage.summary,meta.security===true),action:redactSecrets(value.triage.action,meta.security===true)} : undefined;
      return [key,{...value,meta,...(triage ? {triage} : {})}];
    });
    for (const entry of [...partial.learned,...(partial.history ?? [])]) entry.subject=redactSecrets(entry.subject,isSecurityEmail(entry.subject,'',''));
  }
  for (const entries of Object.values(input.state.histories)) for (const entry of entries) entry.subject=redactSecrets(entry.subject,isSecurityEmail(entry.subject,'',''));
  const context=input.context as unknown as RunContext;
  if (context.test || context.jobId!==job || input.result.job!==job || input.result.test || !(input.marks.doneKeys instanceof Set)) throw new Error('Invalid trusted real-run snapshot');
  const aliases=new Set(context.accounts.map(a=>a.alias));
  if (aliases.size!==context.accounts.length || input.partials.length!==aliases.size || new Set(input.partials.map(p=>p.alias)).size!==aliases.size || input.partials.some(p=>!aliases.has(p.alias))) throw new Error('Incomplete trusted mailbox set');
  for (const partial of input.partials) {
    const account=context.accounts.find(a=>a.alias===partial.alias)!;
    const email=account.email.toLowerCase();
    if (partial.status.alias!==partial.alias || partial.status.email.toLowerCase()!==email || partial.items.some(it=>it.account!==partial.alias || it.accountEmail.toLowerCase()!==email) || partial.toCache.some(([key,value])=>!key.startsWith(`${partial.alias}:`) || (value.mailbox!==undefined && value.mailbox.toLowerCase()!==email)) || (!partial.status.ok && (partial.toCache.length>0 || !!partial.run || partial.learned.length>0))) throw new Error('Accepted partial does not match bound mailbox');
  }
  const prepared=await prepareAssembly({} as RunEnv,context,input.partials,input.marks);
  // Estimated classifications are seen marks: they must remain queued for a later model recheck.
  for (const [key,entry] of prepared.toCache) {
    if (!entry.estimated) continue;
    const sep=key.indexOf(':'), alias=key.slice(0,sep), message=key.slice(sep+1);
    if (sep<1 || !message || !prepared.lists.get(alias)?.next.some(e=>e.id===message)) throw new Error('Estimated seen mark missing its recheck');
  }
  // This higher bound is exclusive to the isolated DO reference experiment; the normal Worker
  // pipeline retains its default. It is not a guarantee about JS heap or deployed CPU limits.
  const expected=buildAssemblyManifest(context,input.partials,prepared,input.state,{id:job,result:input.result},{operations:1000,bytes:32*1024*1024});
  const changes: Change[]=[];
  for (const write of expected.writes) {
    if (write.kind==='delete') { changes.push({key:write.key,kind:'delete'}); continue; }
    const bytes=encoder.encode(write.value), chunks: {hash:string;bytes:number}[]=[];
    for (let offset=0; offset<bytes.length; offset+=64*1024) {
      const part=bytes.slice(offset,Math.min(bytes.length,offset+64*1024));
      chunks.push({hash:await sha(part),bytes:part.byteLength});
    }
    const expiresAt=write.expirationTtl===undefined ? undefined : input.ttlBaseMs+write.expirationTtl*1000;
    if (expiresAt!==undefined && !Number.isSafeInteger(expiresAt)) throw new Error('Invalid expiry');
    changes.push({key:write.key,kind:'put',chunks,...(expiresAt===undefined?{}:{expiresAt}),...(write.metadata?{metadata:{arrived:write.metadata.arrived}}:{})});
  }
  return {reference:{job,generation,sourceId:input.sourceId,previousHead:input.previousHead,versions:input.versions,digest:prepared.digest.id,changes},writes:expected.writes};
}

export async function projectDomainReference(loader: TrustedAssemblyLoader, job: string, generation: string): Promise<DomainReference> {
  return (await projectDomainReferenceWithWrites(loader,job,generation)).reference;
}

/** Exact match: missing or added writes, altered values, TTLs or metadata all fail. */
export function matchesDomainReference(reference: DomainReference, candidate: Manifest): boolean {
  if (!reference || !candidate || reference.job!==candidate.job || reference.generation!==candidate.generation || reference.sourceId!==candidate.sourceId || reference.previousHead!==candidate.previous || reference.digest!==candidate.digest || reference.changes.length!==candidate.changes.length) return false;
  const revisions=(v:{key:string;version:number}[])=>[...v].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  if(JSON.stringify(revisions(reference.versions))!==JSON.stringify(revisions(candidate.versions))) return false;
  const normalize=(changes: Change[])=>changes.map(c=>c.kind==='delete'?{key:c.key,kind:'delete'}:{key:c.key,kind:'put',chunks:c.chunks?.map(p=>({hash:p.hash,bytes:p.bytes})),...(c.expiresAt===undefined?{}:{expiresAt:c.expiresAt}),...(c.metadata?{metadata:{arrived:c.metadata.arrived}}:{})}).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  return JSON.stringify(normalize(reference.changes))===JSON.stringify(normalize(candidate.changes));
}
