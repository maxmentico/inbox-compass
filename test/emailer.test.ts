import { describe, expect, it, vi } from "vitest";
import { applySettings, type Digest } from "../src/digest";
import { buildMime, digestText, encodeHeader, sendDigestEmail } from "../src/emailer";
import { DEFAULT_SETTINGS } from "../src/rules";

const digest: Digest = {
	id: "2026-10-24T06:30:00Z",
	date: "2026-10-24",
	generatedAt: "2026-10-24T06:30:00Z",
	model: "m",
	query: "q",
	modelErrors: [],
	accounts: [
		{ alias: "mentico", email: "a@x", ok: true, found: 2, newlyClassified: 2 },
		{ alias: "mirror", email: "b@x", ok: false, found: 0, newlyClassified: 0, needsRelink: true, error: "x" },
	],
	items: [
		{ key: "mentico:1", account: "mentico", accountEmail: "a@x", messageId: "1", threadId: "t1", from: "Анна <anna@x.ru>", subject: "Счёт", date: null, snippet: "", needsAction: true, action: "Pay invoice", urgency: "high", category: "payment", due: "2026-10-27", summary: "", classified: true, done: false },
		{ key: "mentico:2", account: "mentico", accountEmail: "a@x", messageId: "2", threadId: "t2", from: "News", subject: "Weekly", date: null, snippet: "", needsAction: false, action: "", urgency: "low", category: "newsletter", due: null, summary: "", classified: true, done: false },
	],
};

describe("digest email", () => {
	it("summarises open items, FYI count, broken mailboxes, and links to the page", () => {
		const { subject, body } = digestText(digest, "https://inbox-digest.me.workers.dev/");
		expect(subject).toBe("Inbox Compass 2026-10-24: 1 new to action");
		expect(body).toContain("[HIGH] mentico: Pay invoice (due 2026-10-27)");
		expect(body).toContain("1 for information only");
		expect(body).toContain("mirror: needs re-linking");
		expect(body).toContain("https://inbox-digest.me.workers.dev/app?run=2026-10-24T06%3A30%3A00Z");
	});

	it("lists still-open items from earlier runs separately", () => {
		const carried = { ...digest.items[0]!, key: "mentico:3", messageId: "3", action: "Renew hosting", carried: true };
		const { subject, body } = digestText({ ...digest, items: [...digest.items, carried] });
		expect(subject).toBe("Inbox Compass 2026-10-24: 1 new to action, 1 still open");
		expect(body.indexOf("1 new to action")).toBeLessThan(body.indexOf("1 still open from earlier"));
		expect(body).toContain("[HIGH] mentico: Renew hosting");
	});

	it("strips links from every email-derived string, since mail clients auto-link plain text", () => {
		const hostile = {
			...digest.items[0]!,
			from: "PayPal www.paypal-help.com <security@paypal.com>",
			subject: "Verify at https://evil.io/login now",
			action: "Sign in at paypal-login.com",
		};
		const { subject, body } = digestText({ ...digest, items: [hostile] });
		for (const text of [subject, body]) {
			expect(text).not.toMatch(/https?:|www\./i);
			expect(text).not.toContain("paypal-login.com");
		}
		expect(body).toContain("Sign in at paypal-login[.]com");
		expect(body).toContain("PayPal [link removed] <security@paypal.com> — Verify at [link removed] now");
	});

	it("counts superseded messages with their conversation's item, not as information", () => {
		const sig = { sender: "person", request: "direct", stakes: "none", addressing: "only_you" } as const;
		const ask = { ...digest.items[0]!, key: "mentico:q", messageId: "q", threadId: "t", date: "2026-10-23T10:00:00Z", signals: sig };
		const nudge = { ...ask, key: "mentico:n", messageId: "n", date: "2026-10-24T10:00:00Z", action: "Answer the nudge" };
		const d = applySettings({ ...digest, items: [ask, nudge] }, DEFAULT_SETTINGS);
		const { subject, body } = digestText(d);
		expect(subject).toBe("Inbox Compass 2026-10-24: 1 new to action");
		expect(body).toContain("Answer the nudge (due 2026-10-27) (+1 earlier in this conversation)");
		expect(body).not.toContain("for information only");
	});

	it("counts a carried item whose sender was muted since as information, like the page", () => {
		const carried = { ...digest.items[0]!, carried: true, from: "Anna <anna@x.ru>", signals: { sender: "person", request: "direct", stakes: "none", addressing: "only_you" } as const };
		const d = applySettings({ ...digest, items: [carried] }, { ...DEFAULT_SETTINGS, muted: ["anna@x.ru"] });
		const { subject, body } = digestText(d);
		expect(subject).toBe("Inbox Compass 2026-10-24: 0 new to action");
		expect(body).not.toContain("still open");
		expect(body).toContain("1 for information only");
	});

	it("says when the model was unavailable, and marks estimated and re-checked items", () => {
		const est = { ...digest.items[0]!, estimated: { by: "history" as const, reason: "x" } };
		const re = { ...digest.items[0]!, key: "mentico:9", messageId: "9", threadId: "t9", action: "Renew hosting", rechecked: true as const };
		const { body } = digestText(
			{ ...digest, items: [est, re], ai: { unavailable: { reason: "error", at: "2026-10-24T06:31:00Z" }, estimated: 1, fromHistory: 0 } },
			undefined,
			"Europe/London",
		);
		expect(body.split("\n")[0]).toBe("The AI model wasn't available at 07:31. 1 email was estimated with simple rules; it'll be re-checked when it's back.");
		expect(body).toContain("Pay invoice (due 2026-10-27) (estimated)");
		expect(body).toContain("Renew hosting (due 2026-10-27) (re-checked: needs you)");
	});

	it("builds valid MIME with UTF-8 body and encoded non-ASCII subject", () => {
		const raw = buildMime({ from: "digest@example.com", to: "me@example.com", subject: "Дайджест", body: "Привет\nline 2", now: new Date(0) });
		const [head, bodyB64] = raw.split("\r\n\r\n");
		expect(head).toContain("Subject: =?UTF-8?B?");
		expect(head).toMatch(/Message-ID: <[^@]+@example\.com>/);
		expect(head).toContain("Content-Transfer-Encoding: base64");
		expect(Buffer.from(bodyB64!.replace(/\r\n/g, ""), "base64").toString("utf8")).toBe("Привет\r\nline 2");
		for (const l of bodyB64!.trimEnd().split("\r\n")) expect(l.length).toBeLessThanOrEqual(76);
	});

	it("neutralises header injection in the subject", () => {
		expect(encodeHeader("Hi\r\nBcc: x@evil.com")).toBe("Hi Bcc: x@evil.com");
	});

	it("only sends when fully configured", async () => {
		expect(await sendDigestEmail({}, digest)).toBe("not-configured");
		const send = vi.fn(async () => {});
		const make = vi.fn(async (from: string, to: string, raw: string) => ({ from, to, raw }));
		const res = await sendDigestEmail(
			{ DIGEST_EMAIL: { send } as unknown as SendEmail, DIGEST_EMAIL_FROM: "d@example.com", DIGEST_EMAIL_TO: "me@example.com" },
			digest,
			make,
		);
		expect(res).toBe("sent");
		expect(make).toHaveBeenCalledWith("d@example.com", "me@example.com", expect.stringContaining("Subject: Inbox Compass"));
		expect(send).toHaveBeenCalledTimes(1);
	});
});
