import { describe, expect, it } from 'vitest';
import { SyntheticJobContextBinding, validateSyntheticJobContext } from '../src/synthetic-job-context';
import { digestConfig } from '../src/config';

const input=()=>({now:'2026-10-24T06:30:00.000Z',window:{kind:'since'},reclassify:false,test:false,cfg:digestConfig({})});

describe('synthetic credential-free job context',()=>{
 it('rejects unknown credential-bearing fields and invalid or oversized inputs',()=>{
  expect(validateSyntheticJobContext(input())).not.toBeNull();
  expect(validateSyntheticJobContext({...input(),sealedRefreshToken:'secret sentinel'})).toBeNull();
  expect(validateSyntheticJobContext({...input(),cfg:{...input().cfg,token:'secret sentinel'}})).toBeNull();
  expect(validateSyntheticJobContext({...input(),window:{kind:'days',amount:1}})).toBeNull();
  expect(validateSyntheticJobContext({...input(),cfg:{...input().cfg,query:'界'.repeat(2048)}})).toBeNull();
  expect(validateSyntheticJobContext({...input(),now:'not a date'})).toBeNull();
 });
 it('copies input, binds atomically, and requires the identical job context on retry',()=>{
  let saved:Record<string,unknown>|undefined;
  const sql={exec:(statement:string,...args:unknown[])=>{
   if(statement.startsWith('INSERT INTO synthetic_job_context'))saved={job:args[0],generation:args[1],input:args[2],run:args[3],date:args[4],started:args[5],previous:args[6]};
   return {toArray:()=>statement.startsWith('SELECT')&&saved&&saved.job===args[0]&&(args.length===1||saved.generation===args[1])?[saved]:[]};
  }} as unknown as SqlStorage;
  const binding=new SyntheticJobContextBinding({sql} as DurableObjectStorage), source=input();
  expect(()=>binding.callbacks(source).bind(sql,'job','generation')).toThrow();
  const callbacks=binding.callbacks(source,undefined,()=> '2026-10-23T06:30:00Z');source.cfg.query='changed';
  expect(callbacks.bind(sql,'job','generation')).toBe(true);
  expect(callbacks.checkExisting(sql,'job','generation')).toBe(true);
  expect(binding.callbacks(source).checkExisting(sql,'job','generation')).toBe(false);
  expect(callbacks.checkExisting(sql,'job','other')).toBe(false);
  expect(binding.readInTransaction(sql,'job','generation')).toMatchObject({run:'2026-10-24T06:30:00Z',date:'2026-10-24',previous:'2026-10-23T06:30:00Z'});
  expect(JSON.stringify(saved)).not.toContain('secret sentinel');
  if(saved)saved.run='tampered';
  expect(binding.readInTransaction(sql,'job','generation')).toBeNull();
 });
});
