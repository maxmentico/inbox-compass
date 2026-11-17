import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The email binding's module exists only in Workers: a stand-in, so the morning run's email can be checked.
vi.mock("cloudflare:email", () => ({ EmailMessage: class { constructor(readonly from: string, readonly to: string, readonly raw: string) {} } }));
import { _clearAccessTokenCache, getAccount, listAccounts, listAccountsWithChecks, removeAccount } from "../src/accounts";
import { getDigest, runDigest } from "../src/digest";
import { INTERNAL_HOST, type Job, MAX_ATTEMPTS, planStep, RETRY_SHARES, STEP_HEADER, STEP_STALE_MS, startJob, stepSignature } from "../src/jobs";
import { createSessionCookie, readSession } from "../src/session";
import { app, clock, scheduledRun } from "../src/web";
import { fakeAi, fakeGmail } from "./fakes";
import { fullMessage, linkAccount, MESSAGE_TIME, makeEnv } from "./helpers";

const ORIGIN = "https://inbox-digest.me.workers.dev";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type TestEnv = ReturnType<typeof makeEnv>;
const NOW = new Date("2026-10-24T06:30:00Z");

async function sessionFor(env: TestEnv) {
	const set = await createSessionCookie(env, { sub: "owner-sub", email: env.OWNER_EMAIL });
	const cookie = set.split(";")[0]!;
	const session = (await readSession(new Request(ORIGIN, { headers: { Cookie: cookie } }), env))!;
	return { cookie, csrf: session.csrf };
}
const get = (env: TestEnv, path: string, cookie: string) => app.fetch(new Request(ORIGIN + path, { headers: { Cookie: cookie } }), env, ctx);
const post = (env: TestEnv, path: string, fields: [string, string][], cookie: string) =>
	app.fetch(
		new Request(ORIGIN + path, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: ORIGIN }, body: new URLSearchParams(fields) }),
		env,
		ctx,
	);

/** Keys a run writes as state (not job bookkeeping). */
const stateKeys = (env: TestEnv) => [...env.MAILBOX_KV.store.keys()].filter((k) => /^(cls|cursor|history|recheck|last-run|digest):?/.test(k)).sort();

/** Three mailboxes: two with mail, one whose token was revoked. */
async function threeMailboxes(env: TestEnv) {
	await linkAccount(env, "mentico");
	await linkAccount(env, "personal");
	await linkAccount(env, "broken", "rt-broken");
	return fakeGmail({
		mentico: [fullMessage("m1", { subject: "Invoice 42", ms: MESSAGE_TIME + 1_000 }), fullMessage("m2", { subject: "Weekly news", ms: MESSAGE_TIME + 3_000 })],
		personal: [fullMessage("p1", { subject: "Invoice gas", ms: MESSAGE_TIME + 2_000 })],
	});
}

/** The job page's meta refresh target, or null. */
/** Where the page's meta refresh goes (after any delay), or null. */
const nextUrl = (html: string) => /<meta http-equiv="refresh" content="\d+;url=([^"]+)">/.exec(html)?.[1]?.replace(/&amp;/g, "&") ?? null;

describe("runs in steps (jobs)", () => {
	const fetchMock = vi.fn<typeof fetch>();
	let realNow: () => Date;
	beforeEach(() => {
		_clearAccessTokenCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
		realNow = clock.now;
		clock.now = () => NOW;
	});
	afterEach(() => {
		clock.now = realNow;
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("an old cache entry holding a raw sign-in code is masked before its mailbox's part is stored in the job mark", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "482913 is your Acme verification code" })] }).impl);
		// Written before secrets were masked, and before runs had cursors (no arrival time): re-used as is.
		const raw = {
			v: 3,
			meta: { threadId: "t-m1", from: "Acme <no-reply@acme.example>", subject: "482913 is your Acme verification code", date: "2026-10-23T12:00:00.000Z", snippet: "Use 482913" },
			triage: { sender: "automated", request: "routine", stakes: "some", action: "Enter 482913", category: "notification", due: null, summary: "Code 482913 for Acme" },
			addressing: "only_you",
			mailbox: "mentico@example.com",
			classifiedAt: "2026-10-01T00:00:00.000Z",
		};
		await env.MAILBOX_KV.put("cls:mentico:m1", JSON.stringify(raw));
		const job: Job = await startJob(env, {}, NOW, "web");
		const plan = await planStep(env, job.id, { now: NOW });
		expect(plan.kind).toBe("process");
		if (plan.kind === "process") await plan.work();
		const mark = env.MAILBOX_KV.store.get(`job:${job.id}:mentico`)!;
		expect(JSON.parse(mark)).toMatchObject({ state: "done" });
		expect(mark).toContain("verification code");
		expect(mark).not.toContain("482913");
	});

	it("Run now needs the CSRF token, then starts a job that holds the lock, and goes to its page", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		const { cookie, csrf } = await sessionFor(env);
		expect((await post(env, "/app/run", [], cookie)).status).toBe(403);
		const res = await post(env, "/app/run", [["csrf", csrf]], cookie);
		expect(res.status).toBe(303);
		const id = /^\/app\/run\/([A-Za-z0-9_-]{22})$/.exec(res.headers.get("Location")!)![1]!;
		expect(JSON.parse(env.MAILBOX_KV.store.get(`job:${id}`)!)).toMatchObject({ id, run: "2026-10-24T06:30:00Z", test: false, driver: "web" });
		expect(JSON.parse(env.MAILBOX_KV.store.get("run-lock")!)).toMatchObject({ job: id, driver: "web" });
	});

	it("does one mailbox per step; a failing mailbox doesn't stop the rest; state is written only after the digest is stored", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const { cookie, csrf } = await sessionFor(env);
		let url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
		const id = url.split("/").pop()!;
		const pages: string[] = [];
		for (let step = 1; step <= 3; step++) {
			const html = await (await get(env, url, cookie)).text();
			pages.push(html);
			const marks = ["broken", "mentico", "personal"].filter((a) => JSON.parse(env.MAILBOX_KV.store.get(`job:${id}:${a}`) ?? "null")?.state === "done");
			expect(marks).toHaveLength(step);
			// Nothing marked seen, no cursor moved, no digest: the run isn't stored yet. The lock is held.
			expect(stateKeys(env)).toEqual([]);
			expect(JSON.parse(env.MAILBOX_KV.store.get("run-lock")!).job).toBe(id);
			url = nextUrl(html)!;
			expect(url).toBe(`/app/run/${id}`);
		}
		// Mailboxes in alias order: broken failed, then the two others completed.
		expect(pages[0]).toContain('<li class="jrow is-failed">');
		expect(pages[0]).toContain("Needs re-linking");
		expect(pages[2]).toContain("Run now · 3 of 3");
		expect(pages[2]).toContain('<p class="jdet note"><span class="mono">1 new · 1 to action</span></p>');
		expect(pages[1]).toContain('<li class="jrow is-todo"><span class="jmark"></span><div class="jbody"><p class="alias">personal</p><p class="jdet note"><span class="nw">Never checked</span></p></div><span class="jstate">To do</span></li>');
		for (const html of pages) expect(html).not.toContain("<script");

		const last = await (await get(env, url, cookie)).text();
		expect(nextUrl(last)).toBe("/app?run=2026-10-24T06%3A30%3A00Z&ran=1");
		const d = (await getDigest(env.MAILBOX_KV, "2026-10-24T06:30:00Z"))!;
		expect(d.items.map((i) => i.key).sort()).toEqual(["mentico:m1", "mentico:m2", "personal:p1"]);
		expect(d.accounts.find((a) => a.alias === "broken")).toMatchObject({ ok: false, needsRelink: true });
		expect(stateKeys(env)).toEqual(expect.arrayContaining(["cls:mentico:m1", "cls:personal:p1", "cursor:mentico", "cursor:personal", "last-run"]));
		expect(env.MAILBOX_KV.store.has("run-lock")).toBe(false);
		// Visiting the job again shows the finished run, which opens its digest in 10 s.
		expect(nextUrl(await (await get(env, `/app/run/${id}`, cookie)).text())).toBe("/app?run=2026-10-24T06%3A30%3A00Z&ran=1");
	});

	it("assembles the same digest, cache and cursors as a run in one go", async () => {
		const once = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(once)).impl);
		await runDigest(once, { now: NOW });
		_clearAccessTokenCache();

		const stepped = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(stepped)).impl);
		const job = await startJob(stepped, {}, NOW, "web");
		for (let i = 0; i < 4; i++) {
			const plan = await planStep(stepped, job.id, { now: NOW });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
		}
		const a = (await getDigest(once.MAILBOX_KV, "2026-10-24T06:30:00Z"))!;
		const b = (await getDigest(stepped.MAILBOX_KV, "2026-10-24T06:30:00Z"))!;
		// The same, but for the stepped digest's record of the job that made it.
		const byKey = ({ job: _job, ...d }: typeof a) => ({ ...d, items: [...d.items].sort((x, y) => x.key.localeCompare(y.key)) });
		expect(byKey(b)).toEqual(byKey(a));
		const state = (env: TestEnv) =>
			stateKeys(env)
				.filter((k) => k !== "runs-index")
				.map((k) => [k, k.startsWith("cls:") ? JSON.parse(env.MAILBOX_KV.store.get(k)!).triage : k.startsWith("digest:") ? "compared above" : env.MAILBOX_KV.store.get(k)]);
		expect(state(stepped)).toEqual(state(once));
	});

	it("a step that died is retried with smaller shares, then marked failed ('took too long')", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const job = await startJob(env, {}, NOW, "web");
		const mark = (alias: string, attempt: number, startedAt: number) => env.MAILBOX_KV.put(`job:${job.id}:${alias}`, JSON.stringify({ state: "running", attempt, startedAt }));
		// A step for "broken" is under way: others wait.
		await mark("broken", 1, NOW.getTime() - 1_000);
		expect((await planStep(env, job.id, { now: NOW })).kind).toBe("wait");
		// It died: once stale, it's tried again, and again after that.
		const later = new Date(NOW.getTime() + STEP_STALE_MS + 1_000);
		expect(await planStep(env, job.id, { now: later })).toMatchObject({ kind: "process", alias: "broken" });
		await mark("broken", 2, NOW.getTime());
		expect(await planStep(env, job.id, { now: later })).toMatchObject({ kind: "process", alias: "broken" });
		// The smallest share died too: failed, and the job goes on with the next mailbox.
		await mark("broken", RETRY_SHARES.length, NOW.getTime());
		const next = await planStep(env, job.id, { now: later });
		expect(next).toMatchObject({ kind: "process", alias: "mentico" });
		if (next.kind !== "process") throw new Error();
		expect(next.view.rows[0]).toEqual({ alias: "broken", state: "failed", reason: "took too long" });
	});

	it("a retried step takes a much smaller share, so a heavy mailbox drains its backlog oldest first", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: Array.from({ length: 40 }, (_, i) => fullMessage(`m${i}`, { subject: `Weekly ${i}`, ms: MESSAGE_TIME + i * 1_000 })) }).impl);
		const job = await startJob(env, {}, NOW, "web");
		// The first try (the full share of 300) died.
		await env.MAILBOX_KV.put(`job:${job.id}:mentico`, JSON.stringify({ state: "running", attempt: 1, startedAt: NOW.getTime() - STEP_STALE_MS - 1 }));
		for (let i = 0; i < 2; i++) {
			const plan = await planStep(env, job.id, { now: NOW });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
		}
		const d = (await getDigest(env.MAILBOX_KV, job.run))!;
		expect(d.accounts[0]).toMatchObject({ ok: true, found: RETRY_SHARES[1], backlog: 40 - RETRY_SHARES[1] });
		expect(d.items.map((i) => i.messageId).sort()).toEqual(Array.from({ length: 15 }, (_, i) => `m${i}`).sort());
		expect(JSON.parse(env.MAILBOX_KV.store.get("cursor:mentico")!).after).toBe(MESSAGE_TIME + 14_000);
	});

	it("a test job writes no run state, and needs no lock", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const job = await startJob(env, { window: { kind: "days", amount: 2 } }, NOW, "web");
		expect(env.MAILBOX_KV.store.has("run-lock")).toBe(false);
		for (let i = 0; i < 4; i++) {
			const plan = await planStep(env, job.id, { now: NOW });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
		}
		expect(stateKeys(env)).toEqual([`digest:${job.run}`]);
	});

	it("keeps each test job's digest when two start in the same second", async () => {
		const env = makeEnv();
		const jobs = await Promise.all([
			startJob(env, { window: { kind: "days", amount: 1 } }, NOW, "web"),
			startJob(env, { window: { kind: "days", amount: 2 } }, NOW, "web"),
		]);
		expect(jobs[0]!.run).not.toBe(jobs[1]!.run);
		await Promise.all(jobs.map(async (job) => {
			const plan = await planStep(env, job.id, { now: NOW });
			if (plan.kind !== "finish") throw new Error("Expected empty test job to finish");
			await plan.work();
		}));
		for (const job of jobs) {
			expect(await getDigest(env.MAILBOX_KV, job.run)).toMatchObject({ job: job.id, window: job.window });
			expect(await env.MAILBOX_KV.get(`job-done:${job.id}`)).toBe(job.run);
		}
	});

	it("finishes an in-flight legacy test job at its original digest URL", async () => {
		const env = makeEnv();
		const job = await startJob(env, { test: true }, NOW, "web");
		const oldRun = "2026-10-24T06:30:00Z-test";
		await env.MAILBOX_KV.put(`job:${job.id}`, JSON.stringify({ ...job, run: oldRun }));
		const plan = await planStep(env, job.id, { now: NOW });
		if (plan.kind !== "finish") throw new Error("Expected legacy test job to finish");
		await plan.work();
		expect(await getDigest(env.MAILBOX_KV, oldRun)).toMatchObject({ id: oldRun, job: job.id });
		expect(await env.MAILBOX_KV.get(`job-done:${job.id}`)).toBe(oldRun);
	});

	it("rejects a saved job pointing at another test job's digest", async () => {
		const env = makeEnv();
		const a = await startJob(env, { test: true }, NOW, "web");
		const b = await startJob(env, { test: true }, NOW, "web");
		await env.MAILBOX_KV.put(`job:${a.id}`, JSON.stringify({ ...a, run: b.run }));
		const plan = await planStep(env, a.id, { now: NOW });
		if (plan.kind !== "finish") throw new Error("Expected empty job to reach finalization");
		await expect(plan.work()).rejects.toThrow("Digest ID does not match the job");
		expect(await getDigest(env.MAILBOX_KV, b.run)).toBeNull();
	});

	it("an abandoned job: the digest page offers to continue it, and Run now offers the same instead of failing", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const { cookie, csrf } = await sessionFor(env);
		const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
		expect(await (await get(env, "/app", cookie)).text()).toContain(`A run is in progress (started 07:30). <a href="${url}">Continue it</a>`);
		const again = await (await post(env, "/app/run", [["csrf", csrf]], cookie)).text();
		expect(again).toContain("A run is already going");
		expect(again).toContain(`<a class="btn primary" href="${url}">Continue it</a>`);
	});

	it("the internal step route answers only the internal host with the job's HMAC", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		const job = await startJob(env, {}, NOW, "cron");
		const sig = await stepSignature(env, job.id);
		const call = (host: string, headers: Record<string, string>) => app.fetch(new Request(`https://${host}/internal/step/${job.id}`, { method: "POST", headers }), env, ctx);
		expect((await call(INTERNAL_HOST, {})).status).toBe(404);
		expect((await call(INTERNAL_HOST, { [STEP_HEADER]: "0".repeat(64) })).status).toBe(404);
		expect((await call("inbox-digest.me.workers.dev", { [STEP_HEADER]: sig })).status).toBe(404);
		expect(await (await call(INTERNAL_HOST, { [STEP_HEADER]: sig })).json()).toEqual({ state: "finished", digest: job.run });
	});

	it("the morning run steps its job through the SELF binding, one invocation per mailbox, then the digest", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai }) as TestEnv & { SELF: Fetcher };
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const calls: string[] = [];
		env.SELF = {
			fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
				const req = new Request(input, init);
				calls.push(new URL(req.url).pathname);
				return app.fetch(req, env, ctx);
			},
		} as unknown as Fetcher;
		vi.spyOn(console, "log").mockImplementation(() => {});
		await scheduledRun(env);
		expect(calls).toHaveLength(4);
		expect(new Set(calls).size).toBe(1);
		const id = await env.MAILBOX_KV.get("last-run");
		expect((await getDigest(env.MAILBOX_KV, id!))!.items).toHaveLength(3);
		expect(env.MAILBOX_KV.store.has("run-lock")).toBe(false);
	});

	it("each step stays well inside the KV budget, and logs its costs with the job id and step", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: Array.from({ length: 300 }, (_, i) => fullMessage(`m${i}`, { subject: `Weekly ${i}`, ms: MESSAGE_TIME + i })) }).impl);
		const job: Job = await startJob(env, {}, NOW, "web");
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		const ops: number[] = [];
		for (let i = 0; i < 2; i++) {
			const before = env.MAILBOX_KV.ops;
			const plan = await planStep(env, job.id, { now: NOW });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
			ops.push(env.MAILBOX_KV.ops - before);
		}
		// The mailbox step reads; the last step writes the 300 cache entries.
		expect(ops[0]).toBeLessThan(30);
		expect(ops[1]).toBeLessThan(300 + 40);
		const lines = logs.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('{"evt":')).map((l) => JSON.parse(l));
		expect(lines.find((l) => l.evt === "step-end")).toMatchObject({ job: job.id, step: 1, alias: "mentico", ok: true });
		expect(lines.find((l) => l.evt === "run-end")).toMatchObject({ job: job.id, step: 2, ok: true });
	});

	it("each step appends its log lines to the run's log, and its error lines apart only when it has any", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const job: Job = await startJob(env, {}, NOW, "web");
		vi.spyOn(console, "log").mockImplementation(() => {});
		for (let i = 0; i < 4; i++) {
			const plan = await planStep(env, job.id, { now: NOW });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
		}
		const saved = (key: string) => env.MAILBOX_KV.store.get(key)!.split("\n").map((l) => JSON.parse(l));
		// Steps in alias order: broken (failed), mentico, personal; then the digest.
		const log = saved(`runlog:${job.run}`);
		expect(log.every((l) => l.job === job.id)).toBe(true);
		expect(log.filter((l) => l.evt === "step-end" || l.evt === "run-end").map((l) => [l.step, l.evt, l.alias ?? null, l.ok])).toEqual([
			[1, "step-end", "broken", false],
			[2, "step-end", "mentico", true],
			[3, "step-end", "personal", true],
			[4, "run-end", null, true],
		]);
		// Step 1's failure, and the digest's run-end that names the mailbox that failed; nothing from steps 2 and 3.
		const errors = saved(`runerrors:${job.run}`);
		expect(errors.map((l) => l.step)).not.toContain(2);
		expect(errors.map((l) => l.step)).not.toContain(3);
		expect(errors.find((l) => l.evt === "step-end")).toMatchObject({ step: 1, alias: "broken", ok: false });
		expect(errors.at(-1)).toMatchObject({ evt: "run-end", step: 4, mailboxes: expect.arrayContaining([expect.objectContaining({ alias: "broken", ok: false })]) });
		expect(JSON.parse(env.MAILBOX_KV.store.get("runlogs-index")!)).toEqual([job.run]);
	});

	it("a step that throws (here, stopped by another run's lock) still saves its log, with why it stopped", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const job: Job = await startJob(env, {}, NOW, "web");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const plan = await planStep(env, job.id, { now: NOW });
		expect(plan.kind).toBe("process");
		await env.MAILBOX_KV.put("run-lock", JSON.stringify({ at: NOW.toISOString(), job: "another-job" }));
		if (plan.kind === "process") await expect(plan.work()).rejects.toThrow("This run was stopped");
		const errors = env.MAILBOX_KV.store.get(`runerrors:${job.run}`)!.split("\n").map((l) => JSON.parse(l));
		expect(errors).toEqual([expect.objectContaining({ evt: "error", source: "step", code: "stopped", job: job.id, step: 1 })]);
		expect(env.MAILBOX_KV.store.get(`runlog:${job.run}`)).toBe(env.MAILBOX_KV.store.get(`runerrors:${job.run}`));
	});

	it("a mailbox whose steps died keeps its open items and its cursor; the rest of the run goes on", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		const g = await threeMailboxes(env);
		fetchMock.mockImplementation(g.impl);
		await runDigest(env, { now: NOW });
		const cursor = env.MAILBOX_KV.store.get("cursor:mentico");
		// New mail since: a step that worked would report it and move the cursor.
		const later = new Date(NOW.getTime() + 3_600_000);
		fetchMock.mockImplementation(
			fakeGmail({
				mentico: [fullMessage("m1", { subject: "Invoice 42", ms: MESSAGE_TIME + 1_000 }), fullMessage("m3", { subject: "Invoice 43", ms: MESSAGE_TIME + 3_000_000 })],
				personal: [fullMessage("p1", { subject: "Invoice gas", ms: MESSAGE_TIME + 2_000 })],
			}).impl,
		);
		const job = await startJob(env, {}, later, "web");
		// Every try for mentico died.
		await env.MAILBOX_KV.put(`job:${job.id}:mentico`, JSON.stringify({ state: "running", attempt: RETRY_SHARES.length, startedAt: later.getTime() - STEP_STALE_MS - 1 }));
		for (let i = 0; i < 4; i++) {
			const plan = await planStep(env, job.id, { now: later });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
		}
		const d = (await getDigest(env.MAILBOX_KV, job.run))!;
		expect(d.accounts.find((a) => a.alias === "mentico")).toMatchObject({ ok: false, error: "took too long" });
		expect(d.items.find((i) => i.key === "mentico:m1")).toMatchObject({ carried: true, needsAction: true });
		expect(d.items.find((i) => i.key === "mentico:m3")).toBeUndefined();
		expect(env.MAILBOX_KV.store.has("cls:mentico:m3")).toBe(false);
		expect(env.MAILBOX_KV.store.get("cursor:mentico")).toBe(cursor);
	});

	it("the step page shows the list at once, the mailbox being done in progress, with no script", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const { cookie, csrf } = await sessionFor(env);
		const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
		const res = await get(env, url, cookie);
		expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
		const reader = res.body!.getReader();
		const first = new TextDecoder().decode((await reader.read()).value);
		expect(first).toContain("Run now · 0 of 3");
		expect(first).toContain('<li class="jrow is-running"><span class="jmark"></span><div class="jbody"><p class="alias">broken</p><p class="jdet note"><span class="progress" aria-hidden="true"></span><span class="jprog mono" aria-hidden="true"></span></p></div><span class="jstate">In progress</span></li>');
		expect(first).toContain(`If this page stops moving, <a href="${url}">continue</a>.`);
		expect(first).not.toContain("http-equiv");
		expect(first).not.toContain("<script");
		await reader.cancel();
	});

	it("streams per-email progress on a mailbox step before the step finishes", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		let releaseAi!: () => void;
		const aiGate = new Promise<void>((r) => {
			releaseAi = r;
		});
		const baseAi = fakeAi();
		env.AI = {
			run: async (...args: unknown[]) => {
				await aiGate;
				return (baseAi as (...a: unknown[]) => Promise<unknown>)(...args);
			},
		} as unknown as Ai;
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(
			fakeGmail({
				mentico: [
					fullMessage("m1", { subject: "Invoice 42", ms: MESSAGE_TIME + 1_000 }),
					fullMessage("m2", { subject: "Weekly news", ms: MESSAGE_TIME + 3_000 }),
				],
			}).impl,
		);
		const { cookie, csrf } = await sessionFor(env);
		const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
		const reader = (await get(env, url, cookie)).body!.getReader();
		const dec = new TextDecoder();
		let all = dec.decode((await reader.read()).value!);
		let sawStart = false;
		for (let i = 0; i < 30 && !sawStart; i++) {
			if (all.includes('content:"0 of ')) {
				sawStart = true;
				break;
			}
			const r = await reader.read();
			if (r.done) break;
			all += dec.decode(r.value);
		}
		expect(sawStart).toBe(true);
		releaseAi();
		let sawDone = false;
		for (let i = 0; i < 30 && !sawDone; i++) {
			if (/content:"[1-9]\d* of \d+"/.test(all)) {
				sawDone = true;
				break;
			}
			const r = await reader.read();
			if (r.done) break;
			all += dec.decode(r.value);
		}
		expect(sawDone).toBe(true);
		for (let i = 0; i < 30 && !all.includes("#step{display:none}"); i++) {
			const r = await reader.read();
			if (r.done) break;
			all += dec.decode(r.value);
		}
		expect(all).toContain("#step{display:none}");
		await reader.cancel();
	});

	it("still completes a mailbox step when progress callbacks throw", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice 42", ms: MESSAGE_TIME + 1_000 })] }).impl);
		const job = await startJob(env, {}, NOW, "web");
		const plan = await planStep(env, job.id, { now: NOW });
		expect(plan.kind).toBe("process");
		if (plan.kind !== "process") return;
		const view = await plan.work({
			onProgress: async () => {
				throw new Error("stream closed");
			},
		});
		expect(view.rows[0]?.state).toBe("done");
		expect(view.rows[0]?.summary?.fresh).toBe(1);
	});

	it("a job left past its lock is stopped for good: it can't finish after a newer run, or roll back last-run", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const { cookie } = await sessionFor(env);
		const a = await startJob(env, {}, NOW, "web");
		// The tab slept: the lock lapsed, and the morning run (B) ran and finished.
		env.MAILBOX_KV.store.delete("run-lock");
		const b = await runDigest(env, { now: new Date(NOW.getTime() + 3_600_000) });
		expect(await planStep(env, a.id, { now: NOW })).toMatchObject({ kind: "stopped" });
		const html = await (await get(env, `/app/run/${a.id}`, cookie)).text();
		expect(html).toContain("This run was stopped");
		expect(html).toContain('<a class="btn primary" href="/app">Open the latest run</a>');
		expect(html).not.toContain("http-equiv");
		expect(await env.MAILBOX_KV.get("last-run")).toBe(b.id);
		expect(env.MAILBOX_KV.store.has(`digest:${a.run}`)).toBe(false);
	});

	it("a digest finished behind a newer last-run writes no state", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const job = await startJob(env, {}, NOW, "web");
		// Another location already stored a newer run (KV reads can lag): this one must not overwrite it.
		await env.MAILBOX_KV.put("last-run", "2026-10-24T09:00:00Z");
		await env.MAILBOX_KV.put("digest:2026-10-24T09:00:00Z", JSON.stringify({ id: "2026-10-24T09:00:00Z" }));
		for (let i = 0; i < 4; i++) {
			const plan = await planStep(env, job.id, { now: NOW });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
		}
		expect(env.MAILBOX_KV.store.has(`digest:${job.run}`)).toBe(true);
		expect(await env.MAILBOX_KV.get("last-run")).toBe("2026-10-24T09:00:00Z");
		expect(stateKeys(env).filter((k) => k.startsWith("cls:") || k.startsWith("cursor:"))).toEqual([]);
	});

	it("a last step retried after it failed part-way assembles the same digest and redoes the same writes", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		await runDigest(env, { now: new Date(NOW.getTime() - 86_400_000) });
		const job = await startJob(env, {}, NOW, "web");
		for (let i = 0; i < 4; i++) {
			const plan = await planStep(env, job.id, { now: NOW });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
		}
		const first = env.MAILBOX_KV.store.get(`digest:${job.run}`);
		const state = JSON.stringify(stateKeys(env).map((k) => [k, k.startsWith("digest") || k === "runs-index" ? "" : env.MAILBOX_KV.store.get(k)]));
		// As if the last step's final write had failed: it runs again, with last-run already this run.
		env.MAILBOX_KV.store.delete(`job-done:${job.id}`);
		await env.MAILBOX_KV.put("run-lock", JSON.stringify({ at: job.now, job: job.id }));
		const again = await planStep(env, job.id, { now: NOW });
		expect(again.kind).toBe("finish");
		if (again.kind === "finish") await again.work();
		expect(env.MAILBOX_KV.store.get(`digest:${job.run}`)).toBe(first);
		expect(JSON.stringify(stateKeys(env).map((k) => [k, k.startsWith("digest") || k === "runs-index" ? "" : env.MAILBOX_KV.store.get(k)]))).toBe(state);
	});

	describe("the morning run's fallbacks", () => {
		const emailEnv = () =>
			makeEnv({
				AI: { run: fakeAi() } as unknown as Ai,
				DIGEST_EMAIL: { send: vi.fn(async () => {}) } as unknown as SendEmail,
				DIGEST_EMAIL_FROM: "digest@example.com",
				DIGEST_EMAIL_TO: "me@example.com",
			}) as TestEnv & { SELF?: Fetcher };
		const drivePaths = (logs: ReturnType<typeof vi.spyOn>): string[] =>
			logs.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('{"evt":"drive"')).map((l: string) => JSON.parse(l).path);

		for (const [name, self] of [
			["throws", async () => {
				throw new Error("Worker exceeded CPU time limit.");
			}],
			["answers 503", async () => new Response("error 1102", { status: 503 })],
		] as const) {
			it(`SELF ${name}: after 3 failed calls, only the last step runs here, so there's a digest, an email, and no lock`, async () => {
				const env = emailEnv();
				fetchMock.mockImplementation((await threeMailboxes(env)).impl);
				const fetchSelf = vi.fn(self);
				env.SELF = { fetch: fetchSelf } as unknown as Fetcher;
				const logs = vi.spyOn(console, "log").mockImplementation(() => {});
				vi.spyOn(console, "error").mockImplementation(() => {});
				await scheduledRun(env);
				expect(fetchSelf).toHaveBeenCalledTimes(3);
				expect(drivePaths(logs)).toEqual(["self", "finish-only"]);
				const d = (await getDigest(env.MAILBOX_KV, (await env.MAILBOX_KV.get("last-run"))!))!;
				expect(d.accounts.every((a) => !a.ok && a.error === "not reached")).toBe(true);
				expect(env.DIGEST_EMAIL!.send).toHaveBeenCalledTimes(1);
				expect(env.MAILBOX_KV.store.has("run-lock")).toBe(false);
			});
		}

		it("no loopback at all: finish-only, still a digest and an email; no mailbox is stepped in the cron invocation", async () => {
			const env = emailEnv();
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			const logs = vi.spyOn(console, "log").mockImplementation(() => {});
			await scheduledRun(env);
			expect(drivePaths(logs)).toEqual(["finish-only"]);
			expect(fetchMock).not.toHaveBeenCalled();
			expect(await env.MAILBOX_KV.get("last-run")).toBe(JSON.parse([...env.MAILBOX_KV.store].find(([k]) => k.startsWith("job:") && !k.slice(4).includes(":"))![1]).run);
			expect(env.DIGEST_EMAIL!.send).toHaveBeenCalledTimes(1);
		});

		it("prefers the ctx.exports loopback when it's there", async () => {
			const env = emailEnv();
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			const self = vi.fn();
			env.SELF = { fetch: self } as unknown as Fetcher;
			const exported = vi.fn(async (req: Request) => app.fetch(req, env, ctx));
			const logs = vi.spyOn(console, "log").mockImplementation(() => {});
			await scheduledRun(env, { ...ctx, exports: { default: { fetch: exported } } } as unknown as ExecutionContext);
			expect(drivePaths(logs)).toEqual(["exports"]);
			expect(exported).toHaveBeenCalledTimes(4);
			expect(self).not.toHaveBeenCalled();
			expect((await getDigest(env.MAILBOX_KV, (await env.MAILBOX_KV.get("last-run"))!))!.items).toHaveLength(3);
		});

		it("the page takes over the morning run's job once it has stalled, and only shows it before that", async () => {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			const { cookie } = await sessionFor(env);
			const job = await startJob(env, {}, NOW, "cron");
			const shown = await (await get(env, `/app/run/${job.id}`, cookie)).text();
			expect(shown).toContain("The morning run is going");
			expect(shown).toContain('<meta http-equiv="refresh" content="5">');
			clock.now = () => new Date(NOW.getTime() + STEP_STALE_MS + 1_000);
			const took = await (await get(env, `/app/run/${job.id}`, cookie)).text();
			expect(nextUrl(took)).toBe(`/app/run/${job.id}`);
			expect(JSON.parse(env.MAILBOX_KV.store.get(`job:${job.id}:broken`)!).state).toBe("done");
		});
	});

	it("one heavy mailbox whose steps all die is failed alone: the morning run still steps the others through the loopback", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai }) as TestEnv & { SELF?: Fetcher };
		for (const a of ["aaheavy", "bb", "cc"]) await linkAccount(env, a);
		fetchMock.mockImplementation(
			fakeGmail({
				aaheavy: [fullMessage("h1", { subject: "Weekly" })],
				bb: [fullMessage("b1", { subject: "Invoice 1" })],
				cc: [fullMessage("c1", { subject: "Invoice 2" })],
			}).impl,
		);
		// Every step that gets to aaheavy dies (exceeded CPU): its running mark is written, then nothing.
		env.SELF = {
			fetch: async (req: Request) => {
				const id = new URL(req.url).pathname.split("/").pop()!;
				const heavy = JSON.parse((await env.MAILBOX_KV.get(`job:${id}:aaheavy`)) ?? "null");
				if (!heavy || (heavy.state === "running" && heavy.attempt < MAX_ATTEMPTS)) {
					await env.MAILBOX_KV.put(`job:${id}:aaheavy`, JSON.stringify({ state: "running", attempt: (heavy?.attempt ?? 0) + 1, startedAt: Date.now() }));
					return new Response("error 1102", { status: 503 });
				}
				return app.fetch(req, env, ctx);
			},
		} as unknown as Fetcher;
		const logs = vi.spyOn(console, "log").mockImplementation(() => {});
		await scheduledRun(env);
		expect(logs.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith('{"evt":"drive"')).map((l) => JSON.parse(l).path)).toEqual(["self"]);
		const d = (await getDigest(env.MAILBOX_KV, (await env.MAILBOX_KV.get("last-run"))!))!;
		expect(d.accounts.map((a) => [a.alias, a.ok, a.error])).toEqual([
			["aaheavy", false, "took too long"],
			["bb", true, undefined],
			["cc", true, undefined],
		]);
		expect(d.items.map((i) => i.key).sort()).toEqual(["bb:b1", "cc:c1"]);
	});

	it("a missing lock right after a step (a lagging KV read) doesn't stop the job; it takes the lock again", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		fetchMock.mockImplementation((await threeMailboxes(env)).impl);
		const job = await startJob(env, {}, NOW, "web");
		env.MAILBOX_KV.store.delete("run-lock");
		const plan = await planStep(env, job.id, { now: new Date(NOW.getTime() + 60_000) });
		expect(plan.kind).toBe("process");
		if (plan.kind === "process") await plan.work();
		expect(JSON.parse(env.MAILBOX_KV.store.get("run-lock")!).job).toBe(job.id);
		// Left longer than the lock lasts, though: stopped.
		env.MAILBOX_KV.store.delete("run-lock");
		expect((await planStep(env, job.id, { now: new Date(Date.now() + 7 * 60_000) })).kind).toBe("stopped");
	});

	it("a mailbox that had to shrink its share starts the next run from twice what worked, growing back toward full", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: Array.from({ length: 100 }, (_, i) => fullMessage(`m${i}`, { subject: `Weekly ${i}`, ms: MESSAGE_TIME + i * 1_000 })) }).impl);
		const job = await startJob(env, {}, NOW, "web");
		await env.MAILBOX_KV.put(`job:${job.id}:mentico`, JSON.stringify({ state: "running", attempt: 1, startedAt: NOW.getTime() - STEP_STALE_MS - 1 }));
		for (let i = 0; i < 2; i++) {
			const plan = await planStep(env, job.id, { now: NOW });
			if (plan.kind === "process" || plan.kind === "finish") await plan.work();
		}
		const cursor = () => JSON.parse(env.MAILBOX_KV.store.get("cursor:mentico")!);
		expect(cursor()).toEqual({ after: MESSAGE_TIME + 14_000, share: 15, checked: NOW.getTime() });
		const next = await runDigest(env, { now: new Date(NOW.getTime() + 3_600_000) });
		expect(next.accounts[0]).toMatchObject({ found: 30, backlog: 55 });
		expect(cursor().share).toBe(30);
		await runDigest(env, { now: new Date(NOW.getTime() + 7_200_000) });
		// 60 of the 55 left: everything, and the share is still below full, so it keeps growing.
		expect(cursor()).toEqual({ after: MESSAGE_TIME + 99_000, share: 60, checked: NOW.getTime() + 7_200_000 });
	});

	describe("last successful check", () => {
		const cursor = (env: TestEnv, alias: string) => JSON.parse(env.MAILBOX_KV.store.get(`cursor:${alias}`) ?? "null");

		it("a real run records it in each mailbox it read, new mail or not; a mailbox that failed keeps its old one", async () => {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			await runDigest(env, { now: NOW });
			expect(cursor(env, "mentico")).toMatchObject({ after: MESSAGE_TIME + 3_000, checked: NOW.getTime() });
			expect(cursor(env, "broken")).toBeNull();
			// Nothing new an hour later: the cursor stays, the check time moves (one write per mailbox).
			const later = new Date(NOW.getTime() + 3_600_000);
			await runDigest(env, { now: later });
			expect(cursor(env, "mentico")).toEqual({ after: MESSAGE_TIME + 3_000, checked: later.getTime() });
			expect(cursor(env, "personal").checked).toBe(later.getTime());
		});

		it("a test run that read a mailbox counts (in its own key, the cursor untouched); a step that died doesn't", async () => {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			await runDigest(env, { now: NOW, window: { kind: "days", amount: 2 } });
			expect(env.MAILBOX_KV.store.get("checked:mentico")).toBe(String(NOW.getTime()));
			expect(env.MAILBOX_KV.store.has("checked:broken")).toBe(false);
			expect(env.MAILBOX_KV.store.has("cursor:mentico")).toBe(false);
			// A real job whose mentico steps all died: mentico isn't checked by it.
			const later = new Date(NOW.getTime() + 3_600_000);
			const job = await startJob(env, {}, later, "web");
			await env.MAILBOX_KV.put(`job:${job.id}:mentico`, JSON.stringify({ state: "running", attempt: RETRY_SHARES.length, startedAt: later.getTime() - STEP_STALE_MS - 1 }));
			for (let i = 0; i < 4; i++) {
				const plan = await planStep(env, job.id, { now: later });
				if (plan.kind === "process" || plan.kind === "finish") await plan.work();
			}
			const { checked } = await listAccountsWithChecks(env.MAILBOX_KV);
			expect(checked.get("mentico")).toBe(NOW.getTime());
			expect(checked.get("personal")).toBe(later.getTime());
			expect(checked.has("broken")).toBe(false);
			// Unlinking forgets it.
			fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
			await removeAccount(env, (await getAccount(env.MAILBOX_KV, "mentico"))!);
			expect(env.MAILBOX_KV.store.has("checked:mentico")).toBe(false);
		});

		it("the mailbox list shows it relative, with the time behind it, at no extra KV read", async () => {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			await runDigest(env, { now: new Date(NOW.getTime() - 3 * 3_600_000) });
			let ops = env.MAILBOX_KV.ops;
			await listAccounts(env.MAILBOX_KV);
			const plain = env.MAILBOX_KV.ops - ops;
			ops = env.MAILBOX_KV.ops;
			await listAccountsWithChecks(env.MAILBOX_KV);
			expect(env.MAILBOX_KV.ops - ops).toBe(plain);
			const { cookie } = await sessionFor(env);
			const html = await (await get(env, "/app", cookie)).text();
			expect(html).toContain(' · <span class="nw">last checked <time class="ago" datetime="2026-10-24T03:30:00.000Z" title="Sat 24 Oct, 04:30">3 h ago</time></span>');
			expect(html).toContain('<span class="nw">never checked</span>');
		});

		it("the run page shows when each mailbox still to do was last checked", async () => {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			await runDigest(env, { now: new Date(NOW.getTime() - 2 * 86_400_000) });
			const { cookie, csrf } = await sessionFor(env);
			const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
			const html = await (await get(env, url, cookie)).text();
			expect(html).toContain('<p class="alias">personal</p><p class="jdet note"><span class="nw">Last checked <time class="ago" datetime="2026-10-22T06:30:00.000Z" title="Thu 22 Oct, 07:30">2 days ago</time></span></p>');
		});
	});

	describe("the finished run", () => {
		/** A whole Run now, stepped from its page; returns the job id and its last page. */
		async function runToEnd(env: TestEnv, cookie: string, csrf: string) {
			const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
			let html = "";
			for (let i = 0; i < 6; i++) {
				html = await (await get(env, url, cookie)).text();
				if (nextUrl(html)?.startsWith("/app?")) break;
			}
			return { id: url.split("/").pop()!, html };
		}

		it("shows every row final with the totals, then opens the digest after 10 s unless paused", async () => {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			const { cookie, csrf } = await sessionFor(env);
			const { id, html } = await runToEnd(env, cookie, csrf);
			expect(html).toContain('<meta http-equiv="refresh" content="10;url=/app?run=2026-10-24T06%3A30%3A00Z&amp;ran=1">');
			expect(html).toContain("Run now · 3 of 3</p><h1>Digest ready</h1>");
			expect(html).toMatch(/<p class="note mono jsum">3 new · 2 to action · 1 failed · \d+\.\d s<\/p>/);
			expect(html).toContain('<p class="jcount">Opening your digest in 10 s</p><span class="countdown" aria-hidden="true"></span>');
			expect(html).toContain(`<a class="btn primary" href="/app?run=2026-10-24T06%3A30%3A00Z&amp;ran=1">Open digest</a><a class="btn quiet" href="/app/run/${id}?paused=1">Pause</a>`);
			expect(html).not.toContain("<script");
			const paused = await (await get(env, `/app/run/${id}?paused=1`, cookie)).text();
			expect(paused).not.toContain("http-equiv");
			expect(paused).toContain("Paused. The digest is ready when you are.");
			expect(paused).toContain('<a class="btn primary" href="/app?run=2026-10-24T06%3A30%3A00Z&amp;ran=1">Open digest</a></p>');
			expect(paused).not.toContain(">Pause</a>");
			expect(paused).toContain('<li class="jrow is-failed">');
		});

		it("the digest says Digest refreshed with a small View last run result link to that run, and Run details at the foot", async () => {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			const { cookie, csrf } = await sessionFor(env);
			const { id } = await runToEnd(env, cookie, csrf);
			const page = await (await get(env, "/app?run=2026-10-24T06%3A30%3A00Z&ran=1", cookie)).text();
			expect(page).toContain(`Digest refreshed. <a class="flash-a" href="/app/run/${id}?paused=1">View last run result</a></p>`);
			const later = await (await get(env, "/app", cookie)).text();
			expect(later).not.toContain("View last run result");
			expect(later).toContain(` · <a href="/app/run/${id}?paused=1">Run details</a></p>`);
		});

		it("details that are gone degrade to a plain page", async () => {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			fetchMock.mockImplementation((await threeMailboxes(env)).impl);
			const { cookie, csrf } = await sessionFor(env);
			const { id } = await runToEnd(env, cookie, csrf);
			env.MAILBOX_KV.store.delete(`job-result:${id}`);
			const res = await get(env, `/app/run/${id}?paused=1`, cookie);
			expect(res.status).toBe(404);
			const html = await res.text();
			expect(html).toContain("Run details are no longer available");
			expect(html).toContain('href="/app?run=2026-10-24T06%3A30%3A00Z&amp;ran=1">Open digest</a>');
			// Long after: the job's own keys (an hour) and its done mark (as long as the digest) are gone too.
			for (const k of [...env.MAILBOX_KV.store.keys()]) if (k.includes(id)) env.MAILBOX_KV.store.delete(k);
			expect(await (await get(env, `/app/run/${id}?paused=1`, cookie)).text()).toContain("Run details are no longer available");
		});
	});
});
