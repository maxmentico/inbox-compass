// SYNTHETIC, UNWIRED prerequisite. Does not authenticate input or redact content. Call only with
// bytes already verified against a coordinator-owned immutable snapshot; never log events or state.
// A trusted coordinator must atomically checkpoint the returned state and consume each event once.

export const STREAM_JSON_LIMITS = { bytesPerCall: 16 * 1024, eventsPerCall: 512, tokenBytes: 16 * 1024, depth: 64, keysPerObject: 512, totalBytes: 10 * 1024 * 1024 } as const;
type Frame = { kind: "object"; expect: "key-or-end" | "key" | "colon" | "value" | "comma-or-end"; keys: string[] } | { kind: "array"; expect: "value-or-end" | "value" | "comma-or-end" };
export type JsonEvent = { type: "object-start" | "object-end" | "array-start" | "array-end" } | { type: "key"; value: string } | { type: "value"; value: string | number | boolean | null };
export interface JsonStreamCheckpoint {
	sourceId: string;
	scope: string;
	root: "value" | "end";
	stack: Frame[];
	lex: null | { kind: "string"; raw: string; escaped: boolean; key: boolean } | { kind: "word"; raw: string };
	totalBytes: number;
}
const HASH = /^[a-f0-9]{64}$/;
const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;

export function startSyntheticJsonStream(sourceId: string, scope: string): JsonStreamCheckpoint {
	if (!HASH.test(sourceId) || !TOKEN.test(scope)) throw new Error("Invalid JSON stream identity");
	return { sourceId, scope, root: "value", stack: [], lex: null, totalBytes: 0 };
}
function canValue(s: JsonStreamCheckpoint): boolean {
	const top = s.stack.at(-1);
	return top ? top.kind === "object" ? top.expect === "value" : top.expect === "value" || top.expect === "value-or-end" : s.root === "value";
}
function completeValue(s: JsonStreamCheckpoint): void {
	const top = s.stack.at(-1);
	if (!top) { if (s.root !== "value") throw new Error("Invalid JSON value"); s.root = "end"; return; }
	if (top.kind === "object") { if (top.expect !== "value") throw new Error("Invalid JSON value"); top.expect = "comma-or-end"; }
	else { if (top.expect !== "value" && top.expect !== "value-or-end") throw new Error("Invalid JSON value"); top.expect = "comma-or-end"; }
}
function word(s: JsonStreamCheckpoint): JsonEvent {
	if (!s.lex || s.lex.kind !== "word") throw new Error("Invalid JSON token");
	const raw = s.lex.raw;
	if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(raw)) throw new Error("Invalid JSON scalar");
	const value = JSON.parse(raw) as number | boolean | null;
	if (typeof value === "number" && !Number.isFinite(value)) throw new Error("Invalid JSON number");
	s.lex = null; completeValue(s); return { type: "value", value };
}
function jsonString(raw: string): string {
	try {
		const bytes = Uint8Array.from(raw, (c) => c.charCodeAt(0));
		const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
		if (typeof parsed !== "string") throw new Error();
		return parsed;
	} catch { throw new Error("Invalid JSON string"); }
}

/** Process at most 16 KiB verified bytes and 512 events. `offset` is within the supplied fragment. */
export function pushSyntheticJsonFragment(checkpoint: JsonStreamCheckpoint, sourceId: string, scope: string, fragment: Uint8Array, offset: number, options?: {bytesPerCall:number;eventsPerCall:number}): { checkpoint: JsonStreamCheckpoint; events: JsonEvent[]; nextOffset: number } {
	if (!checkpoint || checkpoint.sourceId !== sourceId || checkpoint.scope !== scope || !HASH.test(sourceId) || !TOKEN.test(scope) || !(fragment instanceof Uint8Array) || fragment.byteLength > 64 * 1024 || !Number.isSafeInteger(offset) || offset < 0 || offset > fragment.byteLength) throw new Error("Invalid JSON stream checkpoint");
	const bytesPerCall=options?.bytesPerCall??STREAM_JSON_LIMITS.bytesPerCall,eventsPerCall=options?.eventsPerCall??STREAM_JSON_LIMITS.eventsPerCall;
	if(!Number.isSafeInteger(bytesPerCall)||bytesPerCall<1||bytesPerCall>65536||!Number.isSafeInteger(eventsPerCall)||eventsPerCall<1||eventsPerCall>2048)throw new Error("Invalid JSON stream budget");
	const s = structuredClone(checkpoint);
	const events: JsonEvent[] = [];
	let i = offset;
	const end = Math.min(fragment.length, offset + bytesPerCall);
	while (i < end && events.length < eventsPerCall) {
		const c = fragment[i]!;
		const consume = () => { i++; if (++s.totalBytes > STREAM_JSON_LIMITS.totalBytes) throw new Error("JSON stream exceeds limit"); };
		if (s.lex?.kind === "string") {
			if (s.lex.raw.length >= STREAM_JSON_LIMITS.tokenBytes) throw new Error("JSON token exceeds limit");
			s.lex.raw += String.fromCharCode(c); consume();
			if (s.lex.escaped) { s.lex.escaped = false; continue; }
			if (c === 92) { s.lex.escaped = true; continue; }
			if (c !== 34) continue;
			const value = jsonString(s.lex.raw), isKey = s.lex.key; s.lex = null;
			if (isKey) {
				const top = s.stack.at(-1);
				if (!top || top.kind !== "object" || (top.expect !== "key" && top.expect !== "key-or-end") || top.keys.includes(value) || top.keys.length >= STREAM_JSON_LIMITS.keysPerObject) throw new Error("Invalid or duplicate JSON key");
				top.keys.push(value); top.expect = "colon"; events.push({ type: "key", value });
			} else { completeValue(s); events.push({ type: "value", value }); }
			continue;
		}
		if (s.lex?.kind === "word") {
			if ([9, 10, 13, 32, 44, 58, 91, 93, 123, 125, 34].includes(c)) { events.push(word(s)); continue; }
			if (s.lex.raw.length >= STREAM_JSON_LIMITS.tokenBytes || c > 127) throw new Error("Invalid JSON scalar");
			s.lex.raw += String.fromCharCode(c); consume(); continue;
		}
		if ([9, 10, 13, 32].includes(c)) { consume(); continue; }
		const top = s.stack.at(-1);
		if (c === 34) {
			const key = !!top && top.kind === "object" && (top.expect === "key" || top.expect === "key-or-end");
			if (!key && !canValue(s)) throw new Error("Invalid JSON string location");
			s.lex = { kind: "string", raw: '"', escaped: false, key }; consume(); continue;
		}
		if (c === 123 || c === 91) {
			if (!canValue(s) || s.stack.length >= STREAM_JSON_LIMITS.depth) throw new Error("Invalid JSON container");
			s.stack.push(c === 123 ? { kind: "object", expect: "key-or-end", keys: [] } : { kind: "array", expect: "value-or-end" });
			events.push({ type: c === 123 ? "object-start" : "array-start" }); consume(); continue;
		}
		if (c === 125 || c === 93) {
			if (!top || (c === 125 && (top.kind !== "object" || (top.expect !== "key-or-end" && top.expect !== "comma-or-end"))) || (c === 93 && (top.kind !== "array" || (top.expect !== "value-or-end" && top.expect !== "comma-or-end")))) throw new Error("Invalid JSON container end");
			s.stack.pop(); completeValue(s); events.push({ type: c === 125 ? "object-end" : "array-end" }); consume(); continue;
		}
		if (c === 58) { if (!top || top.kind !== "object" || top.expect !== "colon") throw new Error("Invalid JSON colon"); top.expect = "value"; consume(); continue; }
		if (c === 44) { if (!top || top.expect !== "comma-or-end") throw new Error("Invalid JSON comma"); top.expect = top.kind === "object" ? "key" : "value"; consume(); continue; }
		if (!canValue(s) || c > 127) throw new Error("Invalid JSON token location");
		s.lex = { kind: "word", raw: String.fromCharCode(c) }; consume();
	}
	return { checkpoint: s, events, nextOffset: i };
}

/** Finish only at the authenticated end of the source; truncated containers and tokens reject. */
export function finishSyntheticJsonStream(checkpoint: JsonStreamCheckpoint, sourceId: string, scope: string): { checkpoint: JsonStreamCheckpoint; events: JsonEvent[] } {
	if (!checkpoint || checkpoint.sourceId !== sourceId || checkpoint.scope !== scope || !HASH.test(sourceId) || !TOKEN.test(scope)) throw new Error("Invalid JSON stream checkpoint");
	const s = structuredClone(checkpoint), events: JsonEvent[] = [];
	if (s.lex?.kind === "string") throw new Error("Truncated JSON string");
	if (s.lex?.kind === "word") events.push(word(s));
	if (s.stack.length || s.root !== "end") throw new Error("Incomplete JSON stream");
	return { checkpoint: s, events };
}
