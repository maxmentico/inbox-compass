// Where each email goes. The model answers questions about it (who sent it, what it asks of the
// owner, what's at stake, any deadline); headers say how it was addressed. Rules applied in order then
// decide: the first rule in step 1 that matches keeps it out of "To action"; otherwise any one rule in
// step 2 puts it in. No points: one strong reason is enough. Decisions are recomputed whenever a digest
// is built or shown, so changing a setting takes effect without another model call.

export const SENDER_TYPES = ["person", "business_person", "automated", "marketing"] as const;
export type SenderType = (typeof SENDER_TYPES)[number];
export const REQUESTS = ["direct", "required", "implied", "routine", "none"] as const;
export type RequestKind = (typeof REQUESTS)[number];
export const STAKES = ["high", "some", "none"] as const;
export type Stakes = (typeof STAKES)[number];
/** How the email reached the mailbox, from headers: never from the model. */
export type Addressing = "only_you" | "to_you" | "cc_you" | "not_named" | "bulk";
export type Urgency = "high" | "medium" | "low";

export interface Signals {
	sender: SenderType;
	request: RequestKind;
	stakes: Stakes;
	addressing: Addressing;
}

/**
 * Step 1 outcomes keep an email out of "To action"; "info" is the default when no step 2 rule matches.
 * "superseded" is set after deciding, when a newer message of the same conversation is in "To action".
 */
export type Outcome = "done" | "phishing" | "replied" | "muted" | "action" | "info" | "superseded";
/** Step 2: any one of these puts an email in "To action". In rule order. */
export const ACTION_RULES = ["important", "direct", "required", "deadline", "waiting", "unclassified", "check"] as const;
export type ActionRule = (typeof ACTION_RULES)[number];

export interface Decision {
	outcome: Outcome;
	/** Every step 2 rule that matched, in rule order. Empty unless outcome is "action". */
	because: ActionRule[];
	/** Orders "To action". Only meaningful when outcome is "action". */
	urgency: Urgency;
}

export interface EmailFacts {
	/** Absent when the model couldn't classify the email. */
	signals?: Signals;
	category: string;
	from: string;
	subject: string;
	due: string | null;
	done: boolean;
	replied: boolean;
	/**
	 * Estimated without the model (estimate.ts) and possibly personal mail: shown in "To action" to be
	 * checked, rather than hidden on a guess.
	 */
	check?: boolean;
}

export const RULE_LABEL: Record<ActionRule, string> = {
	important: "on your important list",
	direct: "a person asks you directly",
	required: "requires an action from you",
	deadline: "deadline soon",
	waiting: "a person is waiting on your reply",
	unclassified: "couldn't be classified; check manually",
	check: "estimated while the AI model was unavailable, and may be personal; check it",
};
export const SENDER_LABEL: Record<SenderType, string> = {
	person: "person",
	business_person: "person at a business",
	automated: "automated",
	marketing: "marketing",
};
export const REQUEST_LABEL: Record<RequestKind, string> = {
	direct: "asks you directly",
	required: "requires an action",
	implied: "reply expected",
	routine: "routine prompt",
	none: "asks nothing",
};
export const STAKES_LABEL: Record<Stakes, string> = { high: "high stakes", some: "some stakes", none: "no stakes" };
export const ADDRESSING_LABEL: Record<Addressing, string> = {
	only_you: "only you in To",
	to_you: "you in To",
	cc_you: "you in Cc",
	not_named: "you not in To/Cc",
	bulk: "mailing list",
};

/** Whole days from `today` to `due` (both YYYY-MM-DD); negative when overdue. */
export function daysUntil(today: string, due: string): number {
	return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

const PERSON: ReadonlySet<SenderType> = new Set(["person", "business_person"]);

// Terms-of-service, privacy and policy updates often say "action required", and the model believes
// them. Matched on the subject; plain alternatives over a capped string, so it stays linear.
const POLICY_UPDATE =
	/terms of (?:service|use)|terms (?:and|&) conditions|privacy (?:policy|notice)|user agreement|polic(?:y|ies) updates?|updates? to (?:our |the |its )?(?:terms|polic)|updated (?:terms|privacy|polic)|условия использования|пользовательское соглашение|политик[аи] конфиденциальности/i;

export function isPolicyUpdate(subject: string): boolean {
	return POLICY_UPDATE.test(subject.slice(0, 300));
}

/** The request the rules act on: a terms or policy update is a routine prompt, whatever the model said. */
export function effectiveRequest(s: Signals, subject: string): RequestKind {
	return s.request === "required" && isPolicyUpdate(subject) ? "routine" : s.request;
}

export function decide(f: EmailFacts, opts: { today: string; settings: Settings }): Decision {
	const out = (outcome: Outcome, because: ActionRule[] = [], urgency: Urgency = "low"): Decision => ({ outcome, because, urgency });
	const s = f.signals && { ...f.signals, request: effectiveRequest(f.signals, f.subject) };

	// Step 1, in order. Phishing comes before "replied": answering a scam doesn't make it safe.
	if (f.done) return out("done");
	if (s && f.category === "suspicious") return out("phishing");
	if (f.replied) return out("replied");
	// The owner's lists can't hide mail the model never read.
	if (!s) return out("action", ["unclassified"], "medium");
	const rule = senderRule(f.from, opts.settings);
	if (rule === "muted") return out("muted");

	// Step 2: any one rule is enough.
	const massMail = s.addressing === "bulk" || s.addressing === "not_named";
	const bulkMarketing = s.sender === "marketing" && massMail;
	const dueIn = f.due ? daysUntil(opts.today, f.due) : null;
	const withinWindow = dueIn !== null && dueIn <= opts.settings.deadlineDays;
	// Only a person can ask directly or expect a reply. The parser already enforces this; repeating it
	// here keeps digests stored by older versions, whose answers weren't checked, to the same rules.
	const personAsks = PERSON.has(s.sender) && (s.request === "direct" || s.request === "implied");
	const asksSomething = personAsks || s.request === "required";

	const because: ActionRule[] = [];
	if (rule === "important") because.push("important");
	if (s.request === "direct" && PERSON.has(s.sender) && !massMail) because.push("direct");
	if (s.request === "required" && !bulkMarketing) because.push("required");
	// Overdue dates don't trigger: a date the model read off an old email would otherwise stick forever.
	if (dueIn !== null && dueIn >= 0 && withinWindow && asksSomething && !bulkMarketing) because.push("deadline");
	if (s.request === "implied" && PERSON.has(s.sender) && s.addressing === "only_you") because.push("waiting");
	if (f.check) because.push("check");
	if (because.length === 0) return out("info");

	// Step 3: urgency only orders "To action".
	const urgency: Urgency =
		withinWindow || s.stakes === "high" ? "high" : s.request === "direct" || (dueIn !== null && dueIn >= 0) ? "medium" : "low";
	return out("action", because, urgency);
}

// --- Addressing, worked out from headers ------------------------------------------------------

// Headers are written by the sender, so parsing must stay linear: no backtracking regex over the
// whole header, and only the first MAX_HEADER_CHARS are read.
const MAX_HEADER_CHARS = 4_000;
const LOCAL = "[a-z0-9!#$%&'*+/=?^_`{|}~.-]+";
const DOMAIN = "[a-z0-9-]+(?:\\.[a-z0-9-]+)+";
const ADDRESS = new RegExp(`^${LOCAL}@${DOMAIN}$`);

/** Splits an address-list header into entries, dropping quoted display-name text. */
function unquotedMailboxes(header: string): string[] {
	const parts: string[] = [];
	let cur = "";
	let quoted = false;
	let escaped = false;
	for (const ch of header.slice(0, MAX_HEADER_CHARS)) {
		if (quoted) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') quoted = false;
			continue;
		}
		if (ch === '"') quoted = true;
		else if (ch === "," || ch === ";") {
			parts.push(cur);
			cur = "";
		} else cur += ch;
	}
	parts.push(cur);
	return parts;
}

function asAddress(s: string): string | null {
	const a = s.trim().toLowerCase();
	return a.length <= 254 && ADDRESS.test(a) ? a : null;
}

/**
 * Lower-cased addresses in a To/Cc/From header value. Takes each entry's <angle address> when it has
 * one, so a display name like `"boss@company.com" <attacker@evil.com>` yields only the real address.
 */
export function addressesIn(header: string): string[] {
	const out: string[] = [];
	for (const part of unquotedMailboxes(header)) {
		const lt = part.lastIndexOf("<");
		const gt = lt >= 0 ? part.indexOf(">", lt) : -1;
		const a =
			gt > lt
				? asAddress(part.slice(lt + 1, gt))
				: (part
						.replace(/\([^()]*\)/g, " ")
						.split(/\s+/)
						.map(asAddress)
						.find((x) => x !== null) ?? null);
		if (a) out.push(a);
	}
	return out;
}

const GMAIL_DOMAINS: ReadonlySet<string> = new Set(["gmail.com", "googlemail.com"]);

/**
 * The mailbox an address delivers to: without a "+tag", and for Gmail without dots, with
 * googlemail.com read as gmail.com. Only used to recognise the owner's own addresses.
 */
export function deliveryAddress(address: string): string {
	const a = address.trim().toLowerCase();
	const at = a.lastIndexOf("@");
	if (at < 1) return a;
	let local = a.slice(0, at);
	let domain = a.slice(at + 1);
	const plus = local.indexOf("+");
	if (plus > 0) local = local.slice(0, plus);
	if (GMAIL_DOMAINS.has(domain)) {
		local = local.replace(/\./g, "");
		domain = "gmail.com";
	}
	return `${local}@${domain}`;
}

/** `mine`: the mailbox's address, or all of its addresses (primary plus send-as aliases). */
export function addressingOf(mine: string | readonly string[], h: { to: string; cc: string; bulk: boolean }): Addressing {
	if (h.bulk) return "bulk";
	const me = new Set((typeof mine === "string" ? [mine] : mine).map(deliveryAddress));
	const isMe = (a: string) => me.has(deliveryAddress(a));
	const to = addressesIn(h.to);
	const cc = addressesIn(h.cc);
	if (to.some(isMe)) return [...to, ...cc].every(isMe) ? "only_you" : "to_you";
	if (cc.some(isMe)) return "cc_you";
	return "not_named";
}

/** Headers that mark list or bulk mail (RFC 2369, RFC 2919, and the de facto Precedence header). */
export function isBulk(get: (name: string) => string | undefined): boolean {
	if (get("List-Unsubscribe") || get("List-Id")) return true;
	return /^(bulk|list|junk)$/i.test((get("Precedence") ?? "").trim());
}

// --- Owner settings ---------------------------------------------------------------------------

export interface Settings {
	/** A deadline this many days away or closer counts as soon (rule "deadline", and high urgency). */
	deadlineDays: number;
	/** Addresses ("anna@x.com") or domains ("@x.com") whose mail always goes in "To action". */
	important: string[];
	/** Addresses or domains whose mail never goes in "To action". Suspicious mail is still shown. */
	muted: string[];
}

export const DEFAULT_DEADLINE_DAYS = 3;
export const MAX_DEADLINE_DAYS = 30;
export const DEFAULT_SETTINGS: Settings = { deadlineDays: DEFAULT_DEADLINE_DAYS, important: [], muted: [] };
export const MAX_SENDER_RULES = 500;
const SETTINGS_KEY = "settings";

/** "Name <Anna@X.com>" -> "anna@x.com"; null when there's no address. */
export function senderAddress(from: string): string | null {
	return addressesIn(from)[0] ?? null;
}

function matches(address: string, rule: string): boolean {
	if (rule.startsWith("@")) {
		const domain = address.slice(address.lastIndexOf("@") + 1);
		const d = rule.slice(1);
		return domain === d || domain.endsWith(`.${d}`);
	}
	return address === rule;
}

/** An exact address rule beats a domain rule; between equals, "important" wins. */
export function senderRule(from: string, s: Settings): "important" | "muted" | null {
	const address = senderAddress(from);
	if (!address) return null;
	if (s.important.includes(address)) return "important";
	if (s.muted.includes(address)) return "muted";
	if (s.important.some((r) => matches(address, r))) return "important";
	if (s.muted.some((r) => matches(address, r))) return "muted";
	return null;
}

/**
 * Normalises one sender rule: an address, or a domain written "@x.com" or "x.com".
 * Returns null when it isn't one.
 */
export function normaliseRule(raw: string): string | null {
	const s = raw.trim().toLowerCase();
	if (s.length === 0 || s.length > 254) return null;
	if (ADDRESS.test(s)) return s;
	const domain = s.startsWith("@") ? s.slice(1) : s;
	if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain)) return `@${domain}`;
	return null;
}

function cleanList(v: unknown): string[] {
	if (!Array.isArray(v)) return [];
	const out = new Set<string>();
	for (const r of v) {
		const n = typeof r === "string" ? normaliseRule(r) : null;
		if (n) out.add(n);
		if (out.size >= MAX_SENDER_RULES) break;
	}
	return [...out];
}

export function cleanDeadlineDays(v: unknown): number {
	const n = typeof v === "number" ? v : Number.parseInt(String(v ?? ""), 10);
	return Number.isFinite(n) ? Math.min(MAX_DEADLINE_DAYS, Math.max(0, Math.round(n))) : DEFAULT_DEADLINE_DAYS;
}

export async function loadSettings(kv: KVNamespace): Promise<Settings> {
	const raw = await kv.get<Partial<Settings>>(SETTINGS_KEY, "json");
	if (!raw) return { ...DEFAULT_SETTINGS };
	return { deadlineDays: cleanDeadlineDays(raw.deadlineDays), important: cleanList(raw.important), muted: cleanList(raw.muted) };
}

export async function saveSettings(kv: KVNamespace, s: Settings): Promise<Settings> {
	const clean = { deadlineDays: cleanDeadlineDays(s.deadlineDays), important: cleanList(s.important), muted: cleanList(s.muted) };
	// A sender can't be on both lists.
	clean.muted = clean.muted.filter((r) => !clean.important.includes(r));
	await kv.put(SETTINGS_KEY, JSON.stringify(clean));
	return clean;
}

/** Puts one sender on a list (removing it from the other), or clears it from both. */
export function withSenderRule(s: Settings, rule: string, kind: "important" | "muted" | "clear"): Settings {
	const important = s.important.filter((r) => r !== rule);
	const muted = s.muted.filter((r) => r !== rule);
	if (kind === "important") important.push(rule);
	if (kind === "muted") muted.push(rule);
	return { ...s, important, muted };
}
