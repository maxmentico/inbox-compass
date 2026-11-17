import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { _clearAccessTokenCache } from "../src/accounts";
import { getAccount } from "../src/accounts";
import { applySettings, collect, type Digest, getDigest, latestRealRun, listDigests, markDone, markUndone, runContext, runDigest, saveDigest, setDoneMarks, withDoneMarks } from "../src/digest";
import { GMAIL_MODIFY_SCOPE } from "../src/config";
import { RATE_LIMIT_RETRY } from "../src/gmail";
import { DEFAULT_SETTINGS, saveSettings } from "../src/rules";
import { chat, fakeAi, fakeGmail, type Lookup, type ThreadMessage } from "./fakes";
import { batchResponse, fullMessage, idsInBatch, linkAccount, MESSAGE_TIME, makeEnv } from "./helpers";

const retryDelay = RATE_LIMIT_RETRY.delayMs;
beforeEach(() => { RATE_LIMIT_RETRY.delayMs = 0; });
afterEach(() => { RATE_LIMIT_RETRY.delayMs = retryDelay; });

describe("runDigest", () => {
	const fetchMock = vi.fn<typeof fetch>();
	beforeEach(() => {
		_clearAccessTokenCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("collects across mailboxes, classifies, sorts, isolates a broken mailbox, and stores by local date", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		await linkAccount(env, "personal");
		await linkAccount(env, "broken");
		const gmail = fakeGmail({
			mentico: [fullMessage("m1", { subject: "Invoice 42", ms: MESSAGE_TIME + 1_000 }), fullMessage("m2", { subject: "Weekly news", ms: MESSAGE_TIME + 3_000 })],
			personal: [fullMessage("p1", { subject: "Invoice gas", ms: MESSAGE_TIME + 2_000 })],
		});
		fetchMock.mockImplementation(gmail.impl);

		// UK clocks go back on 25 Oct 2026, so 23:30 UTC that evening is still the 25th in London.
		const d = await runDigest(env, { now: new Date("2026-10-25T23:30:00Z") });
		expect(d.date).toBe("2026-10-25");

		expect(d.items.map((i) => i.key)).toEqual(["personal:p1", "mentico:m1", "mentico:m2"]);
		expect(d.items[0]).toMatchObject({ needsAction: true, urgency: "high", action: "Pay Invoice gas", accountEmail: "personal@example.com", threadId: "t-p1", classified: true });
		expect(d.items[0]!.decision).toEqual({ outcome: "action", because: ["required"], urgency: "high" });
		expect(d.items[0]!.signals).toEqual({ sender: "automated", request: "required", stakes: "high", addressing: "not_named" });
		expect(d.items[2]).toMatchObject({ needsAction: false, action: "" });

		const broken = d.accounts.find((a) => a.alias === "broken")!;
		expect(broken).toMatchObject({ ok: false, needsRelink: true });
		expect(d.accounts.find((a) => a.alias === "mentico")).toMatchObject({ ok: true, found: 2, newlyClassified: 2 });

		// Three emails fit one model batch.
		expect(ai).toHaveBeenCalledTimes(1);
		expect(d.id).toBe("2026-10-25T23:30:00Z");
		expect(await getDigest(env.MAILBOX_KV, d.id)).toMatchObject({ date: "2026-10-25" });
		expect(await listDigests(env.MAILBOX_KV)).toEqual([d.id]);
	});

	it("reuses cached classifications: no re-fetch and no model call for already-seen mail", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const inbox = { mentico: [fullMessage("m1", { subject: "Invoice 1" })] };
		const gmail = fakeGmail(inbox);
		fetchMock.mockImplementation(gmail.impl);

		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(ai).toHaveBeenCalledTimes(1);
		expect(gmail.calls.batch).toEqual([["m1"]]);

		inbox.mentico.push(fullMessage("m2", { subject: "Invoice 2" }));
		const second = await runDigest(env, { now: new Date("2026-10-25T06:30:00Z") });
		expect(ai).toHaveBeenCalledTimes(2);
		expect(gmail.calls.batch).toEqual([["m1"], ["m2"]]); // only the new one fetched in full
		expect(gmail.calls.bodies.filter((b) => b.includes("/messages/")).every((b) => b.includes("format=full"))).toBe(true);
		// m1 is still open, so it comes along as carried over; only m2 is new.
		expect(second.items.map((i) => [i.messageId, i.carried === true]).sort()).toEqual([
			["m1", true],
			["m2", false],
		]);
		expect(second.items.every((i) => i.classified)).toBe(true);
	});

	it("keeps a cleaned excerpt of what the sender wrote, and To and Cc, on each item: carried over, never in the classification cache", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const body = "Hi,\r\n\r\n\r\n\r\nPlease pay invoice 1 by Friday.\r\n\r\nOn Mon, 20 Oct 2026 at 10:00, Alice <alice@client.com> wrote:\r\n> earlier";
		const inbox = {
			mentico: [fullMessage("m1", { subject: "Invoice 1", body, to: "Max <me@example.com>", headers: [{ name: "Cc", value: "Bo <bo@client.com>" }] })],
		};
		const gmail = fakeGmail(inbox);
		fetchMock.mockImplementation(gmail.impl);

		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(first.items[0]).toMatchObject({ key: "mentico:m1", needsAction: true, text: "Hi,\n\nPlease pay invoice 1 by Friday.…", textCut: "quote", to: "Max <me@example.com>", cc: "Bo <bo@client.com>" });
		// The classification cache stays small: no email text in it.
		const cached = env.MAILBOX_KV.store.get("cls:mentico:m1")!;
		expect(cached).not.toContain("Please pay");
		expect(cached).not.toContain("bo@client.com");

		// Next run: m1 isn't fetched again, but it's still open, so it's carried over with its text.
		inbox.mentico.push(fullMessage("m2", { subject: "Invoice 2", body: "Second", ms: MESSAGE_TIME + 86_400_000 }));
		const second = await runDigest(env, { now: new Date("2026-10-25T06:30:00Z") });
		expect(gmail.calls.batch).toEqual([["m1"], ["m2"]]);
		expect(second.items.find((i) => i.messageId === "m1")).toMatchObject({ carried: true, text: "Hi,\n\nPlease pay invoice 1 by Friday.…", textCut: "quote", cc: "Bo <bo@client.com>" });
		expect(second.items.find((i) => i.messageId === "m2")).toMatchObject({ text: "Second", to: "me@example.com" });
		expect(second.items.find((i) => i.messageId === "m2")!.cc).toBeUndefined();
		expect((await getDigest(env.MAILBOX_KV, second.id))!.items.find((i) => i.messageId === "m1")!.text).toBe("Hi,\n\nPlease pay invoice 1 by Friday.…");

		// Still open more than CARRIED_TEXT_DAYS after it came (23 Oct): carried without its text, To or Cc.
		const later = await runDigest(env, { now: new Date("2026-11-06T13:00:00Z") });
		const m1 = later.items.find((i) => i.messageId === "m1")!;
		expect(m1).toMatchObject({ carried: true, needsAction: true, summary: expect.any(String) });
		expect([m1.text, m1.textCut, m1.to, m1.cc]).toEqual([undefined, undefined, undefined, undefined]);
		// One that came the next day still has its text (13 days old).
		expect(later.items.find((i) => i.messageId === "m2")).toMatchObject({ carried: true, text: "Second" });
	});

	it("sign-in codes and reset links never reach the model, the item, the cache or the history", async () => {
		// The model "rebuilds" a code into its words: those are masked too.
		const ai = vi.fn(async (_model: string, inputs: any) => {
			const content: string = inputs.messages[1].content;
			const emails = JSON.parse(content.slice(content.indexOf("[")));
			return chat(
				JSON.stringify({
					items: emails.map((e: any) => ({
						ref: e.ref,
						sender_type: "automated",
						request: "required",
						stakes: "high",
						action: "Use code 778899 at https://evil.example/x",
						category: "task",
						due: null,
						summary: /door/i.test(e.subject) ? "The door code is 556677" : "Reset at https://acme.example/reset?t=abc with 482913",
					})),
				}),
			);
		});
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const gmail = fakeGmail({
			mentico: [
				fullMessage("m1", {
					subject: "482913 is your Acme verification code",
					from: "Acme <no-reply@acme.example>",
					snippet: "482913 is your code",
					body: "Your verification code is 482913.\nOr reset your password at https://acme.example/reset?t=abc",
				}),
				fullMessage("m2", { subject: "Door", body: "The door code is 4821. See you at 12:30 in room 2026." }),
			],
		});
		fetchMock.mockImplementation(gmail.impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });

		// The model's input.
		const prompt = JSON.stringify(ai.mock.calls.map((c) => c[1]));
		expect(prompt).not.toMatch(/482913|acme\.example\/reset|4821/);
		expect(prompt).toContain("Your verification code is ••••••.");
		expect(prompt).toContain("room 2026");
		// The items: flagged, masked, model words masked.
		const m1 = d.items.find((i) => i.messageId === "m1")!;
		expect(m1).toMatchObject({ security: true, subject: "•••••• is your Acme verification code", snippet: "•••••• is your code" });
		expect(m1.text).toBe("Your verification code is ••••••.\nOr reset your password at [link removed]");
		expect(m1.summary).toBe("Reset at [link removed] with ••••••");
		const m2 = d.items.find((i) => i.messageId === "m2")!;
		expect(m2.security).toBeUndefined();
		expect(m2.text).toBe("The door code is ••••••. See you at 12:30 in room 2026.");
		expect(m2.summary).toBe("The door code is ••••••");
		expect(m2.action).not.toContain("778899");
		// Nothing stored anywhere holds a code or the reset link: digest, cache, history, job state.
		for (const [key, value] of env.MAILBOX_KV.store) {
			expect(`${key} ${value}`).not.toMatch(/482913|acme\.example\/reset|4821|556677|778899/);
		}
		expect([...env.MAILBOX_KV.store.keys()].some((k) => k.startsWith("history:"))).toBe(true);
		expect(env.MAILBOX_KV.store.get("cls:mentico:m1")).toContain('"security":true');
	});

	it("an item read from the classification cache (a test run over seen mail) has no text", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const gmail = fakeGmail({ mentico: [fullMessage("m1", { subject: "Weekly news", body: "News" })] });
		fetchMock.mockImplementation(gmail.impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const test = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z"), test: true, window: { kind: "days", amount: 1 } });
		const m1 = test.items.find((i) => i.messageId === "m1")!;
		expect(m1.classified).toBe(true);
		expect(m1.text).toBeUndefined();
	});

	it("when the model fails, mail is estimated and shown, then re-checked by the next run where it works", async () => {
		const failing = vi.fn(async () => {
			throw new Error("Workers AI capacity");
		});
		const env = makeEnv({ AI: { run: failing } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice for the contract", to: "mentico@example.com" })] }).impl);

		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		// Rule (b): it mentions a payment, so it requires an action.
		expect(d.items[0]).toMatchObject({ classified: true, needsAction: true, subject: "Invoice for the contract", estimated: { by: "rules", reason: "Estimated: it mentions a payment; check it", check: true } });
		// Primary and fallback both tried.
		expect(failing).toHaveBeenCalledTimes(2);
		expect(d.modelErrors).toEqual([
			"@cf/openai/gpt-oss-120b: Workers AI capacity",
			"@cf/google/gemma-4-26b-a4b-it: Workers AI capacity",
		]);
		expect(d.ai).toEqual({
			unavailable: { reason: "error", at: "2026-10-24T06:30:00.000Z" },
			estimated: 1,
			fromHistory: 0,
			waiting: 1,
			oldestWaiting: "2026-10-24T06:30:00.000Z",
		});
		// Seen, so not reported again, but no answers cached: they aren't final.
		const mark = JSON.parse(env.MAILBOX_KV.store.get("cls:mentico:m1")!);
		expect(mark).toMatchObject({ estimated: true, arrived: MESSAGE_TIME });
		expect(mark.triage).toBeUndefined();
		expect(JSON.parse(env.MAILBOX_KV.store.get("recheck:mentico")!).map((e: { id: string }) => e.id)).toEqual(["m1"]);

		const ok = fakeAi();
		env.AI = { run: ok } as unknown as Ai;
		const retry = await runDigest(env, { now: new Date("2026-10-24T07:00:00Z") });
		expect(ok).toHaveBeenCalledTimes(1);
		// The model's answer replaces the carried estimate, in To action, marked re-checked.
		expect(retry.items.map((i) => [i.messageId, i.carried === true, i.rechecked, i.needsAction, i.estimated])).toEqual([["m1", false, true, true, undefined]]);
		expect(retry.ai).toBeUndefined();
		expect(JSON.parse(env.MAILBOX_KV.store.get("cls:mentico:m1")!).triage).toMatchObject({ request: "required" });
		expect(env.MAILBOX_KV.store.has("recheck:mentico")).toBe(false);
	});

	it("uses the fallback model when the primary is down, and records which model classified it", async () => {
		const good = fakeAi();
		const run = vi.fn(async (model: string, inputs: any) => {
			if (model === "@cf/openai/gpt-oss-120b") throw new Error("3040: capacity");
			return good(model, inputs);
		});
		const env = makeEnv({ AI: { run } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice 9" })] }).impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.items[0]).toMatchObject({ classified: true, needsAction: true, category: "payment" });
		const cached = JSON.parse(env.MAILBOX_KV.store.get("cls:mentico:m1")!);
		expect(cached.model).toBe("@cf/google/gemma-4-26b-a4b-it");
	});

	it("markUndone clears the done mark of known items only, so they carry over again", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" }), fullMessage("m2", { subject: "Invoice B" })] }).impl);

		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		await markDone(env.MAILBOX_KV, first.id, ["mentico:m1"]);
		expect(env.MAILBOX_KV.store.has("done:mentico:m1")).toBe(true);
		expect(await markUndone(env.MAILBOX_KV, first.id, ["mentico:m1", "mentico:m2", "mentico:unknown"])).toEqual(["mentico:m1"]);
		expect(env.MAILBOX_KV.store.has("done:mentico:m1")).toBe(false);
		const same = await withDoneMarks(env.MAILBOX_KV, (await getDigest(env.MAILBOX_KV, first.id))!);
		expect(same!.items.every((i) => !i.done)).toBe(true);
		expect(same!.items.map((i) => i.messageId)).toEqual(first.items.map((i) => i.messageId));
		expect(await markUndone(env.MAILBOX_KV, "no-such-run", ["mentico:m1"])).toEqual([]);
	});

	it("done marks are the source of truth: switches write only them, and carry-over reads them", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" }), fullMessage("m2", { subject: "Invoice B" })] }).impl);
		await env.MAILBOX_KV.put("done:mentico:m1", "1");
		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const stored = env.MAILBOX_KV.store.get(`digest:${first.id}`)!;
		expect((JSON.parse(stored) as typeof first).items.find((i) => i.messageId === "m1")!.done).toBe(true);

		// Two switches in quick succession each write their own key and never the digest.
		await Promise.all([setDoneMarks(env.MAILBOX_KV, ["mentico:m1"], false), setDoneMarks(env.MAILBOX_KV, ["mentico:m2"], true)]);
		expect(env.MAILBOX_KV.store.get(`digest:${first.id}`)).toBe(stored);
		expect(env.MAILBOX_KV.store.has("done:mentico:m1")).toBe(false);
		expect(env.MAILBOX_KV.store.has("done:mentico:m2")).toBe(true);

		// The stored digest still says m1 is done, but its mark is gone: it carries over as open.
		const next = await runDigest(env, { now: new Date("2026-10-25T06:30:00Z") });
		expect(next.items.map((i) => [i.messageId, i.carried, i.done])).toEqual([["m1", true, false]]);
	});

	it("an item switched back while a run is going is carried into that run", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const gmail = fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" }), fullMessage("m2", { subject: "Invoice B" })] }).impl;
		fetchMock.mockImplementation(gmail);
		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		await markDone(env.MAILBOX_KV, first.id, ["mentico:m1"]);

		// The next run reads the marks when it starts; the owner un-ticks m1 while it talks to Gmail.
		let unticked = false;
		fetchMock.mockImplementation(async (input, init) => {
			if (!unticked) {
				unticked = true;
				await setDoneMarks(env.MAILBOX_KV, ["mentico:m1"], false);
			}
			return gmail(input, init);
		});
		const next = await runDigest(env, { now: new Date("2026-10-25T06:30:00Z") });
		expect(unticked).toBe(true);
		const m1 = next.items.find((i) => i.messageId === "m1");
		expect(m1).toMatchObject({ carried: true, done: false, needsAction: true });
	});

	it("latestRealRun: last-run when its digest exists, else the newest real digest among all stored", async () => {
		const env = makeEnv();
		const put = (id: string) => saveDigest(env.MAILBOX_KV, { id, generatedAt: id.slice(0, 20) } as Digest);
		await put("2026-09-01T06:30:00Z");
		// More than the 14 newest are test runs.
		for (let d = 10; d < 30; d++) await put(`2026-10-${d}T06:30:00Z-test`);
		expect(await latestRealRun(env.MAILBOX_KV)).toBe("2026-09-01T06:30:00Z");

		await put("2026-10-01T06:30:00Z");
		await env.MAILBOX_KV.put("last-run", "2026-10-01T06:30:00Z");
		expect(await latestRealRun(env.MAILBOX_KV)).toBe("2026-10-01T06:30:00Z");

		// last-run points at a digest that's gone (only its test twin is left): fall back.
		await env.MAILBOX_KV.put("last-run", "2026-10-10T06:30:00Z");
		expect(await latestRealRun(env.MAILBOX_KV)).toBe("2026-10-01T06:30:00Z");
	});

	it("done marks persist across runs and days", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" }), fullMessage("m2", { subject: "Invoice B" })] }).impl);

		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(await markDone(env.MAILBOX_KV, first.id, ["mentico:m1", "mentico:unknown"])).toEqual(["mentico:m1"]);
		expect(await markDone(env.MAILBOX_KV, first.id, ["mentico:m1"])).toEqual([]); // already done: nothing changes
		const same = await withDoneMarks(env.MAILBOX_KV, (await getDigest(env.MAILBOX_KV, first.id))!);
		expect(same!.items.find((i) => i.messageId === "m1")!.done).toBe(true);
		// A done item keeps its place: the order is the same as before it was ticked.
		expect(same!.items.map((i) => i.messageId)).toEqual(first.items.map((i) => i.messageId));

		// Done items aren't carried over; the open one is.
		const next = await runDigest(env, { now: new Date("2026-10-25T06:30:00Z") });
		expect(next.items.map((i) => [i.messageId, i.carried, i.done])).toEqual([["m2", true, false]]);
	});

	it("fetches rate-limited (429) messages again, and lists any still limited after the retries", async () => {
		const delay = RATE_LIMIT_RETRY.delayMs;
		RATE_LIMIT_RETRY.delayMs = 0;
		try {
			const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
			await linkAccount(env, "mentico");
			const inbox = { mentico: [fullMessage("m1"), fullMessage("m2"), fullMessage("m3")] };
			const g = fakeGmail(inbox);
			const limited = { m2: 1, m3: Infinity } as Record<string, number>; // times each answers 429
			fetchMock.mockImplementation(async (input, init) => {
				if (String(input) !== "https://gmail.googleapis.com/batch/gmail/v1" || String(init?.body).includes("/threads/")) {
					return g.impl(input, init);
				}
				const ids = idsInBatch(String(init?.body));
				g.calls.batch.push(ids);
				return batchResponse(
					ids.map((id, i) => {
						if ((limited[id] ?? 0) > 0) {
							limited[id]!--;
							return { id: String(i), status: 429, body: { error: { code: 429 } } };
						}
						return { id: String(i), status: 200, body: inbox.mentico.find((m) => m.id === id)! };
					}),
				);
			});
			const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
			expect(g.calls.batch).toEqual([["m1", "m2", "m3"], ["m2", "m3"], ["m3"]]);
			expect(d.items.find((i) => i.messageId === "m2")!.classified).toBe(true);
			expect(d.items.find((i) => i.messageId === "m3")).toMatchObject({ classified: false, subject: "(Gmail error 429)" });
		} finally {
			RATE_LIMIT_RETRY.delayMs = delay;
		}
	});

	it("treats a thread you replied to last as handled, until the other side writes again", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const inbox = {
			mentico: [
				fullMessage("m1", { subject: "Invoice 1" }),
				fullMessage("m2", { subject: "Invoice 2" }),
				fullMessage("m3", { subject: "Invoice 3" }),
			],
		};
		const threads: Record<string, ThreadMessage[]> = {
			// You replied after their email.
			"t-m1": [{ id: "m1", internalDate: "100", labelIds: ["INBOX"] }, { internalDate: "200", labelIds: ["SENT"] }],
			// You replied, then they wrote again.
			"t-m2": [{ internalDate: "100", labelIds: ["SENT"] }, { id: "m2", internalDate: "200", labelIds: ["INBOX", "UNREAD"] }],
			// A newer unsent draft is not a reply.
			"t-m3": [{ id: "m3", internalDate: "100", labelIds: ["INBOX"] }, { internalDate: "300", labelIds: ["DRAFT"] }],
		};
		const g = fakeGmail(inbox, threads);
		fetchMock.mockImplementation(g.impl);

		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const by = (d: typeof first, id: string) => d.items.find((i) => i.messageId === id)!;
		expect(by(first, "m1")).toMatchObject({ replied: true, needsAction: false });
		expect(by(first, "m1").decision!.outcome).toBe("replied");
		expect(by(first, "m2")).toMatchObject({ needsAction: true });
		expect(by(first, "m2").replied).toBeUndefined();
		expect(by(first, "m3")).toMatchObject({ needsAction: true });
		expect(g.calls.threads).toEqual([["t-m1", "t-m2", "t-m3"]]);

		// Their answer to your reply arrives as a new email in the same thread: it's new, and open.
		inbox.mentico.push(fullMessage("m1b", { subject: "Invoice 1 again", threadId: "t-m1", ms: MESSAGE_TIME + 60_000 }));
		threads["t-m1"]!.push({ id: "m1b", internalDate: "300", labelIds: ["INBOX", "UNREAD"] });
		// Replying to a carried item drops it.
		threads["t-m2"]!.push({ internalDate: "400", labelIds: ["SENT"] });
		const next = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(next.items.map((i) => [i.messageId, i.carried === true, i.needsAction])).toEqual([
			["m1b", false, true],
			["m3", true, true],
		]);
	});

	it("reads the conversation: question, your reply, their thanks leaves nothing to act on", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const inbox = {
			mentico: [
				fullMessage("q", { subject: "Invoice question", threadId: "t", ms: MESSAGE_TIME }),
				fullMessage("thanks", { subject: "Re: Invoice question - thank you", threadId: "t", ms: MESSAGE_TIME + 2_000 }),
			],
		};
		const ann = [{ name: "From", value: "Ann <ann@client.com>" }];
		const threads: Record<string, ThreadMessage[]> = {
			t: [
				{ id: "q", internalDate: String(MESSAGE_TIME), labelIds: ["INBOX"], snippet: "Can you check invoice 42?", payload: { headers: ann } },
				{ id: "r", internalDate: String(MESSAGE_TIME + 1_000), labelIds: ["SENT"], snippet: "Done, paid today.", payload: { headers: [{ name: "From", value: "Me <mentico@example.com>" }] } },
				{ id: "thanks", internalDate: String(MESSAGE_TIME + 2_000), labelIds: ["INBOX"], snippet: "Thank you!", payload: { headers: ann } },
			],
		};
		fetchMock.mockImplementation(fakeGmail(inbox, threads).impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.items.find((i) => i.messageId === "q")).toMatchObject({ replied: true, needsAction: false });
		expect(d.items.find((i) => i.messageId === "thanks")).toMatchObject({ needsAction: false, decision: { outcome: "info" } });
		// The model saw the thanks as the next message after your reply.
		const content: string = ai.mock.calls[0]![1].messages[1].content;
		const sent = JSON.parse(content.slice(content.indexOf("["))).find((e: any) => /thank/i.test(e.subject));
		expect(sent.thread).toEqual([
			{ by: "other", from: "Ann <ann@client.com>", date: new Date(MESSAGE_TIME).toISOString(), preview: "Can you check invoice 42?" },
			{ by: "owner", from: "Me <mentico@example.com>", date: new Date(MESSAGE_TIME + 1_000).toISOString(), preview: "Done, paid today." },
		]);
	});

	it("lists one To action item per conversation: the newest stands for older unanswered ones", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(
			fakeGmail({
				mentico: [
					fullMessage("ask", { subject: "Invoice 7", threadId: "t", ms: MESSAGE_TIME }),
					fullMessage("nudge", { subject: "Invoice 7 reminder", threadId: "t", ms: MESSAGE_TIME + 5_000 }),
					fullMessage("other", { subject: "Invoice 8", ms: MESSAGE_TIME + 1_000 }),
				],
			}).impl,
		);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const by = (id: string) => d.items.find((i) => i.messageId === id)!;
		expect(by("nudge")).toMatchObject({ needsAction: true, covers: 1 });
		expect(by("ask")).toMatchObject({ needsAction: false, decision: { outcome: "superseded" } });
		expect(by("other")).toMatchObject({ needsAction: true });
		expect(by("other").covers).toBeUndefined();
	});

	it("an older unanswered message under a newer one stays open across runs, and returns when the newer is ticked", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai, ENABLE_MARK_READ: "false" });
		await linkAccount(env, "mentico");
		const thread = {
			t: [
				{ id: "ask", internalDate: String(MESSAGE_TIME), labelIds: ["INBOX"] },
				{ id: "nudge", internalDate: String(MESSAGE_TIME + 5_000), labelIds: ["INBOX"] },
			],
		};
		fetchMock.mockImplementation(
			fakeGmail(
				{
					mentico: [
						fullMessage("ask", { subject: "Invoice 7", threadId: "t", ms: MESSAGE_TIME }),
						fullMessage("nudge", { subject: "Invoice 7 reminder", threadId: "t", ms: MESSAGE_TIME + 5_000 }),
					],
				},
				thread,
			).impl,
		);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const second = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		const by = (id: string) => second.items.find((i) => i.messageId === id)!;
		expect(by("nudge")).toMatchObject({ carried: true, needsAction: true, covers: 1 });
		expect(by("ask")).toMatchObject({ carried: true, decision: { outcome: "superseded" } });
		await markDone(env.MAILBOX_KV, second.id, ["mentico:nudge"]);
		const third = await runDigest(env, { now: new Date("2026-10-24T08:30:00Z") });
		expect(third.items.map((i) => [i.messageId, i.needsAction])).toEqual([["ask", true]]);
	});

	it("a conversation's item takes the highest urgency and every reason in it", () => {
		const base = { account: "a", accountEmail: "a@x", threadId: "t", from: "x@y.com", snippet: "", action: "", category: "other" as const, summary: "", classified: true, done: false, needsAction: false, urgency: "low" as const };
		const d = {
			id: "2026-10-24",
			date: "2026-10-24",
			generatedAt: "",
			model: "",
			query: "",
			accounts: [],
			modelErrors: [],
			items: [
				// Older: renewal due tomorrow (high). Newer: a plain request with no deadline.
				{ ...base, key: "a:old", messageId: "old", subject: "Renew", date: "2026-10-23T10:00:00Z", due: "2026-10-25", signals: { sender: "automated", request: "required", stakes: "some", addressing: "only_you" } },
				{ ...base, key: "a:new", messageId: "new", subject: "Also", date: "2026-10-24T10:00:00Z", due: null, signals: { sender: "person", request: "direct", stakes: "none", addressing: "only_you" } },
			],
		} as unknown as Parameters<typeof applySettings>[0];
		applySettings(d, DEFAULT_SETTINGS);
		const top = d.items.find((i) => i.messageId === "new")!;
		expect(top).toMatchObject({ needsAction: true, urgency: "high", covers: 1 });
		expect(top.decision!.because).toEqual(["direct", "required", "deadline"]);
		// Rendering again (the page does) doesn't double-count.
		applySettings(d, DEFAULT_SETTINGS);
		expect(d.items.find((i) => i.messageId === "new")!.covers).toBe(1);
	});

	it("reads threads only for emails with earlier messages, still-open items, and To action candidates", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		// Single-message threads (Gmail names a thread after its first message).
		const g = fakeGmail({
			mentico: [fullMessage("w1", { subject: "Weekly", threadId: "w1" }), fullMessage("w2", { subject: "Weekly 2", threadId: "w2" }), fullMessage("i1", { subject: "Invoice", threadId: "i1" })],
		});
		fetchMock.mockImplementation(g.impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		// Only the invoice could go into To action; the newsletters' threads are never read.
		expect(g.calls.threads).toEqual([["i1"]]);
		expect(g.calls.bodies.filter((b) => b.includes("/threads/"))[0]).toContain("format=metadata&metadataHeaders=From");
	});

	it("if the reply check fails, mail is treated as unreplied and the mailbox stays healthy", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const g = fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" })] });
		fetchMock.mockImplementation(async (input, init) => {
			if (String(init?.body ?? "").includes("/threads/")) return new Response("boom", { status: 500 });
			return g.impl(input, init);
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.items[0]).toMatchObject({ needsAction: true });
		expect(d.accounts[0]).toMatchObject({ ok: true });
		expect(warn).toHaveBeenCalled();
	});

	it("lists a message Gmail failed to return instead of dropping it", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const g = fakeGmail({ mentico: [fullMessage("m1")] });
		fetchMock.mockImplementation(async (input, init) => {
			if (String(input).includes("/messages?")) return Response.json({ messages: [{ id: "m1" }, { id: "gone" }] });
			return g.impl(input, init);
		});
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.items.map((i) => i.messageId).sort()).toEqual(["gone", "m1"]);
		expect(d.items.find((i) => i.messageId === "gone")).toMatchObject({ classified: false, subject: "(Gmail error 404)" });
	});

	it("with no linked mailboxes, stores an empty digest without calling anything", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.items).toEqual([]);
		expect(ai).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});
	it("works out addressing from headers, never from the model", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const unsubscribe = [{ name: "List-Unsubscribe", value: "<mailto:u@x.com>" }];
		fetchMock.mockImplementation(
			fakeGmail({
				mentico: [
					fullMessage("only", { subject: "Invoice A", to: "Max <MENTICO@example.com>" }),
					fullMessage("many", { subject: "Invoice B", to: "mentico@example.com, b@x.com" }),
					fullMessage("list", { subject: "Invoice C", to: "mentico@example.com", headers: unsubscribe }),
				],
			}).impl,
		);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const by = (id: string) => d.items.find((i) => i.messageId === id)!;
		expect(by("only").signals!.addressing).toBe("only_you");
		expect(by("many").signals!.addressing).toBe("to_you");
		expect(by("list").signals!.addressing).toBe("bulk");
	});

	it("counts mail to the mailbox's send-as aliases and +tag addresses as addressed to you, reading them once per run", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const inbox = {
			mentico: [
				fullMessage("alias", { subject: "Invoice A", to: "Owner <Alias@example.com>" }),
				fullMessage("tag", { subject: "Invoice B", to: "mentico+billing@example.com" }),
				fullMessage("cc", { subject: "Invoice C", to: "a@x.com", headers: [{ name: "Cc", value: "alias@example.com" }] }),
			],
		};
		const g = fakeGmail(inbox, {}, { mentico: ["mentico@example.com", "alias@example.com"] });
		fetchMock.mockImplementation(g.impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const by = (id: string) => d.items.find((i) => i.messageId === id)!;
		expect(by("alias").signals!.addressing).toBe("only_you");
		expect(by("tag").signals!.addressing).toBe("only_you");
		expect(by("cc").signals!.addressing).toBe("cc_you");
		expect(g.calls.sendAs).toBe(1);
		// Nothing new: not read at all.
		await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(g.calls.sendAs).toBe(1);
	});

	it("if the send-as addresses can't be read, addressing falls back to the primary address", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const g = fakeGmail({
			mentico: [fullMessage("alias", { subject: "Invoice A", to: "hello@example.com" }), fullMessage("tag", { subject: "Invoice B", to: "mentico+x@example.com" })],
		});
		fetchMock.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/settings/sendAs")) return new Response("boom", { status: 500 });
			return g.impl(input, init);
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.accounts[0]).toMatchObject({ ok: true });
		expect(d.items.find((i) => i.messageId === "alias")!.signals!.addressing).toBe("not_named");
		expect(d.items.find((i) => i.messageId === "tag")!.signals!.addressing).toBe("only_you");
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("send-as addresses failed"));
	});

	it("sends random, unique refs so one email can't name another's", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1"), fullMessage("m2"), fullMessage("m3")] }).impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const content: string = ai.mock.calls[0]![1].messages[1].content;
		const refs = JSON.parse(content.slice(content.indexOf("["))).map((e: { ref: string }) => e.ref);
		expect(new Set(refs).size).toBe(3);
		for (const r of refs) expect(r).toMatch(/^[0-9a-f]{12}$/);
	});

	it("applies the owner's sender lists, and re-decides stored digests when they change", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		await saveSettings(env.MAILBOX_KV, { deadlineDays: 3, important: ["@news.example"], muted: ["boss@client.com"] });
		fetchMock.mockImplementation(
			fakeGmail({
				mentico: [
					fullMessage("news", { subject: "Weekly", from: "News <hi@mail.news.example>" }),
					fullMessage("boss", { subject: "Invoice", from: "Boss <boss@client.com>" }),
					fullMessage("other", { subject: "Invoice 2", from: "Ann <ann@client.com>" }),
				],
			}).impl,
		);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const by = (id: string) => d.items.find((i) => i.messageId === id)!;
		expect(by("news")).toMatchObject({ needsAction: true, decision: { because: ["important"] } }); // subdomain of an important domain
		expect(by("boss")).toMatchObject({ needsAction: false, decision: { outcome: "muted" } });
		expect(by("other")).toMatchObject({ needsAction: true, decision: { because: ["required"] } });

		const stored = (await getDigest(env.MAILBOX_KV, d.id))!;
		applySettings(stored, DEFAULT_SETTINGS);
		expect(stored.items.filter((i) => i.needsAction).map((i) => i.messageId).sort()).toEqual(["boss", "other"]);
	});

	it("re-classifies results cached by an older version", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		// A v2 entry: the previous version's answers, without the "required" level.
		const old = { v: 2, meta: { threadId: "t", from: "a", subject: "s", date: null, snippet: "" }, triage: { sender: "automated", request: "routine", stakes: "none" }, addressing: "only_you", model: "x", classifiedAt: "" };
		await env.MAILBOX_KV.put("cls:mentico:m1", JSON.stringify(old));
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" })] }).impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(ai).toHaveBeenCalledTimes(1);
		expect(d.items[0]!.signals).toBeDefined();
		expect(JSON.parse(env.MAILBOX_KV.store.get("cls:mentico:m1")!).v).toBe(3);
	});
});

describe("since last check", () => {
	const fetchMock = vi.fn<typeof fetch>();
	beforeEach(() => {
		_clearAccessTokenCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const HOUR = 3_600_000;
	const cursorOf = (env: ReturnType<typeof makeEnv>) => JSON.parse(env.MAILBOX_KV.store.get("cursor:mentico") ?? "null")?.after;
	const afterIn = (q: string) => Number(/after:(\d+)/.exec(q)?.[1]);

	it("looks back 3 days the first time, then only after the cursor (less 1 hour), never repeating a report", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const inbox = { mentico: [fullMessage("a", { subject: "Weekly" }), fullMessage("b", { subject: "Invoice", ms: MESSAGE_TIME + 1_000 })] };
		const g = fakeGmail(inbox);
		fetchMock.mockImplementation(g.impl);

		const now1 = new Date("2026-10-24T06:30:00Z");
		const first = await runDigest(env, { now: now1 });
		expect(afterIn(g.calls.queries[0]!)).toBe(Math.floor((now1.getTime() - 3 * 24 * HOUR) / 1000));
		expect(first.items.map((i) => i.messageId).sort()).toEqual(["a", "b"]);
		expect(cursorOf(env)).toBe(MESSAGE_TIME + 1_000);

		inbox.mentico.push(fullMessage("c", { subject: "Weekly 2", ms: MESSAGE_TIME + 2 * HOUR }));
		const second = await runDigest(env, { now: new Date("2026-10-24T09:00:00Z") });
		expect(afterIn(g.calls.queries[1]!)).toBe(Math.floor((MESSAGE_TIME + 1_000 - HOUR) / 1000));
		// c is new; b is still open so it's carried; a was reported and was only information.
		expect(second.items.map((i) => [i.messageId, i.carried === true]).sort()).toEqual([
			["b", true],
			["c", false],
		]);
		expect(cursorOf(env)).toBe(MESSAGE_TIME + 2 * HOUR);
		expect(await env.MAILBOX_KV.get("last-run")).toBe(second.id);
	});

	it("an estimated email moves the cursor and isn't reported as new again; the next run with the model re-checks it", async () => {
		// Leaves out anything about a contract, so it ends up estimated.
		const picky = vi.fn(async (model: string, inputs: any) => {
			const raw = (await fakeAi()(model, inputs)) as { choices: { message: { content: string } }[] };
			const content: string = inputs.messages[1].content;
			const contract = JSON.parse(content.slice(content.indexOf("["))).filter((e: any) => /contract/i.test(e.subject)).map((e: any) => e.ref);
			const parsed = JSON.parse(raw.choices[0]!.message.content);
			parsed.items = parsed.items.filter((it: any) => !contract.includes(it.ref));
			return chat(JSON.stringify(parsed));
		});
		const env = makeEnv({ AI: { run: picky } as unknown as Ai });
		await linkAccount(env, "mentico");
		const inbox = { mentico: [fullMessage("x", { subject: "Contract" }), fullMessage("y", { subject: "Weekly", ms: MESSAGE_TIME + 5_000 })] };
		const g = fakeGmail(inbox);
		fetchMock.mockImplementation(g.impl);

		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		// Not addressed to the mailbox and no keywords: mass mail, for information.
		expect(first.items.find((i) => i.messageId === "x")).toMatchObject({ classified: true, needsAction: false, estimated: { by: "rules" } });
		// Bad answers, not an outage: no notice of the model being unavailable, but the estimate is counted.
		expect(first.ai).toEqual({ estimated: 1, fromHistory: 0, waiting: 1, oldestWaiting: "2026-10-24T06:30:00.000Z" });
		expect(cursorOf(env)).toBe(MESSAGE_TIME + 5_000);

		const good = fakeAi();
		env.AI = { run: good } as unknown as Ai;
		const second = await runDigest(env, { now: new Date("2026-10-24T07:00:00Z") });
		// x is still in the listed window, but seen: only the re-check fetches it, and the model sees it once.
		expect(g.calls.batch.at(-1)).toEqual(["x"]);
		expect(good).toHaveBeenCalledTimes(1);
		// Now classified for information, as before: nothing to show again.
		expect(second.items).toEqual([]);
		expect(JSON.parse(env.MAILBOX_KV.store.get("cls:mentico:x")!).triage).toBeDefined();
		expect(env.MAILBOX_KV.store.has("recheck:mentico")).toBe(false);
	});

	it("drops a still-open item once it's archived in Gmail", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const threads: Record<string, ThreadMessage[]> = {};
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" })] }, threads).impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		threads["t-m1"] = [{ id: "m1", internalDate: "1", labelIds: ["CATEGORY_UPDATES"] }];
		const next = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(next.items).toEqual([]);
	});

	it("test runs use their own window, show everything in it, can re-classify, and leave the cursor alone", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const g = fakeGmail({ mentico: [fullMessage("m1", { subject: "Weekly" }), fullMessage("m2", { subject: "Weekly 2", ms: MESSAGE_TIME + 1_000 })] });
		fetchMock.mockImplementation(g.impl);
		const real = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const cursor = cursorOf(env);
		const cache = () => [...env.MAILBOX_KV.store].filter(([k]) => k.startsWith("cls:")).sort();
		const cacheBefore = cache();
		expect(cacheBefore.length).toBe(2);
		expect(ai).toHaveBeenCalledTimes(1);

		const now = new Date("2026-10-24T08:00:00Z");
		const test = await runDigest(env, { now, window: { kind: "days", amount: 2 }, reclassify: true });
		expect(test).toMatchObject({ id: "2026-10-24T08:00:00Z-test", test: true });
		expect(afterIn(g.calls.queries.at(-1)!)).toBe(Math.floor((now.getTime() - 2 * 24 * HOUR) / 1000));
		// Already reported and already cached, but shown again and sent to the model again.
		expect(test.items.map((i) => i.messageId).sort()).toEqual(["m1", "m2"]);
		expect(ai).toHaveBeenCalledTimes(2);
		expect(cursorOf(env)).toBe(cursor);
		// Re-classified, but nothing cached: the real run's view of what was seen is untouched.
		expect(cache()).toEqual(cacheBefore);
		expect(await env.MAILBOX_KV.get("last-run")).toBe(real.id);

		// "Last N emails": no time filter, newest first; without re-classify the cache is used.
		const last = await runDigest(env, { now, window: { kind: "emails", amount: 1 } });
		expect(g.calls.queries.at(-1)).toBe("in:inbox");
		expect(last.items.map((i) => i.messageId)).toEqual(["m2"]);
		expect(ai).toHaveBeenCalledTimes(2);
	});

	it("works through a backlog oldest first across runs, reporting every email exactly once", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai, DIGEST_MAX_PER_ACCOUNT: "150" });
		await linkAccount(env, "mentico");
		const many = Array.from({ length: 160 }, (_, i) => fullMessage(`n${i}`, { subject: `Weekly ${i}`, ms: MESSAGE_TIME + i * 1_000 }));
		fetchMock.mockImplementation(fakeGmail({ mentico: many }).impl);

		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(first.accounts[0]).toMatchObject({ found: 150, backlog: 10 });
		expect(first.items.map((i) => i.messageId)).toContain("n0");
		expect(first.items.map((i) => i.messageId)).not.toContain("n150");
		expect(cursorOf(env)).toBe(MESSAGE_TIME + 149_000);

		const second = await runDigest(env, { now: new Date("2026-10-24T06:40:00Z") });
		expect(second.accounts[0]).toMatchObject({ found: 10 });
		expect(second.accounts[0]!.backlog).toBeUndefined();
		const reported = [...first.items, ...second.items].map((i) => i.messageId);
		expect(reported.length).toBe(160);
		expect(new Set(reported).size).toBe(160);
	});

	it("pages through Gmail's results and splits the per-run budget across mailboxes", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		await linkAccount(env, "personal");
		const many = (p: string) => Array.from({ length: 520 }, (_, i) => fullMessage(`${p}${i}`, { subject: `Weekly ${i}`, ms: MESSAGE_TIME + i }));
		const g = fakeGmail({ mentico: many("m"), personal: many("p") });
		fetchMock.mockImplementation(g.impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(g.calls.list).toBe(4); // 500 + 20 per mailbox
		// 500 new emails per run, split between two mailboxes.
		for (const a of d.accounts) expect(a).toMatchObject({ found: 250, backlog: 270 });
		// Bulk reads keep a full run well inside the ~1,000 KV operations a Worker may make.
		expect(env.MAILBOX_KV.ops).toBeLessThan(800);
	});

	it("a mailbox that can't be read keeps its open items, and the run still moves on", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" })] }).impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		// The refresh token stops working (revoked, or the app went back to Testing).
		await linkAccount(env, "mentico", "rt-broken");
		const broken = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(broken.accounts[0]).toMatchObject({ ok: false, needsRelink: true });
		expect(broken.items.map((i) => [i.messageId, i.carried])).toEqual([["m1", true]]);
		// Fixed: it's still there to carry.
		await linkAccount(env, "mentico");
		const fixed = await runDigest(env, { now: new Date("2026-10-24T08:30:00Z") });
		expect(fixed.items.map((i) => [i.messageId, i.carried])).toEqual([["m1", true]]);
	});

	it("estimated mail moves the cursor; a message that failed to load holds it", async () => {
		const failing = vi.fn(async () => {
			throw new Error("Workers AI capacity");
		});
		const env = makeEnv({ AI: { run: failing } as unknown as Ai });
		await linkAccount(env, "mentico");
		const g = fakeGmail({ mentico: [fullMessage("m1", { subject: "Weekly" })] });
		fetchMock.mockImplementation(g.impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(cursorOf(env)).toBe(MESSAGE_TIME);

		env.AI = { run: fakeAi() } as unknown as Ai;
		fetchMock.mockImplementation(async (input, init) => {
			if (String(input).includes("/messages?")) return Response.json({ messages: [{ id: "m1" }, { id: "gone" }] });
			return g.impl(input, init);
		});
		const d = await runDigest(env, { now: new Date("2026-10-24T07:00:00Z") });
		expect(d.items.find((i) => i.messageId === "gone")).toMatchObject({ classified: false });
		expect(cursorOf(env)).toBe(MESSAGE_TIME);
	});

	/**
	 * "stuck" is the second message of thread t-stuck, two hours older than m1, and Gmail answers 500
	 * whenever it's fetched in full. Runs until the failure hold is over and stuck is out of the window,
	 * with `lookup` as Gmail's answer to looking stuck up ("unavailable": the whole lookup request
	 * fails), and returns that run.
	 */
	async function carryStuck(lookup?: Lookup | "unavailable") {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const inbox = {
			mentico: [fullMessage("m1", { subject: "Weekly" }), fullMessage("stuck", { subject: "Contract", threadId: "t-stuck", ms: MESSAGE_TIME - 2 * HOUR })],
		};
		const threads: Record<string, ThreadMessage[]> = {
			"t-stuck": [
				{ id: "first", internalDate: "100", labelIds: ["INBOX"] },
				{ id: "stuck", internalDate: "200", labelIds: ["INBOX", "UNREAD"] },
			],
		};
		const lookups: Record<string, Lookup> = {};
		const g = fakeGmail(inbox, threads, {}, { failFull: new Set(["stuck"]), lookups });
		fetchMock.mockImplementation(g.impl);
		const stuck = (d: Awaited<ReturnType<typeof runDigest>>) => d.items.find((i) => i.messageId === "stuck");

		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(stuck(first)).toMatchObject({ classified: false, needsAction: true, subject: "(Gmail error 500)" });
		expect(cursorOf(env)).toBeUndefined();
		const nextDay = await runDigest(env, { now: new Date("2026-10-25T06:30:00Z") });
		expect(stuck(nextDay)).toMatchObject({ classified: false, needsAction: true });
		expect(cursorOf(env)).toBeUndefined();
		// Two days after it first failed: shown once more, and the cursor moves on.
		const later = await runDigest(env, { now: new Date("2026-10-26T06:31:00Z") });
		expect(stuck(later)).toMatchObject({ classified: false, needsAction: true });
		expect(stuck(later)!.carried).toBeUndefined();
		expect(cursorOf(env)).toBe(MESSAGE_TIME);
		expect(g.calls.minimal).toEqual([]);

		// Now before the window: carried from the last run, after looking the message up.
		if (lookup === "unavailable") {
			fetchMock.mockImplementation(async (input, init) =>
				String(init?.body ?? "").includes("format=minimal") ? new Response("unavailable", { status: 503 }) : g.impl(input, init),
			);
		} else if (lookup !== undefined) lookups.stuck = lookup;
		const carried = await runDigest(env, { now: new Date("2026-10-26T07:30:00Z") });
		if (lookup !== "unavailable") expect(g.calls.minimal).toEqual(Array.from({ length: lookup === 500 ? 3 : 1 }, () => ["stuck"]));
		return { env, g, threads, carried, item: stuck(carried) };
	}

	describe("a message Gmail can't load, carried once the failure hold is over", () => {
		it("still in the inbox: carried as still open, with its real thread", async () => {
			const { carried, item } = await carryStuck();
			expect(item).toMatchObject({ carried: true, classified: false, needsAction: true, threadId: "t-stuck" });
			expect(carried.accounts[0]).toMatchObject({ ok: true });
		});

		it("deleted in Gmail (404): dropped", async () => {
			const { carried, item } = await carryStuck(404);
			expect(item).toBeUndefined();
			expect(carried.accounts[0]).toMatchObject({ ok: true });
		});

		it("no longer in the inbox: dropped", async () => {
			// Its thread still says INBOX, so only the lookup's labels can drop it.
			const { item } = await carryStuck({ threadId: "t-stuck", labelIds: ["CATEGORY_UPDATES"] });
			expect(item).toBeUndefined();
		});

		it("if the lookup fails for another reason, it's kept as it was (fail open)", async () => {
			const { carried, item } = await carryStuck(500);
			expect(item).toMatchObject({ carried: true, classified: false, needsAction: true, threadId: "stuck" });
			expect(carried.accounts[0]).toMatchObject({ ok: true });
		});

		it("if the whole lookup request fails, it's kept as it was (fail open)", async () => {
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const { carried, item } = await carryStuck("unavailable");
			expect(item).toMatchObject({ carried: true, classified: false, needsAction: true, threadId: "stuck" });
			expect(carried.accounts[0]).toMatchObject({ ok: true });
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("message lookup failed for mentico"));
		});

		it("drops out once archived in Gmail", async () => {
			const { env, g, threads } = await carryStuck();
			threads["t-stuck"]![1]!.labelIds = [];
			const next = await runDigest(env, { now: new Date("2026-10-26T08:30:00Z") });
			expect(next.items.find((i) => i.messageId === "stuck")).toBeUndefined();
			// Its thread was stored by the previous run: no second lookup.
			expect(g.calls.minimal).toEqual([["stuck"]]);
		});

		it("drops out once you reply after it", async () => {
			const { env, threads } = await carryStuck();
			threads["t-stuck"]!.push({ internalDate: "300", labelIds: ["SENT"] });
			const next = await runDigest(env, { now: new Date("2026-10-26T08:30:00Z") });
			expect(next.items.find((i) => i.messageId === "stuck")).toBeUndefined();
		});
	});

	it("a message that failed to load, ticked done, no longer holds the cursor", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai, ENABLE_MARK_READ: "false" });
		await linkAccount(env, "mentico");
		const inbox = { mentico: [fullMessage("x", { subject: "Contract" }), fullMessage("y", { subject: "Weekly", ms: MESSAGE_TIME + 5_000 })] };
		fetchMock.mockImplementation(fakeGmail(inbox, {}, {}, { failFull: new Set(["x"]) }).impl);
		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		// Its arrival time is unknown, so it holds the cursor where it is.
		expect(cursorOf(env)).toBeUndefined();
		await markDone(env.MAILBOX_KV, first.id, ["mentico:x"]);
		const second = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(second.items.find((i) => i.messageId === "x")).toMatchObject({ classified: false, done: true });
		expect(cursorOf(env)).toBe(MESSAGE_TIME + 5_000);
	});

	it("never moves the cursor past now, even for mail dated in the future", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const now = new Date("2026-10-24T06:30:00Z");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("f", { subject: "Weekly", ms: Date.parse("2030-01-01T00:00:00Z") })] }).impl);
		await runDigest(env, { now });
		expect(cursorOf(env)).toBe(now.getTime());
	});

	it("answers cached by the previous version count as unseen once: reported without a model call, then seen", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const old = {
			v: 3,
			meta: { threadId: "t-m1", from: "News <n@x.com>", subject: "Weekly", date: new Date(MESSAGE_TIME).toISOString(), snippet: "" },
			triage: { sender: "marketing", request: "none", stakes: "none", action: "", category: "newsletter", due: null, summary: "News" },
			addressing: "bulk",
			model: "x",
			classifiedAt: "",
		};
		await env.MAILBOX_KV.put("cls:mentico:m1", JSON.stringify(old));
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Weekly" })] }).impl);
		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(first.items.map((i) => i.messageId)).toEqual(["m1"]);
		expect(ai).not.toHaveBeenCalled();
		expect(JSON.parse(env.MAILBOX_KV.store.get("cls:mentico:m1")!).arrived).toBe(MESSAGE_TIME);
		const second = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(second.items).toEqual([]);
	});

	it("a test run is a test even for 'since last check' without re-classifying, and is capped", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai, DIGEST_MAX_PER_ACCOUNT: "2" });
		await linkAccount(env, "mentico");
		const msgs = Array.from({ length: 5 }, (_, i) => fullMessage(`m${i}`, { subject: "Weekly", ms: MESSAGE_TIME + i * 1_000 }));
		fetchMock.mockImplementation(fakeGmail({ mentico: msgs }).impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z"), test: true });
		expect(d.id).toMatch(/-test$/);
		expect(cursorOf(env)).toBeUndefined();
		expect(await env.MAILBOX_KV.get("last-run")).toBeNull();
		expect([...env.MAILBOX_KV.store.keys()].some((k) => k.startsWith("cls:"))).toBe(false);
		// Newest first, within the run's share.
		expect(d.items.map((i) => i.messageId).sort()).toEqual(["m3", "m4"]);
		expect(d.accounts[0]).toMatchObject({ truncated: true });
	});

	it("one real run at a time; test runs don't need the lock", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1")] }).impl);
		await env.MAILBOX_KV.put("run-lock", "2026-10-24T06:29:00.000Z");
		await expect(runDigest(env, { now: new Date("2026-10-24T06:30:00Z") })).rejects.toThrow(/Another run started at 2026-10-24T06:29/);
		await expect(runDigest(env, { now: new Date("2026-10-24T06:30:00Z"), window: { kind: "days", amount: 1 } })).resolves.toBeTruthy();
		await env.MAILBOX_KV.delete("run-lock");
		await runDigest(env, { now: new Date("2026-10-24T06:31:00Z") });
		expect(env.MAILBOX_KV.store.has("run-lock")).toBe(false);
	});

	it("re-linking an alias to another account clears its cursor and doesn't carry the old account's items", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Invoice" })] }).impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(cursorOf(env)).toBeDefined();
		const { getAccount, removeAccount, saveAccount } = await import("../src/accounts");
		await removeAccount(env, (await getAccount(env.MAILBOX_KV, "mentico"))!);
		expect(cursorOf(env)).toBeUndefined();
		await saveAccount(env, { alias: "mentico", email: "someone-else@example.com", scopes: [GMAIL_MODIFY_SCOPE], refreshToken: "rt-mentico" });
		fetchMock.mockImplementation(fakeGmail({ mentico: [] }).impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(d.items).toEqual([]);
	});
});

describe("without the model: Gmail's filing, estimates and re-checks", () => {
	const fetchMock = vi.fn<typeof fetch>();
	beforeEach(() => {
		_clearAccessTokenCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const QUOTA = "4006: you have used up your daily free allocation of 10,000 neurons";
	const HOUR = 3_600_000;
	const outOfAllowance = () =>
		vi.fn(async () => {
			throw new Error(QUOTA);
		});
	/** Subjects the model was sent, across calls. */
	const sentSubjects = (ai: ReturnType<typeof vi.fn>) =>
		ai.mock.calls.flatMap((c: any[]) => {
			const content: string = c[1].messages[1].content;
			return JSON.parse(content.slice(content.indexOf("["))).map((e: { subject: string }) => e.subject);
		});
	const toMe = "mentico@example.com";
	const stored = (env: ReturnType<typeof makeEnv>, key: string) => JSON.parse(env.MAILBOX_KV.store.get(key) ?? "null");

	it("mail Gmail filed under Promotions or Social skips the model, unless the sender is important", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		await saveSettings(env.MAILBOX_KV, { deadlineDays: 3, important: ["priya@northwind.example"], muted: [] });
		fetchMock.mockImplementation(
			fakeGmail({
				mentico: [
					fullMessage("promo", { subject: "48 hours only", from: "Deals <deals@shop.example>", labels: ["CATEGORY_PROMOTIONS"], snippet: "Up to 60% off at https://shop.example/sale" }),
					fullMessage("social", { subject: "Anna mentioned you", from: "Social <notify@social.example>", labels: ["CATEGORY_SOCIAL"] }),
					fullMessage("vip", { subject: "Invoice for the budget", from: "Priya <priya@northwind.example>", labels: ["CATEGORY_PROMOTIONS"] }),
				],
			}).impl,
		);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(sentSubjects(ai)).toEqual(["Invoice for the budget"]);
		const by = (id: string) => d.items.find((i) => i.messageId === id)!;
		expect(by("promo")).toMatchObject({ filed: "Promotions", needsAction: false, category: "newsletter", summary: "Up to 60% off at [link removed]", decision: { outcome: "info" } });
		expect(by("social")).toMatchObject({ filed: "Social", needsAction: false, category: "notification" });
		expect(by("vip").filed).toBeUndefined();
		// Cached as final, like a model answer.
		expect(stored(env, "cls:mentico:promo")).toMatchObject({ source: "rule", filed: "Promotions", triage: { sender: "marketing" } });
		expect(d.ai).toBeUndefined();
	});

	it("only filed mail: the model isn't called at all", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("p", { labels: ["CATEGORY_PROMOTIONS"] })] }).impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(ai).not.toHaveBeenCalled();
	});

	it("once the daily allowance runs out, no further batch is sent and the fallback isn't tried; the re-check went first and waits on", async () => {
		const ai = outOfAllowance();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		await env.MAILBOX_KV.put("recheck:mentico", JSON.stringify([{ id: "older", added: MESSAGE_TIME }]));
		await env.MAILBOX_KV.put("cursor:mentico", JSON.stringify({ after: MESSAGE_TIME - 1 }));
		const inbox = Array.from({ length: 40 }, (_, i) => fullMessage(`m${i}`, { subject: `Weekly ${i}`, ms: MESSAGE_TIME + i }));
		// Estimated by an earlier run, before the window this run lists.
		inbox.push(fullMessage("older", { subject: "Older estimate", ms: MESSAGE_TIME - 3 * HOUR }));
		const g = fakeGmail({ mentico: inbox });
		fetchMock.mockImplementation(g.impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T10:28:00Z") });
		// 5 batches: only the 3 sent in parallel before the first answer came back, all to the primary.
		expect(ai).toHaveBeenCalledTimes(3);
		expect(ai.mock.calls.every((c: any[]) => c[0] === "@cf/openai/gpt-oss-120b")).toBe(true);
		expect(d.ai).toEqual({
			unavailable: { reason: "quota", at: "2026-10-24T10:28:00.000Z" },
			estimated: 40,
			fromHistory: 0,
			waiting: 41,
			oldestWaiting: new Date(MESSAGE_TIME).toISOString(),
		});
		expect(d.items.every((i) => i.estimated && i.classified)).toBe(true);
		// The re-check was in the first batch sent; not classified, it stays on the list.
		expect(sentSubjects(ai).slice(0, 1)).toEqual(["Older estimate"]);
		expect(d.items.find((i) => i.messageId === "older")).toBeUndefined();
		expect(stored(env, "recheck:mentico").map((e: { id: string }) => e.id).sort()).toEqual(["older", ...Array.from({ length: 40 }, (_, i) => `m${i}`)].sort());
	});

	it("estimates from the closest earlier email in the mailbox's history, and the rules then place it", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const inbox = { mentico: [fullMessage("i41", { subject: "Invoice 41 for October", from: "Acme Billing <billing@acme.example>", to: toMe, labels: ["CATEGORY_UPDATES"] })] };
		fetchMock.mockImplementation(fakeGmail(inbox).impl);
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(stored(env, "history:mentico")).toMatchObject([{ id: "i41", address: "billing@acme.example", answers: { sender: "automated", request: "required", stakes: "high", category: "payment" } }]);

		env.AI = { run: outOfAllowance() } as unknown as Ai;
		inbox.mentico.push(fullMessage("i42", { subject: "Invoice 42 for November", from: "Acme Billing <billing@acme.example>", to: toMe, labels: ["CATEGORY_UPDATES"], ms: MESSAGE_TIME + HOUR }));
		const d = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		const i42 = d.items.find((i) => i.messageId === "i42")!;
		expect(i42).toMatchObject({
			needsAction: true,
			urgency: "high",
			signals: { sender: "automated", request: "required", stakes: "high", addressing: "only_you" },
			estimated: { by: "history", reason: "Estimated: like ‘Invoice 41 for October’ from Acme Billing (23 Oct)" },
			decision: { because: ["required"] },
		});
		expect(d.ai).toMatchObject({ estimated: 1, fromHistory: 1 });
		// Estimates don't teach the history.
		expect(stored(env, "history:mentico").map((e: { id: string }) => e.id)).toEqual(["i41"]);
	});

	it("seeds the history once from cached answers when there's none yet", async () => {
		const env = makeEnv({ AI: { run: outOfAllowance() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const cached = {
			v: 3,
			arrived: MESSAGE_TIME - 86_400_000,
			meta: { threadId: "t-old", from: "Acme Billing <billing@acme.example>", subject: "Invoice 40 for September", date: new Date(MESSAGE_TIME - 86_400_000).toISOString(), snippet: "" },
			triage: { sender: "automated", request: "required", stakes: "high", action: "Pay", category: "payment", due: null, summary: "" },
			addressing: "only_you",
			model: "x",
			classifiedAt: "",
		};
		await env.MAILBOX_KV.put("cls:mentico:old", JSON.stringify(cached));
		await env.MAILBOX_KV.put("cls:mentico:promo", JSON.stringify({ ...cached, source: "rule" }));
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("new", { subject: "Invoice 42 for November", from: "Acme Billing <billing@acme.example>", to: toMe })] }).impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.items[0]!.estimated).toMatchObject({ by: "history", reason: "Estimated: like ‘Invoice 40 for September’ from Acme Billing (22 Oct)" });
		// Saved, so it's seeded once. Gmail's own filing isn't the model's answer, so it isn't history.
		expect(stored(env, "history:mentico").map((e: { id: string }) => e.id)).toEqual(["old"]);
	});

	it("the history is written only by real runs, newest first, and capped at 500", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const old = Array.from({ length: 500 }, (_, i) => ({ id: `h${i}`, address: "a@b.example", domain: "b.example", name: "", shape: [], addressing: "bulk", tab: "", important: false, starred: false, conversation: false, attachment: false, flags: [], answers: { sender: "marketing", request: "none", stakes: "none", category: "newsletter" }, date: "2026-10-01T00:00:00Z", subject: "x" }));
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("a", { subject: "Weekly A" }), fullMessage("b", { subject: "Weekly B", ms: MESSAGE_TIME + 1 })] }).impl);
		// A test run with the model out: it estimates, so it reads (and seeds) the history, but never saves it.
		const answer = { sender: "marketing", request: "none", stakes: "none", action: "", category: "newsletter", due: null, summary: "" };
		const seed = { v: 3, arrived: MESSAGE_TIME - 86_400_000, meta: { threadId: "t-s", from: "Alice <alice@client.com>", subject: "Weekly Z", date: "2026-10-22T12:00:00Z", snippet: "" }, triage: answer, addressing: "not_named", model: "x", classifiedAt: "" };
		await env.MAILBOX_KV.put("cls:mentico:s", JSON.stringify(seed));
		env.AI = { run: outOfAllowance() } as unknown as Ai;
		const test = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z"), window: { kind: "days", amount: 2 } });
		expect(test.items.map((i) => i.estimated?.by)).toEqual(["history", "history"]);
		expect(env.MAILBOX_KV.store.has("history:mentico")).toBe(false);
		env.AI = { run: fakeAi() } as unknown as Ai;

		await env.MAILBOX_KV.put("history:mentico", JSON.stringify(old));
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const history = stored(env, "history:mentico");
		expect(history).toHaveLength(500);
		expect(history.slice(0, 3).map((e: { id: string }) => e.id)).toEqual(["b", "a", "h0"]);
	});

	it("an estimated email to check stays open across runs while the model is down, and the done switch still works", async () => {
		const ai = outOfAllowance();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai, ENABLE_MARK_READ: "false" });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("lunch", { subject: "Lunch next week?", from: "Tom <tom@friends.example>", to: toMe })] }).impl);
		const first = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(first.items[0]).toMatchObject({ needsAction: true, estimated: { by: "rules", check: true }, decision: { because: ["check"] } });

		// No new mail: the re-check is tried, fails, and the estimate is carried as still open.
		const second = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(ai).toHaveBeenCalledTimes(2);
		expect(second.items.map((i) => [i.messageId, i.carried, i.needsAction, i.estimated?.check])).toEqual([["lunch", true, true, true]]);
		expect(second.ai).toEqual({
			unavailable: { reason: "quota", at: "2026-10-24T07:30:00.000Z" },
			estimated: 0,
			fromHistory: 0,
			waiting: 1,
			oldestWaiting: "2026-10-24T06:30:00.000Z",
		});
		expect(stored(env, "recheck:mentico").map((e: { id: string }) => e.id)).toEqual(["lunch"]);

		await markDone(env.MAILBOX_KV, second.id, ["mentico:lunch"]);
		const third = await runDigest(env, { now: new Date("2026-10-24T08:30:00Z") });
		expect(third.items).toEqual([]);
	});

	it("an estimate the model couldn't re-check in 14 days leaves the list and is shown once more, to check", async () => {
		const env = makeEnv({ AI: { run: outOfAllowance() } as unknown as Ai });
		await linkAccount(env, "mentico");
		// Estimated long ago as information; still in the inbox; the model has been out since.
		const mark = { v: 3, arrived: MESSAGE_TIME - 15 * 24 * HOUR, meta: { threadId: "t-late", from: "Ann <ann@client.example>", subject: "Quarterly figures", date: "2026-10-08T12:00:00Z", snippet: "Figures attached" }, addressing: "to_you", estimated: true, mailbox: toMe, classifiedAt: "" };
		await env.MAILBOX_KV.put("cls:mentico:late", JSON.stringify(mark));
		await env.MAILBOX_KV.put("cls:mentico:gone", JSON.stringify({ ...mark, meta: { ...mark.meta, threadId: "t-gone" } }));
		await env.MAILBOX_KV.put("cursor:mentico", JSON.stringify({ after: MESSAGE_TIME }));
		const added = Date.parse("2026-10-09T06:00:00Z");
		await env.MAILBOX_KV.put("recheck:mentico", JSON.stringify([{ id: "late", added }, { id: "gone", added }, { id: "recent", added: Date.parse("2026-10-23T06:00:00Z") }]));
		const g = fakeGmail({
			mentico: [fullMessage("late", { threadId: "t-late", ms: MESSAGE_TIME - 15 * 24 * HOUR }), fullMessage("recent", { ms: MESSAGE_TIME - 2 * HOUR })],
		});
		fetchMock.mockImplementation(g.impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const late = d.items.find((i) => i.messageId === "late")!;
		expect(late).toMatchObject({ needsAction: true, subject: "Quarterly figures", estimated: { check: true }, decision: { because: ["check"] } });
		expect(late.carried).toBeUndefined();
		// Deleted in Gmail: dropped. Neither lapsed one is on the list any more; the recent one waits on.
		expect(d.items.find((i) => i.messageId === "gone")).toBeUndefined();
		expect(stored(env, "recheck:mentico")).toEqual([{ id: "recent", added: Date.parse("2026-10-23T06:00:00Z") }]);
		expect(d.ai).toMatchObject({ expired: 1, waiting: 1, oldestWaiting: "2026-10-23T06:00:00.000Z" });

		// Shown once: the next run carries it as still open like any To action item, and doesn't surface it again.
		const next = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(next.items.filter((i) => i.messageId === "late").map((i) => i.carried)).toEqual([true]);
		expect(next.ai?.expired).toBeUndefined();
	});

	it("Gmail's filing has recourse: a bill in Promotions, a personal message in Social and a security lure in Promotions reach the model", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(
			fakeGmail({
				mentico: [
					fullMessage("bill", { subject: "Your invoice is due", from: "Shop <billing@shop.example>", labels: ["CATEGORY_PROMOTIONS"], headers: [{ name: "List-Unsubscribe", value: "<mailto:u@shop.example>" }] }),
					fullMessage("friend", { subject: "Photos from Saturday", from: "Anna <anna@client.example>", to: toMe, labels: ["CATEGORY_SOCIAL"] }),
					fullMessage("lure", { subject: "Verify your password now", from: "Security <no-reply@sh0p.example>", labels: ["CATEGORY_PROMOTIONS"] }),
					fullMessage("sale", { subject: "50% off everything", from: "Deals <deals@shop.example>", labels: ["CATEGORY_PROMOTIONS"] }),
				],
			}).impl,
		);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(sentSubjects(ai).sort()).toEqual(["Photos from Saturday", "Verify your password now", "Your invoice is due"]);
		expect(d.items.find((i) => i.messageId === "sale")!.filed).toBe("Promotions");
	});

	it("re-checks run when the fallback model recovered from the primary's error, and get their slice of a full run", async () => {
		const good = fakeAi();
		const run = vi.fn(async (model: string, inputs: any) => {
			if (model === "@cf/openai/gpt-oss-120b") throw new Error("3040: capacity temporarily exceeded");
			return good(model, inputs);
		});
		const env = makeEnv({ AI: { run } as unknown as Ai, DIGEST_MAX_PER_ACCOUNT: "3" });
		await linkAccount(env, "mentico");
		await env.MAILBOX_KV.put("cursor:mentico", JSON.stringify({ after: MESSAGE_TIME - 1 }));
		await env.MAILBOX_KV.put("recheck:mentico", JSON.stringify([{ id: "r0", added: MESSAGE_TIME }, { id: "r1", added: MESSAGE_TIME + 1 }]));
		const inbox = [
			fullMessage("r0", { subject: "Invoice r0", to: toMe, ms: MESSAGE_TIME - 3 * HOUR }),
			fullMessage("r1", { subject: "Invoice r1", to: toMe, ms: MESSAGE_TIME - 3 * HOUR }),
			...Array.from({ length: 5 }, (_, i) => fullMessage(`n${i}`, { subject: `Weekly ${i}`, ms: MESSAGE_TIME + i })),
		];
		const g = fakeGmail({ mentico: inbox });
		fetchMock.mockImplementation(g.impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		// A share of 3 with 5 new emails waiting: a third (1) for the oldest re-check, 2 for new mail.
		expect(d.items.filter((i) => i.rechecked).map((i) => i.messageId)).toEqual(["r0"]);
		expect(d.accounts[0]).toMatchObject({ found: 2, backlog: 3 });
		expect(stored(env, "recheck:mentico").map((e: { id: string }) => e.id)).toEqual(["r1"]);
		expect(d.ai).toMatchObject({ unavailable: { reason: "error" }, estimated: 0, waiting: 1 });
	});

	it("writes the re-check list before the seen marks, so a crash in between can't leave an estimate seen but never re-checked", async () => {
		const env = makeEnv({ AI: { run: outOfAllowance() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Weekly" })] }).impl);
		env.MAILBOX_KV.failPut = (key) => key.startsWith("cls:");
		await expect(runDigest(env, { now: new Date("2026-10-24T06:30:00Z") })).rejects.toThrow(/KV put failed/);
		expect(stored(env, "recheck:mentico").map((e: { id: string }) => e.id)).toEqual(["m1"]);
		expect(env.MAILBOX_KV.store.has("cls:mentico:m1")).toBe(false);
	});

	it("a seen mark written for another Google account doesn't count: the alias was re-linked", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const mark = { v: 3, arrived: MESSAGE_TIME, meta: { threadId: "t-m1", from: "a", subject: "Weekly", date: null, snippet: "" }, addressing: "bulk", estimated: true, mailbox: "someone-else@example.com", classifiedAt: "" };
		await env.MAILBOX_KV.put("cls:mentico:m1", JSON.stringify(mark));
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Weekly" })] }).impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.items.map((i) => i.messageId)).toEqual(["m1"]);
		expect(ai).toHaveBeenCalledTimes(1);
		expect(stored(env, "cls:mentico:m1")).toMatchObject({ mailbox: toMe, triage: { category: "newsletter" } });
	});

	it("seeds the history with the newest 500 cached answers by arrival, whatever their ids", async () => {
		const env = makeEnv({ AI: { run: outOfAllowance() } as unknown as Ai });
		await linkAccount(env, "mentico");
		const answer = { sender: "marketing", request: "none", stakes: "none", action: "", category: "newsletter", due: null, summary: "" };
		// Ids sort the opposite way to arrival: a000 is the newest.
		for (let i = 0; i < 600; i++) {
			const arrived = MESSAGE_TIME - (i + 1) * HOUR;
			const entry = { v: 3, arrived, meta: { threadId: `t${i}`, from: "News <news@shop.example>", subject: `Weekly ${i}`, date: new Date(arrived).toISOString(), snippet: "" }, triage: answer, addressing: "bulk", mailbox: toMe, model: "x", classifiedAt: "" };
			await env.MAILBOX_KV.put(`cls:mentico:a${String(i).padStart(3, "0")}`, JSON.stringify(entry), { metadata: { arrived } });
		}
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("new", { subject: "Weekly 700", from: "News <news@shop.example>" })] }).impl);
		env.MAILBOX_KV.ops = 0;
		await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const ids = stored(env, "history:mentico").map((e: { id: string }) => e.id);
		expect(ids).toHaveLength(500);
		expect(ids[0]).toBe("a000");
		expect(ids).not.toContain("a599");
		expect(env.MAILBOX_KV.ops).toBeLessThan(40);
	});

	it("ten mailboxes, each with a long backlog, all estimated: the run stays inside ~1,000 KV operations", async () => {
		const env = makeEnv({ AI: { run: outOfAllowance() } as unknown as Ai });
		const aliases = Array.from({ length: 10 }, (_, i) => `box${i}`);
		for (const a of aliases) await linkAccount(env, a);
		const inbox = Object.fromEntries(aliases.map((a) => [a, Array.from({ length: 1_600 }, (_, i) => fullMessage(`${a}-${i}`, { subject: `Weekly ${i}`, ms: MESSAGE_TIME + i }))]));
		fetchMock.mockImplementation(fakeGmail(inbox).impl);
		env.MAILBOX_KV.ops = 0;
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.accounts.every((a) => a.ok && a.found === 50)).toBe(true);
		// 1,500 listed per mailbox, not 5,000: each 100 cost a KV read.
		expect(d.accounts.every((a) => a.truncated)).toBe(true);
		expect(env.MAILBOX_KV.ops).toBeLessThan(1_000);
	});

	it("the re-check list outlives a mailbox that fails from the 14-day lapse for over two weeks, so the estimate is still shown", async () => {
		vi.useFakeTimers({ toFake: ["Date"] });
		try {
			const env = makeEnv({ AI: { run: outOfAllowance() } as unknown as Ai });
			await linkAccount(env, "mentico");
			fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("news", { subject: "Weekly", from: "News <news@shop.example>" })] }).impl);
			const at = (day: number) => {
				const t = new Date(Date.parse("2026-10-24T06:30:00Z") + day * 24 * HOUR);
				vi.setSystemTime(t);
				return t;
			};
			// Estimated as information, so it isn't carried: only the list remembers it.
			const first = await runDigest(env, { now: at(0) });
			expect(first.items[0]).toMatchObject({ needsAction: false, estimated: { by: "rules" } });
			// Daily runs with the model still out (each renews the list), then the mailbox fails from day 14
			// to day 29. Back on day 30: inside the list's life (last renewed day 13, plus 14 + 7 days).
			for (let day = 1; day <= 13; day++) await runDigest(env, { now: at(day) });
			await linkAccount(env, "mentico", "rt-broken");
			for (let day = 14; day <= 29; day++) expect((await runDigest(env, { now: at(day) })).accounts[0]!.ok).toBe(false);
			await linkAccount(env, "mentico");
			const back = await runDigest(env, { now: at(30) });
			expect(back.items.find((i) => i.messageId === "news")).toMatchObject({ needsAction: true, estimated: { check: true } });
			expect(back.ai?.expired).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("an estimate to check is cleared by your reply, even when its thread wasn't read for the model", async () => {
		const env = makeEnv({ AI: { run: outOfAllowance() } as unknown as Ai });
		await linkAccount(env, "mentico");
		// The first message of its thread (so not read before the model), and you've replied since.
		const threads: Record<string, ThreadMessage[]> = {
			lunch: [
				{ id: "lunch", internalDate: String(MESSAGE_TIME), labelIds: ["INBOX"] },
				{ internalDate: String(MESSAGE_TIME + HOUR), labelIds: ["SENT"] },
			],
		};
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("lunch", { subject: "Lunch next week?", from: "Tom <tom@friends.example>", to: toMe, threadId: "lunch" })] }, threads).impl);
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(d.items[0]).toMatchObject({ replied: true, needsAction: false, estimated: { check: true }, decision: { outcome: "replied" } });
	});

	it("a worst-case run, every one of 500 emails estimated, then all re-checked, stays inside ~1,000 KV operations each", async () => {
		const env = makeEnv({ AI: { run: outOfAllowance() } as unknown as Ai });
		await linkAccount(env, "mentico");
		await linkAccount(env, "personal");
		const many = (p: string) => Array.from({ length: 250 }, (_, i) => fullMessage(`${p}${i}`, { subject: `Invoice ${i}`, to: `${p === "m" ? "mentico" : "personal"}@example.com`, ms: MESSAGE_TIME + i }));
		fetchMock.mockImplementation(fakeGmail({ mentico: many("m"), personal: many("p") }).impl);
		const down = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		expect(down.ai).toMatchObject({ estimated: 500 });
		expect(env.MAILBOX_KV.ops).toBeLessThan(1_000);

		env.MAILBOX_KV.ops = 0;
		env.AI = { run: fakeAi() } as unknown as Ai;
		const back = await runDigest(env, { now: new Date("2026-10-24T07:30:00Z") });
		expect(back.items.filter((i) => i.rechecked)).toHaveLength(500);
		expect(env.MAILBOX_KV.store.has("recheck:mentico")).toBe(false);
		expect(env.MAILBOX_KV.ops).toBeLessThan(1_000);
	});
});

describe("run telemetry", () => {
	const fetchMock = vi.fn<typeof fetch>();
	beforeEach(() => {
		_clearAccessTokenCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	const lines = (spy: ReturnType<typeof vi.spyOn>): Record<string, any>[] =>
		spy.mock.calls.map((c: unknown[]) => String(c[0])).filter((l: string) => l.startsWith('{"evt":')).map((l: string) => JSON.parse(l));

	it("logs one JSON line per phase, counting subrequests, AI calls and KV operations, with no email content", async () => {
		const ai = fakeAi();
		const env = makeEnv({ AI: { run: ai } as unknown as Ai });
		await linkAccount(env, "mentico");
		const g = fakeGmail({ mentico: [fullMessage("m1", { subject: "Secret subject 123", from: "Alice <alice@client.com>", to: "mentico@example.com" })] });
		fetchMock.mockImplementation(g.impl);
		const opsBefore = env.MAILBOX_KV.ops;
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const out = lines(spy);
		expect(out.map((l) => l.evt)).toEqual(["run-start", "mailbox", "model", "sorted", "writes", "run-end"]);
		expect(out.every((l) => l.run === d.id)).toBe(true);
		expect(out[0]).toMatchObject({ test: false, window: "since", mailboxes: 1, share: 300 });
		expect(out[1]).toMatchObject({ alias: "mentico", ok: true, listed: 1, fresh: 1, take: 1, fetched: 1, failed: 0, gmailCalls: 4 });
		expect(Object.keys(out[1]!.ms).sort()).toEqual(["cache", "cursor", "fetch", "list", "lookups", "recheckList", "sendAs", "threads"]);
		expect(out[2]).toMatchObject({ emails: 1, rechecks: 0 });
		expect(out[3]).toMatchObject({ alias: "mentico", classified: 1, estimated: 0 });
		const end = out.at(-1)!;
		// Every fetch the fake saw went through the counter: token, list, batch, sendAs, threads...
		expect(end).toMatchObject({ ok: true, subrequests: fetchMock.mock.calls.length, ai: ai.mock.calls.length, items: 1 });
		// Plus what the run doesn't count, after run-end: its saved log, and the log index (a read and a write each).
		expect(end.kv.reads + end.kv.writes + end.kv.deletes + end.kv.lists).toBe(env.MAILBOX_KV.ops - opsBefore - 4);
		expect(end.mailboxes).toEqual([{ alias: "mentico", ok: true, found: 1, classified: 1 }]);
		const text = spy.mock.calls.map((c: unknown[]) => String(c[0])).join("\n");
		for (const secret of ["Secret subject", "alice@client.com", "mentico@example.com", "Bearer", "at:mentico"]) expect(text).not.toContain(secret);
	});

	it("saves the run's log lines to KV after it ends, and its error lines apart only when it has any", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1", { subject: "Secret subject 123", from: "Alice <alice@client.com>" })] }).impl);
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const d = await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
		const saved = env.MAILBOX_KV.store.get(`runlog:${d.id}`)!;
		expect(saved.split("\n").map((l) => JSON.parse(l))).toEqual(lines(spy));
		expect(env.MAILBOX_KV.store.has(`runerrors:${d.id}`)).toBe(false);
		for (const secret of ["Secret subject", "alice@client.com"]) expect(saved).not.toContain(secret);
	});

	it("keeps the logs of the last 10 runs only, deleting both keys of each older run", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "broken", "rt-broken");
		fetchMock.mockImplementation(fakeGmail({}).impl);
		vi.spyOn(console, "log").mockImplementation(() => {});
		const ids: string[] = [];
		for (let i = 0; i < 12; i++) ids.push((await runDigest(env, { now: new Date(Date.UTC(2026, 9, 24, 6, 30 + i)), test: i % 2 === 1 })).id);
		const kept = (prefix: string) => [...env.MAILBOX_KV.store.keys()].filter((k) => k.startsWith(prefix)).sort();
		// Every run failed a mailbox, so each had both keys; the first two runs' are gone.
		expect(kept("runlog:")).toEqual(ids.slice(2).map((id) => `runlog:${id}`).sort());
		expect(kept("runerrors:")).toEqual(ids.slice(2).map((id) => `runerrors:${id}`).sort());
		expect(JSON.parse(env.MAILBOX_KV.store.get("runlogs-index")!)).toEqual([...ids.slice(2)].sort());
	});

	it("a run that fails saves its run-end in the errors log too", async () => {
		const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
		await linkAccount(env, "mentico");
		await env.MAILBOX_KV.put("run-lock", JSON.stringify({ at: "2026-10-24T06:29:00.000Z" }));
		vi.spyOn(console, "log").mockImplementation(() => {});
		await expect(runDigest(env, { now: new Date("2026-10-24T06:30:00Z") })).rejects.toThrow();
		const errors = env.MAILBOX_KV.store.get("runerrors:2026-10-24T06:30:00Z")!.split("\n").map((l) => JSON.parse(l));
		expect(errors).toEqual([expect.objectContaining({ evt: "run-end", ok: false, failure: "locked" })]);
	});

	it("notes errors by code: Gmail rate limits, the AI allowance, and a mailbox that failed", async () => {
		const delay = RATE_LIMIT_RETRY.delayMs;
		RATE_LIMIT_RETRY.delayMs = 0;
		try {
			const env = makeEnv({ AI: { run: vi.fn(async () => { throw new Error("4006: you have used up your daily free allocation of 10,000 neurons"); }) } as unknown as Ai });
			await linkAccount(env, "mentico");
			await linkAccount(env, "broken");
			const inbox = { mentico: [fullMessage("m1"), fullMessage("m2")] };
			const g = fakeGmail(inbox);
			let limited = 1;
			fetchMock.mockImplementation(async (input, init) => {
				if (String(input) === "https://gmail.googleapis.com/batch/gmail/v1" && String(init?.body).includes("format=full") && limited-- > 0) {
					return batchResponse(idsInBatch(String(init?.body)).map((_, i) => ({ id: String(i), status: 429, body: {} })));
				}
				return g.impl(input, init);
			});
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			await runDigest(env, { now: new Date("2026-10-24T06:30:00Z") });
			const out = lines(spy);
			const end = out.at(-1)!;
			expect(end.rateLimitedParts).toBe(2);
			expect(end.errors).toMatchObject({ "ai 4006": 1, "http 400": 1 });
			expect(end.mailboxes.find((m: { alias: string }) => m.alias === "broken")).toMatchObject({ ok: false, error: "error" });
			expect(out.filter((l) => l.evt === "error").map((l) => [l.source, l.code])).toEqual(expect.arrayContaining([["ai", "4006"], ["http", "400"]]));
			expect(out.find((l) => l.evt === "model")).toMatchObject({ unavailable: "quota", errors: ["4006"] });
			// The errors log holds the error lines and the run-end (a mailbox failed), none of the rest.
			const saved: Record<string, any>[] = env.MAILBOX_KV.store.get(`runerrors:${end.run}`)!.split("\n").map((l: string) => JSON.parse(l));
			expect(saved.map((l) => l.evt)).toEqual(expect.arrayContaining(["error", "mailbox", "run-end"]));
			expect(saved.every((l) => l.evt === "error" || l.ok === false || l.mailboxes?.some((m: { ok: boolean }) => !m.ok))).toBe(true);
			expect(saved.length).toBeLessThan(out.length);
		} finally {
			RATE_LIMIT_RETRY.delayMs = delay;
		}
	});
});

describe("run progress (collect)", () => {
	const fetchMock = vi.fn<typeof fetch>();
	beforeEach(() => {
		_clearAccessTokenCache();
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("reports progress when the model is off", async () => {
		const env = makeEnv();
		await linkAccount(env, "mentico");
		fetchMock.mockImplementation(fakeGmail({ mentico: [fullMessage("m1"), fullMessage("m2")] }).impl);
		const now = new Date("2026-10-24T06:30:00Z");
		const ctx = await runContext(env, {}, now, false);
		const account = (await getAccount(env.MAILBOX_KV, "mentico"))!;
		const progress: { done: number; total: number }[] = [];
		await collect(env, ctx, [account], { reason: "quota", at: now.toISOString() }, async (done, total) => {
			progress.push({ done, total });
		});
		expect(progress.length).toBeGreaterThan(0);
		const last = progress.at(-1)!;
		expect(last.done).toBe(last.total);
		expect(last.done).toBeGreaterThan(0);
	});
});
