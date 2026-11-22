// Web UI and OAuth routes. Everything under /app requires the owner's session.

import { type Context, Hono } from "hono";
import {
	getAccount,
	lastChecks,
	listAccounts,
	listAccountsWithChecks,
	type PublicAccount,
	reconcileAccountIndex,
	removeAccount,
	saveAccount,
	toPublic,
	validateAlias,
} from "./accounts";
import { errorCode, log } from "./telemetry";
import { canModify, canRead, digestConfig, isOwner, mailboxScope, markReadEnabled } from "./config";
import {
	applySettings,
	conversationKey,
	DIGEST_ID,
	digestSections,
	isOpen,
	RECHECK_DAYS,
	type Digest,
	type DigestItem,
	getDigest,
	latestRealRun,
	listDigests,
	type LockHolder,
	reconcileRunsIndex,
	setDoneMarks,
	withDoneMarks,
	type RunWindow,
	RunInProgressError,
	TEST_LIMITS,
} from "./digest";
import { assembleBrief, briefParts, toActionBrief } from "./brief";
import { sendDigestEmail } from "./emailer";
import { JOB_AUTHORITY_LEASE_MS } from "./job-authority";
import {
	driveJob,
	JOB_ID,
	type JobRow,
	JobStoppedError,
	type JobView,
	planStep,
	readFinalizationDiagnostic,
	readJobLock,
	readResult,
	type FinalizationDiagnostic,
	releaseJobLock,
	type RunResult,
	runStep,
	startJob,
	validStepRequest,
} from "./jobs";
import { clearCookie, consumeFlow, FLOW_COOKIE, FlowError, startFlow } from "./flow";
import { getProfile, GmailClient } from "./gmail";
import { buildAuthorizeUrl, exchangeCode, fetchUserInfo, GoogleAuthError } from "./google";
import { aiNotice, dayLabel, dueLabel, itemTime, nameLooksLikeAddress, runTime, senderName, shortTime, timeAgo, toActionHeadline } from "./format";
import { errorPage, escapeHtml, ICON, page, stepProgressTick, streamPage, WORDMARK_BAR } from "./pages";
import {
	ADDRESSING_LABEL,
	cleanDeadlineDays,
	DEFAULT_DEADLINE_DAYS,
	effectiveRequest,
	loadSettings,
	MAX_DEADLINE_DAYS,
	MAX_SENDER_RULES,
	normaliseRule,
	REQUEST_LABEL,
	RULE_LABEL,
	SENDER_LABEL,
	saveSettings,
	senderAddress,
	senderRule,
	type Settings,
	STAKES_LABEL,
	withSenderRule,
} from "./rules";
import { checkCsrf, clearSessionCookie, createSessionCookie, readSession, type Session } from "./session";

type AppEnv = { Bindings: Env; Variables: { session: Session } };

export const app = new Hono<AppEnv>();

const callbackUrl = (requestUrl: string) => new URL("/callback", requestUrl).href;

function redirect(location: string, setCookies: string[] = []): Response {
	const headers = new Headers({ Location: location, "Cache-Control": "no-store" });
	for (const c of setCookies) headers.append("Set-Cookie", c);
	return new Response(null, { status: 303, headers });
}

// --- Public: sign-in ----------------------------------------------------------------------------

app.get("/", async (c) => {
	if (await readSession(c.req.raw, c.env)) return redirect("/app");
	return page(
		"Inbox Compass",
		`<h1>Inbox Compass</h1>
<p class="lede">Your mailboxes, read each morning, with the few emails that need you on top.</p>
<p class="actions"><a class="btn primary" href="/login">Sign in with Google</a></p>
<p class="note">Private. Only the configured owner can sign in.</p>`,
		{ solo: true },
	);
});

app.get("/login", async (c) => {
	// Cloudflare sets this header at the edge. Never trust caller-controlled X-Forwarded-For.
	// In local development without an edge IP, use one shared bucket rather than bypassing the limit.
	const ip = c.req.header("CF-Connecting-IP")?.trim() || "unknown";
	const { success } = await c.env.LOGIN_RATE_LIMITER.limit({ key: `login:${ip}` });
	if (!success) {
		return new Response("Too many sign-in attempts. Try again shortly.", {
			status: 429,
			headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "Retry-After": "60" },
		});
	}
	const { state, setCookie } = await startFlow(c.env.MAILBOX_KV, { kind: "login" });
	const location = buildAuthorizeUrl({
		clientId: c.env.GOOGLE_CLIENT_ID,
		redirectUri: callbackUrl(c.req.url),
		scope: "openid email profile",
		state,
		prompt: "select_account",
		loginHint: c.env.OWNER_EMAIL,
	});
	return redirect(location, [setCookie]);
});

app.post("/logout", async (c) => {
	const session = await readSession(c.req.raw, c.env);
	const form = await c.req.raw.formData();
	if (session && !checkCsrf(c.req.raw, session, form.get("csrf"))) return errorPage("Invalid form.", 403);
	return redirect("/", [clearSessionCookie()]);
});

app.get("/callback", async (c) => {
	let flow;
	try {
		flow = await consumeFlow(c.env.MAILBOX_KV, c.req.raw, c.req.query("state"));
	} catch (e) {
		return errorPage(e instanceof FlowError ? e.message : "Invalid sign-in state.");
	}
	const clear = clearCookie(FLOW_COOKIE);
	const googleError = c.req.query("error");
	if (googleError) return errorPage(`Google returned: ${googleError}. Nothing changed.`);
	const code = c.req.query("code");
	if (!code) return errorPage("Google didn't return an authorization code.");

	let tokens;
	try {
		tokens = await exchangeCode({
			clientId: c.env.GOOGLE_CLIENT_ID,
			clientSecret: c.env.GOOGLE_CLIENT_SECRET,
			code,
			redirectUri: callbackUrl(c.req.url),
		});
	} catch (e) {
		return errorPage(e instanceof GoogleAuthError ? e.message : "Couldn't complete sign-in with Google.", 502);
	}

	if (flow.kind === "login") {
		const info = await fetchUserInfo(tokens.access_token).catch(() => null);
		if (!info?.sub || !isOwner(info, c.env)) {
			return errorPage("This Google account isn't allowed to use this app.", 403);
		}
		const sessionCookie = await createSessionCookie(c.env, { sub: info.sub, email: info.email ?? "" });
		return redirect("/app", [sessionCookie, clear]);
	}

	// Linking a mailbox: the browser must also hold the owner's session.
	if (!(await readSession(c.req.raw, c.env))) return errorPage("Your session expired. Sign in and try again.", 401);
	if (!tokens.refresh_token) {
		return errorPage(
			"Google didn't issue a long-lived token. Remove this app at myaccount.google.com/connections for that account, then link again.",
		);
	}
	const scopes = (tokens.scope ?? "").split(/\s+/).filter(Boolean);
	if (!canRead(scopes)) {
		return errorPage("Gmail access wasn't granted. On Google's consent screen, tick the Gmail permission, then link again.");
	}
	let email: string;
	try {
		email = (await getProfile(tokens.access_token)).emailAddress;
	} catch (e) {
		return errorPage(`Couldn't read the mailbox profile: ${(e as Error).message}`, 502);
	}
	const all = await listAccounts(c.env.MAILBOX_KV);
	const sameEmail = all.find((a) => a.email.toLowerCase() === email.toLowerCase() && a.alias !== flow.alias);
	if (sameEmail) return errorPage(`${email} is already linked as "${sameEmail.alias}". Nothing changed.`, 409);
	const existing = all.find((a) => a.alias === flow.alias);
	if (existing && !flow.replace) {
		return errorPage(`"${flow.alias}" is already linked to ${existing.email}. Tick "replace" to re-link it.`, 409);
	}
	if (existing && existing.email.toLowerCase() !== email.toLowerCase()) {
		// Different Google account: revoke the old grant. Same account: overwrite only, because
		// revoking would also kill the token Google just issued for this grant.
		await removeAccount(c.env, existing);
	}
	await saveAccount(c.env, { alias: flow.alias, email, scopes, refreshToken: tokens.refresh_token });
	return redirect(`/app?linked=${encodeURIComponent(flow.alias)}`, [clear]);
});

// --- Owner-only ---------------------------------------------------------------------------------

app.use("/app/*", async (c, next) => {
	const session = await readSession(c.req.raw, c.env);
	if (!session) return redirect("/");
	c.set("session", session);
	if (c.req.method === "POST") {
		const form = await c.req.raw.clone().formData();
		if (!checkCsrf(c.req.raw, session, form.get("csrf"))) {
			return errorPage("This form expired or didn't come from this app. Reload and try again.", 403);
		}
	}
	await next();
});
app.use("/app", async (c, next) => {
	const session = await readSession(c.req.raw, c.env);
	if (!session) return redirect("/");
	c.set("session", session);
	await next();
});

/** The clock pages are rendered against. Tests and the UI snapshots pin it. */
export const clock = { now: (): Date => new Date() };

/** What every part of a rendered digest needs to know. */
interface View {
	tz: string;
	now: Date;
	settings: Settings;
	/** Keys of the items ticked done: they're shown in place, with their switch on. */
	done: Set<string>;
	/** Only the latest real run's page has done switches; older runs and test runs are shown read-only. */
	editable: boolean;
	/** Mailboxes whose mail the switches also mark read or unread in Gmail: alias -> linked address. */
	gmail: Map<string, string>;
}

const hiddenCsrf = (session: Session) => `<input type="hidden" name="csrf" value="${escapeHtml(session.csrf)}">`;

/** The owner's top bar: wordmark, settings, and sign-out (a CSRF-protected form). */
function ownerBar(session: Session, current?: "settings"): string {
	return `<header class="bar"><div class="bar-in"><a class="mark" href="/app">Inbox Compass</a>
<a class="btn quiet" href="/app/settings"${current === "settings" ? ' aria-current="page"' : ""}>Rules and settings</a>
<form method="post" action="/logout">${hiddenCsrf(session)}<span class="who">${escapeHtml(session.email)}</span><button class="quiet" type="submit">Sign out</button></form></div></header>`;
}

/** A one-line status message, such as "Digest refreshed.". `text` is plain text. */
/** `link`: an optional small text link after the message, [href, text], both plain. */
const flash = (text: string, kind: "ok" | "warn" = "ok", link?: [string, string]) =>
	`<p class="flash${kind === "warn" ? " warn" : ""}" role="status">${kind === "warn" ? ICON.alert : ICON.check}${escapeHtml(text)}${
		link ? ` <a class="flash-a" href="${escapeHtml(link[0])}">${escapeHtml(link[1])}</a>` : ""
	}</p>`;

/** One notices panel. Each entry is HTML the caller has already escaped. */
function noticesHtml(entries: string[], kind: "warn" | "info" = "warn"): string {
	if (!entries.length) return "";
	const icon = kind === "info" ? ICON.info : ICON.alert;
	const cls = kind === "info" ? "notice info" : "notice";
	return `<ul class="notices">${entries.map((e) => `<li class="${cls}">${icon}<div>${e}</div></li>`).join("")}</ul>`;
}

/** A section heading: the title, then how many still need you, then how many are done ("5 · 2 done"). */
const heading = (title: string, count?: number, done = 0) =>
	`${escapeHtml(title)}${count === undefined ? "" : ` <span class="n">${count}</span>`}${done ? `<span class="n">· ${done} done</span>` : ""}`;

/** A collapsible section. `cls` adds to "fold"; `body` is HTML; `open` shows it expanded. */
const fold = (cls: string, summaryHtml: string, body: string, open = false) =>
	`<details class="${cls ? `${cls} ` : ""}fold"${open ? " open" : ""}><summary class="sec-h">${summaryHtml}${ICON.plus}</summary>${body}</details>`;

function gmailLink(it: DigestItem): string {
	return `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(it.accountEmail)}#all/${encodeURIComponent(it.threadId)}`;
}

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "Important sender" / "Not important sender" buttons. They submit the surrounding digest form elsewhere. */
function senderButtons(it: DigestItem, settings: Settings): string {
	const address = it.signals ? senderAddress(it.from) : null;
	if (!address) return "";
	const value = escapeHtml(address);
	const btn = (kind: string, label: string) =>
		`<button class="sm" type="submit" formaction="/app/sender?kind=${kind}" name="sender" value="${value}">${label}</button>`;
	const rule = senderRule(it.from, settings);
	return `<div class="senders">${
		rule === "important"
			? btn("clear", "Unmark important sender")
			: rule === "muted"
				? btn("clear", "Unmute sender")
				: `${btn("important", "Important sender")}${btn("muted", "Not important sender")}`
	}</div>`;
}

/** Why the email is where it is, plain text; "" when nothing placed it (information, phishing). */
function whyText(it: DigestItem): string {
	const d = it.decision;
	if (d?.outcome === "action") return capitalise(d.because.map((r) => RULE_LABEL[r]).join(" · "));
	if (d?.outcome === "replied") return "You replied after it, so it's handled";
	if (d?.outcome === "superseded") return "A newer message in this conversation is in To action";
	if (d?.outcome === "muted") return "On your not-important list";
	if (it.filed && d?.outcome === "info") return `Gmail filed it under ${it.filed}`;
	return "";
}

/** The model's answers the rules worked from, plain text. */
function answersText(it: DigestItem): string {
	const s = it.signals;
	if (!s) return "";
	const request = effectiveRequest(s, it.subject);
	const requestLabel = REQUEST_LABEL[request] + (request === s.request ? "" : " (terms or policy update)");
	return capitalise([SENDER_LABEL[s.sender], requestLabel, STAKES_LABEL[s.stakes], ADDRESSING_LABEL[s.addressing]].join(" · "));
}

/** "Why it's here": the rule, the conversation, the answers and the sender, then the sender buttons. */
function whyHtml(it: DigestItem, settings: Settings): string {
	const address = it.signals ? senderAddress(it.from) : null;
	const facts: [string, string][] = [
		["Why", whyText(it)],
		["Estimate", it.estimated?.reason ?? ""],
		["Checked", it.rechecked ? "Estimated by an earlier run, then re-checked by the AI model" : ""],
		["Thread", it.covers ? `Covers ${it.covers} earlier unanswered message${it.covers === 1 ? "" : "s"} in this conversation` : ""],
		["Read as", answersText(it)],
		["Sender", address ?? ""],
	];
	const rows = facts
		.filter(([, v]) => v)
		.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
		.join("");
	const buttons = senderButtons(it, settings);
	if (!rows && !buttons) return "";
	return `<details class="why"><summary>${ICON.chevron}Why it's here</summary><div class="why-in">${rows ? `<dl class="facts">${rows}</dl>` : ""}${buttons}</div></details>`;
}

/** The signal line: urgency, due date, flags and mailbox, joined only from the parts that are present. */
function signalHtml(it: DigestItem, view: View): string {
	const open = isOpen(it);
	const due = open && it.due ? dueLabel(it.due, view.tz, view.now) : null;
	const parts = [
		open ? `<span class="badge u-${escapeHtml(it.urgency)}">${escapeHtml(it.urgency)}</span>` : "",
		due ? `<span class="due${due.late ? " late" : ""}">${escapeHtml(due.text)}</span>` : "",
		it.classified ? "" : '<span class="flag">Unclassified</span>',
		it.rechecked && open ? '<span class="flag">Re-checked: needs you</span>' : "",
		it.estimated ? '<span class="est">Estimated</span>' : "",
		// Which mailbox it came from: "@mentico", quiet, never split across lines.
		`<span class="mbox" title="${escapeHtml(`Mailbox: ${it.account}`)}">@${escapeHtml(it.account)}</span>`,
		it.replied ? '<span class="badge acct">you replied</span>' : "",
		// The email in Gmail, from the folded row too (a click on the row opens it here instead).
		gmailA(it, "gm", `Gmail${ICON.out}`, `Open in Gmail: ${it.subject}`),
	];
	return `<p class="sig">${parts.join("")}</p>`;
}

/** "Open in Gmail" for an item: a new tab, no referrer. `cls` and `inner` are trusted HTML. */
const gmailA = (it: DigestItem, cls: string, inner: string, label?: string) =>
	`<a class="${cls}" href="${escapeHtml(gmailLink(it))}" target="_blank" rel="noopener noreferrer"${label ? ` aria-label="${escapeHtml(label)}"` : ""}>${inner}</a>`;

/** "Anna Weber <anna@client.example>", or the header as it is. Plain text. */
function fromFull(from: string): string {
	const name = senderName(from);
	const address = senderAddress(from);
	return address && name && name !== address ? `${name} <${address}>` : from;
}

/**
 * The email, folded: sender, subject and summary are the summary of a native <details> (no script), so a
 * click anywhere on the row opens it in place. Open: From, To, Cc, when it came, what the sender wrote
 * (stored text, escaped, links inert) and "Open in Gmail". The real address is shown beside the display
 * name on possible phishing, and whenever the name could pass for an address or a domain.
 */
function mailHtml(it: DigestItem, view: View): string {
	const name = senderName(it.from);
	const address = senderAddress(it.from);
	const showAddress = !!address && address !== name && (it.category === "suspicious" || nameLooksLikeAddress(name));
	const from = name
		? `<span class="from">${escapeHtml(name)}${showAddress ? ` <span class="addr mono">${escapeHtml(`<${address}>`)}</span>` : ""}</span>`
		: "";
	const summary = it.summary ? `<span class="sum">${escapeHtml(it.summary)}</span>` : "";
	const facts: [string, string][] = [
		["From", fromFull(it.from)],
		["To", it.to ?? ""],
		["Cc", it.cc ?? ""],
		["Received", it.date ? runTime(it.date, view.tz, view.now) : ""],
	];
	const rows = facts
		.filter(([, v]) => v)
		.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`)
		.join("");
	const cut =
		it.textCut === "quote"
			? '<p class="note mail-cut">Earlier quoted text hidden — open in Gmail for the full email.</p>'
			: it.textCut === "length"
				? '<p class="note mail-cut">Shortened — open in Gmail for the full email.</p>'
				: "";
	// Sign-in codes and links were masked when the digest was made, and again when it was read (secrets.ts).
	const secure = it.security ? '<p class="note mail-cut">Codes and links are hidden for safety. Open in Gmail to see them.</p>' : "";
	const text = it.text?.trim()
		? `<div class="mail-text">${escapeHtml(it.text.trim())}</div>${secure}${cut}`
		: `<p class="note mail-none">The text of this email wasn't kept. Open it in Gmail to read it.</p>${secure}`;
	return `<details class="mail"><summary><span class="src">${from}<span class="subj">${escapeHtml(it.subject)}${ICON.chevron}</span></span>${summary}</summary><div class="mail-in"><dl class="facts">${rows}</dl>${text}<p class="mail-go">${gmailA(it, "btn sm", `Open in Gmail${ICON.out}<span class="vh"> (new tab)</span>`)}</p></div></details>`;
}

/** Earlier unanswered messages of a conversation, folded under its newest one; `expand` when the newest is done but one of these isn't. */
function threadHtml(covered: DigestItem[], view: View, expand: boolean): string {
	if (!covered.length) return "";
	const n = covered.length;
	return `<details class="thread"${expand ? " open" : ""}><summary>${ICON.chevron}${n} earlier message${n === 1 ? "" : "s"} in this conversation</summary><div class="thread-in"><ul class="items">${covered
		.map((c) => itemHtml(c, view, {}))
		.join("")}</ul></div></details>`;
}

/** The fragment id of an item: its key with anything outside [A-Za-z0-9-] encoded, so it's safe in a URL and unique. */
export function itemAnchor(key: string): string {
	return `item-${key.replace(/[^A-Za-z0-9-]/g, (ch) => `_${ch.charCodeAt(0).toString(16)}`)}`;
}

/** Whether switching this item also marks it read or unread in Gmail. */
const changesGmail = (it: DigestItem, view: View) => view.gmail.get(it.account)?.toLowerCase() === it.accountEmail.toLowerCase();

/**
 * The column left of an item. On the latest run, the done switch: a submit button of the digest form.
 * Off, it marks the item done (/app/done); on, it undoes that (/app/undone). Elsewhere, a check on done
 * items. The column is a dead zone for the row's click area, so a near-miss on the switch opens nothing.
 */
function sideHtml(it: DigestItem, view: View, done: boolean): string {
	if (!view.editable) return `<span class="side">${done ? `<span class="done-mark">${ICON.check}<span class="vh">Done</span></span>` : ""}</span>`;
	const gmail = changesGmail(it, view) ? (done ? " (switching off marks it unread in Gmail)" : " (marks it read in Gmail)") : "";
	const label = `Done: ${it.action && isOpen(it) ? it.action : it.subject}${gmail}`;
	return `<span class="side"><button class="switch" type="submit" formaction="/app/${done ? "undone" : "done"}" name="item" value="${escapeHtml(it.key)}" role="switch" aria-checked="${done}" aria-label="${escapeHtml(label)}">${SWITCH_CHECK}</button></span>`;
}

const SWITCH_CHECK = '<svg width="10" height="10" viewBox="0 0 14 14" aria-hidden="true"><path d="m3 7.5 2.5 2.5L11 4.5"/></svg>';

/**
 * One email. Full items lead with the action; `lite` ones (information, phishing) lead with the sender
 * and subject and put the signal line after the summary. A done item stays where it is, dimmed. The
 * subject stretches over the whole row, so clicking anywhere on it opens the email in place (mailHtml).
 */
function itemHtml(it: DigestItem, view: View, opts: { lite?: boolean }, covered: DigestItem[] = []): string {
	const done = view.done.has(it.key);
	const when = itemTime(it.date, view.tz, view.now);
	const time = when ? `<time class="when" datetime="${escapeHtml(it.date ?? "")}">${escapeHtml(when)}</time>` : "";
	const action = !opts.lite && isOpen(it) && it.action ? `<p class="act">${escapeHtml(it.action)}</p>` : "";
	const body = opts.lite ? `${mailHtml(it, view)}${signalHtml(it, view)}` : `${action}${signalHtml(it, view)}${mailHtml(it, view)}`;
	return `<li class="item${done ? " is-done" : ""}" id="${itemAnchor(it.key)}">${sideHtml(it, view, done)}${time}<div class="body">
${body}
${whyHtml(it, view.settings)}${threadHtml(covered, view, done && covered.some((c) => !view.done.has(c.key)))}</div></li>`;
}

/**
 * The top of an empty To action: "Nothing new needs you." and where the rest of the mail went, or,
 * when everything in it is ticked, "All done.".
 */
function calmHtml(d: Digest, fyi: number, suspicious: number, allDone: boolean): string {
	const since = d.window?.kind === "since" ? "since the last check" : "in this run";
	const n = fyi + suspicious;
	const where = [fyi ? "For information" : "", suspicious ? "Possible phishing" : ""].filter(Boolean).join(" and ");
	const [title, note] = allDone
		? ["All done.", "Everything in To action is ticked off. It stays listed below until the next run; switch back a mistake before then."]
		: [
				"Nothing new needs you.",
				n
					? `${n} email${n === 1 ? "" : "s"} came in ${since}. None ask anything of you; ${n === 1 ? "it's" : "they're"} under ${where}.`
					: `No new email came in ${since}.`,
			];
	return `<div class="calm"><span class="calm-mark">${ICON.check}</span><div><p class="calm-t">${title}</p><p class="note">${escapeHtml(note)}</p></div></div>`;
}

/** A few friendly words on how much To action holds (since last check), or what a test run looked at. */
function windowTitle(d: Digest, done: Set<string>): string {
	const w = d.window;
	if (!w) return "Digest";
	if (w.kind === "since") {
		const { open, stillOpen } = digestSections(d);
		const { needsYou } = conversations(d, done);
		return toActionHeadline(open.filter(needsYou).length, open.length, stillOpen.filter(needsYou).length);
	}
	if (w.kind === "emails") return `Test run: last ${w.amount} emails per mailbox`;
	return `Test run: last ${w.amount} ${w.kind}`;
}

/** "Since Fri 23 Oct, 20:40 · 2 mailboxes". */
function windowSub(d: Digest, view: View): string {
	const from = d.windowFrom && d.window?.kind !== "emails" ? `${d.window?.kind === "since" ? "Since" : "From"} ${runTime(d.windowFrom, view.tz, view.now)}` : "";
	const n = d.accounts.length;
	return [from, `${n} mailbox${n === 1 ? "" : "es"}`].filter(Boolean).join(" · ");
}

/** "Sat 24 Oct, 07:30", plus " · test" for a test run. Runs stored by date only show the date. */
function runLabel(id: string, view: View): string {
	const at = id.slice(0, 20);
	const when = at.length === 20 ? runTime(at, view.tz, view.now) : id;
	return id.endsWith("-test") ? `${when} · test` : when;
}

const runNowForm = (session: Session, primary: boolean) =>
	`<form method="post" action="/app/run">${hiddenCsrf(session)}<button${primary ? ' class="primary"' : ""} type="submit">Run now</button></form>`;

function digestHead(d: Digest, session: Session, view: View): string {
	return `<div class="head"><div><p class="eyebrow mono">${escapeHtml(runLabel(d.id, view))}</p><h1>${escapeHtml(windowTitle(d, view.done))}</h1><p class="sub">${escapeHtml(windowSub(d, view))}</p></div>
${runNowForm(session, false)}</div>`;
}

/** First visit: no digest yet, with the three first-run steps. */
function emptyHead(session: Session, accounts: PublicAccount[]): string {
	const linked = accounts.length > 0;
	const step = (n: number, done: boolean, title: string, note: string) =>
		`<li${done ? ' class="done"' : ""}><span class="step-n${done ? "" : " mono"}">${done ? ICON.check : n}</span><div><p class="step-t">${title}</p><p class="note">${escapeHtml(note)}</p></div></li>`;
	const sub = linked
		? "Each morning's run lists what came in overnight. Run one now to see today's; it takes about a minute."
		: "Link a mailbox first, under Mailboxes below. Then run one to see today's digest; it takes about a minute.";
	return `<div class="head"><div><h1>No digest yet</h1><p class="sub">${escapeHtml(sub)}</p></div>
${runNowForm(session, linked)}</div>
<ol class="steps">
${step(1, linked, "Link a mailbox", linked ? `${accounts.length} linked: ${accounts.map((a) => a.alias).join(", ")}.` : "Give it an alias, then choose the Google account on the next screen.")}
${step(2, false, "Run now", "Fetches mail that arrived since the last check, sorts it, and lists what needs you.")}
${step(3, false, "Tick what you've dealt with", "Then mark it done. Tomorrow's digest starts where this one stops.")}
</ol>`;
}

/** The info panel (test run, earlier run, the model unavailable), then ONE warning panel for everything that went wrong. */
function digestNotices(d: Digest, latest: string | null, view: View): string {
	const info = d.test ? ["<p>Test run: the last-check cursor was not moved.</p>"] : [];
	// Estimates are a fallback that worked, so this is information, with the model's error as the detail.
	if (d.ai) {
		const detail = d.modelErrors[0] ? `<p class="note mono">${escapeHtml(d.modelErrors[0])}</p>` : "";
		info.push(`<p>${escapeHtml(aiNotice(d.ai, view.tz, view.now))}</p>${detail}`);
	}
	if (d.id !== latest) {
		const where = latest ? ` <a href="/app?run=${encodeURIComponent(latest)}">Open the latest run</a>` : "";
		info.push(`<p>${d.test ? "Items on a test run can't be switched done." : "This is an earlier run, shown as it is now. Its items can't be switched done."}${where}</p>`);
	}
	const warnings: string[] = [];
	const alias = (a: { alias: string }) => `<strong>${escapeHtml(a.alias)}</strong>`;
	// Broken mailboxes first: they need the owner to act.
	for (const a of d.accounts.filter((a) => !a.ok)) {
		const what = a.needsRelink ? " needs re-linking." : `: ${escapeHtml((a.error ?? "failed").replace(/\.$/, ""))}.`;
		warnings.push(`<p>${alias(a)}${what} <a href="#mailboxes">Go to Mailboxes</a></p>`);
	}
	for (const a of d.accounts.filter((a) => a.ok)) {
		if (a.truncated) warnings.push(`<p>${alias(a)}: more mail than one run can list; the oldest of it wasn't looked at.</p>`);
		if (a.backlog) {
			warnings.push(`<p>${alias(a)}: ${escapeHtml(String(a.backlog))} newer emails are waiting. This run took the oldest ${escapeHtml(String(a.found))}; click Run now again to continue.</p>`);
		}
	}
	if (d.modelErrors.length && !d.ai) {
		warnings.push(`<p>The model failed on some emails; they're listed as unclassified.</p><p class="note mono">${escapeHtml(d.modelErrors[0] ?? "")}</p>`);
	}
	return noticesHtml(info, "info") + noticesHtml(warnings);
}

/**
 * Older unanswered messages of a conversation, listed under its newest one; and whether an item still
 * needs the owner (it, or an earlier message of its conversation, isn't done).
 */
function conversations(d: Digest, done: Set<string>) {
	const covered = new Map<string, DigestItem[]>();
	for (const i of d.items.filter((i) => i.decision?.outcome === "superseded")) {
		covered.set(conversationKey(i), [...(covered.get(conversationKey(i)) ?? []), i]);
	}
	const nested = (i: DigestItem) => (i.needsAction ? (covered.get(conversationKey(i)) ?? []) : []);
	const needsYou = (i: DigestItem) => !done.has(i.key) || nested(i).some((c) => !done.has(c.key));
	return { nested, needsYou };
}

/**
 * The digest: To action, Possible phishing, For information and Still open from earlier. One form, so
 * every done switch and sender button posts the run id and the CSRF token. It has no text field, so
 * Enter never submits it.
 */
function digestHtml(d: Digest, session: Session, view: View, hint: string): string {
	const { nested, needsYou } = conversations(d, view.done);
	const { open, suspicious, fyi, stillOpen } = digestSections(d);
	const hidden = `${hiddenCsrf(session)}<input type="hidden" name="run" value="${escapeHtml(d.id)}">`;
	const list = (items: DigestItem[], lite = false) =>
		`<ul class="items${lite ? " lite" : ""}">${items.map((i) => itemHtml(i, view, { lite }, nested(i))).join("")}</ul>`;
	const head = (title: string, items: DigestItem[]) => {
		const left = items.filter(needsYou).length;
		return heading(title, left, items.length - left);
	};
	const allDone = open.length > 0 && !open.some(needsYou);
	// To action as one message for an LLM: the text is rendered here (escaped, in a hidden textarea); the
	// script only copies its value. Without the script, the icon is a link to the same text as text/plain.
	const parts = briefParts(d, view.tz, view.now);
	const brief = assembleBrief(parts, (k) => view.done.has(k));
	const copy = parts.tops.length
		? `<span class="copy-msg" id="copy-msg" role="status"></span><span class="copy-note">Paste only into a chat with browsing, connectors and tools turned off.</span><a class="copy" href="${escapeHtml(`/app/copy?run=${encodeURIComponent(d.id)}`)}" data-copy data-count="${brief.count}" aria-label="Copy To action for an LLM" title="Copy To action for an LLM">${ICON.copy}</a>`
		: "";
	// Every item's text, done or not (escaped, never shown): the script puts the message together from
	// these for the switches as they are when the owner clicks. The visible-on-fallback textarea starts
	// with the message for the page as rendered; the script replaces its value before copying.
	const ta = (attr: string, text: string) => `<textarea ${attr} readonly tabindex="-1">${escapeHtml(text)}</textarea>`;
	const partsHtml = `<div id="copy-parts" hidden>${ta("data-head", parts.head)}${parts.tops
		.map(
			(t) =>
				`<div data-top="${escapeHtml(t.key)}" data-done="${view.done.has(t.key) ? 1 : 0}">${ta("data-block", t.block)}${t.earlier
					.map((e) => `<div data-earlier="${escapeHtml(e.key)}" data-done="${view.done.has(e.key) ? 1 : 0}">${ta("data-nested", e.nested)}${ta("data-alone", e.alone)}</div>`)
					.join("")}</div>`,
		)
		.join("")}</div>`;
	const copyText = parts.tops.length ? `<textarea id="copy-text" class="copy-text vh" readonly tabindex="-1" aria-hidden="true">${escapeHtml(brief.text)}</textarea>${partsHtml}` : "";
	const top = open.length && !allDone ? (hint ? `<p class="note hint">${escapeHtml(hint)}</p>` : "") : calmHtml(d, fyi.length, suspicious.length, allDone);

	return `<form method="post" action="/app/done" class="digest">${hidden}
<section class="sec lead"><h2 class="sec-h">${head("To action", open)}${copy}</h2>${top}${open.length ? list(open) : ""}</section>
${suspicious.length ? fold("sec alert", `${ICON.alert}${head("Possible phishing", suspicious)}`, list(suspicious, true)) : ""}
${fyi.length ? fold("", head("For information", fyi), list(fyi, true), open.length === 0) : ""}
${stillOpen.length ? `<section class="sec"><h2 class="sec-h">${head("Still open from earlier", stillOpen)}</h2>${list(stillOpen)}</section>` : ""}
<p class="runinfo mono">Run ${escapeHtml(shortTime(d.generatedAt, view.tz, view.now))} · ${escapeHtml(d.model)} · <code>${escapeHtml(d.query)}</code>${
		d.job ? ` · <a href="${escapeHtml(resultUrl(d.job))}">Run details</a>` : ""
	}</p>
</form>${copyText}`;
}

/** What the done switches do, under the To action header. */
function doneHint(markRead: boolean, accounts: PublicAccount[]): string {
	const later = "Switch back a mistake before the next run.";
	if (!markRead) return `Switch on what you've dealt with. Gmail isn't changed. ${later}`;
	const readOnly = accounts.filter((a) => !canModify(a.scopes)).map((a) => a.alias);
	return `Switch on what you've dealt with. It's marked read in Gmail too${readOnly.length ? `, except in ${readOnly.join(", ")} (read-only)` : ""}. ${later}`;
}

function testRunHtml(session: Session): string {
	return fold(
		"sec",
		heading("Test run"),
		`<form method="post" action="/app/run" class="pad">${hiddenCsrf(session)}
<p class="note">Looks at the window you pick, shows everything in it, and never moves the last-check cursor, so the next real run is unaffected.</p>
<div class="fields"><label class="check">Window <select name="window"><option value="since">Since last check</option><option value="hours">Last N hours</option><option value="days" selected>Last N days</option><option value="emails">Last N emails per mailbox</option></select></label>
<label class="check">N <input type="number" name="amount" min="1" max="${TEST_LIMITS.emails}" value="1" class="num"></label></div>
<div class="fields"><label class="check"><input type="checkbox" name="reclassify" value="1">Re-classify (ignore cached answers; uses Workers AI allowance)</label></div>
<div class="fields"><button type="submit" name="test" value="1">Start test run</button></div></form>`,
	);
}

/**
 * "last checked 3 h ago" (relative, in a <time> with the ISO time, and the local time as its title), or
 * "never checked". Kept on one line.
 */
function lastCheckedHtml(at: number | undefined, tz: string, now: Date, label = "last checked"): string {
	if (at === undefined) return `<span class="nw">${label === "last checked" ? "never checked" : "Never checked"}</span>`;
	const iso = new Date(at).toISOString();
	return `<span class="nw">${label} <time class="ago" datetime="${escapeHtml(iso)}" title="${escapeHtml(runTime(iso, tz, now))}">${escapeHtml(timeAgo(at, now))}</time></span>`;
}

/** Linked mailboxes, flagging any that failed in the digest shown, then the link form. */
function mailboxesHtml(accounts: PublicAccount[], d: Digest | null, session: Session, view: View, markRead: boolean, checked: Map<string, number>): string {
	const failed = new Map((d?.accounts ?? []).filter((a) => !a.ok).map((a) => [a.alias, a]));
	const rows = accounts
		.map((a) => {
			const bad = failed.get(a.alias);
			const flag = bad ? `<span class="flag">${bad.needsRelink ? "Needs re-linking" : "Failed in this run"}</span> · ` : "";
			const access = canModify(a.scopes) ? "Read + mark read" : "Read-only";
			return `<li class="mrow${bad ? " bad" : ""}"><div><p class="alias">${escapeHtml(a.alias)}</p><p class="note">${escapeHtml(a.email)}</p></div><p class="note">${flag}${access} · linked ${escapeHtml(dayLabel(a.linkedAt, view.tz, view.now))} · ${lastCheckedHtml(checked.get(a.alias), view.tz, view.now)}</p><a class="btn sm quiet" href="/app/unlink?alias=${encodeURIComponent(a.alias)}" aria-label="Unlink ${escapeHtml(a.alias)}">Unlink</a></li>`;
		})
		.join("\n");
	const relink = [...failed.values()].some((a) => a.needsRelink) ? " To re-link, enter the same alias and tick Replace." : "";
	return `<section class="sec" id="mailboxes"><h2 class="sec-h">${heading("Mailboxes", accounts.length || undefined)}</h2>${
		accounts.length ? `<ul class="rows">\n${rows}</ul>` : '<p class="note pad">No mailboxes linked yet.</p>'
	}
<form method="post" action="/app/link" class="fields">${hiddenCsrf(session)}<input type="text" name="alias" placeholder="Alias, e.g. mentico" required pattern="[a-z0-9][a-z0-9-]{0,31}" autocapitalize="none" autocomplete="off" aria-label="Alias"><label class="check"><input type="checkbox" name="replace" value="1">Replace</label><button${accounts.length ? "" : ' class="primary"'} type="submit">Link mailbox</button></form>
<p class="note gap">You'll choose the Google account on the next screen. Access requested: ${markRead ? "read + mark as read" : "read-only"}.${relink}</p></section>`;
}

function earlierRunsHtml(runs: string[], shown: string | undefined, view: View): string {
	if (!runs.length) return "";
	return `<section class="sec"><h2 class="sec-h">${heading("Earlier runs", runs.length)}</h2><nav class="runs mono" aria-label="Earlier runs">${runs
		.map((r) => `<a href="/app?run=${encodeURIComponent(r)}"${r === shown ? ' aria-current="page"' : ""}>${escapeHtml(runLabel(r, view))}</a>`)
		.join("")}</nav></section>`;
}

app.get("/app", async (c) => {
	const session = c.get("session");
	const cfg = digestConfig(c.env);
	const requested = c.req.query("run");
	const runs = await listDigests(c.env.MAILBOX_KV);
	const id = requested && DIGEST_ID.test(requested) ? requested : runs[0];
	const [stored, { accounts, checked }, settings, latest, lock] = await Promise.all([
		id ? getDigest(c.env.MAILBOX_KV, id) : null,
		listAccountsWithChecks(c.env.MAILBOX_KV),
		loadSettings(c.env.MAILBOX_KV),
		latestRealRun(c.env.MAILBOX_KV),
		readJobLock(c.env),
	]);
	// Done marks say what's done. Done items stay where they were until the next run: lay the page out
	// as if none were done, and show which ones are with their switches.
	const marked = stored && (await withDoneMarks(c.env.MAILBOX_KV, stored));
	const done = new Set((marked?.items ?? []).filter((i) => i.done).map((i) => i.key));
	const digest = marked && applySettings({ ...marked, items: marked.items.map((i) => ({ ...i, done: false })) }, settings);
	const markRead = markReadEnabled(c.env);
	const gmail = new Map(markRead ? accounts.filter((a) => canModify(a.scopes)).map((a) => [a.alias, a.email]) : []);
	const editable = !!digest && digest.id === latest;
	const view: View = { tz: cfg.timeZone, now: clock.now(), settings, done, editable, gmail };
	const linked = c.req.query("linked");
	const ran = c.req.query("ran");
	const failed = (c.req.query("gmail") ?? "").split(",").filter((a) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(a));

	return page(
		"Inbox Compass",
		`${digest ? digestHead(digest, session, view) : emptyHead(session, accounts)}
${runningNotice(lock, cfg.timeZone)}${linked ? flash(`Linked ${linked}.`) : ""}${ran ? flash("Digest refreshed.", "ok", digest?.job ? [resultUrl(digest.job), "View last run result"] : undefined) : ""}${failed.length ? flash(`Saved here, but Gmail couldn't be updated for ${failed.join(", ")}.`, "warn") : ""}
${digest ? `${digestNotices(digest, latest, view)}\n${digestHtml(digest, session, view, editable ? doneHint(markRead, accounts) : "")}` : ""}
<div class="tools">
${testRunHtml(session)}
${mailboxesHtml(accounts, digest, session, view, markRead, checked)}
${earlierRunsHtml(runs, digest?.id, view)}
</div>`,
		// The done-switch script only where there are switches: the latest real run.
		// The one script (done switches and the copy icon) only where there are switches: the latest real
		// run. Elsewhere the copy icon is a plain link to the same text.
		{ bar: ownerBar(session), script: editable, runStartScript: true },
	);
});

/**
 * The done switches: marks the items done (and read in Gmail, when enabled) or undoes that (and marks
 * them unread again). Only the latest real run's items, and only keys that are in it; ids are never
 * taken from anywhere else. Gmail is changed only for items whose done state changed, in a mailbox
 * still linked to the same Google account with modify access. Read-only mailboxes are skipped quietly
 * (the page says so); a Gmail error comes back as a one-line notice on the item.
 */
async function setDone(c: Context<AppEnv>, done: boolean): Promise<Response> {
	// The done-switch script asks for JSON and updates the page in place; a plain form post is redirected.
	const wantsJson = (c.req.header("Accept") ?? "").includes("application/json");
	// `code` tells the script what helps: "stale" (reload the page) or "invalid".
	const fail = (message: string, status: 400 | 404 | 409) =>
		wantsJson ? jsonResponse({ ok: false, code: status === 400 ? "invalid" : "stale", error: message }, status) : errorPage(message, status);
	const form = await c.req.raw.formData();
	const run = String(form.get("run") ?? "");
	const keys = form.getAll("item").map(String);
	if (keys.length === 0) return wantsJson ? fail("No item.", 400) : backToDigest(run);
	const [digest, latest] = await Promise.all([getDigest(c.env.MAILBOX_KV, run), latestRealRun(c.env.MAILBOX_KV)]);
	if (!digest) return fail("That digest no longer exists.", 404);
	if (digest.id !== latest) return fail("Only the latest run's items can be switched done. Open the latest run and try there.", 409);

	const known = new Map(digest.items.map((i) => [i.key, i]));
	const selected = keys.map((k) => known.get(k)).filter((i): i is DigestItem => !!i);
	if (wantsJson && selected.length === 0) return fail("That item isn't in this run.", 400);
	const changed = new Set(await setDoneMarks(c.env.MAILBOX_KV, selected.map((i) => i.key), done));

	const failed: string[] = [];
	let updated = false;
	// The done mark is already saved. The script shows the flip before this reply, so the browser may
	// go away now: waitUntil lets the Gmail calls finish anyway, and awaiting them still reports failures.
	const gmailWork = (async () => {
		if (!markReadEnabled(c.env)) return;
		const byAccount = new Map<string, DigestItem[]>();
		for (const it of selected.filter((i) => changed.has(i.key))) byAccount.set(it.account, [...(byAccount.get(it.account) ?? []), it]);
		await Promise.all(
			[...byAccount].map(async ([alias, items]) => {
				const account = await getAccount(c.env.MAILBOX_KV, alias);
				if (!account || !canModify(account.scopes)) return;
				// Re-linked to another Google account since: these message ids aren't in it.
				const same = items.filter((i) => i.accountEmail.toLowerCase() === account.email.toLowerCase());
				if (same.length < items.length) failed.push(alias);
				if (!same.length) return;
				try {
					const gmail = new GmailClient(c.env, account);
					const ids = same.map((i) => i.messageId);
					await (done ? gmail.markRead(ids) : gmail.markUnread(ids));
					updated = true;
				} catch (e) {
					console.error(`mark ${done ? "read" : "unread"} failed for ${alias}`, (e as Error).message);
					if (!failed.includes(alias)) failed.push(alias);
				}
			}),
		);
	})();
	c.executionCtx.waitUntil(gmailWork);
	await gmailWork;
	if (wantsJson) {
		const gmail = failed.length ? "failed" : updated ? "ok" : "skipped";
		return jsonResponse({ ok: true, done, gmail, ...(failed.length ? { mailbox: failed.sort().join(", ") } : {}) });
	}
	return redirect(digestUrl(run, selected[0]?.key, failed));
}

/** A JSON reply for the done-switch script: never cached, never sniffed as HTML. */
function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
	});
}

// To action as plain text for an LLM: what the copy icon copies, for when the script can't run.
app.get("/app/copy", async (c) => {
	const id = c.req.query("run") ?? "";
	const stored = DIGEST_ID.test(id) ? await getDigest(c.env.MAILBOX_KV, id) : null;
	const headers = { "Content-Type": "text/plain; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" };
	if (!stored) return new Response("That run no longer exists.\n", { status: 404, headers });
	const [marked, settings] = await Promise.all([withDoneMarks(c.env.MAILBOX_KV, stored), loadSettings(c.env.MAILBOX_KV)]);
	const done = new Set(marked.items.filter((i) => i.done).map((i) => i.key));
	const digest = applySettings({ ...marked, items: marked.items.map((i) => ({ ...i, done: false })) }, settings);
	return new Response(toActionBrief(digest, done, digestConfig(c.env).timeZone, clock.now()).text, { headers });
});

app.post("/app/done", (c) => setDone(c, true));
app.post("/app/undone", (c) => setDone(c, false));

/** The digest page of a run, scrolled to an item when one is given; `failed` names mailboxes Gmail couldn't update. */
function digestUrl(run: unknown, key?: string, failed: string[] = []): string {
	const id = typeof run === "string" && DIGEST_ID.test(run) ? run : "";
	const query = [id ? `run=${encodeURIComponent(id)}` : "", failed.length ? `gmail=${encodeURIComponent(failed.sort().join(","))}` : ""].filter(Boolean);
	return `/app${query.length ? `?${query.join("&")}` : ""}${key ? `#${itemAnchor(key)}` : ""}`;
}

function backToDigest(run: unknown): Response {
	return redirect(digestUrl(run));
}

// Submitted by the per-email sender buttons, which sit inside the digest's "done" form.
app.post("/app/sender", async (c) => {
	const form = await c.req.raw.formData();
	const kind = c.req.query("kind");
	const rule = normaliseRule(String(form.get("sender") ?? ""));
	if (!rule || !rule.includes("@") || rule.startsWith("@") || (kind !== "important" && kind !== "muted" && kind !== "clear")) {
		return errorPage("That sender couldn't be saved.");
	}
	const settings = await loadSettings(c.env.MAILBOX_KV);
	if (kind !== "clear" && settings[kind].length >= MAX_SENDER_RULES) {
		return errorPage("Too many sender rules. Remove some in Settings first.");
	}
	await saveSettings(c.env.MAILBOX_KV, withSenderRule(settings, rule, kind));
	return backToDigest(form.get("run"));
});

function settingsHtml(s: Settings, csrf: string, saved: boolean): string {
	return `<a class="crumb" href="/app">${ICON.back}Back to digest</a>
<div class="head"><div><h1>Rules and settings</h1><p class="sub">How the digest decides what goes in To action.</p></div></div>
${saved ? flash("Saved. The digest is re-sorted with these settings.") : ""}
<form method="post" action="/app/settings" class="settings">${csrf}
<div class="set"><div><h2 class="set-h"><label for="deadline">Deadline window</label></h2><p class="note">A deadline this many days away or closer counts as soon: it puts an email that asks something of you in To action, and makes it high urgency.</p></div>
<div class="fields top"><input id="deadline" type="number" name="deadlineDays" min="0" max="${MAX_DEADLINE_DAYS}" step="1" value="${escapeHtml(String(s.deadlineDays))}" class="num"><span class="note">days (default ${DEFAULT_DEADLINE_DAYS})</span></div></div>
<div class="set"><div><h2 class="set-h"><label for="important">Important senders</label></h2><p class="note">Always in To action. One per line: an address (anna@example.com) or a whole domain (@example.com).</p></div>
<textarea id="important" name="important" rows="6" spellcheck="false" autocapitalize="none">${escapeHtml(s.important.join("\n"))}</textarea></div>
<div class="set"><div><h2 class="set-h"><label for="muted">Not important senders</label></h2><p class="note">Never in To action; shown under For information. Possible phishing is still flagged.</p></div>
<textarea id="muted" name="muted" rows="6" spellcheck="false" autocapitalize="none">${escapeHtml(s.muted.join("\n"))}</textarea></div>
<div class="savebar"><button class="primary" type="submit">Save settings</button></div>
</form>
<section class="sec doc"><h2 class="sec-h">How emails are sorted</h2>
<p class="note pad">The model answers questions about each email; whether it was sent to you personally comes from its headers, not the model. Mass mail means a mailing list, or you not named in To or Cc.</p>
<div class="doc-grid">
<div><h3>Kept out of To action</h3><p class="note">First match wins.</p>
<ol class="rules"><li>You ticked it done.</li><li>It looks like phishing: shown under Possible phishing, even if you replied.</li><li>You wrote in the conversation after it (a reply, or anything later in the thread).</li><li>The sender is on your not-important list.</li></ol></div>
<div><h3>Put in To action</h3><p class="note">Any one is enough.</p>
<ol class="rules"><li>The sender is on your important list.</li><li>A person asks you directly, and it isn't mass mail.</li><li>It requires an action from you (pay, renew, sign, submit, fix a payment), unless it's marketing sent as mass mail. Terms, privacy and policy updates never count as requiring an action.</li><li>A deadline within your window (not already passed), and it asks you directly, requires an action, or a person expects a reply, unless it's marketing sent as mass mail.</li><li>A person is waiting on your reply, and you're the only recipient.</li><li>The model couldn't classify it.</li><li>It was estimated while the AI model was unavailable, and may be personal mail: check it.</li></ol></div>
</div>
<p class="note pad">Mail Gmail files under Promotions or Social skips the model and is under For information, unless the sender is on your important list, it mentions money, a deadline or security, it's only to you from a person, or it's in a conversation you've written in. When the model is unavailable (its daily allowance ran out, say), each email is estimated instead: from the most similar email the model sorted before in the same mailbox, or by simple rules. Possibly personal mail is shown, never hidden. Estimates are marked Estimated, and runs where the model works re-check them; one not re-checked within ${RECHECK_DAYS} days is shown once more in To action to check.</p>
<p class="note pad">One item per conversation: when several unanswered messages of a thread qualify, only the newest is listed. The model reads each email with the earlier messages of its conversation, so a "thank you" after your reply asks nothing.</p>
<div class="pad"><h3>Urgency</h3><p class="note">Orders To action. <span class="badge u-high">high</span> for a deadline within your window or overdue, or high stakes; <span class="badge u-medium">medium</span> for a direct request or a later deadline; <span class="badge u-low">low</span> otherwise.</p></div>
</section>`;
}

app.get("/app/settings", async (c) => {
	const session = c.get("session");
	return page("Settings", settingsHtml(await loadSettings(c.env.MAILBOX_KV), hiddenCsrf(session), c.req.query("saved") === "1"), {
		bar: ownerBar(session, "settings"),
	});
});

app.post("/app/settings", async (c) => {
	const form = await c.req.raw.formData();
	const lines = (name: string) =>
		String(form.get(name) ?? "")
			.split(/[\n,]/)
			.map((l) => l.trim())
			.filter(Boolean);
	const days = String(form.get("deadlineDays") ?? "").trim();
	if (!/^\d{1,2}$/.test(days) || Number(days) > MAX_DEADLINE_DAYS) {
		return errorPage(`The deadline window must be a whole number of days from 0 to ${MAX_DEADLINE_DAYS}. Nothing was saved.`);
	}
	const important = lines("important");
	const muted = lines("muted");
	const bad = [...important, ...muted].filter((l) => !normaliseRule(l));
	if (bad.length) {
		return errorPage(`Not an email address or domain: ${bad.slice(0, 3).join(", ")}. Nothing was saved.`);
	}
	if (important.length > MAX_SENDER_RULES || muted.length > MAX_SENDER_RULES) {
		return errorPage(`Each list can hold up to ${MAX_SENDER_RULES} entries. Nothing was saved.`);
	}
	await saveSettings(c.env.MAILBOX_KV, { deadlineDays: cleanDeadlineDays(days), important, muted });
	return redirect("/app/settings?saved=1");
});

/** Test-run options from the Run now form; null when they're invalid. A plain "Run now" is a real run. */
function runOptions(form: FormData): { window: RunWindow; reclassify: boolean; test: boolean } | null {
	if (form.get("test") !== "1") return { window: { kind: "since" }, reclassify: false, test: false };
	const kind = String(form.get("window") ?? "");
	const reclassify = form.get("reclassify") === "1";
	if (kind === "since") return { window: { kind }, reclassify, test: true };
	if (kind !== "hours" && kind !== "days" && kind !== "emails") return null;
	const raw = String(form.get("amount") ?? "").trim();
	const amount = Number(raw);
	if (!/^\d{1,4}$/.test(raw) || amount < 1 || amount > TEST_LIMITS[kind]) return null;
	return { window: { kind, amount }, reclassify, test: true };
}

/** The lock's message with its start time made human: "Another run started at 07:29 and…". */
function runInProgressText(message: string, timeZone: string): string {
	const at = /started at (\S+) and/.exec(message)?.[1];
	const when = at ? itemTime(at, timeZone, clock.now()) : "";
	return when ? `Another run started at ${when} and is still going. Try again in a minute.` : message;
}

/** The page and the morning run share a job's progress list: "Run now"/"Morning run" and "Test run". */
const jobUrl = (id: string) => `/app/run/${encodeURIComponent(id)}`;

/** "A run is in progress (started 07:31). Continue it", while a job holds the lock. */
function runningNotice(lock: LockHolder | null, timeZone: string): string {
	if (!lock?.job) return "";
	const when = itemTime(lock.at, timeZone, clock.now());
	const link = `<a href="${escapeHtml(jobUrl(lock.job))}">${lock.driver === "cron" ? "Watch it" : "Continue it"}</a>`;
	return noticesHtml([`<p>A run is in progress${when ? ` (started ${escapeHtml(when)})` : ""}. ${link}</p>`], "info");
}

// Run now (or a test run) starts a job and goes to its page, which steps it one mailbox at a time.
app.post("/app/run", async (c) => {
	const options = runOptions(await c.req.raw.formData());
	if (!options) {
		return errorPage(
			`Test run: pick a window and a whole number N up to ${TEST_LIMITS.hours} hours, ${TEST_LIMITS.days} days or ${TEST_LIMITS.emails} emails.`,
		);
	}
	try {
		const job = await startJob(c.env, options, clock.now(), "web");
		return redirect(jobUrl(job.id));
	} catch (e) {
		if (!(e instanceof RunInProgressError)) {
			console.error("run now failed", (e as Error).message);
			return runFailedPage((e as Error).message, options.test ? "Test run" : "Run now");
		}
		const holder = e.holder;
		// Another run holds the lock: offer to continue it (or watch the morning run) rather than fail.
		const go = holder?.job
			? `<a class="btn primary" href="${escapeHtml(jobUrl(holder.job))}">${holder.driver === "cron" ? "Watch it" : "Continue it"}</a>`
			: "";
		return page(
			"A run is already going",
			`<p class="eyebrow mono">${options.test ? "Test run" : "Run now"}</p><h1>A run is already going</h1>
<p class="lede">${escapeHtml(runInProgressText(e.message, digestConfig(c.env).timeZone))}</p>
<p class="actions">${go}<a class="btn" href="/app">${ICON.back}Back to digest</a></p>`,
			{ solo: true, bar: WORDMARK_BAR },
		);
	}
});

function runFailedPage(message: string, what: string, retry?: string): Response {
	return page(
		"The run failed",
		`<p class="eyebrow mono">${escapeHtml(what)}</p><h1>The run failed</h1>
<p class="errbox mono">${escapeHtml(message)}</p>
<p class="actions">${retry ? `<a class="btn primary" href="${escapeHtml(retry)}">Try again</a>` : ""}<a class="btn" href="/app">${ICON.back}Back to digest</a></p>`,
		{ solo: true, bar: WORDMARK_BAR, status: 500 },
	);
}

const STOPPED_LEDE = "It was left longer than its lock lasts, or another run started, so it stopped before it could overwrite a newer run. Its digest wasn't made.";
const STOPPED_ACTIONS = `<p class="actions"><a class="btn primary" href="/app">Open the latest run</a></p>`;

function finalizationDiagnosticHtml(value: FinalizationDiagnostic | null, self: string): string {
	if (!value) return "";
	const text = JSON.stringify(value, null, 2);
	return `<details class="diag" open><summary>Diagnostic details</summary>
<p class="note">This contains counts and runtime phases only—no email content. Copy it if the run still fails.</p>
<textarea class="diagout mono" readonly spellcheck="false" aria-label="Finalization diagnostic">${escapeHtml(text)}</textarea>
<p><a class="diaglink" href="${escapeHtml(self)}/diagnostic">Open as plain text</a></p></details>`;
}

/** The end of a step page whose work threw: the error, and a way to try the step again (or, stopped, the latest run). */
const stepFailedHtml = (e: unknown, self: string, diagnostic: FinalizationDiagnostic | null = null) =>
	e instanceof JobStoppedError
		? `<style>#step{display:none}</style><div><h1>This run was stopped</h1><p class="lede">${escapeHtml(STOPPED_LEDE)}</p>${finalizationDiagnosticHtml(diagnostic, self)}${STOPPED_ACTIONS}</div>`
		: `<style>#step{display:none}</style><div><h1>The run failed</h1>
<p class="errbox">The final digest could not be stored. You can retry after copying the diagnostic details below.</p>
${finalizationDiagnosticHtml(diagnostic, self)}
<p class="actions"><a class="btn primary" href="${escapeHtml(self)}">Try again</a><a class="btn" href="/app">${ICON.back}Back to digest</a></p></div>`;

const ROW_STATE: Record<JobRow["state"], string> = { todo: "To do", running: "In progress", done: "Completed", failed: "Failed" };

/**
 * One mailbox's row: state mark, alias, a detail slot, state word. Every row has the same geometry in
 * every state (the detail slot is one fixed-height line, the progress line sits inside it, the state
 * word has a fixed width), so rows never move as a run goes on. All text escaped.
 */
function jobRowHtml(r: JobRow, checks?: Checks): string {
	const mark = r.state === "done" ? ICON.check : r.state === "failed" ? ICON.alert : "";
	const detail =
		r.state === "done" && r.summary
			? `<span class="mono">${r.summary.fresh} new · ${r.summary.toAction} to action${r.summary.estimated ? ` · ${r.summary.estimated} estimated` : ""}</span>`
			: r.state === "failed"
				? escapeHtml(capitalise(r.reason ?? "failed"))
				: r.state === "running"
					? '<span class="progress" aria-hidden="true"></span><span class="jprog mono" aria-hidden="true"></span>'
					: checks
						? lastCheckedHtml(checks.at.get(r.alias), checks.tz, checks.now, "Last checked")
						: "";
	return `<li class="jrow is-${r.state}"><span class="jmark">${mark}</span><div class="jbody"><p class="alias">${escapeHtml(r.alias)}</p><p class="jdet note">${detail}</p></div><span class="jstate">${ROW_STATE[r.state]}</span></li>`;
}

/** When each mailbox was last checked, for the to-do rows. */
interface Checks {
	at: Map<string, number>;
	tz: string;
	now: Date;
}

const jobWhat = (job: { driver: "web" | "cron"; test: boolean }) => (job.driver === "cron" ? "Morning run" : job.test ? "Test run" : "Run now");

/**
 * A job page: the same header (eyebrow and a one-line title) and list in every state, then whatever
 * the state needs under the list, so nothing above or in the list moves between steps. `title` and
 * `below` are given escaped/HTML as noted.
 */
function jobPageHtml(o: { what: string; finished: number; rows: JobRow[]; title: string; below: string; checks?: Checks; id?: string }): string {
	return `<div class="jobpage"${o.id ? ` id="${o.id}"` : ""} role="status"><p class="eyebrow mono">${escapeHtml(o.what)} · ${o.finished} of ${o.rows.length}</p><h1>${escapeHtml(o.title)}</h1>
<ol class="jrows" aria-label="Mailboxes">${o.rows.map((r) => jobRowHtml(r, o.checks)).join("")}</ol>
<div class="jbelow">${o.below}</div></div>`;
}

const STEP_LEDE = "One mailbox at a time, so each step stays inside Cloudflare's limits. Keep this tab open: it moves on by itself.";

/** A page that reloads itself (meta refresh: no script) after `seconds`, or goes to `to`. */
const refresh = (seconds: number, to?: string) => `<meta http-equiv="refresh" content="${seconds}${to ? `;url=${escapeHtml(to)}` : ""}">`;

/** Seconds a finished run's page waits before opening the digest. */
export const OPEN_DIGEST_AFTER = 10;

const digestOf = (id: string) => `/app?run=${encodeURIComponent(id)}&ran=1`;
const resultUrl = (job: string) => `${jobUrl(job)}?paused=1`;

/** "6.4 s", "1 min 12 s". */
function took(ms: number): string {
	const s = Math.max(0, ms) / 1000;
	return s < 60 ? `${s.toFixed(1)} s` : `${Math.floor(s / 60)} min ${Math.round(s % 60)} s`;
}

/**
 * A finished run: every row final, the totals and the time it took, then either a 10-second countdown
 * to the digest (meta refresh, a shrinking line in CSS) with Open digest and Pause, or (paused) just
 * Open digest.
 */
function finishedHtml(r: RunResult, paused: boolean): string {
	const done = r.rows.filter((x) => x.state === "done");
	const sum = (k: "fresh" | "toAction") => done.reduce((n, x) => n + (x.summary?.[k] ?? 0), 0);
	const failed = r.rows.filter((x) => x.state === "failed").length;
	const totals = [`${sum("fresh")} new`, `${sum("toAction")} to action`, ...(failed ? [`${failed} failed`] : []), took(r.finished - r.started)].join(" · ");
	const open = `<a class="btn primary" href="${escapeHtml(digestOf(r.digest))}">Open digest</a>`;
	const timer = paused
		? `<p class="jcount">Paused. The digest is ready when you are.</p><p class="actions">${open}</p>`
		: `<p class="jcount">Opening your digest in ${OPEN_DIGEST_AFTER} s</p><span class="countdown" aria-hidden="true"></span>
<p class="actions">${open}<a class="btn quiet" href="${escapeHtml(resultUrl(r.job))}">Pause</a></p>`;
	return jobPageHtml({ what: jobWhat(r), finished: r.rows.length, rows: r.rows, title: "Digest ready", below: `<p class="note mono jsum">${escapeHtml(totals)}</p>${timer}` });
}

const finishedPage = (r: RunResult, paused: boolean) =>
	page("Digest ready", `${paused ? "" : refresh(OPEN_DIGEST_AFTER, digestOf(r.digest))}${finishedHtml(r, paused)}`, { solo: true, bar: WORDMARK_BAR });

app.get("/app/run/:id/diagnostic", async (c) => {
	const id = c.req.param("id");
	if (!JOB_ID.test(id)) return c.text("Not found.\n", 404);
	const diagnostic = await readFinalizationDiagnostic(c.env.MAILBOX_KV, id);
	return new Response(diagnostic ? `${JSON.stringify(diagnostic, null, 2)}\n` : "No finalization diagnostic is available.\n", {
		status: diagnostic ? 200 : 404,
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
	});
});

const goneDetails = (digestId: string | null) =>
	page(
		"Run details",
		`<h1>Run details are no longer available</h1>
<p class="lede">They're kept as long as the run's digest.</p>
<p class="actions">${digestId ? `<a class="btn primary" href="${escapeHtml(digestOf(digestId))}">Open digest</a>` : ""}<a class="btn" href="/app">${ICON.back}Back to digest</a></p>`,
		{ solo: true, bar: WORDMARK_BAR, status: 404 },
	);

// One step of a job per request: the page shows the list at once, does one mailbox, then shows the
// list again and reloads itself (same URL, so the browser keeps its scroll) for the next step. The
// last step stores the digest and shows the finished run, which opens the digest after 10 s unless
// paused (?paused=1, also the "View last run result" link).
app.get("/app/run/:id", async (c) => {
	const id = c.req.param("id");
	if (!JOB_ID.test(id)) return errorPage("Not found.", 404);
	const paused = c.req.query("paused") === "1";
	const self = jobUrl(id);
	// The morning run steps its own job: this page only shows it, unless it stalled, when it takes over.
	const preparedAt = Date.now();
	const plan = await planStep(c.env, id, { now: clock.now(), observeCron: true, ...(paused ? { observe: true } : {}) });
	const plannedAt = Date.now();
	if (plan.kind === "done") {
		const result = await readResult(c.env.MAILBOX_KV, id);
		return result ? finishedPage(result, paused) : paused ? goneDetails(plan.digestId) : redirect(digestOf(plan.digestId));
	}
	if (plan.kind === "missing") return paused ? goneDetails(null) : errorPage("That run has finished or expired.", 404);
	const opts = { solo: true, bar: WORDMARK_BAR } as const;
	const what = jobWhat(plan.view.job);
	// One bulk read: when each mailbox was last checked, shown on the rows still to do.
	const checks: Checks = { at: await lastChecks(c.env.MAILBOX_KV, plan.view.job.aliases), tz: digestConfig(c.env).timeZone, now: clock.now() };
	log("run-page-ready", { job: id, state: plan.kind, planMs: plannedAt - preparedAt, checksMs: Date.now() - plannedAt });
	const view = (v: JobView, title: string, below: string, id?: string) => jobPageHtml({ what, finished: v.finished, rows: v.rows, title, below, checks, ...(id ? { id } : {}) });
	const lede = (text: string) => `<p class="note jlede">${escapeHtml(text)}</p>`;
	if (plan.kind === "stopped") return page("Building digest", view(plan.view, "This run was stopped", `${lede(STOPPED_LEDE)}${STOPPED_ACTIONS}`), opts);
	if (plan.kind === "wait") {
		const text = plan.view.job.driver === "cron" ? "The morning run is going: it works through the mailboxes one at a time, and this page updates itself." : "Another tab is working on this run; this page updates itself.";
		return page("Building digest", `${paused ? "" : refresh(plan.view.job.driver === "cron" ? 5 : 3)}${view(plan.view, "Building your digest", lede(text))}`, opts);
	}
	const cont = `<p class="note jcont">If this page stops moving, <a href="${escapeHtml(self)}">continue</a>.</p>`;
	const stillThere = `${lede(STEP_LEDE)}${cont}`;
	// The whole list is in the first chunk; the last chunk hides it and puts the new one in its place.
	if (plan.kind === "process") {
		return streamPage(
			"Building digest",
			view(plan.view, "Building your digest", stillThere, "step"),
			async (write) => {
				try {
					const next = await plan.work({
						onProgress: (done, total) => {
							write(stepProgressTick(done, total));
						},
					});
					return `${refresh(0, self)}<style>#step{display:none}</style>${view(next, "Building your digest", lede(STEP_LEDE))}`;
				} catch (e) {
					console.error("run step failed", (e as Error).message);
					return stepFailedHtml(e, self, await readFinalizationDiagnostic(c.env.MAILBOX_KV, id));
				}
			},
			{ ...opts, waitUntil: (p) => c.executionCtx.waitUntil(p) },
		);
	}
	return streamPage(
		"Building digest",
		view(plan.view, "Building your digest", `${lede("Every mailbox is done; storing the digest.")}${cont}`, "step"),
		async () => {
			try {
				const digest = await plan.work();
				const result = await readResult(c.env.MAILBOX_KV, id);
				if (!result) return `${refresh(0, digestOf(digest.id))}<style>#step{display:none}</style>`;
				return `${refresh(OPEN_DIGEST_AFTER, digestOf(digest.id))}<style>#step{display:none}</style>${finishedHtml(result, false)}`;
			} catch (e) {
				console.error("run failed", (e as Error).message);
				return stepFailedHtml(e, self, await readFinalizationDiagnostic(c.env.MAILBOX_KV, id));
			}
		},
		{ ...opts, waitUntil: (p) => c.executionCtx.waitUntil(p) },
	);
});

// The morning run's steps, called through the SELF service binding (jobs.ts driveJob). Answers only
// requests on the internal host carrying the job's HMAC; anything else is "not found".
app.post("/internal/step/:id", async (c) => {
	const id = c.req.param("id");
	if (!JOB_ID.test(id) || !(await validStepRequest(c.env, c.req.raw, id))) return errorPage("Not found.", 404);
	return Response.json(await runStep(c.env, id), { headers: { "Cache-Control": "no-store" } });
});

app.post("/app/link", async (c) => {
	const form = await c.req.raw.formData();
	let alias: string;
	try {
		alias = validateAlias(String(form.get("alias") ?? ""));
	} catch (e) {
		return errorPage((e as Error).message);
	}
	const replace = form.get("replace") === "1";
	const existing = await getAccount(c.env.MAILBOX_KV, alias);
	if (existing && !replace) return errorPage(`"${alias}" is already linked to ${existing.email}. Tick "replace" to re-link it.`, 409);
	const { state, setCookie } = await startFlow(c.env.MAILBOX_KV, { kind: "link", alias, replace });
	const location = buildAuthorizeUrl({
		clientId: c.env.GOOGLE_CLIENT_ID,
		redirectUri: callbackUrl(c.req.url),
		scope: mailboxScope(c.env),
		state,
		offline: true,
		// consent: forces Google to issue a refresh token even if this account consented before.
		prompt: "consent select_account",
	});
	return redirect(location, [setCookie]);
});

app.get("/app/unlink", async (c) => {
	const session = c.get("session");
	const alias = c.req.query("alias") ?? "";
	const account = await getAccount(c.env.MAILBOX_KV, alias);
	if (!account) return errorPage("No such mailbox.", 404);
	const pub = toPublic(account);
	return page(
		"Unlink mailbox",
		`<form method="post" action="/app/unlink"><h1>Unlink ${escapeHtml(pub.alias)}?</h1>
<p class="lede">${escapeHtml(pub.email)} will be removed and its Google access revoked. Past digests keep their text.</p>
${hiddenCsrf(session)}<input type="hidden" name="alias" value="${escapeHtml(pub.alias)}">
<p class="actions"><button class="danger" type="submit">Unlink</button><a class="btn quiet" href="/app">Cancel</a></p></form>`,
		{ solo: true, bar: WORDMARK_BAR },
	);
});

app.post("/app/unlink", async (c) => {
	const form = await c.req.raw.formData();
	const account = await getAccount(c.env.MAILBOX_KV, String(form.get("alias") ?? ""));
	if (account) await removeAccount(c.env, account);
	return redirect("/app");
});

app.notFound(() => errorPage("Not found.", 404));
app.onError((err) => {
	console.error(err);
	return errorPage("Unexpected error. Check the Worker logs.", 500);
});

/**
 * How long the morning run waits for a Run now in progress before giving up: the authoritative
 * lease's whole 10-minute life. Waiting costs no CPU and leaves roughly five minutes of the Cron
 * Trigger's 15-minute wall-time limit for a typical three-minute run.
 */
export const SCHEDULED_WAIT = { attempts: Math.ceil(JOB_AUTHORITY_LEASE_MS / 60_000), delayMs: 60_000 };

/** Cron entry point. */

export async function scheduledRun(env: Env & { SELF?: Fetcher }, ctx?: ExecutionContext): Promise<void> {
	let job: Awaited<ReturnType<typeof startJob>> | undefined;
	for (let attempt = 0; !job; attempt++) {
		try {
			job = await startJob(env, {}, clock.now(), "cron");
		} catch (e) {
			if (!(e instanceof RunInProgressError)) throw e;
			if (attempt >= SCHEDULED_WAIT.attempts) {
				console.error(`scheduled run gave up waiting: ${e.message}`);
				return;
			}
			// A Run now is going: wait for it, then run (and send the email) on top of it.
			await new Promise((r) => setTimeout(r, SCHEDULED_WAIT.delayMs));
		}
	}
	// One mailbox per step, each a separate invocation (ctx.exports or the SELF binding); if that keeps
	// failing, only the last step runs here. The lock is released whatever happens.
	let id: string | null;
	try {
		id = await driveJob(env, job, ctx);
	} finally {
		await releaseJobLock(env, job);
	}
	const digest = id ? await getDigest(env.MAILBOX_KV, id) : null;
	if (!digest) {
		console.error(`scheduled run didn't finish: job ${job.id}`);
		return;
	}
	const sent = await sendDigestEmail(env, digest).catch((e) => {
		console.error("digest email failed", e);
		return "failed";
	});
	const open = digest.items.filter((i) => i.needsAction && !i.done).length;
	console.log(`digest ${digest.id}: ${digest.items.length} items, ${open} to action, email ${sent}`);
	await reconcileIndexes(env.MAILBOX_KV, new Date());
}

/**
 * Once a day, after the morning run: repairs the accounts and runs indexes from a KV list each, in
 * case a race (KV reads can be stale across locations) dropped an entry. Logged when it changes them.
 */
export async function reconcileIndexes(kv: KVNamespace, now: Date): Promise<void> {
	try {
		const [accounts, runs] = await Promise.all([reconcileAccountIndex(kv), reconcileRunsIndex(kv, now)]);
		if (accounts.length || runs.added || runs.removed) {
			log("reconcile", { accountsAdded: accounts, runsAdded: runs.added, runsRemoved: runs.removed });
		}
	} catch (e) {
		log("error", { source: "reconcile", code: errorCode((e as Error).message) });
	}
}
