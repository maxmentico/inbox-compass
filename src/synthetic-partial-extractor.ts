// SYNTHETIC/UNWIRED. Extracts bounded subrecords from authenticated tokenizer events; it is not a
// MailboxPartial validator, DTO mapper or publication path. The caller must verify source chunks,
// persist event progress atomically, redact before storage and reject missing/extra fields later.
import type { JsonEvent } from "./synthetic-stream-json";

const SOURCE = /^[a-f0-9]{64}$/;
const SCOPE = /^[A-Za-z0-9_-]{22,128}$/;
export const PARTIAL_EXTRACT_LIMITS = { events: 512, records: 16, recordBytes: 16 * 1024, depth: 64 } as const;
type Frame = { kind: "object" | "array"; path: string[]; index: number; key: string | null };
type Container = Record<string, unknown> | unknown[];
// Children are attached only when closed. Each frame owns its value, so the checkpoint survives
// serialization without relying on object-reference identity between root and stack frames.
type Capture = { path: string[]; frames: { value: Container; key: string | null }[]; bytes: number };
export interface PartialExtractCheckpoint { sourceId: string; scope: string; nextEvent: number; stack: Frame[]; capture: Capture | null; rootSeen: boolean; rootDone: boolean }
export interface ExtractedSubrecord { path: string[]; value: unknown }
const patterns = [
	["alias"], ["status"], ["unavailable"], ["windowStart"], ["estimated"], ["fromHistory"], ["carryOnly"],
	["run", "before"], ["run", "backlog"], ["run", "share"], ["run", "full"],
	["items", "*"], ["toCache", "*"], ["learned", "*"], ["history", "*"],
	["recheck", "before", "*"], ["recheck", "settled", "*"], ["recheck", "estimated", "*"],
	["run", "seenTimes", "*"], ["surfaced", "*"], ["replacedCarried", "*"], ["errors", "*"],
];
const markers = [["items"],["toCache"],["learned"],["history"],["recheck"],["recheck","before"],["recheck","settled"],["recheck","estimated"],["run"],["run","seenTimes"],["surfaced"],["replacedCarried"],["errors"]];
const rootFields=new Set(["alias","status","items","toCache","run","recheck","learned","history","windowStart","surfaced","replacedCarried","unavailable","errors","estimated","fromHistory","carryOnly"]);
const nestedFields:Record<string,ReadonlySet<string>>={run:new Set(["before","seenTimes","backlog","share","full"]),recheck:new Set(["before","settled","estimated"])};
const match = (path: string[]) => patterns.some((p) => p.length === path.length && p.every((x, i) => x === "*" ? /^\d+$/.test(path[i]!) : x === path[i]));
const isMarker = (path: string[]) => markers.some((p) => p.length === path.length && p.every((x,i)=>x===path[i]));
const encoder = new TextEncoder();

export function startPartialExtraction(sourceId: string, scope: string): PartialExtractCheckpoint {
	if (!SOURCE.test(sourceId) || !SCOPE.test(scope)) throw new Error("Invalid extraction identity");
	return { sourceId, scope, nextEvent: 0, stack: [], capture: null, rootSeen: false, rootDone: false };
}
function nextPath(s: PartialExtractCheckpoint): string[] {
	const parent = s.stack.at(-1);
	if (!parent) { if (s.rootSeen) throw new Error("Multiple JSON roots"); return []; }
	if (parent.kind === "array") return [...parent.path, String(parent.index)];
	if (parent.key === null) throw new Error("Missing object key");
	return [...parent.path, parent.key];
}
function consumeSlot(s: PartialExtractCheckpoint): void {
	const parent = s.stack.at(-1);
	if (!parent) { s.rootSeen = true; return; }
	if (parent.kind === "array") parent.index++;
	else { if (parent.key === null) throw new Error("Missing object key"); parent.key = null; }
}
function attach(frame: Capture["frames"][number], value: unknown): void {
	if (Array.isArray(frame.value)) frame.value.push(value);
	else {
		if (frame.key === null) throw new Error("Missing captured key");
		Object.defineProperty(frame.value, frame.key, { value, enumerable: true, writable: true, configurable: true });
		frame.key = null;
	}
}
function accountCapture(c: Capture, event: JsonEvent): void {
	c.bytes += encoder.encode(JSON.stringify(event)).byteLength;
	if (c.bytes > PARTIAL_EXTRACT_LIMITS.recordBytes) throw new Error("Partial subrecord exceeds limit");
}

/** Consume a bounded, ordered event page. Unconsumed events must be replayed with the new index. */
export function extractPartialEvents(checkpoint: PartialExtractCheckpoint, sourceId: string, scope: string, expectedEvent: number, events: readonly JsonEvent[]): { checkpoint: PartialExtractCheckpoint; records: ExtractedSubrecord[]; consumed: number } {
	if (!checkpoint || checkpoint.sourceId !== sourceId || checkpoint.scope !== scope || !SOURCE.test(sourceId) || !SCOPE.test(scope) || checkpoint.nextEvent !== expectedEvent || !Array.isArray(events) || events.length > PARTIAL_EXTRACT_LIMITS.events) throw new Error("Invalid extraction checkpoint");
	const s = structuredClone(checkpoint), records: ExtractedSubrecord[] = [];
	let consumed = 0;
	for (const event of events) {
		if (records.length >= PARTIAL_EXTRACT_LIMITS.records) break;
		if (!event || typeof event !== "object") throw new Error("Invalid JSON event");
		if (s.capture) accountCapture(s.capture, event);
		if (event.type === "key") {
			const top = s.stack.at(-1);
			if (!top || top.kind !== "object" || top.key !== null || typeof event.value !== "string") throw new Error("Invalid extraction key");
			if ((top.path.length===0&&!rootFields.has(event.value))||(top.path.length===1&&nestedFields[top.path[0]!]&&!nestedFields[top.path[0]!]!.has(event.value))) throw new Error("Unsupported partial field");
			top.key = event.value;
			if (s.capture) { const c = s.capture.frames.at(-1)!; if (Array.isArray(c.value) || c.key !== null) throw new Error("Invalid captured key"); c.key = event.value; }
		} else if (event.type === "object-start" || event.type === "array-start") {
			if (s.stack.length >= PARTIAL_EXTRACT_LIMITS.depth) throw new Error("Partial extraction exceeds depth");
			const path = nextPath(s), selected = match(path), value: Container = event.type === "object-start" ? {} : [];
			if (isMarker(path)) {
				const objectExpected = path.join(".") === "run" || path.join(".") === "recheck";
				if ((event.type === "object-start") !== objectExpected) throw new Error("Invalid partial collection type");
				records.push({ path, value: { present: true } });
			}
			if (s.capture) s.capture.frames.push({ value, key: null });
			else if (selected) { s.capture = { path, frames: [{ value, key: null }], bytes: encoder.encode(JSON.stringify(event)).byteLength }; }
			consumeSlot(s);
			s.stack.push({ kind: event.type === "object-start" ? "object" : "array", path, index: 0, key: null });
		} else if (event.type === "object-end" || event.type === "array-end") {
			const top = s.stack.pop();
			if (!top || top.kind !== (event.type === "object-end" ? "object" : "array") || top.key !== null) throw new Error("Invalid extraction end");
			if (s.capture) {
				const frame = s.capture.frames.pop();
				if (!frame || frame.key !== null) throw new Error("Invalid captured end");
				if (!s.capture.frames.length) { records.push({ path: s.capture.path, value: frame.value }); s.capture = null; }
				else attach(s.capture.frames.at(-1)!, frame.value);
			}
			if (!s.stack.length) s.rootDone = true;
		} else if (event.type === "value") {
			const path = nextPath(s);
			if (isMarker(path)) throw new Error("Invalid partial collection type");
			if (s.capture) attach(s.capture.frames.at(-1)!, event.value);
			else if (match(path)) {
				if (encoder.encode(JSON.stringify(event)).byteLength > PARTIAL_EXTRACT_LIMITS.recordBytes) throw new Error("Partial subrecord exceeds limit");
				records.push({ path, value: event.value });
			}
			consumeSlot(s); if (!s.stack.length) s.rootDone = true;
		} else throw new Error("Invalid JSON event");
		consumed++; s.nextEvent++;
	}
	return { checkpoint: s, records, consumed };
}

export function finishPartialExtraction(checkpoint: PartialExtractCheckpoint, sourceId: string, scope: string): void {
	if (!checkpoint || checkpoint.sourceId !== sourceId || checkpoint.scope !== scope || !checkpoint.rootDone || checkpoint.stack.length || checkpoint.capture) throw new Error("Incomplete partial extraction");
}
