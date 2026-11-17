import { afterEach, describe, expect, it, vi } from "vitest";
import { _clearAccessTokenCache } from "../src/accounts";
import { planStep, startJob, STEP_STALE_MS } from "../src/jobs";
import { fakeAi, fakeGmail } from "./fakes";
import { fullMessage, linkAccount, makeEnv } from "./helpers";

// These tests document current unsafe behavior, even with a strongly consistent fake KV.
// Replace the assertions with safety properties when a coordinator fixes the races.
describe("job concurrency hazards", () => {
	afterEach(() => {
		_clearAccessTokenCache();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("demonstrates duplicate classification by overlapping mailbox steps", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mail");
		const now = new Date();
		vi.stubGlobal("fetch", vi.fn(fakeGmail({ mail: [fullMessage("m1", { subject: "Invoice", ms: now.getTime() - 60_000 })] }).impl));
		vi.spyOn(console, "log").mockImplementation(() => {});
		const job = await startJob(env, {}, now, "web");
		const [a, b] = await Promise.all([planStep(env, job.id, { now }), planStep(env, job.id, { now })]);
		if (a.kind !== "process" || b.kind !== "process") throw new Error("Expected both workers to plan before either claims the mailbox");
		await Promise.all([a.work(), b.work()]);
		expect(ai).toHaveBeenCalledTimes(2);
	});

	it("demonstrates duplicate writes by overlapping finalizers", async () => {
		const env = makeEnv();
		vi.spyOn(console, "log").mockImplementation(() => {});
		const now = new Date();
		const job = await startJob(env, {}, now, "web");
		const [a, b] = await Promise.all([planStep(env, job.id, { now }), planStep(env, job.id, { now })]);
		if (a.kind !== "finish" || b.kind !== "finish") throw new Error("Expected both workers to plan finalization before either commits");
		const put = vi.spyOn(env.MAILBOX_KV, "put");
		await Promise.all([a.work(), b.work()]);
		expect(put.mock.calls.filter(([key]) => key === `digest:${job.run}`)).toHaveLength(2);
	});

	it("demonstrates a stale attempt overwriting a newer completed mailbox step", async () => {
		let unblock!: () => void;
		let notifyStarted!: () => void;
		const blocked = new Promise<void>((resolve) => { unblock = resolve; });
		const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
		const base = fakeAi();
		let calls = 0;
		const ai = vi.fn(async (...args: Parameters<typeof base>) => {
			if (++calls === 1) { notifyStarted(); await blocked; }
			return base(...args);
		});
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mail");
		const now = new Date();
		vi.stubGlobal("fetch", vi.fn(fakeGmail({ mail: [fullMessage("m1", { subject: "Invoice", ms: now.getTime() - 60_000 })] }).impl));
		vi.spyOn(console, "log").mockImplementation(() => {});
		const job = await startJob(env, {}, now, "web");
		const first = await planStep(env, job.id, { now });
		if (first.kind !== "process") throw new Error("Expected first mailbox step");
		const oldWork = first.work();
		await started;
		const retry = await planStep(env, job.id, { now: new Date(Date.now() + STEP_STALE_MS + 1_000) });
		if (retry.kind !== "process") throw new Error("Expected stale step retry");
		await retry.work();
		expect(JSON.parse(env.MAILBOX_KV.store.get(`job:${job.id}:mail`)!)).toMatchObject({ state: "done", attempt: 2 });
		unblock();
		await oldWork;
		expect(JSON.parse(env.MAILBOX_KV.store.get(`job:${job.id}:mail`)!)).toMatchObject({ state: "done", attempt: 1 });
	});
});
