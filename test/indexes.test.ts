import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _clearAccessTokenCache, getAccount, listAccounts, removeAccount } from "../src/accounts";
import { type Digest, latestRealRun, listDigests, reconcileRunsIndex, runDigest, saveDigest } from "../src/digest";
import { createSessionCookie, readSession } from "../src/session";
import { app, scheduledRun } from "../src/web";
import { linkAccount, makeEnv } from "./helpers";

const ORIGIN = "https://inbox-digest.me.workers.dev";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type TestEnv = ReturnType<typeof makeEnv>;

async function signedIn(env: TestEnv) {
	const set = await createSessionCookie(env, { sub: "owner-sub", email: env.OWNER_EMAIL });
	const cookie = set.split(";")[0]!;
	await readSession(new Request(ORIGIN, { headers: { Cookie: cookie } }), env);
	return cookie;
}
const page = async (env: TestEnv, cookie: string, path = "/app") =>
	(await app.fetch(new Request(ORIGIN + path, { headers: { Cookie: cookie } }), env, ctx)).text();

/**
 * KV lists that lag like Workers KV's (eventually consistent, up to a minute): from now on they only
 * see the keys that existed at this point. Returns how many list calls were made since.
 */
function staleLists(env: TestEnv): { count: number } {
	const kv = env.MAILBOX_KV;
	const frozen = new Set(kv.store.keys());
	const real = kv.list.bind(kv);
	const calls = { count: 0 };
	kv.list = (async (opts?: KVNamespaceListOptions) => {
		calls.count++;
		const res = await real(opts);
		return { ...res, keys: res.keys.filter((k) => frozen.has(k.name)) };
	}) as typeof kv.list;
	return calls;
}

/** Gets of these keys return the given (stale) values, as another location's cache might. */
function staleGets(env: TestEnv, values: Record<string, string>): () => void {
	const kv = env.MAILBOX_KV;
	const real = kv.get.bind(kv);
	kv.get = (async (key: string | string[], type?: unknown) => {
		if (typeof key === "string" && key in values) return type === "json" ? JSON.parse(values[key]!) : values[key];
		return (real as (k: unknown, t: unknown) => Promise<unknown>)(key, type);
	}) as typeof kv.get;
	return () => {
		kv.get = real;
	};
}

const run = (id: string) => ({ id, date: id.slice(0, 10), generatedAt: id.slice(0, 20), model: "", query: "", items: [], accounts: [], modelErrors: [] }) as Digest;

describe("indexes instead of KV lists", () => {
	const fetchMock = vi.fn<typeof fetch>();
	beforeEach(() => {
		_clearAccessTokenCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("a just-linked mailbox shows at once on the page and in a run, though KV lists lag", async () => {
		const env = makeEnv();
		await linkAccount(env, "personal");
		const cookie = await signedIn(env);
		staleLists(env);
		await linkAccount(env, "work");
		expect(await page(env, cookie)).toContain("work@example.com");
		fetchMock.mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "at", expires_in: 3599 });
			if (url.includes("/messages?")) return Response.json({ messages: [] });
			throw new Error(`unexpected ${url}`);
		});
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.accounts.map((a) => a.alias)).toEqual(["personal", "work"]);
	});

	it("unlinking takes the mailbox off the index", async () => {
		const env = makeEnv();
		await linkAccount(env, "personal");
		await linkAccount(env, "work");
		fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
		await removeAccount(env, (await getAccount(env.MAILBOX_KV, "work"))!);
		staleLists(env);
		expect((await listAccounts(env.MAILBOX_KV)).map((a) => a.alias)).toEqual(["personal"]);
		expect(JSON.parse(env.MAILBOX_KV.store.get("accounts-index")!)).toEqual(["personal"]);
	});

	it("an existing deployment without the index is seeded from one list, once", async () => {
		const env = makeEnv();
		await linkAccount(env, "personal");
		await linkAccount(env, "work");
		env.MAILBOX_KV.store.delete("accounts-index");
		const lists = staleLists(env);
		expect((await listAccounts(env.MAILBOX_KV)).map((a) => a.alias)).toEqual(["personal", "work"]);
		expect(JSON.parse(env.MAILBOX_KV.store.get("accounts-index")!)).toEqual(["personal", "work"]);
		await listAccounts(env.MAILBOX_KV);
		expect(lists.count).toBe(1);
	});

	it("runs are found through their index, seeded once from a list, and expired ones are dropped", async () => {
		const env = makeEnv();
		const digest = (id: string) => ({ id, date: id.slice(0, 10), generatedAt: id.slice(0, 20), model: "", query: "", items: [], accounts: [], modelErrors: [] }) as Digest;
		// From before the index: stored directly.
		await env.MAILBOX_KV.put("digest:2026-08-01T06:30:00Z", JSON.stringify(digest("2026-08-01T06:30:00Z")));
		await env.MAILBOX_KV.put("last-run", "2026-08-01T06:30:00Z");
		const lists = staleLists(env);
		expect(await listDigests(env.MAILBOX_KV)).toEqual(["2026-08-01T06:30:00Z"]);
		expect(lists.count).toBe(1);
		// Saved since: in the index at once, though lists lag.
		await saveDigest(env.MAILBOX_KV, digest("2026-09-15T06:30:00Z-test"));
		await saveDigest(env.MAILBOX_KV, digest("2026-09-20T06:30:00Z"));
		expect(await listDigests(env.MAILBOX_KV)).toEqual(["2026-09-20T06:30:00Z", "2026-09-15T06:30:00Z-test", "2026-08-01T06:30:00Z"]);
		// last-run still points at a live run.
		expect(await latestRealRun(env.MAILBOX_KV)).toBe("2026-08-01T06:30:00Z");
		// 60 days after 1 Aug, its digest has expired (and KV has deleted it): the next save drops it from
		// the index, and last-run, pointing at it, no longer counts.
		env.MAILBOX_KV.store.delete("digest:2026-08-01T06:30:00Z");
		await saveDigest(env.MAILBOX_KV, digest("2026-10-01T06:30:00Z"));
		expect(await listDigests(env.MAILBOX_KV)).toEqual(["2026-10-01T06:30:00Z", "2026-09-20T06:30:00Z", "2026-09-15T06:30:00Z-test"]);
		expect(await latestRealRun(env.MAILBOX_KV)).toBe("2026-10-01T06:30:00Z");
		expect(lists.count).toBe(1);
	});

	it("the digest page makes no KV list calls once the indexes exist", async () => {
		const env = makeEnv();
		await linkAccount(env, "personal");
		await saveDigest(env.MAILBOX_KV, { id: "2026-10-24T06:30:00Z", date: "2026-10-24", generatedAt: "2026-10-24T06:30:00Z", model: "", query: "", items: [], accounts: [], modelErrors: [] });
		const cookie = await signedIn(env);
		const lists = staleLists(env);
		await page(env, cookie);
		await page(env, cookie, "/app?run=2026-10-24T06%3A30%3A00Z");
		await page(env, cookie, "/app/settings");
		expect(lists.count).toBe(0);
	});

	it("a save made from a stale index can't lose the latest real run: last-run is trusted, and merged back in", async () => {
		const env = makeEnv();
		const kv = env.MAILBOX_KV;
		await saveDigest(kv, run("2026-10-20T06:30:00Z"));
		await saveDigest(kv, run("2026-10-24T06:30:00Z"));
		await kv.put("last-run", "2026-10-24T06:30:00Z");
		// A test run elsewhere reads the index as it was before the 24th's run, then saves.
		const fresh = staleGets(env, { "runs-index": JSON.stringify(["2026-10-20T06:30:00Z"]) });
		await saveDigest(kv, run("2026-10-24T07:00:00Z-test"));
		fresh();
		expect(await latestRealRun(kv)).toBe("2026-10-24T06:30:00Z");
		expect(await listDigests(kv)).toEqual(["2026-10-24T07:00:00Z-test", "2026-10-24T06:30:00Z", "2026-10-20T06:30:00Z"]);

		// Worse: that location's last-run is stale too, so the merge can't save the 24th's run. The index
		// loses it (until the daily reconcile), but the latest real run is still the 24th's: last-run, read
		// fresh, is trusted while its digest exists.
		const stale = staleGets(env, { "runs-index": JSON.stringify(["2026-10-20T06:30:00Z"]), "last-run": "2026-10-20T06:30:00Z" });
		await saveDigest(kv, run("2026-10-24T08:00:00Z-test"));
		stale();
		expect(await listDigests(kv)).not.toContain("2026-10-24T06:30:00Z");
		expect(await latestRealRun(kv)).toBe("2026-10-24T06:30:00Z");
	});

	it("the morning run reconciles both indexes: puts back a lost run and a lost mailbox, drops a gone run, and logs it", async () => {
		// Pinned, so the fixtures' dates stay inside the digests' 60 days.
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date("2026-10-25T06:30:00Z"));
		const env = makeEnv();
		const kv = env.MAILBOX_KV;
		await linkAccount(env, "work");
		await saveDigest(kv, run("2026-10-20T06:30:00Z"));
		// Races lost both from their indexes; the index also holds a run whose digest is gone.
		await kv.put("accounts-index", JSON.stringify([]));
		await kv.put("runs-index", JSON.stringify(["2026-10-21T06:30:00Z"]));
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		await scheduledRun(env);
		expect(JSON.parse(kv.store.get("accounts-index")!)).toEqual(["work"]);
		const runs = JSON.parse(kv.store.get("runs-index")!);
		expect(runs).toContain("2026-10-20T06:30:00Z");
		expect(runs).not.toContain("2026-10-21T06:30:00Z");
		const line = logs.mock.calls.map((c) => String(c[0])).find((l) => l.startsWith('{"evt":"reconcile"'));
		expect(JSON.parse(line!)).toEqual({ evt: "reconcile", accountsAdded: ["work"], runsAdded: 1, runsRemoved: 1 });
	});

	it("keeps a same-second test digest readable by URL if a stale index misses it, then restores the listing", async () => {
		const env = makeEnv();
		const kv = env.MAILBOX_KV;
		const at = "2026-10-24T06:30:00Z";
		const a = `${at}-${"A".repeat(22)}-test`;
		const b = `${at}-${"B".repeat(22)}-test`;
		const testRun = (id: string, amount: number): Digest => ({ ...run(id), test: true, window: { kind: "days", amount } });
		await saveDigest(kv, testRun(a, 2));
		// A second finalizer reads an index cached before the first digest was added.
		const fresh = staleGets(env, { "runs-index": "[]" });
		await saveDigest(kv, testRun(b, 3));
		fresh();
		expect(await listDigests(kv)).toEqual([b]);
		const html = await page(env, await signedIn(env), `/app?run=${encodeURIComponent(a)}`);
		expect(html).toContain("Test run: last 2 days");
		expect(await reconcileRunsIndex(kv, new Date(at))).toEqual({ added: 1, removed: 0 });
		expect(await listDigests(kv)).toEqual([b, a]);
	});

	it("test runs can't push real runs out of the index", async () => {
		const env = makeEnv();
		await saveDigest(env.MAILBOX_KV, run("2026-09-01T06:30:00Z"));
		// More test runs than the old shared cap of 200.
		for (let i = 0; i < 210; i++) await saveDigest(env.MAILBOX_KV, run(`2026-10-24T${String(6 + Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}:00Z-test`));
		const ids = JSON.parse(env.MAILBOX_KV.store.get("runs-index")!) as string[];
		expect(ids).toContain("2026-09-01T06:30:00Z");
		expect(ids.filter((id) => id.endsWith("-test"))).toHaveLength(30);
		expect(await latestRealRun(env.MAILBOX_KV)).toBe("2026-09-01T06:30:00Z");
	});
});
