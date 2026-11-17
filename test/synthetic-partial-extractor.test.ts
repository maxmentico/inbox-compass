import { afterEach, describe, expect, it, vi } from "vitest";
import { extractPartialEvents, finishPartialExtraction, PARTIAL_EXTRACT_LIMITS, startPartialExtraction, type ExtractedSubrecord } from "../src/synthetic-partial-extractor";
import { finishSyntheticJsonStream, pushSyntheticJsonFragment, startSyntheticJsonStream, type JsonEvent } from "../src/synthetic-stream-json";
import { finishPartialDtoMapping, mapPartialDtoBatch, startPartialDtoMapping } from "../src/synthetic-partial-dto";
import { _clearAccessTokenCache } from "../src/accounts";
import { buildAssemblyManifest, collect, prepareAssembly, runContext, type MailboxPartial } from "../src/digest";
import { fakeAi, fakeGmail } from "./fakes";
import { fullMessage, linkAccount, makeEnv, MESSAGE_TIME } from "./helpers";

const sourceId = "a".repeat(64), scope = "b".repeat(22), encoder = new TextEncoder();
afterEach(()=>{_clearAccessTokenCache();vi.unstubAllGlobals();vi.restoreAllMocks();});
function extract(value: unknown, fragmentBytes: number) {
	const bytes = encoder.encode(JSON.stringify(value));
	let parser = startSyntheticJsonStream(sourceId, scope), reducer = startPartialExtraction(sourceId, scope), fragments = 0;
	const records: ExtractedSubrecord[] = [];
	const apply = (events: JsonEvent[]) => {
		let offset = 0;
		while (offset < events.length) {
			const step = extractPartialEvents(reducer, sourceId, scope, reducer.nextEvent, events.slice(offset));
			expect(step.records.length).toBeLessThanOrEqual(PARTIAL_EXTRACT_LIMITS.records);
			if (!step.consumed) throw new Error("no extraction progress");
			// Model a durable JSON checkpoint between every bounded reducer step.
			reducer = JSON.parse(JSON.stringify(step.checkpoint)); offset += step.consumed; records.push(...step.records);
		}
	};
	for (let i = 0; i < bytes.length; i += fragmentBytes) {
		fragments++;
		const fragment = bytes.slice(i, i + fragmentBytes); let offset = 0;
		while (offset < fragment.length) {
			const step = pushSyntheticJsonFragment(parser, sourceId, scope, fragment, offset);
			if (step.nextOffset === offset && !step.events.length) throw new Error("no tokenizer progress");
			parser = JSON.parse(JSON.stringify(step.checkpoint)); offset = step.nextOffset; apply(step.events);
		}
	}
	const finish = finishSyntheticJsonStream(parser, sourceId, scope); apply(finish.events);
	finishPartialExtraction(reducer, sourceId, scope);
	return { records, fragments };
}

describe("bounded nested partial extraction", () => {
	it("extracts 500 items and 5,000 Unicode history entries across more than 160 fragments without loss", () => {
		const items = Array.from({ length: 500 }, (_, i) => ({ key: `mail:m${i}`, account: "mail", accountEmail: "mail@example.com", messageId: `m${i}`, threadId: `t${i}`, from: "sender@example.com", subject: `消息 ${i} ✓`, snippet: "摘要", date: "2026-10-24T06:00:00Z", needsAction: true, action: "Review", urgency: "medium", category: "task", due: null, summary: "Summary", classified: true, done: false }));
		const history = Array.from({ length: 5_000 }, (_, i) => ({ id: `h${i}`, address: "sender@example.com", domain: "example.com", name: "Sender", subject: `历史记录 ${i}`, shape: [], addressing: "only_you", tab: "primary", important: false, starred: false, conversation: false, attachment: false, flags: [], answers: { sender: "person", request: "direct", stakes: "some", category: "task" }, date: null }));
		const cached = { v: 3, meta: { threadId: "t0", from: "sender@example.com", subject: "测试", snippet: "摘要", date: null }, classifiedAt: "2026-10-24T06:30:00Z" };
		const partial = { alias: "mail", status: { alias: "mail", email: "mail@example.com", ok: true, found: 500, newlyClassified: 500 }, items, toCache: [["mail:m0", cached]], learned: [], history, recheck: { before: [{ id: "old", added: 1 }], settled: ["done"], estimated: ["new"] }, run: { before: null, seenTimes: [1, 2], backlog: false }, surfaced: [], replacedCarried: [], errors: [], estimated: 0, fromHistory: 0 };
		const result = extract(partial, 512);
		expect(result.fragments).toBeGreaterThan(160);
		expect(result.records.filter((r) => r.path[0] === "items" && r.path.length===2).map((r) => r.value)).toEqual(items);
		expect(result.records.filter((r) => r.path[0] === "history" && r.path.length===2).map((r) => r.value)).toEqual(history);
		expect(result.records.find((r) => r.path[0] === "toCache" && r.path.length===2)?.value).toEqual(partial.toCache[0]);
		expect(result.records.filter((r) => r.path[0] === "recheck" && r.path.length===3).map((r) => r.value)).toEqual([{ id: "old", added: 1 }, "done", "new"]);
		let dto = startPartialDtoMapping(sourceId, scope, "mail", "mail@example.com", "c".repeat(64));
		const mapped = [];
		for (let i = 0; i < result.records.length; i += 16) {
			const next = mapPartialDtoBatch(dto, { sourceId, scope, account: "mail", identity: "c".repeat(64), nextSequence: dto.nextSequence }, result.records.slice(i, i + 16));
			const persisted = JSON.parse(JSON.stringify({ ...next.checkpoint, seenKeys: [...next.checkpoint.seenKeys] }));
			dto = { ...persisted, seenKeys: new Set<string>(persisted.seenKeys) }; mapped.push(...next.records);
		}
		expect(mapped.filter((r) => r.kind === "item")).toHaveLength(500);
		expect(mapped.filter((r) => r.kind === "history")).toHaveLength(5_000);
		const final=finishPartialDtoMapping(dto);
		expect(final.records.find((r)=>r.kind==="mailbox-partial")).toMatchObject({status:partial.status,estimated:0,fromHistory:0});
		expect(final.records.find((r)=>r.kind==="partial-list"&&r.list==="history")).toMatchObject({present:true,count:5000});
		expect(final.records.find((r)=>r.kind==="partial-list"&&r.list==="learned")).toMatchObject({present:true,count:0});
		expect(final.checkpoint.nextSequence).toBe(dto.nextSequence+final.records.length);
	});

	it("rejects oversized records and changed or replayed identity/sequence", () => {
		expect(() => extract({ items: [{ value: "x".repeat(16 * 1024) }] }, 512)).toThrow(/limit/);
		expect(() => extract({ alias: "mail", unexpected: "value" }, 512)).toThrow(/Unsupported/);
		expect(() => extract({ alias: "mail", run: { unexpected: true } }, 512)).toThrow(/Unsupported/);
		const state = startPartialExtraction(sourceId, scope);
		expect(() => extractPartialEvents(state, "c".repeat(64), scope, 0, [])).toThrow(/checkpoint/);
		expect(() => extractPartialEvents(state, sourceId, scope, 1, [])).toThrow(/checkpoint/);
		expect(() => finishPartialExtraction(state, sourceId, scope)).toThrow(/Incomplete/);
	});

	it("rejects missing or changed account identity, credential fields and unsupported raw errors", () => {
		const initial = startPartialDtoMapping(sourceId, scope, "mail", "mail@example.com", "c".repeat(64));
		const expected = { sourceId, scope, account: "mail", identity: "c".repeat(64), nextSequence: 0 };
		expect(() => mapPartialDtoBatch(initial, expected, [{ path: ["alias"], value: "other" }])).toThrow(/identity/);
		expect(() => mapPartialDtoBatch(initial, { ...expected, identity: "d".repeat(64) }, [])).toThrow(/checkpoint/);
		const verified = mapPartialDtoBatch(initial, expected, [{ path: ["alias"], value: "mail" }, { path: ["items"], value: { present: true } }, { path: ["errors"], value: { present: true } }]).checkpoint;
		const base = { key: "mail:m1", account: "mail", accountEmail: "mail@example.com", messageId: "m1", threadId: "t1", from: "sender@example.com", subject: "Invoice", snippet: "Invoice", date: null, needsAction: true, action: "Review", urgency: "medium", category: "task", due: null, summary: "Review", classified: true, done: false };
		expect(() => mapPartialDtoBatch(verified, expected, [{ path: ["items", "0"], value: { ...base, accountEmail: "other@example.com" } }])).toThrow(/identity/);
		expect(() => mapPartialDtoBatch(verified, expected, [{ path: ["items", "0"], value: { ...base, sealedRefreshToken: "credential-sentinel" } }])).toThrow(/record/);
		expect(() => mapPartialDtoBatch(verified, expected, [{ path: ["items", "0"], value: { ...base, subject: "Your sign-in code is 482913", snippet: "Use 482913" } }])).toThrow(/Unredacted/);
		expect(() => mapPartialDtoBatch(verified, expected, [{ path: ["errors", "0"], value: "raw provider error" }])).toThrow(/Unsupported/);
	});

	it("preserves absent lists separately from present empty lists", () => {
		const partial={alias:"mail",status:{alias:"mail",email:"mail@example.com",ok:true,found:0,newlyClassified:0},items:[],toCache:[],learned:[],surfaced:[],replacedCarried:[],errors:[],estimated:0,fromHistory:0};
		const values=extract(partial,17).records;
		let dto=startPartialDtoMapping(sourceId,scope,"mail","mail@example.com","c".repeat(64));
		for(let i=0;i<values.length;i+=16)dto=mapPartialDtoBatch(dto,{sourceId,scope,account:"mail",identity:"c".repeat(64),nextSequence:dto.nextSequence},values.slice(i,i+16)).checkpoint;
		const final=finishPartialDtoMapping(dto).records;
		expect(final.find((r)=>r.kind==="partial-list"&&r.list==="history")).toMatchObject({present:false,count:0});
		expect(final.find((r)=>r.kind==="partial-list"&&r.list==="learned")).toMatchObject({present:true,count:0});
		expect(final.some((r)=>r.kind==="mailbox-run")).toBe(false);
	});

	it("round-trips a real synthetic collected partial into the reference manifest", async () => {
		const env=makeEnv({AI:{run:fakeAi()} as unknown as Ai});await linkAccount(env,"mail");
		vi.stubGlobal("fetch",vi.fn(fakeGmail({mail:[fullMessage("m1",{subject:"Invoice",ms:MESSAGE_TIME})]}).impl));
		const ctx=await runContext(env,{},new Date("2026-10-24T06:30:00Z"),false);
		const original=(await collect(env,ctx,ctx.accounts))[0]!;
		const extracted=extract(original,512).records;
		let dto=startPartialDtoMapping(sourceId,scope,"mail","mail@example.com","c".repeat(64));
		const mapped: any[]=[];
		for(let i=0;i<extracted.length;i+=16){const page=mapPartialDtoBatch(dto,{sourceId,scope,account:"mail",identity:"c".repeat(64),nextSequence:dto.nextSequence},extracted.slice(i,i+16));dto=page.checkpoint;mapped.push(...page.records);}
		mapped.push(...finishPartialDtoMapping(dto).records);
		const meta=mapped.find((r)=>r.kind==="mailbox-partial");if(!meta||meta.kind!=="mailbox-partial")throw new Error("missing metadata");
		const run=mapped.find((r)=>r.kind==="mailbox-run");
		const list=(name:string)=>mapped.some((r)=>r.kind==="partial-list"&&r.list===name&&r.present);
		const strippedItems=mapped.filter((r)=>r.kind==="item").map(({version:_v,scope:_s,sequence:_n,kind:_k,collection:_c,...value})=>value);
		const before=mapped.filter((r)=>r.kind==="recheck"&&r.list==="before").map((r)=>({id:r.messageId,added:r.added!}));
		const rebuilt={alias:"mail",status:meta.status,items:strippedItems,toCache:mapped.filter((r)=>r.kind==="cache").map((r)=>[`${r.account}:${r.messageId}`,r.value]),learned:mapped.filter((r)=>r.kind==="history"&&r.list==="learned").map((r)=>r.value),...(list("history")?{history:mapped.filter((r)=>r.kind==="history"&&r.list==="before").map((r)=>r.value)}:{}),...(list("recheck")?{recheck:{before,settled:mapped.filter((r)=>r.kind==="recheck"&&r.list==="settled").map((r)=>r.messageId),estimated:mapped.filter((r)=>r.kind==="recheck"&&r.list==="estimated").map((r)=>r.messageId)}}:{}),...(run&&run.kind==="mailbox-run"?{run:{before:run.before,backlog:run.backlog,seenTimes:mapped.filter((r)=>r.kind==="seen-times").flatMap((r)=>r.values),...(run.share===undefined?{}:{share:run.share}),...(run.full===undefined?{}:{full:run.full})}}:{}),surfaced:mapped.filter((r)=>r.kind==="item-flag"&&r.list==="surfaced").map((r)=>r.key),replacedCarried:mapped.filter((r)=>r.kind==="item-flag"&&r.list==="replaced-carried").map((r)=>r.key),errors:[],estimated:meta.estimated,fromHistory:meta.fromHistory,...(meta.windowStart===undefined?{}:{windowStart:meta.windowStart}),...(meta.carryOnly===undefined?{}:{carryOnly:meta.carryOnly}),...(meta.unavailable===undefined?{}:{unavailable:meta.unavailable})} as unknown as MailboxPartial;
		expect(rebuilt).toEqual(original);
		const snapshot={lastRun:null,indexedRuns:[],cursors:{mail:null},failureHolds:{mail:null},histories:{mail:[]}};
		const originalPrepared=await prepareAssembly(env,ctx,[original],{doneKeys:new Set()});
		const rebuiltPrepared=await prepareAssembly(env,ctx,[rebuilt],{doneKeys:new Set()});
		expect(buildAssemblyManifest(ctx,[rebuilt],rebuiltPrepared,snapshot)).toEqual(buildAssemblyManifest(ctx,[original],originalPrepared,snapshot));
	});
});
