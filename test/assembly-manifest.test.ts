import { afterEach, describe, expect, it, vi } from "vitest";
import { _clearAccessTokenCache } from "../src/accounts";
import { ASSEMBLY_MANIFEST_LIMITS, assemble, buildAssemblyManifest, collect, prepareAssembly, runContext, type AssemblyStateSnapshot } from "../src/digest";
import { planStep, readResult, startJob } from "../src/jobs";
import { fakeAi, fakeGmail } from "./fakes";
import { fullMessage, linkAccount, makeEnv, MESSAGE_TIME } from "./helpers";

afterEach(() => { _clearAccessTokenCache(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture() {
	const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
	await linkAccount(env, "mail");
	vi.stubGlobal("fetch", vi.fn(fakeGmail({ mail: [fullMessage("m1", { subject: "Invoice", ms: MESSAGE_TIME })] }).impl));
	vi.spyOn(console, "log").mockImplementation(() => {});
	const ctx = await runContext(env, {}, new Date("2026-10-24T06:30:00Z"), false);
	const partials = await collect(env, ctx, ctx.accounts);
	const prepared = await prepareAssembly(env, ctx, partials, { doneKeys: new Set() });
	const snapshot: AssemblyStateSnapshot = { lastRun: null, indexedRuns: [], cursors: { mail: null }, failureHolds: { mail: null }, histories: { mail: [] } };
	return { env, ctx, partials, prepared, snapshot };
}

describe("assembly manifest planning", () => {
	it("plans the same persisted values, TTLs and metadata without IO or mutation", async () => {
		const { env, ctx, partials, prepared, snapshot } = await fixture();
		const before = structuredClone({ partials, prepared, snapshot });
		const put = vi.spyOn(env.MAILBOX_KV, "put");
		const get = vi.spyOn(env.MAILBOX_KV, "get");
		const manifest = buildAssemblyManifest(ctx, partials, prepared, snapshot);
		expect(manifest.atomicPublicationRequired).toBe(true);
		expect(manifest.encodedBytes).toBe(new TextEncoder().encode(JSON.stringify(manifest)).byteLength);
		expect(put).not.toHaveBeenCalled();
		expect(get).not.toHaveBeenCalled();
		expect({ partials, prepared, snapshot }).toEqual(before);
		await assemble(env, ctx, partials);
		for (const write of manifest.writes) {
			if (write.kind === "delete") expect(env.MAILBOX_KV.store.has(write.key)).toBe(false);
			else {
				expect(env.MAILBOX_KV.store.get(write.key)).toBe(write.value);
				const call = put.mock.calls.find(([key]) => key === write.key);
				expect(call?.[2]).toEqual(write.expirationTtl === undefined ? undefined : { expirationTtl: write.expirationTtl, ...(write.metadata ? { metadata: write.metadata } : {}) });
			}
		}
	});

	it("does not serialize account or environment credentials into a manifest", async () => {
		const { env, ctx, partials, prepared, snapshot } = await fixture();
		const sentinel = "credential-sentinel-never-in-manifest";
		env.GOOGLE_CLIENT_SECRET = sentinel;
		env.TOKEN_ENCRYPTION_KEY = sentinel;
		ctx.accounts[0]!.sealedRefreshToken = sentinel;
		const manifest = buildAssemblyManifest(ctx, partials, prepared, snapshot);
		expect(JSON.stringify(manifest)).not.toContain(sentinel);
		expect(JSON.stringify(manifest)).not.toContain("sealedRefreshToken");
	});

	it("fails closed when required snapshot records are missing", async () => {
		const { ctx, partials, prepared, snapshot } = await fixture();
		expect(() => buildAssemblyManifest(ctx, partials, prepared, { ...snapshot, cursors: {} })).toThrow(/cursor snapshot/);
		expect(() => buildAssemblyManifest(ctx, partials, prepared, { ...snapshot, histories: {} })).toThrow(/history snapshot/);
		const failed = structuredClone(prepared);
		failed.digest.items[0]!.classified = false;
		expect(() => buildAssemblyManifest(ctx, partials, failed, { ...snapshot, failureHolds: {} })).toThrow(/failure snapshot/);
		expect(() => buildAssemblyManifest(ctx, partials, prepared, { ...snapshot, lastRun: undefined } as unknown as AssemblyStateSnapshot)).toThrow(/Incomplete/);
	});

	it("demonstrates why an empty versus missing history needs an explicit record", async () => {
		const { env, ctx, partials, snapshot } = await fixture();
		const withoutHistory = structuredClone(partials);
		withoutHistory[0]!.learned = [];
		delete withoutHistory[0]!.history;
		const emptyHistory = structuredClone(withoutHistory);
		emptyHistory[0]!.history = [];
		const absent = await prepareAssembly(env, ctx, withoutHistory, { doneKeys: new Set() });
		const present = await prepareAssembly(env, ctx, emptyHistory, { doneKeys: new Set() });
		const a = buildAssemblyManifest(ctx, withoutHistory, absent, snapshot);
		const b = buildAssemblyManifest(ctx, emptyHistory, present, snapshot);
		// The current per-entry DTO has no way to encode an empty history list versus no list.
		expect(a.writes.some((write) => write.key === "history:mail")).toBe(false);
		expect(b.writes.find((write) => write.key === "history:mail")).toMatchObject({ kind: "put", value: "[]" });
	});

	it("includes a re-check list and seen mark in one atomic publication manifest", async () => {
		const { ctx, partials, prepared, snapshot } = await fixture();
		const pending = structuredClone(prepared);
		pending.lists.set("mail", { changed: true, next: [{ id: "m1", added: ctx.now.getTime() }] });
		const result = buildAssemblyManifest(ctx, partials, pending, snapshot);
		expect(result.atomicPublicationRequired).toBe(true);
		expect(result.writes.map((w) => w.key)).toEqual(expect.arrayContaining(["recheck:mail", "cls:mail:m1"]));
	});

	it("requires matching job identity and includes result and done records matching finalization", async () => {
		const env = makeEnv();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const now = new Date();
		const job = await startJob(env, {}, now, "web");
		const ctx = await runContext(env, {}, now, false, job.aliases, job.previous);
		ctx.jobId = job.id;
		const prepared = await prepareAssembly(env, ctx, [], { doneKeys: new Set() });
		const snapshot: AssemblyStateSnapshot = { lastRun: null, indexedRuns: [], cursors: {}, failureHolds: {}, histories: {} };
		expect(() => buildAssemblyManifest(ctx, [], prepared, snapshot)).toThrow(/job result/);
		const plan = await planStep(env, job.id, { now });
		if (plan.kind !== "finish") throw new Error("Expected empty job to finish");
		await plan.work();
		const result = (await readResult(env.MAILBOX_KV, job.id))!;
		expect(() => buildAssemblyManifest(ctx, [], prepared, snapshot, { id: job.id, result: { ...result, digest: "2026-01-01" } })).toThrow(/job result/);
		expect(() => buildAssemblyManifest(ctx, [], prepared, snapshot, { id: job.id, result: { ...result, job: "other" } })).toThrow(/job result/);
		const manifest = buildAssemblyManifest(ctx, [], prepared, snapshot, { id: job.id, result });
		for (const key of [`job-result:${job.id}`, `job-done:${job.id}`]) {
			const write = manifest.writes.find((w) => w.key === key);
			expect(write).toMatchObject({ kind: "put", value: env.MAILBOX_KV.store.get(key), expirationTtl: 60 * 24 * 60 * 60 });
		}
	});

	it("redacts digest secrets and rejects excessive encoded bytes or write counts", async () => {
		const { ctx, partials, prepared, snapshot } = await fixture();
		const modified = structuredClone(prepared);
		modified.digest.items[0]!.subject = "Your verification code is 482913";
		modified.digest.items[0]!.snippet = "Use 482913";
		const result = buildAssemblyManifest(ctx, partials, modified, snapshot);
		const stored = result.writes.find((w) => w.kind === "put" && w.key.startsWith("digest:"));
		expect(JSON.stringify(stored)).not.toContain("482913");
		modified.digest.modelErrors = ["ø".repeat(ASSEMBLY_MANIFEST_LIMITS.bytes)];
		expect(() => buildAssemblyManifest(ctx, partials, modified, snapshot)).toThrow(/exceeds limits/);
		const many = structuredClone(prepared);
		const first = [...many.toCache.values()][0]!;
		many.toCache = new Map(Array.from({ length: ASSEMBLY_MANIFEST_LIMITS.operations }, (_, i) => [`mail:${i}`, first]));
		expect(() => buildAssemblyManifest(ctx, partials, many, snapshot)).toThrow(/exceeds limits/);
	});

	it("accepts the multi-mailbox write volume that exceeded the former 1,000-entry cap", async () => {
		const { ctx, prepared, snapshot } = await fixture();
		const many = structuredClone(prepared);
		const first = [...many.toCache.values()][0]!;
		many.toCache = new Map(Array.from({ length: 1_500 }, (_, i) => [`mail:${i}`, first]));
		const manifest = buildAssemblyManifest(ctx, [], many, snapshot);
		expect(manifest.writes.length).toBeGreaterThan(1_000);
		expect(manifest.writes.length).toBeLessThan(ASSEMBLY_MANIFEST_LIMITS.operations);
	});
});
