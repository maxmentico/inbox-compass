// EXPERIMENTAL, not wired to production. These are bounded, credential-free records, not a complete
// representation of assembly state. Only pass bytes returned by the verified snapshot reader.
import { z } from "zod";
import { redactItem, redactMeta, redactSecrets } from "./secrets";
import { ACTION_RULES, REQUESTS, SENDER_TYPES, STAKES } from "./rules";
import { CATEGORIES } from "./llm";

export const ASSEMBLY_INPUT_LIMITS = { recordBytes: 16 * 1024, batchBytes: 128 * 1024, batchRecords: 16, records: 20_000 } as const;
const token = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
const alias = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const id = z.string().regex(/^[A-Za-z0-9_-]{1,256}$/);
const base = { version: z.literal(1), scope: token, sequence: z.number().int().min(0).max(ASSEMBLY_INPUT_LIMITS.records - 1) };
const addressing = z.enum(["only_you", "to_you", "cc_you", "not_named", "bulk"]);
const urgency = z.enum(["high", "medium", "low"]);
const signal = z.object({ sender: z.enum(SENDER_TYPES), request: z.enum(REQUESTS), stakes: z.enum(STAKES), addressing }).strict();
const triage = z.object({ sender: z.enum(SENDER_TYPES), request: z.enum(REQUESTS), stakes: z.enum(STAKES), action: z.string().max(160), category: z.enum(CATEGORIES), due: z.string().max(40).nullable(), summary: z.string().max(220) }).strict();
const meta = z.object({ threadId: id, from: z.string().max(500), subject: z.string().max(500), date: z.string().max(40).nullable(), snippet: z.string().max(1_000), security: z.literal(true).optional() }).strict();
const cursorValue = z.object({ after: z.number().finite().optional(), share: z.number().int().positive().optional(), checked: z.number().finite().optional() }).strict().nullable();
const history = z.object({
	id, address: z.string().max(320), domain: z.string().max(255), name: z.string().max(500), subject: z.string().max(500),
	shape: z.array(z.string().max(120)).max(100), addressing, tab: z.enum(["primary", "social", "promotions", "updates", "forums", ""]),
	important: z.boolean(), starred: z.boolean(), conversation: z.boolean(), attachment: z.boolean(),
	flags: z.array(z.enum(["money", "deadline", "request", "security"])).max(4),
	answers: z.object({ sender: z.enum(SENDER_TYPES), request: z.enum(REQUESTS), stakes: z.enum(STAKES), category: z.enum(CATEGORIES) }).strict(),
	date: z.string().max(40).nullable(),
}).strict();
const schema = z.discriminatedUnion("kind", [
	z.object({ ...base, kind: z.literal("account"), alias, email: z.string().email().max(320), identityVersion: token }).strict(),
	z.object({
		...base, kind: z.literal("item"), collection: z.enum(["partial", "open", "open-if-unticked", "digest"]), key: z.string().max(360), account: alias, accountEmail: z.string().email().max(320), messageId: id, threadId: id,
		from: z.string().max(500), subject: z.string().max(500), snippet: z.string().max(1_000),
		summary: z.string().max(220), action: z.string().max(160), text: z.string().max(3_000).optional(),
		date: z.string().max(40).nullable(), classified: z.boolean(), done: z.boolean(), needsAction: z.boolean(), urgency, category: z.enum(CATEGORIES), due: z.string().max(40).nullable(),
		signals: signal.optional(), security: z.literal(true).optional(), replied: z.boolean().optional(), carried: z.boolean().optional(), covers: z.number().int().nonnegative().optional(), rechecked: z.literal(true).optional(), filed: z.enum(["Promotions", "Social"]).optional(),
		decision: z.object({ outcome: z.enum(["done", "phishing", "replied", "muted", "action", "info", "superseded"]), because: z.array(z.enum(ACTION_RULES)).max(ACTION_RULES.length), urgency }).strict().optional(),
		estimated: z.object({ by: z.enum(["history", "rules"]), reason: z.string().max(1_000), check: z.literal(true).optional() }).strict().optional(),
		textCut: z.enum(["quote", "length"]).optional(), to: z.string().max(500).optional(), cc: z.string().max(500).optional(),
	}).strict(),
	z.object({ ...base, kind: z.literal("cache"), account: alias, messageId: id, value: z.object({
		v: z.number().int().nonnegative(), arrived: z.number().finite().optional(), meta, triage: triage.optional(), addressing: addressing.optional(), estimated: z.literal(true).optional(), mailbox: z.string().max(320).optional(), source: z.enum(["model", "rule"]).optional(), filed: z.enum(["Promotions", "Social"]).optional(), model: z.string().max(256).optional(), classifiedAt: z.string().max(40),
	}).strict() }).strict(),
	z.object({ ...base, kind: z.literal("history"), account: alias, list: z.enum(["before", "learned"]), value: history }).strict(),
	z.object({ ...base, kind: z.literal("recheck"), account: alias, list: z.enum(["before", "settled", "estimated"]), messageId: id, added: z.number().finite().optional() }).strict(),
	z.object({ ...base, kind: z.literal("cursor"), account: alias, value: cursorValue }).strict(),
	z.object({ ...base, kind: z.literal("failure"), account: alias, messageId: id, firstFailed: z.number().finite() }).strict(),
	z.object({ ...base, kind: z.literal("settings"), revision: token, deadlineDays: z.number().int().min(0).max(30) }).strict(),
	z.object({ ...base, kind: z.literal("sender-rule"), list: z.enum(["important", "muted"]), rule: z.string().min(1).max(254) }).strict(),
	z.object({ ...base, kind: z.literal("run-info"), runId: z.string().max(64), now: z.string().max(40), date: z.string().max(10), test: z.boolean(),
		window: z.union([z.object({ kind: z.literal("since") }).strict(), z.object({ kind: z.enum(["hours", "days", "emails"]), amount: z.number().int().positive() }).strict()]),
		config: z.object({ query: z.string().max(4_096), maxPerAccount: z.number().int().positive(), model: z.string().max(256), fallbackModel: z.string().max(256).nullable(), timeZone: z.string().max(100) }).strict(),
		share: z.number().int().positive(), fullShare: z.number().int().positive(), jobId: token.optional(), previous: z.string().max(64).nullable(),
	}).strict(),
	z.object({ ...base, kind: z.literal("mailbox-partial"), account: alias, status: z.object({ alias, email: z.string().max(320), ok: z.boolean(), found: z.number().int().nonnegative(), newlyClassified: z.number().int().nonnegative(), error: z.string().max(1_000).optional(), needsRelink: z.boolean().optional(), truncated: z.boolean().optional(), backlog: z.number().int().nonnegative().optional() }).strict(),
		windowStart: z.number().finite().optional(), carryOnly: z.literal(true).optional(), estimated: z.number().int().nonnegative(), fromHistory: z.number().int().nonnegative(), unavailable: z.object({ reason: z.enum(["quota", "error"]), at: z.string().max(40) }).strict().optional(),
	}).strict(),
	z.object({ ...base, kind: z.literal("mailbox-run"), account: alias, before: cursorValue, backlog: z.boolean(), share: z.number().int().positive().optional(), full: z.number().int().positive().optional() }).strict(),
	z.object({ ...base, kind: z.literal("seen-times"), account: alias, chunk: z.number().int().nonnegative(), values: z.array(z.number().finite()).max(500) }).strict(),
	z.object({ ...base, kind: z.literal("item-flag"), list: z.enum(["done", "ticked", "surfaced", "replaced-carried"]), key: z.string().max(360) }).strict(),
	z.object({ ...base, kind: z.literal("state-head"), lastRun: z.string().max(64).nullable() }).strict(),
	z.object({ ...base, kind: z.literal("run-index"), runId: z.string().max(64) }).strict(),
	z.object({ ...base, kind: z.literal("run-error"), index: z.number().int().nonnegative(), error: z.string().max(1_000) }).strict(),
	z.object({ ...base, kind: z.literal("job-result-info"), jobId: token, digestId: z.string().max(64), driver: z.enum(["web", "cron"]), test: z.boolean(), started: z.number().finite(), finished: z.number().finite() }).strict(),
	z.object({ ...base, kind: z.literal("job-row"), alias, state: z.enum(["todo", "running", "done", "failed"]), summary: z.object({ fresh: z.number().int().nonnegative(), toAction: z.number().int().nonnegative(), estimated: z.number().int().nonnegative() }).strict().optional(), reason: z.string().max(1_000).optional() }).strict(),
	z.object({ ...base, kind: z.literal("partial-list"), account: alias, list: z.enum(["items","toCache","learned","history","recheck","recheck.before","recheck.settled","recheck.estimated","run","run.seenTimes","surfaced","replacedCarried","errors"]), present: z.boolean(), count: z.number().int().nonnegative().max(ASSEMBLY_INPUT_LIMITS.records) }).strict(),
]);

export type AssemblyInputRecord = z.infer<typeof schema>;
export interface AssemblyInputBatch {
	records: AssemblyInputRecord[];
	nextSequence: number;
	seenKeys: Set<string>;
}

/**
 * Validates one bounded page from a previously verified immutable source. The caller must bind the
 * verified source id to its coordinator-owned checkpoint and persist sequence/seenKeys atomically.
 * The two ids here are a consistency check, not cryptographic verification of the supplied bytes.
 */
export function parseAssemblyInputBatch(
	bytes: readonly Uint8Array[],
	verifiedSourceId: string,
	expected: { sourceId: string; scope: string; nextSequence: number; seenKeys: ReadonlySet<string> },
): AssemblyInputBatch {
	if (!/^[a-f0-9]{64}$/.test(expected.sourceId) || verifiedSourceId !== expected.sourceId || !token.safeParse(expected.scope).success || !Number.isSafeInteger(expected.nextSequence) || expected.nextSequence < 0 || expected.nextSequence > ASSEMBLY_INPUT_LIMITS.records || expected.seenKeys.size > ASSEMBLY_INPUT_LIMITS.records) throw new Error("Invalid assembly input checkpoint");
	if (bytes.length > ASSEMBLY_INPUT_LIMITS.batchRecords) throw new Error("Assembly input batch exceeds limits");
	let total = 0;
	const seen = new Set(expected.seenKeys);
	const records: AssemblyInputRecord[] = [];
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	for (const raw of bytes) {
		if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > ASSEMBLY_INPUT_LIMITS.recordBytes) throw new Error("Invalid assembly input record size");
		total += raw.byteLength;
		if (total > ASSEMBLY_INPUT_LIMITS.batchBytes) throw new Error("Assembly input batch exceeds limits");
		let value: unknown;
		try { value = JSON.parse(decoder.decode(raw)); } catch { throw new Error("Invalid assembly input JSON"); }
		const parsed = schema.safeParse(value);
		if (!parsed.success || parsed.data.scope !== expected.scope || parsed.data.sequence !== expected.nextSequence + records.length) throw new Error("Invalid assembly input record or sequence");
		// Schemas validate without transforming. Preserve the source's field order: the reference
		// manifest hashes JSON bytes, and Zod's parsed object uses schema order instead.
		const record = value as AssemblyInputRecord;
		const key = record.kind === "account" || record.kind === "job-row" ? `${record.kind}:${record.alias}` : record.kind === "item" ? `item:${record.collection}:${record.account}:${record.messageId}` : record.kind === "cache" || record.kind === "failure" ? `${record.kind}:${record.account}:${record.messageId}` : record.kind === "cursor" || record.kind === "mailbox-partial" || record.kind === "mailbox-run" ? `${record.kind}:${record.account}` : record.kind === "partial-list" ? `partial-list:${record.account}:${record.list}` : record.kind === "seen-times" ? `seen-times:${record.account}:${record.chunk}` : record.kind === "history" ? `history:${record.account}:${record.list}:${record.value.id}` : record.kind === "recheck" ? `recheck:${record.account}:${record.list}:${record.messageId}` : record.kind === "sender-rule" ? `sender-rule:${record.list}:${record.rule}` : record.kind === "item-flag" ? `item-flag:${record.list}:${record.key}` : record.kind === "run-index" ? `run-index:${record.runId}` : record.kind === "run-error" ? `run-error:${record.index}` : record.kind;
		if (seen.has(key)) throw new Error("Duplicate assembly input record");
		if (record.kind === "item") {
			if (record.key !== `${record.account}:${record.messageId}`) throw new Error("Invalid assembly input item key");
			const redacted = redactItem(record);
			if (redacted.subject !== record.subject || redacted.snippet !== record.snippet || redacted.summary !== record.summary || redacted.action !== record.action || redacted.text !== record.text || redacted.estimated?.reason !== record.estimated?.reason) throw new Error("Unredacted assembly input item");
		} else if (record.kind === "cache") {
			const redacted = redactMeta(record.value.meta);
			if (redacted.subject !== record.value.meta.subject || redacted.snippet !== record.value.meta.snippet || (record.value.triage && (redactSecrets(record.value.triage.action, !!redacted.security) !== record.value.triage.action || redactSecrets(record.value.triage.summary, !!redacted.security) !== record.value.triage.summary))) throw new Error("Unredacted assembly input cache");
		} else if (record.kind === "history" && redactSecrets(record.value.subject, false) !== record.value.subject) {
			throw new Error("Unredacted assembly input history");
		} else if (record.kind === "recheck" && ((record.list === "before") !== (record.added !== undefined))) {
			throw new Error("Invalid assembly input recheck");
		} else if (record.kind === "mailbox-partial" && record.status.alias !== record.account) {
			throw new Error("Invalid assembly input mailbox status");
		} else if (record.kind === "partial-list" && !record.present && record.count !== 0) {
			throw new Error("Invalid assembly input list presence");
		}
		seen.add(key);
		if (seen.size > ASSEMBLY_INPUT_LIMITS.records) throw new Error("Assembly input exceeds record limit");
		records.push(record);
	}
	return { records, nextSequence: expected.nextSequence + records.length, seenKeys: seen };
}
