import { describe, expect, it } from 'vitest';
import { SyntheticTrustedInputReader } from '../src/synthetic-trusted-input-reader';
import type { TrustedAssemblySource } from '../src/trusted-assembly-source';

const id='A'.repeat(22),hash='2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';
function fixture(){
 const sql={exec:()=>({toArray:()=>[{n:1}]})} as unknown as SqlStorage;
 const storage={sql,transactionSync:(f:()=>unknown)=>f()} as unknown as DurableObjectStorage;
 let valid=true,data=new TextEncoder().encode('hello');
 const entries=[{cursor:'1',kind:'partial',key:'a',index:0,bytes:5,hash},{cursor:'2',kind:'missing',key:'cursor:a',index:0,bytes:0,hash:null}];
 const source={describe:()=>({job:id,generation:id,head:null,versions:[],at:1,rows:[{alias:'a',identity:'a'.repeat(64),state:'done',partial:hash,partial_count:1}]}),validateInTransaction:()=>valid,inventoryPageInTransaction:()=>({entries,next:null}),readPartial:()=>data,readState:()=>({kind:'missing'})} as unknown as TrustedAssemblySource;
 return {reader:new SyntheticTrustedInputReader(storage,source,()=>true),input:{scope:id,job:id,generation:id,attempt:id,sourceId:'a'.repeat(64)},entries,stale:()=>{valid=false;},tamper:()=>{data=new TextEncoder().encode('other');}};
}
describe('synthetic authenticated raw input reader',()=>{
 it('reads exact bytes and distinguishes missing source state',async()=>{
  const f=fixture(),result=await f.reader.read(f.input);
  expect(result?.values.get('partial:a')).toEqual({kind:'partial',bytes:new TextEncoder().encode('hello')});
  expect(result?.values.get('state:cursor:a')).toEqual({kind:'missing'});
 });
 it('rejects stale authorization, altered bytes, duplicates and missing chunks',async()=>{
  const stale=fixture();stale.stale();expect(await stale.reader.read(stale.input)).toBeNull();
  const corrupt=fixture();corrupt.tamper();expect(await corrupt.reader.read(corrupt.input)).toBeNull();
  const duplicate=fixture();duplicate.entries.push(duplicate.entries[0]!);expect(await duplicate.reader.read(duplicate.input)).toBeNull();
  const gap=fixture();gap.entries[0]!.index=1;expect(await gap.reader.read(gap.input)).toBeNull();
 });
});
