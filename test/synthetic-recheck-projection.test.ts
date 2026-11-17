import { describe, expect, it } from "vitest";
import { buildAssemblyManifest, prepareAssembly, runContext, type MailboxPartial } from "../src/digest";
import { beginRecheckProjection, nextRecheckProjectionPage, RECHECK_PROJECTION_LIMITS, type RecheckProjectionSource } from "../src/synthetic-recheck-projection";
import { stageVerifiedOutputPage, type AtomicStageStorage, type StageCursor, type StagedPage } from "../src/atomic-stage-page";
import { makeEnv } from "./helpers";

const scope="a".repeat(22),sourceId="b".repeat(64),now=new Date("2026-10-24T06:30:00Z");
function source(before:{id:string;added:number}[],settled:string[],estimated:string[],present=true){
	let current=true;
	const api:RecheckProjectionSource={current:()=>current,info:()=>({present,before:before.length,estimated:estimated.length,now:now.getTime()}),beforeAt:(_s,_id,_a,i)=>before[i]??null,estimatedAt:(_s,_id,_a,i)=>estimated[i]??null,isSettled:(_s,_id,_a,id)=>settled.includes(id),inBefore:(_s,_id,_a,id)=>before.some(e=>e.id===id)};
	return {api,invalidate:()=>{current=false;}};
}
function plan(api:RecheckProjectionSource){
	let checkpoint=beginRecheckProjection(api,scope,sourceId,"mail"),out="",final=null,steps=0;
	while(checkpoint.phase!=="done"){
		const p=nextRecheckProjectionPage(api,checkpoint,{scope,sourceId,phase:checkpoint.phase,index:checkpoint.index});
		expect(new TextEncoder().encode(p.chunk).byteLength).toBeLessThanOrEqual(RECHECK_PROJECTION_LIMITS.bytesPerPage);
		checkpoint=JSON.parse(JSON.stringify(p.checkpoint));out+=p.chunk;final=p.final;if(++steps>2000)throw new Error("no progress");
	}
	return {out,final,steps};
}
async function reference(before:{id:string;added:number}[],settled:string[],estimated:string[],present=true){
	const env=makeEnv(),ctx=await runContext(env,{},now,false);
	const partial={alias:"mail",status:{alias:"mail",email:"mail@example.com",ok:false,found:0,newlyClassified:0},items:[],toCache:[],learned:[],surfaced:[],replacedCarried:[],errors:[],estimated:0,fromHistory:0,...(present?{recheck:{before,settled,estimated}}:{})} as MailboxPartial;
	const prepared=await prepareAssembly(env,ctx,[partial],{doneKeys:new Set()});
	return buildAssemblyManifest(ctx,[partial],prepared,{lastRun:null,indexedRuns:[],cursors:{},failureHolds:{},histories:{}}).writes.find(w=>w.key==="recheck:mail");
}

describe("bounded synthetic recheck projection",()=>{
	it("matches the reference for 5,000 old entries, 500 settled and 500 new estimates",async()=>{
		const before=Array.from({length:5000},(_,i)=>({id:`old${i}`,added:i+1}));
		const settled=before.slice(0,500).map(e=>e.id),estimated=Array.from({length:500},(_,i)=>`new${i}`);
		const actual=plan(source(before,settled,estimated).api),expected=await reference(before,settled,estimated);
		expect(actual.steps).toBeGreaterThan(160);
		expect(expected).toEqual({kind:"put",key:"recheck:mail",value:actual.out,expirationTtl:21*24*60*60});
		expect(actual.final).toEqual({kind:"put",expirationTtl:21*24*60*60});
	});
	it("preserves duplicate ordering and the original-before membership rule",async()=>{
		const before=[{id:"old",added:1},{id:"old",added:2},{id:"keep",added:3}],settled=["old"],estimated=["old","fresh","fresh"];
		const actual=plan(source(before,settled,estimated).api);
		expect(JSON.parse(actual.out)).toEqual([{id:"keep",added:3},{id:"fresh",added:now.getTime()},{id:"fresh",added:now.getTime()}]);
		expect(await reference(before,settled,estimated)).toMatchObject({kind:"put",value:actual.out});
	});
	it("distinguishes absent, empty, unchanged and delete",async()=>{
		for(const present of [true,false]){const actual=plan(source([],[],[],present).api);expect(actual.final).toEqual({kind:"noop"});expect(await reference([],[],[],present)).toBeUndefined();}
		const prior=[{id:"old",added:1}];
		const unchanged=plan(source(prior,[],[]).api);expect(unchanged.final).toMatchObject({kind:"put"});expect(await reference(prior,[],[])).toMatchObject({kind:"put",value:unchanged.out});
		const removed=plan(source(prior,["old"],[]).api);expect(removed.final).toEqual({kind:"delete"});expect(await reference(prior,["old"],[])).toEqual({kind:"delete",key:"recheck:mail"});
	});
	it("rejects missing records, replayed or changed checkpoints and source invalidation",()=>{
		const fixture=source([{id:"old",added:1}],[],[]),start=beginRecheckProjection(fixture.api,scope,sourceId,"mail");
		expect(()=>nextRecheckProjectionPage(fixture.api,start,{scope,sourceId,phase:"before",index:1})).toThrow(/checkpoint/);
		const missing={...fixture.api,beforeAt:()=>null};expect(()=>nextRecheckProjectionPage(missing,start,{scope,sourceId,phase:"before",index:0})).toThrow(/Missing/);
		const changed={...fixture.api,beforeAt:(...args:Parameters<RecheckProjectionSource["beforeAt"]>)=>{fixture.invalidate();return fixture.api.beforeAt(...args);}};
		expect(()=>nextRecheckProjectionPage(changed,start,{scope,sourceId,phase:"before",index:0})).toThrow(/stale/);
	});
	it("can atomically stage a bounded page with rollback and idempotent retry",async()=>{
		const before=Array.from({length:17},(_,i)=>({id:`m${i}`,added:i+1})),api=source(before,[],[]).api;
		let cursor:StageCursor={scope,sourceId,generation:1,attempt:"c".repeat(22),expiresAt:Date.now()+60_000,nextPage:0,nextSequence:0,totalRecords:17,complete:false};
		let pages=new Map<number,StagedPage>(),fail=true;
		const storage:AtomicStageStorage={transactionSync:(work)=>{let c=structuredClone(cursor),p=structuredClone(pages);const value=work({readCursor:()=>structuredClone(c),readPage:(_s,i)=>p.get(i)??null,writePage:(_s,i,v)=>{p.set(i,structuredClone(v));},writeCursor:(_s,v)=>{if(fail)throw new Error("crash");c=structuredClone(v);}});cursor=c;pages=p;return value;}};
		const checkpoint=beginRecheckProjection(api,scope,sourceId,"mail"),first=nextRecheckProjectionPage(api,checkpoint,{scope,sourceId,phase:checkpoint.phase,index:checkpoint.index});
		const page={scope,sourceId,generation:1,attempt:"c".repeat(22),page:0,startSequence:0,endSequence:first.checkpoint.processed,final:false,bytes:new TextEncoder().encode(first.chunk)};
		await expect(stageVerifiedOutputPage(storage,page)).rejects.toThrow(/crash/);expect(pages.size).toBe(0);expect(cursor.nextSequence).toBe(0);
		fail=false;expect(await stageVerifiedOutputPage(storage,page)).toBe("staged");expect(await stageVerifiedOutputPage(storage,page)).toBe("already-staged");
		const last=nextRecheckProjectionPage(api,first.checkpoint,{scope,sourceId,phase:first.checkpoint.phase,index:first.checkpoint.index});
		expect(await stageVerifiedOutputPage(storage,{...page,page:1,startSequence:first.checkpoint.processed,endSequence:last.checkpoint.processed,final:true,bytes:new TextEncoder().encode(last.chunk)})).toBe("staged");
		expect(cursor.complete).toBe(true);
	});
});
