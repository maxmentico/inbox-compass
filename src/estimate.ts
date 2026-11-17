// Answers without the model. Two uses:
//   - Gmail's own filing: mail Gmail put under Promotions or Social skips the model (it never needs
//     the owner), with fixed answers.
//   - Estimates: when the model couldn't classify an email (its daily allowance ran out, or it failed),
//     the answers are copied from the most similar email the model classified before in the same
//     mailbox (its history), or failing that, set by a few rules over headers, labels and keywords.
// Plain code: no model, no network, nothing here can act. An estimate is never final: digest.ts shows
// it as estimated and has the model re-check it on a later run. rules.ts still decides where it goes.

import { applyPolicy, type Category, snippetSummary, type Triage } from "./llm";
import { isSecurityEmail, redactSecrets } from "./secrets";
import { type Addressing, decide, type RequestKind, type SenderType, senderAddress, type Stakes } from "./rules";
import { senderName } from "./format";

/** Gmail's inbox tab for a message, from its CATEGORY_ label; "" when it has none. */
export type GmailTab = "primary" | "social" | "promotions" | "updates" | "forums" | "";
export type KeywordFlag = "money" | "deadline" | "request" | "security";

/** What an email is compared on. Built from headers, Gmail labels and text: never from the model. */
export interface Features {
	/** Lower-cased sender address; "" when there's none. */
	address: string;
	domain: string;
	/** The sender's display name (or address), for reason text. */
	name: string;
	/** The subject as written (capped), for the rules that read it (terms and policy updates). */
	subject: string;
	/** Subject tokens, with numbers, dates, amounts and ids replaced by placeholders. */
	shape: string[];
	addressing: Addressing;
	tab: GmailTab;
	important: boolean;
	starred: boolean;
	/** A reply in a conversation the owner has written in. */
	conversation: boolean;
	/** Has a PDF or an invoice-like attachment. */
	attachment: boolean;
	flags: KeywordFlag[];
}

/** The model's answers an estimate can copy. */
export interface Answers {
	sender: SenderType;
	request: RequestKind;
	stakes: Stakes;
	category: Category;
}

/** One email the model classified, kept per mailbox (digest.ts) to estimate later ones from. */
export interface HistoryEntry extends Features {
	/** Gmail message id, so an email is kept once. */
	id: string;
	answers: Answers;
	/** Arrival time (ISO), or null. */
	date: string | null;
	/** Capped, for the reason text. */
	subject: string;
}

export interface Estimate {
	triage: Triage;
	by: "history" | "rules";
	/** Plain text: "Estimated: like ‘…’ from … (21 Oct)". Contains email text, so callers escape it. */
	reason: string;
	/** Possibly personal mail: rules.ts puts it in To action to be checked. */
	check: boolean;
}

/** Newest examples kept per mailbox. */
export const HISTORY_MAX = 500;
/** Weights of the similarity score; they add up to 1. */
export const WEIGHTS = { address: 0.4, shape: 0.25, domain: 0.15, addressing: 0.1, tab: 0.1 } as const;
/** The best neighbour must score at least this, and the close ones must agree, to be copied. */
export const MATCH_THRESHOLD = 0.6;
/** ...and share at least this much of the subject's shape: the same sender alone isn't the same kind of email. */
export const MIN_SUBJECT_OVERLAP = 0.4;
const NEIGHBOURS = 3;
const SUBJECT_CHARS = 120;
const TEXT_CHARS = 3_000;
export const ESTIMATED_ACTION = "Check this email (estimated)";

const TABS: Record<string, GmailTab> = {
	CATEGORY_PERSONAL: "primary",
	CATEGORY_SOCIAL: "social",
	CATEGORY_PROMOTIONS: "promotions",
	CATEGORY_UPDATES: "updates",
	CATEGORY_FORUMS: "forums",
};

export function gmailTab(labelIds: readonly string[] = []): GmailTab {
	for (const l of labelIds) if (TABS[l]) return TABS[l]!;
	return "";
}

/** Gmail filed it under Promotions or Social: mail that skips the model. */
export function filedTab(labelIds: readonly string[] = []): "Promotions" | "Social" | null {
	const tab = gmailTab(labelIds);
	return tab === "promotions" ? "Promotions" : tab === "social" ? "Social" : null;
}

/** Fixed answers for mail Gmail filed under Promotions or Social. Its summary is Gmail's snippet, cleaned. */
export function filedTriage(tab: "Promotions" | "Social", snippet: string): Triage {
	return {
		sender: tab === "Promotions" ? "marketing" : "automated",
		request: "none",
		stakes: "none",
		action: "",
		category: tab === "Promotions" ? "newsletter" : "notification",
		due: null,
		summary: snippetSummary(snippet),
	};
}

// --- Features ---------------------------------------------------------------------------------

const REPLY_PREFIX = /^(?:\s*(?:re|fwd?|aw|wg|sv|tr|ответ|пересл)\s*(?:\[\d{1,3}\])?\s*:)+/i;

/**
 * "Invoice 2026-118 for €1,240 due 03/11" -> ["invoice", "<n>", "for", "<amount>", "due", "<date>"].
 * Lower-cased word tokens, each once, reply prefixes dropped. Linear: a capped string, no backtracking
 * patterns.
 */
export function subjectShape(subject: string): string[] {
	const s = subject
		.slice(0, 300)
		.toLowerCase()
		.replace(REPLY_PREFIX, " ")
		.replace(/\d{4}-\d{2}-\d{2}|\d{1,2}[./]\d{1,2}(?:[./]\d{2,4})?/g, " <date> ")
		.replace(/[£$€₽]\s?\d[\d,.]*|\d[\d,.]*\s?(?:usd|eur|gbp|rub|руб|₽|€|£|\$)/g, " <amount> ")
		// Ids: 5+ letters and digits mixed ("A7F3K9", "ord12345").
		.replace(/[a-z0-9]+/g, (m) => (m.length >= 5 && /\d/.test(m) && /[a-z]/.test(m) ? " <id> " : m))
		.replace(/\d+/g, " <n> ");
	const tokens = s.match(/<(?:date|amount|id|n)>|[\p{L}\p{N}]{2,}/gu) ?? [];
	return [...new Set(tokens.map((t) => t.slice(0, 30)))].slice(0, 16);
}

const KEYWORDS: Record<KeywordFlag, RegExp> = {
	money: /invoice|payment|\bpay\b|\bpaid\b|\bbill(?:ing)?\b|receipt|refund|\bcharged?\b|amount due|overdue|balance|[£€$₽]\s?\d|сч[её]т|оплат|плат[её]ж|задолженн|квитанц/,
	deadline: /deadline|\bdue\b|expir|\burgent|\basap\b|final notice|by (?:today|tomorrow|monday|tuesday|wednesday|thursday|friday|the end)|срок|истека|срочн|не позднее/,
	request: /please|could you|can you|would you|let me know|\bconfirm|\bapprove|\bsign\b(?![- ]?(?:in|up|on)\b)|\breply\b|\brespond|пожалуйста|прошу|подтверд|ответьте|сообщите|подпиш/,
	security: /password|sign-?in|log-?in|\bverif|security|two-factor|\b2fa\b|one-time code|unusual activity|парол|вход|код подтвержд|безопасност/,
};

/** Keyword flags of the subject and text, English and Russian. */
export function keywordFlags(text: string): KeywordFlag[] {
	const t = text.slice(0, TEXT_CHARS).toLowerCase();
	return (Object.keys(KEYWORDS) as KeywordFlag[]).filter((k) => KEYWORDS[k].test(t));
}

const INVOICE_FILE = /\.pdf$|invoice|receipt|statement|сч[её]т|квитанц|акт/i;

// Local parts that no person reads. Anchored, plain alternatives: linear.
const NO_REPLY = /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|bounces?|notifications?|notify|news(?:letter)?s?|marketing|promo(?:tions)?|offers|deals)(?:[-_.+].*)?$/;
const ROLE = /^(?:info|hello|hi|support|help|billing|accounts?|team|admin|contact|sales|service|updates?|alerts?|security|account-security|mail|robot|system)(?:[-_.+].*)?$/;

const localPart = (address: string) => address.slice(0, Math.max(0, address.lastIndexOf("@")));

/** An address nobody answers (no-reply, notifications, newsletters). */
export function isNoReply(address: string): boolean {
	return NO_REPLY.test(localPart(address));
}

/** A no-reply address, or a role address (info@, support@, billing@) rather than a person's. */
export function isRoleAddress(address: string): boolean {
	const local = localPart(address);
	return NO_REPLY.test(local) || ROLE.test(local);
}

export function featuresOf(e: {
	from: string;
	subject: string;
	/** Body text or snippet, for the keyword flags. */
	text: string;
	addressing: Addressing;
	labelIds?: readonly string[];
	conversation: boolean;
	attachments: readonly string[];
}): Features {
	const address = senderAddress(e.from) ?? "";
	const labels = e.labelIds ?? [];
	return {
		address,
		domain: address.slice(address.lastIndexOf("@") + 1),
		name: senderName(e.from).slice(0, 80),
		subject: e.subject.slice(0, 300),
		shape: subjectShape(e.subject),
		addressing: e.addressing,
		tab: gmailTab(labels),
		important: labels.includes("IMPORTANT"),
		starred: labels.includes("STARRED"),
		conversation: e.conversation,
		attachment: e.attachments.some((f) => INVOICE_FILE.test(f)),
		flags: keywordFlags(`${e.subject}\n${e.text}`),
	};
}

export function historyEntry(id: string, f: Features, t: Triage, meta: { date: string | null; subject: string }): HistoryEntry {
	return {
		id,
		...f,
		answers: { sender: t.sender, request: t.request, stakes: t.stakes, category: t.category },
		date: meta.date,
		// Masked again: history is seeded from cache entries made before secrets were masked (secrets.ts).
		subject: redactSecrets(meta.subject, isSecurityEmail(meta.subject, "", "")).slice(0, SUBJECT_CHARS),
	};
}

// --- Similarity -------------------------------------------------------------------------------

// Mail providers anyone can sign up with: two senders on one of these have nothing else in common.
const GENERIC_DOMAIN =
	/^(?:gmail\.com|googlemail\.com|outlook\.com|hotmail\.com|live\.com|yahoo\.[a-z.]{2,6}|icloud\.com|me\.com|mail\.ru|yandex\.[a-z.]{2,6}|proton\.me|protonmail\.com|gmx\.[a-z.]{2,6}|aol\.com)$/;

export function isGenericDomain(domain: string): boolean {
	return GENERIC_DOMAIN.test(domain);
}

function jaccard(a: readonly string[], b: readonly string[]): number {
	if (a.length === 0 && b.length === 0) return 0;
	const set = new Set(a);
	let both = 0;
	for (const t of b) if (set.has(t)) both++;
	return both / (set.size + b.length - both);
}

/**
 * 0..1: same address 0.40, subject-shape overlap 0.25, same domain 0.15, same addressing 0.10, same
 * Gmail tab 0.10. The domain counts only for different addresses on a company's own domain: the same
 * address already scored, and a generic provider (gmail.com) says nothing.
 */
export function similarity(a: Features, b: Features): number {
	const sameAddress = !!a.address && a.address === b.address;
	return (
		(sameAddress ? WEIGHTS.address : 0) +
		WEIGHTS.shape * jaccard(a.shape, b.shape) +
		(!sameAddress && a.domain && a.domain === b.domain && !isGenericDomain(a.domain) ? WEIGHTS.domain : 0) +
		(a.addressing === b.addressing ? WEIGHTS.addressing : 0) +
		(a.tab === b.tab ? WEIGHTS.tab : 0)
	);
}

/** Breaks ties between equal scores: how many keyword and attachment flags match. */
function flagMatches(a: Features, b: Features): number {
	const all: KeywordFlag[] = ["money", "deadline", "request", "security"];
	return all.filter((k) => a.flags.includes(k) === b.flags.includes(k)).length + (a.attachment === b.attachment ? 1 : 0);
}

/** The closest examples, best first: score, then matching flags, then the newest. */
export function neighbours(f: Features, history: readonly HistoryEntry[], n = NEIGHBOURS): { entry: HistoryEntry; score: number }[] {
	return history
		.map((entry) => ({ entry, score: similarity(f, entry), ties: flagMatches(f, entry) }))
		.sort((x, y) => y.score - x.score || y.ties - x.ties || (y.entry.date ?? "").localeCompare(x.entry.date ?? ""))
		.slice(0, n)
		.map(({ entry, score }) => ({ entry, score }));
}

// Floating-point sums like 0.4 + 0.1 + 0.1 must count as reaching 0.6.
const EPSILON = 1e-9;

const NEUTRAL = { deadlineDays: 3, important: [], muted: [] };

/** Where rules.ts would put an estimate, before the owner's sender lists (which apply to any answer alike). */
function placement(e: Estimate, f: Features): "action" | "phishing" | "other" {
	const outcome = decide(
		{
			signals: { sender: e.triage.sender, request: e.triage.request, stakes: e.triage.stakes, addressing: f.addressing },
			category: e.triage.category,
			from: "",
			// The real subject: a terms or policy update turns "requires an action" into a routine prompt.
			subject: f.subject,
			due: null,
			done: false,
			replied: false,
			check: e.check,
		},
		{ today: "1970-01-01", settings: NEUTRAL },
	).outcome;
	return outcome === "action" || outcome === "phishing" ? outcome : "other";
}

/** Sent to you personally: only you, or you among others, in To, by an address someone answers. */
function personal(f: Features): boolean {
	return (f.addressing === "only_you" || f.addressing === "to_you") && !!f.address && !isNoReply(f.address);
}

/** You're in Cc, and a person (not a role address like info@ or support@) sent it. */
function ccFromPerson(f: Features): boolean {
	return f.addressing === "cc_you" && !!f.address && !isRoleAddress(f.address);
}

/**
 * Mail a copied answer must not quietly hide: sent to you personally (or Cc'd to you by a person), a
 * reply in a conversation you've written in, or with money, deadline, request or security words.
 */
function mustNotHide(f: Features): boolean {
	return personal(f) || ccFromPerson(f) || f.conversation || f.flags.length > 0;
}

/**
 * The answers for an email the model couldn't classify. From history when the best of the 3 nearest
 * neighbours scores at least MATCH_THRESHOLD, shares at least MIN_SUBJECT_OVERLAP of its subject shape,
 * and every neighbour that also reaches the threshold agrees with it on both request and category
 * (neighbours below the threshold don't vote); its answers are copied. Otherwise the rules below.
 * A copy never places mail that mustNotHide lower than the rules would: if the rules put it in To
 * action and the copy wouldn't, the rules' answer stands. `day` formats a date for the reason ("21 Oct").
 */
export function estimate(
	f: Features,
	email: { snippet: string },
	history: readonly HistoryEntry[],
	day: (iso: string) => string,
): Estimate {
	const ruled = byRules(f, email.snippet);
	const copied = fromHistory(f, email, history, day);
	if (!copied) return ruled;
	if (mustNotHide(f) && placement(ruled, f) === "action" && placement(copied, f) === "other") return ruled;
	return copied;
}

function fromHistory(f: Features, email: { snippet: string }, history: readonly HistoryEntry[], day: (iso: string) => string): Estimate | null {
	const near = neighbours(f, history);
	const best = near[0];
	if (best && best.score >= MATCH_THRESHOLD - EPSILON && jaccard(f.shape, best.entry.shape) >= MIN_SUBJECT_OVERLAP - EPSILON) {
		const close = near.filter((n) => n.score >= MATCH_THRESHOLD - EPSILON);
		const a = best.entry.answers;
		if (close.every((n) => n.entry.answers.request === a.request && n.entry.answers.category === a.category)) {
			// The parser's rule, kept: only a person can ask directly or expect a reply.
			const request = (a.sender === "automated" || a.sender === "marketing") && (a.request === "direct" || a.request === "implied") ? "routine" : a.request;
			const who = best.entry.name || best.entry.address || "the same sender";
			const when = best.entry.date ? ` (${day(best.entry.date)})` : "";
			return {
				triage: applyPolicy({
					sender: a.sender,
					request,
					stakes: a.stakes,
					action: request === "none" ? "" : ESTIMATED_ACTION,
					category: a.category,
					due: null,
					summary: snippetSummary(email.snippet),
				}),
				by: "history",
				reason: `Estimated: like ‘${best.entry.subject}’ from ${who}${when}`,
				check: false,
			};
		}
	}
	return null;
}

/**
 * Whether mail Gmail filed under Promotions or Social can skip the model: not when it mentions money,
 * a deadline or security, is only to you from an address someone answers, is Cc'd to you by a person, or
 * is in a conversation you've written in. Those go to the model like any other mail.
 */
export function skipsModel(f: Features): boolean {
	if (f.flags.some((k) => k === "money" || k === "deadline" || k === "security")) return false;
	if (f.addressing === "only_you" && f.address && !isNoReply(f.address)) return false;
	if (ccFromPerson(f)) return false;
	return !f.conversation;
}

/**
 * No close neighbour: (a) Promotions or Social with nothing that would have sent it to the model
 * (skipsModel), or a mailing list from a no-reply address: marketing, asks nothing. (b) Money or deadline
 * words, unless it's mass mail outside Gmail's Updates tab: requires an action, and to check when it's
 * personal (so a terms or policy subject can't demote it out of To action). (c) Gmail marked it
 * important, only you in To, from a person's address: a direct request, to check. (d) A reply in a
 * conversation you've written in: a reply expected, to check. (e) Sent to you personally (only you, or you
 * among others, in To), or Cc'd to you by a person: to check, with no request claimed. Otherwise mass
 * mail, information. Unsure personal mail is shown, never hidden.
 */
export function byRules(f: Features, snippet: string): Estimate {
	const summary = snippetSummary(snippet);
	const t = (sender: SenderType, request: RequestKind, stakes: Stakes, category: Category): Triage => ({
		sender,
		request,
		stakes,
		action: request === "none" ? "" : ESTIMATED_ACTION,
		category,
		due: null,
		summary,
	});
	// Mail to check gets an action line, even when nothing in it is known to be asked.
	const rule = (triage: Triage, reason: string, check = false): Estimate => ({
		triage: check ? { ...triage, action: ESTIMATED_ACTION } : triage,
		by: "rules",
		reason: `Estimated: ${reason}`,
		check,
	});
	const tab = f.tab === "promotions" ? "Promotions" : f.tab === "social" ? "Social" : null;
	if ((tab && skipsModel(f)) || (f.addressing === "bulk" && isNoReply(f.address))) {
		return rule(
			tab === "Social" ? t("automated", "none", "none", "notification") : t("marketing", "none", "none", "newsletter"),
			tab ? `Gmail filed it under ${tab}` : "a mailing list from a no-reply address",
		);
	}
	const money = f.flags.includes("money");
	if ((money || f.flags.includes("deadline")) && !(f.addressing === "bulk" && f.tab !== "updates")) {
		const check = personal(f) || ccFromPerson(f);
		const what = money ? "it mentions a payment" : "it mentions a deadline";
		return rule(t("automated", "required", "some", money ? "payment" : "task"), check ? `${what}; check it` : what, check);
	}
	if (f.important && f.addressing === "only_you" && f.address && !isRoleAddress(f.address)) {
		return rule(t("person", "direct", "some", "reply"), "Gmail marked it important, and a person sent it to you only; check it", true);
	}
	if (f.conversation) return rule(t("person", "implied", "none", "reply"), "a reply in a conversation you've written in; check it", true);
	// Nothing says it asks anything: "check" alone puts it in To action, with no claimed request.
	if (f.addressing === "only_you" || f.addressing === "to_you") return rule(t("person", "none", "none", "other"), "sent to you personally; check it", true);
	if (ccFromPerson(f)) return rule(t("person", "none", "none", "other"), "a person copied you in; check it", true);
	const mass = f.addressing === "bulk" ? "a mailing list" : f.addressing === "cc_you" ? "you're only in Cc, from a role address" : "you're not in To or Cc";
	return rule(t("automated", "none", "none", "notification"), `mass mail (${mass})`);
}
