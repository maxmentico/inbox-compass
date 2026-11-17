import { describe, expect, it } from "vitest";
import {
	byRules,
	ESTIMATED_ACTION,
	estimate,
	type Features,
	featuresOf,
	filedTab,
	filedTriage,
	type HistoryEntry,
	historyEntry,
	isGenericDomain,
	isNoReply,
	isRoleAddress,
	keywordFlags,
	similarity,
	skipsModel,
	subjectShape,
} from "../src/estimate";
import type { Triage } from "../src/llm";
import { decide, DEFAULT_SETTINGS } from "../src/rules";

const features = (o: Partial<Parameters<typeof featuresOf>[0]> = {}): Features =>
	featuresOf({ from: "Acme Billing <billing@acme.example>", subject: "Invoice 41 for October", text: "", addressing: "only_you", conversation: false, attachments: [], ...o });

const triage = (o: Partial<Triage> = {}): Triage => ({
	sender: "automated",
	request: "required",
	stakes: "high",
	action: "Pay invoice 41",
	category: "payment",
	due: null,
	summary: "",
	...o,
});

const entry = (id: string, f: Features, t: Triage, subject = "Invoice 41 for October", date = "2026-10-21T09:00:00Z"): HistoryEntry =>
	historyEntry(id, f, t, { date, subject });

const day = (iso: string) => `day(${iso.slice(0, 10)})`;

describe("features", () => {
	it("shapes subjects: reply prefixes dropped, numbers, dates, amounts and ids replaced", () => {
		expect(subjectShape("Re: Fwd: Invoice 2026-118 for €1,240 due 03/11, ref A7F3K9Q")).toEqual(["invoice", "<n>", "for", "<amount>", "due", "<date>", "ref", "<id>"]);
		expect(subjectShape("Счёт №123 на 500 руб.")).toEqual(["счёт", "<n>", "на", "<amount>"]);
		// Same shape for the next invoice from the same sender.
		expect(subjectShape("Invoice 42 for November")).toEqual(["invoice", "<n>", "for", "november"]);
	});

	it("stays fast on a hostile subject", () => {
		const start = performance.now();
		subjectShape(`${"a1".repeat(5_000)} ${"9,".repeat(5_000)}`);
		keywordFlags("x".repeat(100_000));
		expect(performance.now() - start).toBeLessThan(50);
	});

	it("reads keyword flags in English and Russian, labels, and invoice-like attachments", () => {
		expect(keywordFlags("Please pay the overdue invoice by Friday")).toEqual(["money", "deadline", "request"]);
		expect(keywordFlags("Оплатите счёт, срок истекает завтра")).toEqual(["money", "deadline"]);
		expect(keywordFlags("New sign-in to your account")).toEqual(["security"]);
		const f = features({ labelIds: ["CATEGORY_UPDATES", "IMPORTANT", "STARRED"], attachments: ["Invoice-41.pdf"] });
		expect(f).toMatchObject({ address: "billing@acme.example", domain: "acme.example", name: "Acme Billing", tab: "updates", important: true, starred: true, attachment: true });
	});

	it("tells no-reply and role addresses from a person's", () => {
		expect(isNoReply("no-reply@accounts.google.com")).toBe(true);
		expect(isNoReply("newsletter@shop.example")).toBe(true);
		expect(isNoReply("anna@client.example")).toBe(false);
		expect(isRoleAddress("support@acme.example")).toBe(true);
		expect(isRoleAddress("anna.smith@client.example")).toBe(false);
	});

	it("knows Gmail's Promotions and Social tabs, and gives them fixed answers", () => {
		expect(filedTab(["INBOX", "CATEGORY_PROMOTIONS"])).toBe("Promotions");
		expect(filedTab(["CATEGORY_SOCIAL"])).toBe("Social");
		expect(filedTab(["CATEGORY_UPDATES"])).toBeNull();
		expect(filedTriage("Promotions", "50% off at https://shop.example/sale today")).toEqual({
			sender: "marketing",
			request: "none",
			stakes: "none",
			action: "",
			category: "newsletter",
			due: null,
			summary: "50% off at [link removed] today",
		});
		expect(filedTriage("Social", "Anna liked your post")).toMatchObject({ sender: "automated", category: "notification" });
	});
});

describe("similarity", () => {
	it("weighs address 0.40, subject shape 0.25, domain 0.15, addressing 0.10 and Gmail tab 0.10", () => {
		const a = features();
		// The same address doesn't also score the domain: 0.40 + 0.25 + 0.10 + 0.10.
		expect(similarity(a, a)).toBeCloseTo(0.85);
		expect(similarity(a, features({ subject: "Something else entirely" }))).toBeCloseTo(0.6);
		expect(similarity(a, features({ from: "Ops <ops@acme.example>", subject: "Your Acme order", addressing: "bulk" }))).toBeCloseTo(0.25);
		expect(similarity(a, features({ from: "x@other.example", subject: "Lunch?", addressing: "bulk", labelIds: ["CATEGORY_SOCIAL"] }))).toBe(0);
	});
});

describe("estimate", () => {
	const invoice = features({ labelIds: ["CATEGORY_UPDATES"] });

	it("copies the closest earlier email's answers when it's close and its close neighbours agree", () => {
		const history = [
			entry("h1", invoice, triage()),
			entry("h2", features({ subject: "Invoice 40 for September", labelIds: ["CATEGORY_UPDATES"] }), triage(), "Invoice 40 for September", "2026-09-21T09:00:00Z"),
			entry("h3", features({ from: "x@elsewhere.example", subject: "Weekly news", addressing: "bulk" }), triage({ sender: "marketing", request: "none", category: "newsletter" })),
		];
		const est = estimate(features({ subject: "Invoice 42 for November", labelIds: ["CATEGORY_UPDATES"] }), { snippet: "Your invoice is ready" }, history, day);
		expect(est).toEqual({
			triage: { sender: "automated", request: "required", stakes: "high", action: ESTIMATED_ACTION, category: "payment", due: null, summary: "Your invoice is ready" },
			by: "history",
			reason: "Estimated: like ‘Invoice 41 for October’ from Acme Billing (day(2026-10-21))",
			check: false,
		});
	});

	it("falls to the rules when the best neighbour is below the threshold", () => {
		const history = [entry("h1", features({ from: "Other <a@other.example>", subject: "Invoice 41 for October" }), triage())];
		// Same shape and addressing, nothing else: 0.25 + 0.10 + 0.10 = 0.45.
		const est = estimate(features({ from: "Anna <anna@client.example>", subject: "Invoice 42 for November" }), { snippet: "" }, history, day);
		expect(est.by).toBe("rules");
	});

	it("falls to the rules when close neighbours disagree on request or category", () => {
		const history = [entry("h1", invoice, triage()), entry("h2", invoice, triage({ request: "none", category: "notification" }))];
		expect(estimate(invoice, { snippet: "" }, history, day).by).toBe("rules");
	});

	it("never lets a copied automated answer ask directly", () => {
		const digest = features({ from: "news@acme.example", subject: "Weekly digest 41", addressing: "bulk" });
		const history = [entry("h1", digest, triage({ request: "direct" }), "Weekly digest 40")];
		expect(estimate(digest, { snippet: "" }, history, day)).toMatchObject({ by: "history", triage: { request: "routine" } });
	});
});

describe("rules without a close neighbour", () => {
	it("(a) Promotions or Social, or a mailing list from a no-reply address: marketing, asks nothing", () => {
		expect(byRules(features({ from: "Deals <deals@shop.example>", subject: "Autumn sale", addressing: "bulk", labelIds: ["CATEGORY_PROMOTIONS"] }), "")).toMatchObject({
			triage: { sender: "marketing", request: "none", category: "newsletter" },
			reason: "Estimated: Gmail filed it under Promotions",
			check: false,
		});
		expect(byRules(features({ from: "no-reply@shop.example", subject: "Your invoice", addressing: "bulk" }), "").reason).toBe(
			"Estimated: a mailing list from a no-reply address",
		);
	});

	it("(b) money or deadline words, unless it's mass mail outside Updates: requires an action", () => {
		expect(byRules(features({ from: "Anna <anna@client.example>", subject: "Invoice overdue" }), "")).toMatchObject({
			triage: { sender: "automated", request: "required", category: "payment" },
			reason: "Estimated: it mentions a payment; check it",
			check: true,
		});
		// Not personal: no check needed, "requires an action" puts it in To action.
		expect(byRules(features({ from: "billing@acme.example", subject: "Invoice overdue", addressing: "bulk", labelIds: ["CATEGORY_UPDATES"] }), "")).toMatchObject({
			reason: "Estimated: it mentions a payment",
			check: false,
		});
		expect(byRules(features({ subject: "Renewal deadline", from: "x@y.example" }), "").triage.category).toBe("task");
		expect(byRules(features({ subject: "Big sale: pay less", addressing: "bulk", from: "deals@y.example" }), "").triage.request).toBe("none");
		expect(byRules(features({ subject: "Your bill", addressing: "bulk", from: "acct@bank.example", labelIds: ["CATEGORY_UPDATES"] }), "").triage.request).toBe("required");
	});

	it("(c) Gmail marked it important, only you in To, from a person: a direct request to check", () => {
		expect(byRules(features({ from: "Anna <anna@client.example>", subject: "Quick question", labelIds: ["IMPORTANT"] }), "")).toMatchObject({
			triage: { sender: "person", request: "direct" },
			check: true,
		});
		// A role address isn't a person.
		expect(byRules(features({ from: "support@client.example", subject: "Quick question", labelIds: ["IMPORTANT"] }), "").triage.request).not.toBe("direct");
	});

	it("(d) a reply in a conversation you've written in: a reply expected, to check", () => {
		expect(byRules(features({ from: "Tom <tom@x.example>", subject: "Re: plans", addressing: "cc_you", conversation: true }), "")).toMatchObject({
			triage: { sender: "person", request: "implied" },
			reason: "Estimated: a reply in a conversation you've written in; check it",
			check: true,
		});
	});

	it("(e) otherwise personal mail is to check; mass mail is information", () => {
		expect(byRules(features({ from: "Tom <tom@x.example>", subject: "Plans", addressing: "to_you" }), "")).toMatchObject({ check: true, reason: "Estimated: sent to you personally; check it" });
		expect(byRules(features({ from: "Tom <tom@x.example>", subject: "Plans", addressing: "not_named" }), "")).toMatchObject({
			triage: { request: "none", category: "notification" },
			check: false,
		});
	});
});

/** Where rules.ts puts an estimate, as the digest would. */
function placed(f: Features, e: ReturnType<typeof estimate>) {
	return decide(
		{ signals: { ...e.triage, addressing: f.addressing }, category: e.triage.category, from: "", subject: f.subject, due: null, done: false, replied: false, check: e.check },
		{ today: "2026-10-24", settings: DEFAULT_SETTINGS },
	).outcome;
}

describe("a copied answer never hides what may need you", () => {
	const anna = (subject: string, o: Partial<Parameters<typeof featuresOf>[0]> = {}) =>
		features({ from: "Anna Weber <anna@client.example>", subject, ...o });
	const fyi = triage({ sender: "person", request: "none", stakes: "none", action: "", category: "fyi" });

	it("Anna's FYI history at volume: none of 500 personal requests from her land in For information", () => {
		// Her past mail, all information, including subjects shaped exactly like the new ones.
		const history = Array.from({ length: 500 }, (_, i) =>
			entry(`h${i}`, anna(i % 2 ? `Notes from our call ${i}` : `Can you approve contract ${i} by 5pm`), fyi, `Notes ${i}`),
		);
		const placements = Array.from({ length: 500 }, (_, i) => {
			const f = anna(i % 3 ? `Can you approve contract ${1000 + i} by 5pm` : `Quick one about the offsite ${i}`);
			return placed(f, estimate(f, { snippet: "" }, history, day));
		});
		expect(placements.filter((p) => p !== "action")).toEqual([]);
	});

	it("two different senders on a generic provider don't match, however alike the subject", () => {
		const a = features({ from: "Ann <ann.k@gmail.com>", subject: "Lunch on Friday?", addressing: "bulk" });
		const b = features({ from: "Bo <bo.l@gmail.com>", subject: "Lunch on Friday?", addressing: "bulk" });
		expect(isGenericDomain("gmail.com")).toBe(true);
		expect(isGenericDomain("acme.example")).toBe(false);
		expect(similarity(a, b)).toBeCloseTo(0.45);
		expect(estimate(b, { snippet: "" }, [entry("h1", a, triage({ sender: "marketing", request: "none", category: "newsletter" }))], day).by).toBe("rules");
	});

	it("the same address with an unrelated subject doesn't copy, though it reaches the threshold", () => {
		const past = features({ from: "news@shop.example", subject: "Autumn collection", addressing: "bulk" });
		const now = features({ from: "news@shop.example", subject: "Your order has shipped", addressing: "bulk" });
		expect(similarity(past, now)).toBeCloseTo(0.6);
		expect(estimate(now, { snippet: "" }, [entry("h1", past, triage({ sender: "marketing", request: "none", category: "newsletter" }))], day).by).toBe("rules");
	});

	it("a legitimate recurring template still copies: a newsletter, and an invoice", () => {
		const news = (n: number) => features({ from: "news@shop.example", subject: `Weekly picks ${n}`, addressing: "bulk", labelIds: ["CATEGORY_UPDATES"] });
		const copied = estimate(news(42), { snippet: "" }, [entry("h1", news(41), triage({ sender: "marketing", request: "none", category: "newsletter" }), "Weekly picks 41")], day);
		expect(copied).toMatchObject({ by: "history", triage: { category: "newsletter" } });
		const bill = (n: number) => features({ subject: `Invoice ${n} for October`, labelIds: ["CATEGORY_UPDATES"] });
		expect(estimate(bill(42), { snippet: "" }, [entry("h1", bill(41), triage())], day)).toMatchObject({ by: "history", triage: { request: "required" } });
	});

	it("money or deadline words override a weaker copied answer", () => {
		const past = features({ from: "ops@vendor.example", subject: "Your account update", addressing: "bulk" });
		const now = features({ from: "ops@vendor.example", subject: "Your account update: payment overdue", addressing: "bulk", labelIds: ["CATEGORY_UPDATES"] });
		const est = estimate(now, { snippet: "" }, [entry("h1", past, triage({ request: "none", category: "notification" }))], day);
		expect(est).toMatchObject({ by: "rules", reason: "Estimated: it mentions a payment" });
		expect(placed(now, est)).toBe("action");
	});
});

describe("Gmail's filing has recourse", () => {
	it("Promotions or Social mail goes to the model when it mentions money, a deadline or security, is only to you from a person, or is in your conversation", () => {
		expect(skipsModel(features({ from: "deals@shop.example", subject: "50% off everything", addressing: "bulk", labelIds: ["CATEGORY_PROMOTIONS"] }))).toBe(true);
		expect(skipsModel(features({ from: "billing@shop.example", subject: "Your invoice is due", addressing: "bulk" }))).toBe(false);
		expect(skipsModel(features({ from: "no-reply@shop.example", subject: "Verify your password now", addressing: "bulk" }))).toBe(false);
		expect(skipsModel(features({ from: "Anna <anna@client.example>", subject: "Photos from Saturday", addressing: "only_you" }))).toBe(false);
		expect(skipsModel(features({ from: "notify@social.example", subject: "Re: plans", addressing: "bulk", conversation: true }))).toBe(false);
	});
});

describe("unsure personal mail is shown, never hidden (the reviewer's probes)", () => {
	const probe = (o: Partial<Parameters<typeof featuresOf>[0]> & { text: string }, history: HistoryEntry[] = []) => {
		const f = featuresOf({ from: "Anna <anna@acme.com>", subject: "", addressing: "only_you", attachments: [], conversation: false, ...o });
		const est = estimate(f, { snippet: o.text }, history, day);
		return { est, placed: placed(f, est) };
	};

	it("a terms or policy subject can't demote personal mail with a deadline or money words", () => {
		expect(probe({ subject: "Privacy policy draft - need your sign-off by Friday", text: "Hi Max" }).placed).toBe("action");
		expect(probe({ subject: "Updated terms and invoice for the client", text: "see attached", addressing: "to_you" }).placed).toBe("action");
	});

	it("nor can it demote a copied 'requires an action': the guard reads the real subject", () => {
		const h = featuresOf({ from: "Anna <anna@acme.com>", subject: "Updated terms for review", text: "", addressing: "only_you", attachments: [], conversation: false });
		const past = historyEntry("h2", h, triage({ sender: "person", request: "required", stakes: "some", category: "task" }), { date: "2026-10-20", subject: "Updated terms for review" });
		expect(probe({ subject: "Updated terms for review", text: "hi" }, [past])).toMatchObject({ placed: "action", est: { by: "rules", check: true } });
	});

	it("personal mail Gmail misfiled under Promotions or Social isn't put under information", () => {
		expect(probe({ from: "Bob <bob@gmail.com>", subject: "Dinner Saturday?", text: "can you make it", labelIds: ["CATEGORY_PROMOTIONS"] }).placed).toBe("action");
		expect(probe({ from: "Bob <bob@gmail.com>", subject: "Re: plan", text: "ok?", addressing: "to_you", labelIds: ["CATEGORY_SOCIAL"], conversation: true }).placed).toBe("action");
		expect(probe({ from: "Ann <ann@studio.io>", subject: "Invoice 41", text: "please pay", labelIds: ["CATEGORY_PROMOTIONS"] }).placed).toBe("action");
	});

	it("Cc'd by a person is to check, in English or Russian, and mass mail says why it's mass mail", () => {
		expect(probe({ subject: "Q3 numbers", text: "Max, can you confirm these today?", addressing: "cc_you" })).toMatchObject({ placed: "action", est: { reason: "Estimated: a person copied you in; check it" } });
		expect(probe({ from: "Анна <anna@acme.ru>", subject: "Отчёт", text: "Макс, можешь посмотреть до вечера?", addressing: "cc_you" }).placed).toBe("action");
		expect(probe({ from: "support@acme.com", subject: "Q3 numbers", text: "FYI", addressing: "cc_you" }).est.reason).toBe("Estimated: mass mail (you're only in Cc, from a role address)");
		// Blind-copied: the model's own rules treat it as mass mail too.
		expect(probe({ subject: "FYI", text: "please call me", addressing: "not_named" })).toMatchObject({ placed: "info", est: { reason: "Estimated: mass mail (you're not in To or Cc)" } });
		expect(skipsModel(featuresOf({ from: "Anna <anna@acme.com>", subject: "Q3", text: "", addressing: "cc_you", labelIds: ["CATEGORY_SOCIAL"], attachments: [], conversation: false }))).toBe(false);
	});

	it("a copy that says phishing stays under Possible phishing, which is shown", () => {
		const h = featuresOf({ from: "Anna <anna@acme.com>", subject: "Invoice 40 attached", text: "pay", addressing: "only_you", attachments: [], conversation: false });
		const sus = historyEntry("h1", h, triage({ sender: "person", category: "suspicious" }), { date: "2026-10-20", subject: "Invoice 40 attached" });
		expect(probe({ subject: "Invoice 41 attached", text: "pay" }, [sus]).placed).toBe("phishing");
	});
});
