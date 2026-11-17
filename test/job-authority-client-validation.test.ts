import { describe, expect, it, vi } from 'vitest';
import { JobAuthorityClient } from '../src/job-authority';

const owner='a'.repeat(22),attempt='b'.repeat(22),job='c'.repeat(22);
const holder={at:'2026-11-14T06:30:00Z',job,driver:'web' as const};
function clientWith(fetcher:(request:Request)=>Promise<Response>) {
 const namespace={idFromName:()=>({}),get:()=>({fetch:fetcher})} as unknown as DurableObjectNamespace;
 return new JobAuthorityClient(namespace);
}
const json=(value:unknown,status=200)=>Promise.resolve(Response.json(value,{status}));

describe('job authority client boundary',()=>{
 it('fails closed on missing binding, network and invalid responses',async()=>{
  const unavailable=clientWith(async()=>{throw new Error('offline');});
  expect(await unavailable.inspect()).toBeNull();
  expect(await clientWith(()=>json({},503)).inspect()).toBeNull();
  expect(await clientWith(()=>json({ok:true})).claim(owner,'mail',attempt,0,120000)).toBeNull();
  expect(await clientWith(()=>json({ok:true,holder,expiresAt:'later'})).inspect()).toBeNull();
  expect(await clientWith(()=>json({ok:true,holder,expiresAt:123,steps:[{step:'mail',generation:1,state:'complete',deadline:null}]})).snapshot(owner)).toBeNull();
 });
 it('rejects unexpected fields that could expose authority capabilities',async()=>{
  expect(await clientWith(()=>json({ok:true,holder,expiresAt:123,owner})).inspect()).toBeNull();
  expect(await clientWith(()=>json({ok:false,reason:'busy',owner})).acquire(owner,holder)).toBeNull();
  expect(await clientWith(()=>json({ok:true,generation:1,deadline:123,attempt})).claim(owner,'mail',attempt,0,120000)).toBeNull();
 });
 it('sends capabilities only in the internal request body',async()=>{
  const fetcher=vi.fn(async(req:Request)=>{expect(req.url).toBe('https://job-authority.internal/claim');expect(req.method).toBe('POST');expect(req.url).not.toContain(owner);expect(req.url).not.toContain(attempt);expect(await req.json()).toEqual({owner,step:'mail',attempt,expectedGeneration:0,ttlMs:120000});return Response.json({ok:true,generation:1,deadline:123});});
  expect(await clientWith(fetcher).claim(owner,'mail',attempt,0,120000)).toEqual({ok:true,generation:1,deadline:123});
  expect(fetcher).toHaveBeenCalledTimes(1);
 });
});
