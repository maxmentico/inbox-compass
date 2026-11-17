// Renders every screen of the app, in each state that matters for design, to static HTML files in
// docs/design-handover/current/. It drives the real routes and templates with an in-memory KV and
// made-up mail, so nothing here touches Gmail, Workers AI or the owner's data.
//
//   npm run ui:snapshots
//
// The files open in any browser (they are self-contained: no scripts, no external assets). Re-run after
// changing src/pages.ts or the templates in src/web.ts to see the result.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { it } from "vitest";
import type { Digest, DigestItem } from "../src/digest";
import { saveSettings } from "../src/rules";
import { createSessionCookie, readSession } from "../src/session";
import { GMAIL_READONLY_SCOPE } from "../src/config";
import { stepProgressStyleTag } from "../src/pages";
import { app, clock } from "../src/web";
import { linkAccount, makeEnv } from "../test/helpers";

const OUT = join(process.cwd(), "docs/design-handover/current");
const ORIGIN = "https://inbox-digest.example.workers.dev";
const ctx = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;
type Env = ReturnType<typeof makeEnv>;

async function signedIn(env: Env) {
	const set = await createSessionCookie(env, { sub: "owner", email: env.OWNER_EMAIL });
	const cookie = set.split(";")[0]!;
	const session = (await readSession(new Request(ORIGIN, { headers: { Cookie: cookie } }), env))!;
	return { cookie, csrf: session.csrf };
}

const get = (env: Env, path: string, cookie?: string) =>
	app.fetch(new Request(ORIGIN + path, { headers: cookie ? { Cookie: cookie } : {} }), env, ctx);

const post = (env: Env, path: string, fields: [string, string][], cookie: string) =>
	app.fetch(
		new Request(ORIGIN + path, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Cookie: cookie, Origin: ORIGIN },
			body: new URLSearchParams(fields),
		}),
		env,
		ctx,
	);

/** Only the first chunk of a streamed page: what the browser shows while a run is going. */
async function firstChunk(res: Response): Promise<string> {
	const reader = res.body!.getReader();
	const { value } = await reader.read();
	await reader.cancel();
	return new TextDecoder().decode(value);
}

const pages: { file: string; title: string; note: string }[] = [];
function save(file: string, title: string, note: string, html: string) {
	writeFileSync(join(OUT, file), html);
	pages.push({ file, title, note });
}

// --- Made-up mail ------------------------------------------------------------------------------

const RUN = "2026-10-24T06:30:00Z";
type Sig = NonNullable<DigestItem["signals"]>;
let n = 0;
function item(account: "personal" | "work", from: string, subject: string, extra: Partial<DigestItem> & { signals?: Sig }): DigestItem {
	n++;
	return {
		key: `${account}:m${n}`,
		account,
		accountEmail: `${account}@example.com`,
		messageId: `m${n}`,
		threadId: `t${n}`,
		from,
		subject,
		date: "2026-10-24T05:10:00Z",
		snippet: "",
		needsAction: false,
		action: "",
		urgency: "low",
		category: "other",
		due: null,
		summary: "",
		classified: true,
		done: false,
		...extra,
	};
}
const sig = (s: Partial<Sig>): Sig => ({ sender: "automated", request: "none", stakes: "none", addressing: "only_you", ...s });

function fullDigest(): Digest {
	n = 0;
	const items: DigestItem[] = [
		// To action, new
		item("personal", "Hostline Billing <billing@hostline.example>", "Your hosting plan ends tomorrow", {
			category: "payment",
			action: "Renew the Basic hosting plan before 25 Oct",
			summary: "The hosting plan for northwind-studio.example expires on 25 October; the site goes offline if it isn't renewed.",
			to: "personal@example.com",
			text: "Hi Max,\n\nYour Basic hosting plan for northwind-studio.example ends on 25 October 2026. If it isn't renewed, the site and its email addresses stop working the next day.\n\nPlan: Basic (1 site, 10 GB)\nRenewal: £4.99 a month, billed yearly (£59.88)\n\nRenew in your control panel: https://hostline.example/renew\n\nNeed help? Reply to this email and we'll get back to you within a day.\n\nHostline Billing",
			due: "2026-10-25",
			date: "2026-10-24T05:58:00Z",
			signals: sig({ request: "required", stakes: "high" }),
		}),
		item("work", "Priya Natarajan <priya@northwind.example>", "Can you sign off the Q4 budget by Friday?", {
			category: "decision",
			action: "Approve or comment on the Q4 budget for Priya",
			summary: "Priya needs approval of the Q4 budget spreadsheet before the finance review on Friday.",
			to: "Max <work@example.com>",
			cc: "Finance <finance@northwind.example>, Owen Price <owen@northwind.example>",
			text: "Hi Max,\n\nThe Q4 budget is in the shared folder (Q4 budget v3.xlsx). The main changes since last quarter:\n\n- Contractors: +£18k for the platform migration (Oct to Dec)\n- Travel: −£6k, since the Lisbon offsite replaces two smaller trips\n- Software: flat\n\nCould you sign it off, or leave comments in the sheet, by Friday? The finance review is on Monday morning and I'd like to send it on Friday afternoon.\n\nThanks,\nPriya",
			due: "2026-10-28",
			date: "2026-10-24T04:40:00Z",
			signals: sig({ sender: "person", request: "direct", stakes: "some", addressing: "to_you" }),
		}),
		item("work", "Tom Berger <tom@lisbon-events.example>", "Re: Contract for the Lisbon offsite", {
			category: "reply",
			action: "Confirm the venue deposit amount with Tom",
			summary: "Tom asks again whether the 30% deposit works, so he can hold the venue.",
			to: "work@example.com",
			text: "Hi Max,\n\nJust following up on the contract. The venue can hold the date until Wednesday, but they need to know whether the 30% deposit works for you before then.\n\nIf it helps, they'd accept 20% now and 10% at the end of November.\n\nBest,\nTom\n\nTom Berger · Lisbon Events\n+351 21 000 0000…",
			textCut: "quote",
			threadId: "lisbon",
			date: "2026-10-24T03:15:00Z",
			signals: sig({ sender: "business_person", request: "direct", stakes: "some", addressing: "only_you" }),
		}),
		item("work", "Tom Berger <tom@lisbon-events.example>", "Contract for the Lisbon offsite", {
			category: "reply",
			action: "Review the offsite contract and reply to Tom",
			summary: "Tom sent the venue contract for 40 people and asks for comments on the deposit terms.",
			to: "work@example.com",
			text: "Hi Max,\n\nAttached is the venue contract for the offsite, 12 to 14 November, for 40 people.\n\nThe points I'd like you to look at:\n1. Deposit: 30% on signing, the rest 14 days before.\n2. Cancellation: free up to 30 days before, 50% after that.\n3. Catering minimum: 35 people.\n\nLet me know if you'd like changes before I send it to the venue.\n\nBest,\nTom",
			threadId: "lisbon",
			date: "2026-10-22T16:20:00Z",
			signals: sig({ sender: "business_person", request: "direct", stakes: "some", addressing: "only_you" }),
		}),
		item("personal", "info@schoolpost.example", "Year 1 trip: payment due", {
			category: "payment",
			action: "Pay £16.50 for the Year 1 museum trip",
			summary: "The school asks for £16.50 per child for the museum trip, payable by 3 November.",
			to: "Parents of Year 1 <year1@schoolpost.example>",
			text: "Dear parents and carers,\n\nYear 1 will visit the Natural History Museum on Thursday 13 November. The trip costs £16.50 per child, which covers the coach and the workshop.\n\nPlease pay through ParentPay by 3 November. If cost is a concern, please speak to the school office in confidence.\n\nChildren will need a packed lunch and a waterproof coat.\n\nThank you,\nMrs Ellis, Year 1",
			due: "2026-11-03",
			date: "2026-10-23T19:56:00Z",
			signals: sig({ request: "required", stakes: "some" }),
		}),
		item("work", "(couldn't load)", "(Gmail error 500)", {
			classified: false,
			needsAction: true,
			urgency: "medium",
			action: "Check manually (couldn't be classified)",
			date: null,
		}),
		// Possible phishing
		item("personal", "Streamflix Support <billing@streamf1ix-help.example>", "Your membership is on hold", {
			category: "suspicious",
			action: "Review: possible phishing or manipulation; don't click links",
			summary: "Claims a payment failed and asks to re-enter card details on a look-alike domain.",
			to: "personal@example.com",
			text: "Dear Customer,\n\nWe were unable to process your last payment and your membership has been placed ON HOLD.\n\nTo avoid losing access, please confirm your card details within 24 hours:\nhttps://streamf1ix-help.example/account/verify\n\nIf you do not update your details, your account will be closed.\n\nStreamflix Support Team",
			signals: sig({ sender: "marketing", request: "routine", stakes: "high" }),
		}),
		// For information
		item("personal", "Google <no-reply@accounts.google.com>", "Security alert: new sign-in on Mac", {
			category: "notification",
			summary: "A new sign-in to your Google Account on a Mac; nothing to do if it was you.",
			signals: sig({ request: "routine", stakes: "some" }),
		}),
		item("work", "Anna Hudson <anna@pure-triumph.example>", "Re: Speedmaster listing", {
			category: "fyi",
			summary: "Anna confirms you've been removed from the mailing list.",
			replied: true,
			signals: sig({ sender: "person", request: "none" }),
		}),
		item("personal", "The Weekly Roast <hello@weeklyroast.example>", "Five coffees to try this autumn", {
			category: "newsletter",
			summary: "Newsletter with autumn coffee recommendations and a 15% discount code.",
			to: "personal@example.com",
			text: "This week: five coffees for the colder months.\n\n1. Huila, Colombia: red apple, caramel\n2. Yirgacheffe, Ethiopia: bergamot, peach\n3. Cerrado, Brazil: hazelnut, cocoa\n4. Antigua, Guatemala: brown sugar, orange\n5. Our autumn blend: toffee, plum\n\nUse AUTUMN15 for 15% off until Sunday.\n\nThe Weekly Roast · Unsubscribe: https://weeklyroast.example/u",
			signals: sig({ sender: "marketing", addressing: "bulk" }),
		}),
		item("personal", "Deals <offers@deals.example-shop.com>", "48 hours only: up to 60% off", {
			category: "newsletter",
			summary: "Sale announcement from a shop you muted.",
			signals: sig({ sender: "marketing", addressing: "bulk" }),
		}),
		item("work", "Cloud Console <noreply@cloud.example>", "[Legal Notice] Updates to our Terms of Service", {
			category: "notification",
			summary: "The provider is updating its terms of service and AI usage guidelines from 1 December.",
			signals: sig({ request: "required", stakes: "some" }),
		}),
		// Still open from earlier
		item("work", "Accounts <ap@supplier.example>", "Invoice 2026-118 is overdue", {
			category: "payment",
			action: "Pay invoice 2026-118 (€1,240) to Supplier Ltd",
			summary: "Supplier Ltd says invoice 2026-118 for €1,240 is 5 days overdue.",
			to: "work@example.com",
			text: "Hello,\n\nOur records show that invoice 2026-118 for €1,240.00, due on 16 October, is still unpaid.\n\nPlease arrange payment to the account on the invoice, or let us know if there is a problem with it.\n\nKind regards,\nAccounts, Supplier Ltd",
			carried: true,
			due: "2026-10-16",
			date: "2026-10-21T09:00:00Z",
			signals: sig({ sender: "automated", request: "required", stakes: "high" }),
		}),
		// Done
		item("personal", "Parcel Co <track@parcel.example>", "Your parcel needs a delivery slot", {
			category: "task",
			action: "Pick a delivery slot for the parcel",
			done: true,
			signals: sig({ request: "required", stakes: "some" }),
		}),
		// To action: estimated by yesterday's run while the model was out, re-checked by this one.
		item("work", "Lena Fischer <lena@northwind.example>", "Draft agenda for Thursday", {
			category: "reply",
			action: "Send Lena your comments on Thursday's agenda",
			summary: "Lena shared the draft agenda for Thursday's planning day and asks for comments by Monday.",
			to: "Max <work@example.com>",
			cc: "Planning <planning@northwind.example>",
			text: "Hi Max,\n\nHere's the draft agenda for Thursday's planning day:\n\n09:30 Welcome and goals\n10:00 Q4 priorities (you)\n11:30 Team breakouts\n13:00 Lunch\n14:00 Roadmap review\n16:00 Wrap-up\n\nCould you send comments by Monday, especially on whether the Q4 slot is long enough?\n\nThanks,\nLena",
			date: "2026-10-23T15:02:00Z",
			rechecked: true,
			signals: sig({ sender: "person", request: "direct", stakes: "some", addressing: "to_you" }),
		}),
		// For information: a sign-in code. Its code and link are masked when the digest is read (secrets.ts).
		item("personal", "Hostline <no-reply@hostline.example>", "Your Hostline sign-in code", {
			category: "notification",
			summary: "A sign-in code for your Hostline account, valid for 10 minutes.",
			date: "2026-10-24T05:31:00Z",
			to: "personal@example.com",
			text: "Your sign-in code is 552301. It expires in 10 minutes.\n\nDidn't ask for it? Secure your account: https://hostline.example/security?u=8812",
			signals: sig({ request: "none", stakes: "some" }),
		}),
		// For information: Gmail filed it under Promotions, so the model never saw it.
		item("personal", "Hearth & Home <offers@hearthhome.example>", "Autumn cushions are here", {
			category: "newsletter",
			summary: "New autumn cushion range, with free delivery over £40 this week.",
			date: "2026-10-24T02:12:00Z",
			filed: "Promotions",
			signals: sig({ sender: "marketing", addressing: "bulk" }),
		}),
	];
	return {
		id: RUN,
		date: "2026-10-24",
		window: { kind: "since" },
		windowFrom: "2026-10-23T19:40:00Z",
		generatedAt: RUN,
		model: "@cf/openai/gpt-oss-120b (fallback @cf/google/gemma-4-26b-a4b-it)",
		query: "in:inbox",
		// Made in steps by this job: "View last run result" and "Run details" link to its result page.
		job: "q7Kd2mXr9TfLw0ZpBvN3sA",
		items,
		accounts: [
			{ alias: "personal", email: "personal@example.com", ok: true, found: 9, newlyClassified: 7 },
			{ alias: "work", email: "work@example.com", ok: true, found: 6, newlyClassified: 6 },
		],
		modelErrors: [],
	};
}

/** A morning when the model's daily allowance ran out part-way: two emails estimated, the notice on top. */
function estimatedDigest(): Digest {
	const d = fullDigest();
	d.items = d.items.filter((i) => !i.rechecked);
	n = 20;
	d.items.push(
		item("personal", "Northwind Water <billing@northwind-water.example>", "Your water bill for October", {
			category: "payment",
			action: "Check this email (estimated)",
			summary: "Your October water bill of £42.10 is ready. Pay by 7 November to avoid a late fee.",
			to: "personal@example.com",
			text: "Your bill for October is ready.\n\nAmount due: £42.10\nPay by: 7 November 2026\n\nYou can pay online at https://northwind-water.example/pay or by phone.\n\nNorthwind Water",
			date: "2026-10-24T06:05:00Z",
			signals: sig({ request: "required", stakes: "high" }),
			estimated: { by: "history", reason: "Estimated: like ‘Your water bill for September’ from Northwind Water (24 Sep)" },
		}),
		item("personal", "Sam Ortiz <sam@ortiz.example>", "Saturday?", {
			category: "other",
			action: "Check this email (estimated)",
			summary: "Are you still up for Saturday? We could do the 10:00 train if that works.",
			to: "personal@example.com",
			text: "Hey!\n\nAre you still up for Saturday? We could do the 10:00 train if that works, and be back by 6.\n\nSam",
			date: "2026-10-24T06:20:00Z",
			signals: sig({ sender: "person", request: "none" }),
			estimated: { by: "rules", reason: "Estimated: sent to you personally; check it", check: true },
		}),
	);
	d.modelErrors = ["@cf/openai/gpt-oss-120b: 4006: you have used up your daily free allocation of 10,000 neurons"];
	d.ai = { unavailable: { reason: "quota", at: "2026-10-24T06:31:10Z" }, estimated: 2, fromHistory: 1, waiting: 5, oldestWaiting: "2026-10-22T06:31:00Z" };
	return d;
}

async function setup(): Promise<{ env: Env; cookie: string; csrf: string }> {
	const env = makeEnv({ OWNER_EMAIL: "max@example.com" });
	await linkAccount(env, "personal");
	// Linked read-only: the switches don't change its mail in Gmail, and the page says so.
	await linkAccount(env, "work", "rt-work", [GMAIL_READONLY_SCOPE]);
	// Done marks say what's done (the stored flag is only what the run saw): the parcel was ticked.
	await env.MAILBOX_KV.put("done:personal:m14", "1");
	await saveSettings(env.MAILBOX_KV, { deadlineDays: 3, important: ["priya@northwind.example"], muted: ["@deals.example-shop.com"] });
	// When each mailbox was last checked: personal a few minutes ago, work yesterday.
	await checkedAgo(env, "personal", 4 * 60_000);
	await checkedAgo(env, "work", 26 * 3_600_000);
	return { env, ...(await signedIn(env)) };
}

/** A mailbox last checked `ms` before the fixture run (kept in its cursor, as a real run does). */
async function checkedAgo(env: Env, alias: string, ms: number) {
	const at = Date.parse(RUN) - ms;
	await env.MAILBOX_KV.put(`cursor:${alias}`, JSON.stringify({ after: at - 3_600_000, checked: at }));
}

/** Six linked mailboxes, as the owner has them; port has never been checked. */
async function setupSix(): Promise<{ env: Env; cookie: string; csrf: string }> {
	const env = makeEnv({ OWNER_EMAIL: "max@example.com" });
	for (const alias of ["devlab", "mentico", "mirror", "personal", "port", "vault"]) await linkAccount(env, alias);
	const H = 3_600_000;
	for (const [alias, ago] of [["devlab", 3 * H], ["mentico", 12 * 60_000], ["mirror", 3 * 24 * H], ["personal", 26 * H], ["vault", 15 * 24 * H]] as const) await checkedAgo(env, alias, ago);
	return { env, ...(await signedIn(env)) };
}

/** A mailbox's step result in a job: completed with these counts, or (null) failed for needing re-linking. */
async function mark(env: Env, id: string, alias: string, summary: { fresh: number; toAction: number } | null) {
	const status = { alias, email: `${alias}@example.com`, ok: !!summary, found: summary?.fresh ?? 0, newlyClassified: summary?.fresh ?? 0, ...(summary ? {} : { needsRelink: true, error: "invalid_grant" }) };
	const partial = { alias, status, items: [], toCache: [], learned: [], surfaced: [], replacedCarried: [], errors: [], estimated: 0, fromHistory: 0 };
	await env.MAILBOX_KV.put(`job:${id}:${alias}`, JSON.stringify({ state: "done", attempt: 1, partial, ...(summary ? { summary: { ...summary, estimated: 0 } } : {}) }));
}

it("renders the UI snapshots", async () => {
	mkdirSync(OUT, { recursive: true });
	// Offline: nothing here may reach Gmail or Google (a step left running in the background would try).
	globalThis.fetch = async () => {
		throw new Error("offline");
	};
	// Dates on the pages are relative to now: render them as of the fixture run.
	clock.now = () => new Date(RUN);

	{
		const env = makeEnv();
		save("01-sign-in.html", "Sign-in", "The only page a signed-out visitor sees.", await (await get(env, "/")).text());
	}
	{
		const { env, cookie } = await setup();
		await env.MAILBOX_KV.put(`digest:${RUN}`, JSON.stringify(fullDigest()));
		await env.MAILBOX_KV.put("digest:2026-10-23T06:30:00Z", JSON.stringify({ ...fullDigest(), id: "2026-10-23T06:30:00Z" }));
		await env.MAILBOX_KV.put("digest:2026-10-22T18:05:11Z-test", JSON.stringify({ ...fullDigest(), id: "2026-10-22T18:05:11Z-test", test: true }));
		save(
			"02-digest.html",
			"Digest: a typical morning",
			"The main screen. New since last check: To action (with urgency, reasons, a conversation with an earlier message nested under it, an unclassified item, an item re-checked by the model after yesterday's estimate, and one item switched done, in place), Possible phishing and For information (collapsed, with an email Gmail filed under Promotions), Still open from earlier; then Test run, Mailboxes (work is read-only), Earlier runs. Expand the <details> sections to see everything.",
			await (await get(env, `/app?run=${encodeURIComponent(RUN)}&ran=1`, cookie)).text(),
		);
		// The same page with one email clicked open (the browser sets `open` on its <details>).
		save(
			"02d-digest-email-open.html",
			"Digest: an email opened in place",
			"The main screen with Priya's and Tom's emails clicked open: From, To, Cc and when it came, what they wrote (stored text, links not clickable), and Open in Gmail; Tom's had quoted earlier text, so it says that was hidden. Under For information, a sign-in code email is open: its code and link are masked, with a note. Further down, a For information email with no stored text says to open it in Gmail.",
			(await (await get(env, `/app?run=${encodeURIComponent(RUN)}`, cookie)).text())
				.replace(/(id="item-work_3am2">[\s\S]*?<details class="mail")>/, "$1 open>")
				.replace(/(id="item-work_3am3">[\s\S]*?<details class="mail")>/, "$1 open>")
				// For information, with the sign-in code email open: its code and link are masked.
				.replace(/<details class="fold">(<summary class="sec-h">For information)/, '<details class="fold" open>$1')
				.replace(/<details class="mail">(<summary><span class="src"><span class="from">Hostline<\/span><span class="subj">Your Hostline sign-in code)/, '<details class="mail" open>$1'),
		);
		{
			const { env: down, cookie: c } = await setup();
			await down.MAILBOX_KV.put(`digest:${RUN}`, JSON.stringify(estimatedDigest()));
			save(
				"02c-digest-model-unavailable.html",
				"Digest: the AI model was unavailable",
				"The model's daily allowance ran out part-way through the run: an info notice on top, two emails estimated (one from the mailbox's history, one by rules, in To action to check), each marked Estimated with the reason under Why it's here.",
				await (await get(down, `/app?run=${encodeURIComponent(RUN)}`, c)).text(),
			);
		}
		save(
			"02b-digest-earlier-run.html",
			"Digest: an earlier run",
			"An earlier run from Earlier runs: shown read-only, with no done switches.",
			await (await get(env, `/app?run=${encodeURIComponent("2026-10-23T06:30:00Z")}`, cookie)).text(),
		);
	}
	{
		const { env, cookie } = await setup();
		await env.MAILBOX_KV.put(`digest:${RUN}`, JSON.stringify(fullDigest()));
		// Everything in To action switched done, including the earlier message of the Lisbon conversation.
		for (const n of [1, 2, 3, 4, 5, 6, 15]) await env.MAILBOX_KV.put(`done:${[2, 3, 4, 6, 15].includes(n) ? "work" : "personal"}:m${n}`, "1");
		save("03b-digest-all-done.html", "Digest: all done", "Every item in To action switched done: they stay listed until the next run.", await (await get(env, "/app", cookie)).text());
	}
	{
		const { env, cookie } = await setup();
		const d = fullDigest();
		d.items = d.items.filter((i) => i.carried || ["newsletter", "notification"].includes(i.category));
		await env.MAILBOX_KV.put(`digest:${RUN}`, JSON.stringify(d));
		save("03-digest-quiet.html", "Digest: nothing new needs you", "A quiet run: nothing new to action, one item still open from earlier, some information.", await (await get(env, "/app", cookie)).text());
	}
	{
		const { env, cookie } = await setup();
		const d = { ...fullDigest(), id: `${RUN}-test`, test: true, window: { kind: "days" as const, amount: 2 }, modelErrors: ["@cf/openai/gpt-oss-120b: 3040: capacity temporarily exceeded"] };
		d.accounts = [
			{ alias: "personal", email: "personal@example.com", ok: true, found: 250, newlyClassified: 250, backlog: 40 },
			{ alias: "work", email: "work@example.com", ok: false, found: 0, newlyClassified: 0, needsRelink: true, error: "invalid_grant" },
		];
		await env.MAILBOX_KV.put(`digest:${d.id}`, JSON.stringify(d));
		save("04-digest-warnings.html", "Digest: test run with warnings", "Every warning at once: test-run banner, a mailbox that needs re-linking, a backlog, a model error.", await (await get(env, "/app", cookie)).text());
	}
	{
		const { env, cookie } = await setup();
		save("05-digest-empty.html", "Digest: first visit", "Signed in, mailboxes linked, no run yet.", await (await get(env, "/app", cookie)).text());
	}
	{
		// A run in steps, with six mailboxes: three finished (one of them failed), the fourth in progress.
		const { env, cookie, csrf } = await setupSix();
		const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
		const id = url.split("/").pop()!;
		await mark(env, id, "devlab", { fresh: 11, toAction: 1 });
		await mark(env, id, "mentico", { fresh: 4, toAction: 0 });
		await mark(env, id, "mirror", null);
		save(
			"06-run-progress.html",
			"Run now: in progress, 3 of 6",
			"A run goes one mailbox per step (each its own request, so it fits the free plan's limits): Completed with what came in, Failed with the reason, In progress with the progress line, To do. The page is streamed, then reloads itself (meta refresh, no JavaScript) for the next step.",
			await firstChunk(await get(env, url, cookie)),
		);
	}
	{
		// Its own KV: the step started for 06 above is still going in the background.
		const { env, cookie, csrf } = await setupSix();
		await post(env, "/app/run", [["csrf", csrf]], cookie);
		save("07-run-already-going.html", "Run now: another run is going", "A second Run now while a run is in progress: it offers to continue that one.", await (await post(env, "/app/run", [["csrf", csrf]], cookie)).text());
	}
	{
		const { env, cookie, csrf } = await setupSix();
		const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
		const id = url.split("/").pop()!;
		for (const [alias, fresh, toAction] of [["devlab", 11, 1], ["mentico", 4, 0], ["personal", 7, 2], ["port", 0, 0], ["vault", 2, 0]] as const) await mark(env, id, alias, { fresh, toAction });
		await mark(env, id, "mirror", null);
		const ready = (await (await get(env, url, cookie)).text()).replace(/<meta http-equiv="refresh"[^>]*>/, "");
		save(
			"06b-run-ready.html",
			"Run now: finished, opening the digest in 10 s",
			"The last step: every mailbox final (one failed), the totals and the time it took, and a 10-second countdown (meta refresh and a CSS line, removed here so the file stays put) with Open digest and Pause.",
			ready,
		);
		save(
			"06d-run-paused.html",
			"Run now: finished, paused",
			"The same page paused (Pause, or View last run result on the digest): no countdown, just Open digest.",
			await (await get(env, `${url}?paused=1`, cookie)).text(),
		);
	}
	{
		// The same six mailboxes at the start of a run, and near its end: the rows never move between states.
		const { env, cookie, csrf } = await setupSix();
		const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
		save("06a-run-start.html", "Run now: the first step", "The first step: every mailbox to do (with when it was last checked), the first in progress.", await firstChunk(await get(env, url, cookie)));
		const counting = (await firstChunk(await get(env, url, cookie))) + stepProgressStyleTag(12, 180);
		save(
			"06f-run-counting.html",
			"Run now: counting emails in one mailbox",
			"Mid-step on a heavy mailbox: the in-progress row shows 12 of 180 and a filled 2 px line (streamed style, no script).",
			counting,
		);
	}
	{
		// Its own KV: the step started for 06a is still going in the background.
		const { env, cookie, csrf } = await setupSix();
		const url = (await post(env, "/app/run", [["csrf", csrf]], cookie)).headers.get("Location")!;
		const id = url.split("/").pop()!;
		for (const [alias, fresh, toAction] of [["devlab", 11, 1], ["mentico", 4, 0], ["personal", 7, 2], ["port", 0, 0]] as const) await mark(env, id, alias, { fresh, toAction });
		await mark(env, id, "mirror", null);
		save("06e-run-last-step.html", "Run now: the last mailbox", "Five of six done (one failed), the last in progress.", await firstChunk(await get(env, url, cookie)));
	}
	{
		const { env, cookie, csrf } = await setup();
		env.MAILBOX_KV.list = async () => {
			throw new Error("KV unavailable");
		};
		env.MAILBOX_KV.store.delete("accounts-index");
		const log = console.error;
		console.error = () => {};
		save("06c-run-failed.html", "Run now: the run failed", "When a run can't even start.", await (await post(env, "/app/run", [["csrf", csrf]], cookie)).text());
		console.error = log;
	}
	{
		const { env, cookie } = await setup();
		save("08-settings.html", "Rules and settings", "Deadline window, important and not-important senders, and the rules explained.", await (await get(env, "/app/settings?saved=1", cookie)).text());
		save("09-unlink.html", "Unlink a mailbox", "Confirmation before revoking a mailbox's access.", await (await get(env, "/app/unlink?alias=work", cookie)).text());
	}
	{
		const { env, cookie, csrf } = await setup();
		save(
			"10-error.html",
			"Error page",
			"Every error uses this page (expired form, bad input, Google errors).",
			await (await post(env, "/app/settings", [["csrf", csrf], ["deadlineDays", "90"], ["important", ""], ["muted", ""]], cookie)).text(),
		);
	}

	const list = [...pages].sort((a, b) => a.file.localeCompare(b.file)).map((p) => `<li><a href="${p.file}">${p.title}</a><br><small>${p.note}</small></li>`).join("\n");
	writeFileSync(
		join(OUT, "index.html"),
		`<!doctype html><meta charset="utf-8"><title>Inbox Compass UI snapshots</title>
<body style="font:15px/1.5 system-ui;max-width:720px;margin:32px auto;padding:0 16px">
<h1>Inbox Compass: current UI</h1><p>Rendered by <code>npm run ui:snapshots</code> from the real templates with made-up mail. Links inside the pages point at the live app and won't work here.</p>
<ol>${list}</ol></body>`,
	);
});
