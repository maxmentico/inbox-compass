// SYNTHETIC/UNWIRED: maps selected extracted partial elements to strict DTOs. The caller must bind
// account identity, source version, extractor progress and checkpoint in one trusted transaction.
// This is not a complete MailboxPartial projection; scalar metadata/status and commit are absent.
import { parseAssemblyInputBatch, type AssemblyInputRecord } from "./assembly-input";
import type { ExtractedSubrecord } from "./synthetic-partial-extractor";

export interface PartialDtoCheckpoint {
	sourceId: string; scope: string; account: string; email: string; identity: string;
	nextSequence: number; seenKeys: Set<string>; aliasVerified: boolean;
	metadata: Record<string, unknown>; lists: Record<string, { present: boolean; count: number }>;
}
const SOURCE = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const ACCOUNT = /^[a-z0-9][a-z0-9-]{0,31}$/;
const encoder = new TextEncoder();
const LISTS = ["items","toCache","learned","history","recheck","recheck.before","recheck.settled","recheck.estimated","run","run.seenTimes","surfaced","replacedCarried","errors"] as const;
const SCALARS = new Set(["status","unavailable","windowStart","estimated","fromHistory","carryOnly","run.before","run.backlog","run.share","run.full"]);

/** `identity` and account/email must be supplied from coordinator-owned identity state. */
export function startPartialDtoMapping(sourceId: string, scope: string, account: string, email: string, identity: string): PartialDtoCheckpoint {
	if (!SOURCE.test(sourceId) || !TOKEN.test(scope) || !ACCOUNT.test(account) || !email || email.length > 320 || !SOURCE.test(identity)) throw new Error("Invalid partial DTO identity");
	return { sourceId, scope, account, email: email.toLowerCase(), identity, nextSequence: 0, seenKeys: new Set(), aliasVerified: false, metadata: {}, lists: Object.fromEntries(LISTS.map((list)=>[list,{present:false,count:0}])) };
}

/** Map one bounded batch. Input records and their ordering must come from the verified extractor. */
export function mapPartialDtoBatch(checkpoint: PartialDtoCheckpoint, expected: { sourceId: string; scope: string; account: string; identity: string; nextSequence: number }, extracted: readonly ExtractedSubrecord[]): { checkpoint: PartialDtoCheckpoint; records: AssemblyInputRecord[] } {
	if (!checkpoint || checkpoint.sourceId !== expected.sourceId || checkpoint.scope !== expected.scope || checkpoint.account !== expected.account || checkpoint.identity !== expected.identity || checkpoint.nextSequence !== expected.nextSequence || !Array.isArray(extracted) || extracted.length > 16) throw new Error("Invalid partial DTO checkpoint");
	const next = structuredClone(checkpoint), encodedRecords: Uint8Array[] = [];
	for (const part of extracted) {
		if (!part || !Array.isArray(part.path) || !part.path.every((p: unknown) => typeof p === "string")) throw new Error("Invalid extracted partial path");
		if (part.path.length === 1 && part.path[0] === "alias") {
			if (next.aliasVerified || part.value !== next.account) throw new Error("Partial account identity mismatch");
			next.aliasVerified = true; continue;
		}
		if (!next.aliasVerified) throw new Error("Partial account not verified");
		const fullPath=part.path.join(".");
		if (Object.hasOwn(next.lists,fullPath)) {
			if (next.lists[fullPath]!.present || !part.value || typeof part.value !== "object" || Array.isArray(part.value) || JSON.stringify(part.value)!=='{"present":true}') throw new Error("Invalid partial list marker");
			next.lists[fullPath]!.present=true;continue;
		}
		if (SCALARS.has(fullPath)) {
			if (Object.hasOwn(next.metadata,fullPath)) throw new Error("Duplicate partial metadata");
			next.metadata[fullPath]=part.value;continue;
		}
		const [top, middle] = part.path;
		if (part.path.length < 2 || !/^\d+$/.test(part.path.at(-1)!)) throw new Error("Invalid extracted partial index");
		const list = top === "recheck" || top === "run" ? `${top}.${middle}` : top!;
		if (!next.lists[list]?.present) throw new Error("Missing partial list marker");
		next.lists[list]!.count++;
		let value: Record<string, unknown>;
		if (top === "items" && part.path.length === 2 && part.value && typeof part.value === "object" && !Array.isArray(part.value)) {
			const item = part.value as Record<string, unknown>;
			if (["kind", "version", "scope", "sequence", "collection"].some((key) => Object.hasOwn(item, key)) || item.account !== next.account || typeof item.accountEmail !== "string" || item.accountEmail.toLowerCase() !== next.email) throw new Error("Partial item identity mismatch");
			value = { kind: "item", collection: "partial", ...item };
		} else if (top === "toCache" && part.path.length === 2 && Array.isArray(part.value) && part.value.length === 2 && typeof part.value[0] === "string" && part.value[0].startsWith(`${next.account}:`)) {
			const cached = part.value[1] as Record<string, unknown> | null;
			if (!cached || typeof cached !== "object" || Array.isArray(cached) || (cached.mailbox !== undefined && (typeof cached.mailbox !== "string" || cached.mailbox.toLowerCase() !== next.email))) throw new Error("Partial cache identity mismatch");
			value = { kind: "cache", account: next.account, messageId: part.value[0].slice(next.account.length + 1), value: cached };
		} else if ((top === "learned" || top === "history") && part.path.length === 2) {
			value = { kind: "history", account: next.account, list: top === "learned" ? "learned" : "before", value: part.value };
		} else if (top === "recheck" && part.path.length === 3 && (middle === "before" || middle === "settled" || middle === "estimated")) {
			if (middle === "before" && part.value && typeof part.value === "object" && !Array.isArray(part.value)) {
				const entry = part.value as Record<string, unknown>;
				if (Object.keys(entry).some((key) => key !== "id" && key !== "added")) throw new Error("Invalid partial recheck entry");
				value = { kind: "recheck", account: next.account, list: middle, messageId: entry.id, added: entry.added };
			} else if (middle !== "before" && typeof part.value === "string") value = { kind: "recheck", account: next.account, list: middle, messageId: part.value };
			else throw new Error("Invalid partial recheck entry");
		} else if (top === "run" && middle === "seenTimes" && part.path.length === 3 && typeof part.value === "number") {
			value = { kind: "seen-times", account: next.account, chunk: Number(part.path[2]), values: [part.value] };
		} else if ((top === "surfaced" || top === "replacedCarried") && part.path.length === 2 && typeof part.value === "string" && part.value.startsWith(`${next.account}:`)) {
			value = { kind: "item-flag", list: top === "surfaced" ? "surfaced" : "replaced-carried", key: part.value };
		} else {
			// Raw model/provider error text may contain secrets; do not silently stage it.
			throw new Error("Unsupported partial subrecord");
		}
		encodedRecords.push(encoder.encode(JSON.stringify({ version: 1, scope: next.scope, sequence: next.nextSequence + encodedRecords.length, ...value })));
	}
	const checked = parseAssemblyInputBatch(encodedRecords, next.sourceId, { sourceId: next.sourceId, scope: next.scope, nextSequence: next.nextSequence, seenKeys: next.seenKeys });
	next.nextSequence = checked.nextSequence; next.seenKeys = checked.seenKeys;
	return { checkpoint: next, records: checked.records };
}

/** Emit the bounded metadata and explicit list presence only after the authenticated JSON ends. */
export function finishPartialDtoMapping(checkpoint: PartialDtoCheckpoint): { checkpoint: PartialDtoCheckpoint; records: AssemblyInputRecord[] } {
	const next=structuredClone(checkpoint), m=next.metadata;
	if(!next.aliasVerified||!m.status||typeof m.status!=="object"||Array.isArray(m.status)||typeof m.estimated!=="number"||typeof m.fromHistory!=="number")throw new Error("Incomplete partial metadata");
	const status=m.status as Record<string,unknown>;
	if(status.alias!==next.account||typeof status.email!=="string"||status.email.toLowerCase()!==next.email||typeof status.error==="string")throw new Error("Invalid or unsupported partial status");
	for(const list of ["items","toCache","learned","surfaced","replacedCarried","errors"])if(!next.lists[list]?.present)throw new Error("Missing required partial list");
	if(next.lists.recheck?.present&&["recheck.before","recheck.settled","recheck.estimated"].some((key)=>!next.lists[key]?.present))throw new Error("Incomplete partial recheck");
	if(next.lists.run?.present&&(!Object.hasOwn(m,"run.before")||typeof m["run.backlog"]!=="boolean"||!next.lists["run.seenTimes"]?.present))throw new Error("Incomplete partial run");
	const values:Record<string,unknown>[]=[{kind:"mailbox-partial",account:next.account,status,estimated:m.estimated,fromHistory:m.fromHistory,...(m.windowStart===undefined?{}:{windowStart:m.windowStart}),...(m.carryOnly===undefined?{}:{carryOnly:m.carryOnly}),...(m.unavailable===undefined?{}:{unavailable:m.unavailable})}];
	if(next.lists.run?.present)values.push({kind:"mailbox-run",account:next.account,before:m["run.before"],backlog:m["run.backlog"],...(m["run.share"]===undefined?{}:{share:m["run.share"]}),...(m["run.full"]===undefined?{}:{full:m["run.full"]})});
	for(const list of LISTS)values.push({kind:"partial-list",account:next.account,list,...next.lists[list]});
	const encoded=values.map((value,i)=>encoder.encode(JSON.stringify({version:1,scope:next.scope,sequence:next.nextSequence+i,...value})));
	const checked=parseAssemblyInputBatch(encoded,next.sourceId,{sourceId:next.sourceId,scope:next.scope,nextSequence:next.nextSequence,seenKeys:next.seenKeys});
	next.nextSequence=checked.nextSequence;next.seenKeys=checked.seenKeys;return {checkpoint:next,records:checked.records};
}
