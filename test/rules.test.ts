import { describe, expect, it } from "vitest";
import { conversationOf, earlierInThread, repliedAfter, withoutQuote } from "../src/gmail";
import {
	addressesIn,
	addressingOf,
	deliveryAddress,
	cleanDeadlineDays,
	DEFAULT_SETTINGS,
	decide,
	type EmailFacts,
	isBulk,
	isPolicyUpdate,
	loadSettings,
	normaliseRule,
	saveSettings,
	senderAddress,
	senderRule,
	type Settings,
	type Signals,
	withSenderRule,
} from "../src/rules";
import { memoryKV } from "./helpers";

const TODAY = "2026-10-24";
const settings = (s: Partial<Settings> = {}): Settings => ({ ...DEFAULT_SETTINGS, ...s });
const sig = (s: Partial<Signals> = {}): Signals => ({ sender: "automated", request: "none", stakes: "none", addressing: "only_you", ...s });
const facts = (s: Partial<Signals> | null, f: Partial<EmailFacts> = {}): EmailFacts => ({
	signals: s === null ? undefined : sig(s),
	category: "notification",
	from: "X <x@service.com>",
	subject: "Hello",
	due: null,
	done: false,
	replied: false,
	...f,
});
const run = (f: EmailFacts, st: Settings = settings()) => decide(f, { today: TODAY, settings: st });

describe("step 1: what keeps an email out of To action, first match wins", () => {
	const strong = facts({ sender: "person", request: "direct", stakes: "high" }, { category: "reply" });

	it("done, then phishing (even if you replied), then replied, then not-important", () => {
		expect(run({ ...strong, done: true, category: "suspicious" }).outcome).toBe("done");
		expect(run({ ...strong, category: "suspicious", replied: true }).outcome).toBe("phishing");
		expect(run({ ...strong, replied: true }).outcome).toBe("replied");
		expect(run({ ...strong, from: "Ann <ann@x.com>" }, settings({ muted: ["@x.com"] })).outcome).toBe("muted");
	});

	it("unclassified mail goes to To action unless done or replied; sender lists can't hide it", () => {
		expect(run(facts(null))).toEqual({ outcome: "action", because: ["unclassified"], urgency: "medium" });
		expect(run(facts(null, { from: "a@x.com" }), settings({ muted: ["@x.com"] })).outcome).toBe("action");
		expect(run(facts(null, { replied: true })).outcome).toBe("replied");
		expect(run(facts(null, { category: "suspicious" })).outcome).toBe("action"); // unread by the model, so not flagged
	});
});

describe("step 2: any one rule puts it in To action", () => {
	it("A: important sender, whatever the answers", () => {
		const d = run(facts({ sender: "marketing", addressing: "bulk" }, { from: "Boss <boss@x.com>" }), settings({ important: ["boss@x.com"] }));
		expect(d).toMatchObject({ outcome: "action", because: ["important"] });
	});

	it("B: a person asks directly, unless it's mass mail", () => {
		expect(run(facts({ sender: "person", request: "direct" })).because).toEqual(["direct"]);
		expect(run(facts({ sender: "business_person", request: "direct", addressing: "cc_you" })).because).toEqual(["direct"]);
		expect(run(facts({ sender: "person", request: "direct", addressing: "bulk" })).outcome).toBe("info");
		expect(run(facts({ sender: "person", request: "direct", addressing: "not_named" })).outcome).toBe("info");
	});

	it("C: something requires an action, whoever the model thinks sent it, unless it's bulk marketing", () => {
		// Reg.ru, as the model actually labelled it today: "marketing", but sent only to you.
		expect(run(facts({ sender: "marketing", request: "required" })).because).toEqual(["required"]);
		// A utility bill with list headers.
		expect(run(facts({ sender: "automated", request: "required", addressing: "bulk" })).because).toEqual(["required"]);
		expect(run(facts({ sender: "marketing", request: "required", addressing: "bulk" })).outcome).toBe("info");
	});

	it("D: a deadline within the window, only when something is asked of you", () => {
		const due = (d: string, s: Partial<Signals>, st?: Settings) => run(facts(s, { due: d }), st);
		expect(due("2026-10-25", { sender: "marketing", request: "required" }).because).toEqual(["required", "deadline"]);
		expect(due("2026-10-27", { sender: "person", request: "implied", addressing: "to_you" }).because).toEqual(["deadline"]);
		// Routine prompts and plain notices with a date don't count.
		expect(due("2026-10-25", { request: "routine", stakes: "high" }).outcome).toBe("info");
		expect(due("2026-10-25", { request: "none" }).outcome).toBe("info");
		// Outside the window, overdue, or bulk marketing: no.
		expect(due("2026-10-28", { sender: "person", request: "implied", addressing: "to_you" }).outcome).toBe("info");
		expect(due("2026-10-20", { sender: "person", request: "implied", addressing: "to_you" }).outcome).toBe("info");
		expect(due("2026-10-25", { sender: "marketing", request: "required", addressing: "bulk" }).outcome).toBe("info");
		// The window is the owner's setting.
		expect(due("2026-10-30", { sender: "person", request: "implied", addressing: "to_you" }, settings({ deadlineDays: 7 })).because).toEqual(["deadline"]);
	});

	it("D and E ignore direct or implied answers from automated senders stored by older versions", () => {
		expect(run(facts({ sender: "automated", request: "direct", addressing: "bulk" }, { due: "2026-10-25" })).outcome).toBe("info");
		expect(run(facts({ sender: "marketing", request: "implied" }, { due: "2026-10-25" })).outcome).toBe("info");
	});

	it("terms, privacy and policy updates never count as requiring an action", () => {
		const subject = "[Legal Notice] Updates to Google Cloud Terms of Service and AI guidelines";
		expect(run(facts({ request: "required" }, { subject })).outcome).toBe("info");
		// An important sender still gets in, through rule A.
		const important = run(facts({ request: "required" }, { subject, from: "g@google.com" }), settings({ important: ["@google.com"] }));
		expect(important.because).toEqual(["important"]);
		// A person asking directly about terms is still a direct request.
		expect(run(facts({ sender: "person", request: "direct" }, { subject: "Can you sign off the new privacy policy?" })).because).toEqual(["direct"]);
	});

	it("recognises terms and policy subjects, and nothing else", () => {
		for (const s of [
			"[Legal Notice] Updates to Google Cloud Terms of Service and AI guidelines",
			"We're updating our Terms of Use",
			"Changes to our Terms & Conditions",
			"Important: Privacy Policy update",
			"Our updated privacy notice",
			"Updates to the User Agreement",
			"Policy updates for your account",
			"Обновление политики конфиденциальности",
			"Новые условия использования сервиса",
		]) {
			expect(isPolicyUpdate(s), s).toBe(true);
		}
		for (const s of ["Invoice 42 is due", "Your hosting expires on 25 Oct", "Legal notice: court hearing on 3 Nov", "Payment terms for order 1182"]) {
			expect(isPolicyUpdate(s), s).toBe(false);
		}
	});

	it("E: a person waiting on a reply, only when you're the only recipient", () => {
		expect(run(facts({ sender: "person", request: "implied" })).because).toEqual(["waiting"]);
		expect(run(facts({ sender: "person", request: "implied", addressing: "to_you" })).outcome).toBe("info");
	});

	it("nothing else gets in: sign-in alerts, terms, marketing, a person asking nothing", () => {
		expect(run(facts({ request: "routine", stakes: "high" })).outcome).toBe("info"); // Google sign-in alert
		expect(run(facts({ sender: "marketing", addressing: "bulk" })).outcome).toBe("info");
		expect(run(facts({ sender: "person", request: "none" })).outcome).toBe("info"); // Anna's acknowledgement
	});
});

describe("step 3: urgency orders To action", () => {
	it("high for a deadline in the window or high stakes; medium for a direct ask or later deadline; else low", () => {
		expect(run(facts({ request: "required" }, { due: "2026-10-25" })).urgency).toBe("high");
		expect(run(facts({ request: "required", stakes: "high" })).urgency).toBe("high");
		expect(run(facts({ request: "required" }, { due: "2026-10-23" })).urgency).toBe("high"); // overdue
		expect(run(facts({ sender: "person", request: "direct" })).urgency).toBe("medium");
		expect(run(facts({ request: "required" }, { due: "2026-11-30" })).urgency).toBe("medium");
		expect(run(facts({ request: "required", stakes: "some" })).urgency).toBe("low"); // ParentMail-style payment
	});
});

describe("sender rules", () => {
	it("an exact address beats a domain, and domains cover subdomains", () => {
		expect(senderRule("a@mail.x.com", settings({ muted: ["@x.com"] }))).toBe("muted");
		expect(senderRule("a@notx.com", settings({ muted: ["@x.com"] }))).toBeNull();
		expect(senderRule("a@x.com", settings({ important: ["@x.com"], muted: ["a@x.com"] }))).toBe("muted");
		expect(senderRule("no address here", settings({ important: ["@x.com"] }))).toBeNull();
	});

	it("normalises addresses and domains and rejects anything else", () => {
		expect(normaliseRule(" Anna@Example.COM ")).toBe("anna@example.com");
		expect(normaliseRule("example.com")).toBe("@example.com");
		expect(normaliseRule("@sub.example.com")).toBe("@sub.example.com");
		for (const bad of ["", "anna", "a@b", "<script>@x.com", "x".repeat(300) + ".com", "javascript:alert(1)"]) {
			expect(normaliseRule(bad)).toBeNull();
		}
	});

	it("moving a sender to one list removes it from the other", () => {
		const s = withSenderRule(settings({ muted: ["a@x.com"] }), "a@x.com", "important");
		expect(s).toMatchObject({ important: ["a@x.com"], muted: [] });
		expect(withSenderRule(s, "a@x.com", "clear")).toMatchObject({ important: [], muted: [] });
	});

	it("settings survive a round trip and are cleaned on the way in and out", async () => {
		const kv = memoryKV();
		expect(await loadSettings(kv)).toEqual(DEFAULT_SETTINGS);
		await saveSettings(kv, { deadlineDays: 250, important: ["A@x.com", "a@x.com", "junk"], muted: ["a@x.com", "y.com"] });
		expect(await loadSettings(kv)).toEqual({ deadlineDays: 30, important: ["a@x.com"], muted: ["@y.com"] });
		// Settings saved by the old points version (a threshold) load as defaults plus the lists.
		kv.store.set("settings", JSON.stringify({ threshold: 50, important: "not a list", muted: [1, "@z.com"] }));
		expect(await loadSettings(kv)).toEqual({ deadlineDays: 3, important: [], muted: ["@z.com"] });
		expect(cleanDeadlineDays("-5")).toBe(0);
	});
});

describe("conversations", () => {
	const msg = (id: string, at: number, ...labelIds: string[]) => ({
		id,
		internalDate: String(at),
		labelIds,
		snippet: `text of ${id} &amp; more`,
		payload: { headers: [{ name: "From", value: labelIds.includes("SENT") ? "Me <me@x.com>" : "Ann <ann@x.com>" }] },
	});
	// Ann asks, you reply, Ann says thanks. A draft and a spam reply don't count.
	const state = {
		inInbox: new Set<string>(),
		messages: conversationOf([msg("thanks", 300, "INBOX"), msg("q", 100, "INBOX"), msg("r", 200, "SENT"), msg("d", 400, "DRAFT"), msg("s", 500, "SPAM")]),
	};

	it("reads the thread oldest first, without drafts, spam or trash", () => {
		expect(state.messages.map((m) => [m.id, m.byOwner])).toEqual([
			["q", false],
			["r", true],
			["thanks", false],
		]);
		expect(state.messages[0]).toMatchObject({ from: "Ann <ann@x.com>", preview: "text of q & more" });
	});

	it("an email is answered when you wrote anything after it", () => {
		expect(repliedAfter(state, "q")).toBe(true);
		expect(repliedAfter(state, "thanks")).toBe(false);
		expect(repliedAfter(state, "not-in-thread", 150)).toBe(true);
		expect(repliedAfter(state, "not-in-thread")).toBe(false);
	});

	it("a reply's preview keeps only its own words, not the quoted message", () => {
		expect(withoutQuote("Ok, done. On Thu, 23 Oct 2026 at 10:00, Ann <ann@x.com> wrote: can you pay")).toBe("Ok, done.");
		expect(withoutQuote("Sure -----Original Message----- From: Ann")).toBe("Sure");
		expect(withoutQuote("Готово. 23.10.2026, Анна пишет: оплатите")).toBe("Готово. 23.10.2026,");
		expect(withoutQuote("Да От: Анна")).toBe("Да");
		expect(withoutQuote("Thanks! Sent from my iPhone")).toBe("Thanks!");
		expect(withoutQuote("No quote here")).toBe("No quote here");
	});

	it("gives the earlier messages of the conversation, oldest first", () => {
		expect(earlierInThread(state, "thanks", 4).map((m) => m.id)).toEqual(["q", "r"]);
		expect(earlierInThread(state, "thanks", 1).map((m) => m.id)).toEqual(["r"]);
		expect(earlierInThread(state, "q", 4)).toEqual([]);
	});
});

describe("addressing", () => {
	it("reads addresses from display-name headers", () => {
		expect(addressesIn('"Smith, Ann" <Ann@X.com>, bob@y.co.uk')).toEqual(["ann@x.com", "bob@y.co.uk"]);
		expect(addressesIn("bob@y.co.uk (Bob), o'neil+tag@x.com")).toEqual(["bob@y.co.uk", "o'neil+tag@x.com"]);
		expect(addressesIn("undisclosed-recipients:;")).toEqual([]);
	});

	it("takes the real angle address, never one written into the display name", () => {
		expect(senderAddress('"boss@company.com" <attacker@evil.com>')).toBe("attacker@evil.com");
		expect(senderAddress("boss@company.com <attacker@evil.com>")).toBe("attacker@evil.com");
		expect(senderAddress('"a \\" boss@company.com, x" <attacker@evil.com>')).toBe("attacker@evil.com");
		expect(addressingOf("me@x.com", { to: '"me@x.com" <other@y.com>', cc: "", bulk: false })).toBe("not_named");
	});

	it("stays fast on hostile headers", () => {
		const hostile = Array.from({ length: 40 }, () => "@".repeat(998)).join("\r\n ");
		const start = performance.now();
		addressesIn(hostile);
		addressingOf("me@x.com", { to: hostile, cc: hostile, bulk: false });
		senderAddress(`${"a".repeat(50_000)}@${"b.".repeat(50_000)}`);
		expect(performance.now() - start).toBeLessThan(50);
	});

	it("tells only-you, to-you, cc and not-named apart, and bulk overrides all", () => {
		expect(addressingOf("Me@x.com", { to: "Me <me@x.com>", cc: "", bulk: false })).toBe("only_you");
		expect(addressingOf("me@x.com", { to: "me@x.com", cc: "b@x.com", bulk: false })).toBe("to_you");
		expect(addressingOf("me@x.com", { to: "a@x.com, me@x.com", cc: "", bulk: false })).toBe("to_you");
		expect(addressingOf("me@x.com", { to: "a@x.com", cc: "me@x.com", bulk: false })).toBe("cc_you");
		expect(addressingOf("me@x.com", { to: "undisclosed-recipients:;", cc: "", bulk: false })).toBe("not_named");
		expect(addressingOf("me@x.com", { to: "me@x.com", cc: "", bulk: true })).toBe("bulk");
	});

	it("recognises the owner's aliases, +tag addresses and Gmail's dotted and googlemail spellings", () => {
		const mine = ["owner@example.com", "alias@example.com"];
		expect(addressingOf(mine, { to: "Alias <ALIAS@example.com>", cc: "", bulk: false })).toBe("only_you");
		expect(addressingOf(mine, { to: "owner@example.com, alias@example.com", cc: "", bulk: false })).toBe("only_you");
		expect(addressingOf(mine, { to: "a@x.com", cc: "alias+team@example.com", bulk: false })).toBe("cc_you");
		expect(addressingOf("me@x.com", { to: "me+news@x.com", cc: "", bulk: false })).toBe("only_you");
		expect(addressingOf("john.smith@gmail.com", { to: "JohnSmith@googlemail.com, a@x.com", cc: "", bulk: false })).toBe("to_you");
		expect(addressingOf("johnsmith@googlemail.com", { to: "j.o.h.n.smith+x@gmail.com", cc: "", bulk: false })).toBe("only_you");
		// Dots matter outside Gmail.
		expect(addressingOf("john.smith@x.com", { to: "johnsmith@x.com", cc: "", bulk: false })).toBe("not_named");
		expect(deliveryAddress("A.B+tag@GoogleMail.com")).toBe("ab@gmail.com");
		expect(deliveryAddress("a.b+tag@x.com")).toBe("a.b@x.com");
	});

	it("spots list and bulk mail from headers", () => {
		const h = (o: Record<string, string>) => (n: string) => o[n];
		expect(isBulk(h({ "List-Unsubscribe": "<mailto:x>" }))).toBe(true);
		expect(isBulk(h({ "List-Id": "x.y" }))).toBe(true);
		expect(isBulk(h({ Precedence: " Bulk " }))).toBe(true);
		expect(isBulk(h({ Precedence: "first-class" }))).toBe(false);
	});
});
