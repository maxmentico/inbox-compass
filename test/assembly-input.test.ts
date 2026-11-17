import { afterEach, describe, expect, it, vi } from "vitest";
import { ASSEMBLY_INPUT_LIMITS, parseAssemblyInputBatch } from "../src/assembly-input";
import { _clearAccessTokenCache } from "../src/accounts";
import { collect, prepareAssembly, runContext } from "../src/digest";
import { fakeAi, fakeGmail } from "./fakes";
import { fullMessage, linkAccount, makeEnv, MESSAGE_TIME } from "./helpers";

const scope = "a".repeat(22);
const sourceId = "b".repeat(64);
const encode = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
const account = (sequence = 0) => ({ version: 1, scope, sequence, kind: "account", alias: "mail", email: "mail@example.com", identityVersion: "c".repeat(22) });
const item = (sequence = 1) => ({ version: 1, scope, sequence, kind: "item", collection: "partial", key: "mail:m1", account: "mail", accountEmail: "mail@example.com", messageId: "m1", threadId: "t1", from: "Sender <sender@example.com>", subject: "Invoice", snippet: "Invoice attached", summary: "Invoice", action: "Review invoice", date: "2026-10-24T06:00:00Z", classified: true, done: false, needsAction: true, urgency: "medium", category: "payment", due: null });
const expected = () => ({ sourceId, scope, nextSequence: 0, seenKeys: new Set<string>() });
afterEach(() => { _clearAccessTokenCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe("bounded assembly input records", () => {
	it("accepts ordered versioned records, supports resume, and does not mutate the checkpoint", () => {
		const checkpoint = expected();
		const first = parseAssemblyInputBatch([encode(account())], sourceId, checkpoint);
		expect(checkpoint.seenKeys.size).toBe(0);
		expect(first.nextSequence).toBe(1);
		const second = parseAssemblyInputBatch([encode(item())], sourceId, { ...checkpoint, nextSequence: first.nextSequence, seenKeys: first.seenKeys });
		expect(second.nextSequence).toBe(2);
		expect([...second.seenKeys]).toEqual(["account:mail", "item:partial:mail:m1"]);
	});

	it("rejects credential fields, unredacted security codes, malformed UTF-8, and unknown schema", () => {
		const sentinel = "secret-credential-sentinel";
		expect(() => parseAssemblyInputBatch([encode({ ...account(), sealedRefreshToken: sentinel })], sourceId, expected())).toThrow(/record/);
		expect(() => parseAssemblyInputBatch([encode({ ...item(0), subject: "Your sign-in code is 482913", snippet: "Use 482913" })], sourceId, expected())).toThrow(/Unredacted/);
		expect(() => parseAssemblyInputBatch([new Uint8Array([0xff])], sourceId, expected())).toThrow(/JSON/);
		expect(() => parseAssemblyInputBatch([encode({ ...account(), version: 2 })], sourceId, expected())).toThrow(/record/);
	});

	it("rejects source or generation mismatch, skipped sequence, and duplicate keys across pages", () => {
		expect(() => parseAssemblyInputBatch([encode(account())], "c".repeat(64), expected())).toThrow(/checkpoint/);
		expect(() => parseAssemblyInputBatch([encode({ ...account(), scope: "d".repeat(22) })], sourceId, expected())).toThrow(/record/);
		expect(() => parseAssemblyInputBatch([encode(account(1))], sourceId, expected())).toThrow(/sequence/);
		const first = parseAssemblyInputBatch([encode(account())], sourceId, expected());
		expect(() => parseAssemblyInputBatch([encode(account(1))], sourceId, { ...expected(), nextSequence: 1, seenKeys: first.seenKeys })).toThrow(/Duplicate/);
	});

	it("rejects oversized records, batches and checkpoints before decoding", () => {
		expect(() => parseAssemblyInputBatch([new Uint8Array(ASSEMBLY_INPUT_LIMITS.recordBytes + 1)], sourceId, expected())).toThrow(/size/);
		expect(() => parseAssemblyInputBatch(Array.from({ length: ASSEMBLY_INPUT_LIMITS.batchRecords + 1 }, () => encode(account())), sourceId, expected())).toThrow(/limits/);
		const tooMany = new Set(Array.from({ length: ASSEMBLY_INPUT_LIMITS.records + 1 }, (_, i) => String(i)));
		expect(() => parseAssemblyInputBatch([], sourceId, { ...expected(), seenKeys: tooMany })).toThrow(/checkpoint/);
	});

	it("round trips actual synthetic item, cache, history, recheck, cursor and settings data", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mail");
		vi.stubGlobal("fetch", vi.fn(fakeGmail({ mail: [fullMessage("m1", { subject: "Invoice", ms: MESSAGE_TIME })] }).impl));
		const ctx = await runContext(env, {}, new Date("2026-10-24T06:30:00Z"), false);
		const partials = await collect(env, ctx, ctx.accounts);
		const prepared = await prepareAssembly(env, ctx, partials, { doneKeys: new Set() });
		const p = partials[0]!;
		const rows: Record<string, unknown>[] = [
			{ kind: "item", collection: "digest", ...prepared.digest.items[0] },
			{ kind: "cache", account: "mail", messageId: "m1", value: p.toCache[0]![1] },
			{ kind: "history", account: "mail", list: "learned", value: p.learned[0] },
			{ kind: "recheck", account: "mail", list: "before", messageId: "old", added: MESSAGE_TIME },
			{ kind: "cursor", account: "mail", value: p.run!.before },
			{ kind: "settings", revision: "d".repeat(22), deadlineDays: ctx.settings.deadlineDays },
			{ kind: "sender-rule", list: "important", rule: "person@example.com" },
			{ kind: "failure", account: "mail", messageId: "bad", firstFailed: MESSAGE_TIME },
			{ kind: "run-info", runId: prepared.digest.id, now: ctx.now.toISOString(), date: ctx.date, test: ctx.test, window: ctx.window, config: ctx.cfg, share: ctx.share, fullShare: ctx.fullShare, previous: null },
			{ kind: "mailbox-partial", account: "mail", status: p.status, estimated: p.estimated, fromHistory: p.fromHistory },
			{ kind: "mailbox-run", account: "mail", before: p.run!.before, backlog: p.run!.backlog },
			{ kind: "seen-times", account: "mail", chunk: 0, values: p.run!.seenTimes },
			{ kind: "item-flag", list: "ticked", key: "mail:m1" },
			{ kind: "state-head", lastRun: null },
			{ kind: "run-index", runId: prepared.digest.id },
			{ kind: "run-error", index: 0, error: "AI unavailable" },
			{ kind: "job-result-info", jobId: scope, digestId: prepared.digest.id, driver: "web", test: false, started: MESSAGE_TIME, finished: MESSAGE_TIME + 1000 },
			{ kind: "job-row", alias: "mail", state: "done", summary: { fresh: 1, toAction: 1, estimated: 0 } },
		];
		const records = rows.map((row, sequence) => ({ version: 1, scope, sequence, ...row }));
		const first = parseAssemblyInputBatch(records.slice(0, 16).map(encode), sourceId, expected());
		const second = parseAssemblyInputBatch(records.slice(16).map(encode), sourceId, { ...expected(), nextSequence: first.nextSequence, seenKeys: first.seenKeys });
		expect([...first.records, ...second.records]).toEqual(records);
	});
});
