import { describe,expect,it } from "vitest";
import { buildAssemblyManifest,prepareAssembly,runContext,type MailboxPartial } from "../src/digest";
import type { HistoryEntry } from "../src/estimate";
import { beginHistoryProjection,nextHistoryProjectionPage,HISTORY_PROJECTION_LIMITS,type HistoryProjectionSource } from "../src/synthetic-history-projection";
import { makeEnv } from "./helpers";

const scope="a".repeat(22),sourceId="b".repeat(64),now=new Date("2026-10-24T06:30:00Z");
const entry=(id:string,date:string|null=null):HistoryEntry=>({id,address:"sender@example.com",domain:"example.com",name:"Sender",subject:`Invoice ${id}`,shape:[],addressing:"only_you",tab:"primary",important:false,starred:false,conversation:false,attachment:false,flags:[],answers:{sender:"person",request:"direct",stakes:"some",category:"task"},date});
function source(before:HistoryEntry[],added:HistoryEntry[],present=true){
	let current=true;const sorted=added.map((value,ordinal)=>({entry:value,ordinal})).sort((a,b)=>(b.entry.date??"").localeCompare(a.entry.date??""));const ids=new Set(added.map(x=>x.id));
	const api:HistoryProjectionSource={current:()=>current,info:()=>({present,before:before.length,added:added.length}),addedSortedAt:(_s,_id,_a,i)=>sorted[i]??null,beforeAt:(_s,_id,_a,i)=>before[i]??null,inAdded:(_s,_id,_a,id)=>ids.has(id)};
	return {api,invalidate:()=>{current=false;}};
}
function plan(api:HistoryProjectionSource){let checkpoint=beginHistoryProjection(api,scope,sourceId,"mail"),out="",final=null,steps=0;while(checkpoint.phase!=="done"){const p=nextHistoryProjectionPage(api,checkpoint,{scope,sourceId,phase:checkpoint.phase,index:checkpoint.index});expect(new TextEncoder().encode(p.chunk).byteLength).toBeLessThanOrEqual(HISTORY_PROJECTION_LIMITS.bytesPerPage);checkpoint=JSON.parse(JSON.stringify(p.checkpoint));out+=p.chunk;final=p.final;if(++steps>2000)throw new Error("no progress");}return {out,final,steps};}
async function reference(before:HistoryEntry[],added:HistoryEntry[],present=true){const env=makeEnv(),ctx=await runContext(env,{},now,false);const partial={alias:"mail",status:{alias:"mail",email:"mail@example.com",ok:false,found:0,newlyClassified:0},items:[],toCache:[],learned:added,surfaced:[],replacedCarried:[],errors:[],estimated:0,fromHistory:0,...(present?{history:before}:{})} as MailboxPartial;const prepared=await prepareAssembly(env,ctx,[partial],{doneKeys:new Set()});return buildAssemblyManifest(ctx,[partial],prepared,{lastRun:null,indexedRuns:[],cursors:{},failureHolds:{},histories:{mail:before}}).writes.find(w=>w.key==="history:mail");}

describe("bounded synthetic history merge",()=>{
	it("matches reference ordering, stable equal dates and dedupe",async()=>{
		const before=[entry("a"),entry("b"),entry("b"),entry("c")];
		const added=[entry("b","2026-10-23"),entry("x","2026-10-24"),entry("y","2026-10-24"),entry("z")];
		const projected=plan(source(before,added).api),expected=await reference(before,added);
		expect(expected).toEqual({kind:"put",key:"history:mail",value:projected.out,expirationTtl:60*24*60*60});
		expect(JSON.parse(projected.out).map((v:HistoryEntry)=>v.id)).toEqual(["x","y","b","z","a","c"]);
	});
	it("caps at 500 without materializing a 5,000-entry history",async()=>{
		const before=Array.from({length:5000},(_,i)=>entry(`m${i}`));
		const projected=plan(source(before,[]).api);expect(JSON.parse(projected.out)).toHaveLength(500);expect(projected.steps).toBeGreaterThan(1);
		expect((await reference(before,[]))).toMatchObject({kind:"put",value:projected.out});
	});
	it("distinguishes an absent history from a present empty history",async()=>{
		expect(plan(source([],[],false).api).final).toEqual({kind:"noop"});expect(await reference([],[],false)).toBeUndefined();
		const empty=plan(source([],[],true).api);expect(empty.final).toMatchObject({kind:"put"});expect(await reference([],[],true)).toMatchObject({kind:"put",value:"[]"});
	});
	it("rejects stale, missing and incorrectly sorted source records",()=>{
		const f=source([],[entry("a","2026-10-24"),entry("b","2026-10-23")]),initial=beginHistoryProjection(f.api,scope,sourceId,"mail");
		expect(()=>nextHistoryProjectionPage(f.api,initial,{scope,sourceId,phase:"added",index:1})).toThrow(/checkpoint/);
		expect(()=>nextHistoryProjectionPage({...f.api,addedSortedAt:()=>null},initial,{scope,sourceId,phase:"added",index:0})).toThrow(/Missing/);
		const reversed={...f.api,addedSortedAt:(_s:string,_id:string,_a:string,i:number)=>i===0?{entry:entry("b","2026-10-23"),ordinal:1}:{entry:entry("a","2026-10-24"),ordinal:0}};
		expect(()=>nextHistoryProjectionPage(reversed,initial,{scope,sourceId,phase:"added",index:0})).toThrow(/ordering/);
		f.invalidate();expect(()=>nextHistoryProjectionPage(f.api,initial,{scope,sourceId,phase:"added",index:0})).toThrow(/checkpoint/);
	});
	it("rejects credential fields and unredacted security codes before output",()=>{
		for(const value of [{...entry("a"),sealedRefreshToken:"secret"},{...entry("b"),subject:"Your sign-in code is 482913"}]){
			const api=source([],[value as HistoryEntry]).api,initial=beginHistoryProjection(api,scope,sourceId,"mail");
			expect(()=>nextHistoryProjectionPage(api,initial,{scope,sourceId,phase:"added",index:0})).toThrow(/Invalid or unredacted/);
		}
	});
});
