// A run: collect inbox mail that arrived since the last check in every linked mailbox, classify what's
// new, carry over To action items that are still open, and store the result as one digest per run.
//
// "Since the last check" is a per-mailbox cursor (the arrival time of the newest email a real run
// handled) plus the classification cache, keyed by Gmail message id: a real run caches an email only
// once it's been reported, so a cached email counts as seen and a 1-hour overlap catches late-indexed
// mail without reporting anything twice. A backlog bigger than one run's share is worked through
// oldest first. Test runs pick their own window, may re-classify, and never write either.
//
// Without the model (its daily allowance ran out, or it failed), emails are estimated (estimate.ts).
// An estimate isn't final, so it isn't cached with answers: its cache entry is only a "seen" mark,
// written like any other, and it counts as handled for the cursor, so it's never reported as new again.
// Its id goes on the mailbox's re-check list instead. The first real run where the model works
// fetches it again, classifies it, caches the final answers and takes it off the list; if it now
// needs the owner, it's shown in To action as re-checked.

import { AccountError, type AccountRecord, checkedKey, cursorKey, historyKey, listAccounts, recheckKey } from "./accounts";
import { digestConfig, localDate } from "./config";
import { estimate, type Features, featuresOf, filedTab, filedTriage, HISTORY_MAX, type HistoryEntry, historyEntry, skipsModel } from "./estimate";
import { dayLabel } from "./format";
import { countingAI, countingKV, errorCode, log, newRunStats, saveRunLog, since, withRunStats } from "./telemetry";
import { earlierInThread, GmailClient, type GmailMessage, repliedAfter, summarize, type ThreadState, toFullMessage } from "./gmail";
import type { RunResult } from "./jobs";
import { ATOMIC_GENERATION_MAX_ENTRIES } from "./atomic-limits";
import {
	BODY_CHARS_FOR_MODEL,
	type Category,
	type EmailForTriage,
	snippetSummary,
	type Triage,
	type TriageOutcome,
	triageEmails,
	type Unavailable,
} from "./llm";

/** Earlier messages of a conversation the model sees with each email, and how much of each. */
const THREAD_CONTEXT = { messages: 4, previewChars: 200, fromChars: 80 };
import { type Excerpt, header } from "./mime";
import { isSecurityEmail, redactItem, redactMeta, redactSecrets } from "./secrets";
import {
	type Addressing,
	addressingOf,
	type Decision,
	decide,
	isBulk,
	loadSettings,
	senderRule,
	type Settings,
	type Signals,
	type Urgency,
	ACTION_RULES,
} from "./rules";

/** Also how long an email counts as seen; far longer than the cursor overlap needs. */
const CLASSIFICATION_TTL = 30 * 24 * 60 * 60;
const DIGEST_TTL = 60 * 24 * 60 * 60;
/** A day longer than a digest lives, so a stored run never shows a ticked item as open again. */
const DONE_TTL = DIGEST_TTL + 24 * 60 * 60;
const CURSOR_OVERLAP_MS = 60 * 60 * 1000;
/** Most ids listed per mailbox per run when looking for a backlog's oldest end... */
const LIST_LIMIT = 5_000;
/**
 * ...and across all mailboxes: each 100 listed ids cost one KV bulk read (their cache entries), so with
 * many mailboxes each lists fewer (1,500 each for 10), keeping a run inside its KV budget.
 */
const LIST_TOTAL = 15_000;
/**
 * A Worker invocation may make about 1,000 KV operations. Each new email costs one write (its cache
 * entry, or an estimate's seen mark), and so does each email re-checked; reads are bulk. New and
 * re-checked emails per real run are capped together across mailboxes to stay well inside it. Each
 * mailbox adds a few more: its cursor, re-check list and history.
 */
const NEW_EMAILS_PER_RUN = 500;
/** KV bulk reads take up to 100 keys. */
const KV_BULK = 100;
/**
 * A run holds this lock so a second real run (double click, or cron during Run now) waits its turn.
 * A real run of 500 emails takes about 3 minutes; the lock outlives that twice over, and only matters
 * when a run dies before releasing it. The morning run waits it out (SCHEDULED_WAIT in web.ts).
 */
export const LOCK_TTL = 6 * 60;
/**
 * An email that failed to load or classify holds its mailbox's cursor, so it's retried, for this long
 * after a real run first saw it fail. Then the cursor moves on; the email stays listed as "check
 * manually" under Still open from earlier until it's ticked, replied to or archived.
 */
const FAILURE_HOLD_MS = 2 * 24 * 60 * 60 * 1000;
/**
 * An estimated email waits this long for the model to re-check it. If it never is, it's shown once in
 * To action to check (unless done or gone from the inbox), and leaves the list.
 */
const RECHECK_TTL = 14 * 24 * 60 * 60;
export const RECHECK_DAYS = RECHECK_TTL / 86_400;
/** With no cursor yet (first run, or a newly linked mailbox), look back this far. */
export const FIRST_RUN_LOOKBACK_DAYS = 3;
/** Test-run window limits. */
export const TEST_LIMITS = { hours: 720, days: 30, emails: 300 } as const;

export interface MessageMeta {
	threadId: string;
	from: string;
	/** Subject and snippet have sign-in codes (and, in a security email, links) masked: secrets.ts. */
	subject: string;
	date: string | null;
	snippet: string;
	/** A password reset, sign-in or verification code, magic link or sign-in alert (secrets.ts). */
	security?: true;
}

/** Bump when Triage changes shape, so older cached results are classified again. */
const CACHE_VERSION = 3;

/** Cached per message so tomorrow's run doesn't re-fetch or re-classify it. */
interface CachedClassification {
	v: number;
	/** Arrival time (ms). Absent on entries written before runs had cursors. */
	arrived?: number;
	meta: MessageMeta;
	/** Absent on the seen mark of an estimated email: an estimate isn't final, so it isn't kept. */
	triage?: Triage;
	addressing?: Addressing;
	/** The seen mark of an estimated email (no answers; `addressing` is from headers). */
	estimated?: true;
	/** The Google account it was written for (lower-cased); an entry for another one is ignored. Absent on older entries. */
	mailbox?: string;
	/** "rule": Gmail filed it under Promotions or Social, so the model never saw it. */
	source?: "model" | "rule";
	filed?: "Promotions" | "Social";
	model?: string;
	classifiedAt: string;
}

export interface DigestItem extends MessageMeta {
	/** `${alias}:${messageId}` */
	key: string;
	account: string;
	accountEmail: string;
	messageId: string;
	/** In "To action": the rules in rules.ts put it there (or, on old items, what was stored). */
	needsAction: boolean;
	action: string;
	/** Set by the rules for items in "To action"; orders that list. */
	urgency: Urgency;
	category: Category;
	due: string | null;
	summary: string;
	/**
	 * False when Gmail couldn't load the message (or, on digests from before estimates, the model
	 * failed): shown as "check manually". Estimated items are classified: they have answers.
	 */
	classified: boolean;
	done: boolean;
	/** The model's answers plus header-derived addressing. Absent on unclassified and older items. */
	signals?: Signals;
	/** Computed from signals and the owner's settings whenever a digest is built or shown. */
	decision?: Decision;
	/** The owner wrote in the conversation after this email, so it's handled: never in "To action". */
	replied?: boolean;
	/** Still open from an earlier run, rather than new in this one. */
	carried?: boolean;
	/** Earlier unanswered messages of this conversation that this item stands for in "To action". */
	covers?: number;
	/**
	 * Answered without the model (estimate.ts), so not final: re-checked by a later run. `check`: may be
	 * personal mail, so it goes in To action to be checked. `reason` contains email text.
	 */
	estimated?: { by: "history" | "rules"; reason: string; check?: true };
	/** Estimated by an earlier run, then classified by the model in this one. */
	rechecked?: true;
	/** Gmail filed it under this tab, so it skipped the model. */
	filed?: "Promotions" | "Social";
	/**
	 * What the sender wrote, cleaned for reading and capped (mime.ts readableExcerpt), and the To and Cc
	 * headers: shown when the email is expanded. Absent when the body wasn't read in that run (an item
	 * from the classification cache) and on older digests. Never in the classification cache.
	 */
	text?: string;
	/** Set when `text` was cut short: quoted earlier text left out, or longer than the cap. */
	textCut?: "quote" | "length";
	to?: string;
	cc?: string;
}

export interface AccountRunStatus {
	alias: string;
	email: string;
	ok: boolean;
	found: number;
	newlyClassified: number;
	error?: string;
	needsRelink?: boolean;
	/** More mail matched than could be listed in one run; the oldest of it wasn't looked at. */
	truncated?: boolean;
	/** New mail left for the next run: a backlog is worked through oldest first. */
	backlog?: number;
}

/** What a run looked at. "since" is the normal run; the others are test windows. */
export type RunWindow = { kind: "since" } | { kind: "hours" | "days" | "emails"; amount: number };

export interface Digest {
	/** Storage key: the run's time (YYYY-MM-DDTHH:MM:SSZ, "-test" for test runs), or a date for older digests. */
	id: string;
	/** Local date of the run; due dates are counted from it. */
	date: string;
	test?: boolean;
	window?: RunWindow;
	/** Earliest arrival time asked for, across mailboxes; null for "last N emails". */
	windowFrom?: string | null;
	generatedAt: string;
	model: string;
	query: string;
	items: DigestItem[];
	accounts: AccountRunStatus[];
	modelErrors: string[];
	/** The job (jobs.ts) that made it, when it was made in steps: its result page is /app/run/<job>?paused=1. */
	job?: string;
	/** Set when the model was unavailable or emails were estimated: the page and the email say so. */
	ai?: {
		unavailable?: Unavailable;
		/** Estimated in this run, and how many of those from history. */
		estimated: number;
		fromHistory: number;
		/** Estimates waiting for the model after this run, across mailboxes, and when the oldest was made. */
		waiting?: number;
		oldestWaiting?: string;
		/** Estimates that waited RECHECK_TTL in vain: shown in To action to check. */
		expired?: number;
	};
}

export type RunEnv = Pick<
	Env,
	| "MAILBOX_KV"
	| "AI"
	| "JOB_AUTHORITY"
	| "ATOMIC_STATE_MODE"
	| "TOKEN_ENCRYPTION_KEY"
	| "GOOGLE_CLIENT_ID"
	| "GOOGLE_CLIENT_SECRET"
	| "OWNER_EMAIL"
	| "DIGEST_QUERY"
	| "DIGEST_MAX_PER_ACCOUNT"
	| "DIGEST_MODEL"
	| "DIGEST_FALLBACK_MODEL"
	| "DIGEST_TIMEZONE"
>;

const clsKey = (alias: string, id: string) => `cls:${alias}:${id}`;
const doneKey = (key: string) => `done:${key}`;
const digestKey = (id: string) => `digest:${id}`;
/** Per mailbox: when each email still failing first failed in a real run (message id -> ms). */
const failuresKey = (alias: string) => `failures:${alias}`;
const LOCK_KEY = "run-lock";
/** Id of the latest real (non-test) run: where still-open items are carried over from. */
const LAST_RUN_KEY = "last-run";
// Keep historical day-only, timestamp and timestamp-test links readable.
export const DIGEST_ID = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z(?:-(?:[A-Za-z0-9_-]{22}-)?test)?)?$/;

/** `body`: the text, when it was read, for a surer security check than the snippet gives. */
function metaOf(m: GmailMessage, body = ""): MessageMeta {
	const s = summarize("", m);
	const from = s.from ?? "(unknown sender)";
	const subject = s.subject ?? "(no subject)";
	const security = isSecurityEmail(subject, from, body || s.snippet) || (!!body && isSecurityEmail(subject, from, s.snippet));
	return {
		threadId: m.threadId,
		from,
		subject: redactSecrets(subject, security),
		date: s.date,
		snippet: redactSecrets(s.snippet, security),
		...(security ? { security: true as const } : {}),
	};
}

/** The model's text with secrets masked, like the email it's about (secrets.ts). */
function redactTriage(t: Triage, security: boolean): Triage {
	return { ...t, summary: redactSecrets(t.summary, security), action: redactSecrets(t.action, security) };
}

const URGENCY_RANK: Record<Urgency, number> = { high: 0, medium: 1, low: 2 };

export function sortItems(items: DigestItem[]): DigestItem[] {
	return [...items].sort((a, b) => {
		if (a.needsAction !== b.needsAction) return a.needsAction ? -1 : 1;
		if (a.needsAction && a.urgency !== b.urgency) return URGENCY_RANK[a.urgency] - URGENCY_RANK[b.urgency];
		return (b.date ?? "").localeCompare(a.date ?? "");
	});
}

/**
 * Decides every item against the current settings, in place, and re-sorts them. Classified items
 * from before signals existed have nothing to decide on and keep their stored needsAction.
 */
export function applySettings(d: Digest, settings: Settings): Digest {
	for (const it of d.items) {
		if (it.classified && !it.signals) continue;
		it.decision = decide(
			{
				signals: it.signals,
				category: it.category,
				from: it.from,
				subject: it.subject,
				due: it.due,
				done: it.done,
				replied: it.replied === true,
				check: it.estimated?.check === true,
			},
			{ today: d.date, settings },
		);
		it.needsAction = it.decision.outcome === "action";
		if (it.needsAction) it.urgency = it.decision.urgency;
		delete it.covers;
	}
	// One "To action" item per conversation: the newest message stands for the older unanswered ones,
	// taking the highest urgency and every reason among them. The older ones stay open (listed under it).
	const isAction = (it: DigestItem) => it.classified && it.decision?.outcome === "action";
	const groups = new Map<string, DigestItem[]>();
	for (const it of d.items.filter(isAction)) {
		const k = conversationKey(it);
		groups.set(k, [...(groups.get(k) ?? []), it]);
	}
	for (const group of groups.values()) {
		if (group.length < 2) continue;
		const top = group.reduce((a, b) => ((b.date ?? "") > (a.date ?? "") ? b : a));
		const rules = new Set(group.flatMap((it) => it.decision!.because));
		top.decision = {
			...top.decision!,
			because: ACTION_RULES.filter((r) => rules.has(r)),
			urgency: group.reduce((u, it) => (URGENCY_RANK[it.urgency] < URGENCY_RANK[u] ? it.urgency : u), top.urgency),
		};
		top.urgency = top.decision.urgency;
		top.covers = group.length - 1;
		for (const it of group) {
			if (it === top) continue;
			it.decision = { ...it.decision!, outcome: "superseded" };
			it.needsAction = false;
		}
	}
	d.items = sortItems(d.items);
	return d;
}

export const conversationKey = (it: DigestItem) => `${it.account}:${it.threadId}`;

/** Still needs the owner: in "To action", or listed there under a newer message of its conversation. */
export const isOpen = (it: DigestItem) => !it.done && (it.needsAction || it.decision?.outcome === "superseded");

/**
 * The page's sections, which the email counts too. Superseded items are in none: each is listed
 * under its conversation's item. Call after applySettings.
 */
export function digestSections(d: Digest) {
	const listed = d.items.filter((i) => !i.done && i.decision?.outcome !== "superseded");
	const fresh = listed.filter((i) => !i.carried);
	return {
		open: fresh.filter((i) => i.category !== "suspicious" && i.needsAction),
		suspicious: fresh.filter((i) => i.category === "suspicious"),
		// A carried item re-decided out of To action since its run (its sender muted since, say) is information now.
		fyi: listed.filter((i) => !i.needsAction && (i.carried || i.category !== "suspicious")),
		stillOpen: listed.filter((i) => i.carried && i.needsAction),
		done: d.items.filter((i) => i.done),
	};
}

interface Pending {
	account: AccountRecord;
	message: GmailMessage;
	/** Random per email, so one email's text can't target another's ref in the same batch. */
	ref: string;
	/** Estimated by an earlier run; fetched again for the model to re-check. */
	recheck?: true;
}

interface Prepared {
	/** Subject and snippet with secrets masked, and whether it's a security email (secrets.ts). */
	meta: MessageMeta;
	/** What the digest item keeps of the email itself (DigestItem text, to, cc). */
	reading: Reading;
	email: EmailForTriage;
	features: Features;
	addressing: Addressing;
}

/** Arrival time (ms), or undefined. */
function arrivalOf(m: GmailMessage): number | undefined {
	const n = Number(m.internalDate);
	return Number.isFinite(n) ? n : undefined;
}

/** How a message was addressed to the mailbox, from its headers. */
function addressingFor(m: GmailMessage, mine: string | string[]): Addressing {
	const hs = m.payload?.headers;
	return addressingOf(mine, { to: header(hs, "To") ?? "", cc: header(hs, "Cc") ?? "", bulk: isBulk((name) => header(hs, name)) });
}

function aiNote(a: NonNullable<Digest["ai"]>): Pick<Digest, "ai"> {
	if (!a.unavailable && !a.estimated && !a.waiting && !a.expired) return {};
	const ai: NonNullable<Digest["ai"]> = { estimated: a.estimated, fromHistory: a.fromHistory };
	if (a.unavailable) ai.unavailable = a.unavailable;
	if (a.waiting) {
		ai.waiting = a.waiting;
		ai.oldestWaiting = a.oldestWaiting;
	}
	if (a.expired) ai.expired = a.expired;
	return { ai };
}

function newRef(): string {
	return crypto.randomUUID().replace(/-/g, "").slice(0, 12);
}

export interface Cursor {
	/** Arrival time (ms since epoch) of the newest email a real run handled. Absent until one did. */
	after?: number;
	/**
	 * Set when the run that wrote it had to take a smaller share of this mailbox's mail than the full one
	 * (a job step retried after it died): the next run starts from twice this, growing back to the full
	 * share, rather than dying on the full share again. Kept in the cursor: no extra write.
	 */
	share?: number;
	/** When a real run last read this mailbox without failing (ms), new mail or not: "last checked". */
	checked?: number;
}

/** Who holds the run lock: when it was taken, and the job driving the run (absent for one-shot runs). */
export interface LockHolder {
	at: string;
	job?: string;
	driver?: "web" | "cron";
}

export class RunInProgressError extends Error {
	constructor(
		message: string,
		readonly holder?: LockHolder,
	) {
		super(message);
	}
}

/** The run lock's holder, or null. Locks written before jobs hold just the time. */
export async function readLock(kv: KVNamespace): Promise<LockHolder | null> {
	const v = await kv.get(LOCK_KEY);
	if (!v) return null;
	try {
		const j = JSON.parse(v) as LockHolder;
		if (j && typeof j.at === "string") return j;
	} catch {
		// an ISO time
	}
	return { at: v };
}

/** Takes (or renews) the lock for LOCK_TTL. */
export async function takeLock(kv: KVNamespace, holder: LockHolder): Promise<void> {
	await kv.put(LOCK_KEY, JSON.stringify(holder), { expirationTtl: LOCK_TTL });
}

export async function releaseLock(kv: KVNamespace): Promise<void> {
	await kv.delete(LOCK_KEY);
}

export const lockMessage = (h: LockHolder) => `Another run started at ${h.at} and is still going. Try again in a minute.`;

export function runId(now: Date, test: boolean, jobId?: string): string {
	const timestamp = `${now.toISOString().slice(0, 19)}Z`;
	if (!test) return timestamp;
	return jobId ? `${timestamp}-${jobId}-test` : `${timestamp}-test`;
}

/** Gmail's after: takes whole seconds. */
const afterQuery = (base: string, ms: number) => `${base} after:${Math.floor(ms / 1000)}`;

/** Bulk KV read, KV_BULK keys per call. */
async function getMany<T>(kv: KVNamespace, keys: string[], type: "json" | "text"): Promise<(T | null)[]> {
	const out: (T | null)[] = [];
	for (let i = 0; i < keys.length; i += KV_BULK) {
		const chunk = keys.slice(i, i + KV_BULK);
		const found = (await kv.get(chunk, type as "json")) as Map<string, T | null>;
		for (const k of chunk) out.push(found.get(k) ?? null);
	}
	return out;
}

/** Lists up to `max` ids, newest first, following pages. */
async function listWindow(client: GmailClient, query: string, max: number): Promise<{ ids: string[]; truncated: boolean }> {
	const ids: string[] = [];
	let pageToken: string | undefined;
	do {
		const page = await client.listMessageIds({ query, maxResults: Math.min(500, max - ids.length), pageToken });
		ids.push(...page.ids);
		pageToken = page.nextPageToken;
	} while (pageToken && ids.length < max);
	return { ids: ids.slice(0, max), truncated: Boolean(pageToken) };
}

/**
 * The id of the latest real (non-test) run: where still-open items carry over from, and the only run
 * whose items can be switched done. Without a stored `last-run` (or if its digest is gone), the newest
 * real digest among all stored ones.
 */
export async function latestRealRun(kv: KVNamespace): Promise<string | null> {
	// `last-run` is trusted whenever its digest exists: the index can lag (it's read, merged and written
	// by every save, and test runs don't take the lock), and it's only the fallback and the history list.
	const id = await kv.get(LAST_RUN_KEY);
	if (id && DIGEST_ID.test(id) && (await kv.get(digestKey(id))) !== null) return id;
	return (await readRuns(kv)).find((d) => !d.endsWith("-test")) ?? null;
}

/**
 * The latest real digest (or, given, this one), with each item's done flag read from its done mark.
 * A job pins it when it starts, so every step, and a retried last step, carries over from the same run.
 */
async function previousRealDigest(kv: KVNamespace, pinned?: string | null): Promise<Digest | null> {
	const id = pinned === undefined ? await latestRealRun(kv) : pinned;
	const d = id ? await getDigest(kv, id) : null;
	return d && withDoneMarks(kv, d);
}

/** `test` forces a test run even for the "since last check" window without re-classifying. */
export type RunOptions = { now?: Date; window?: RunWindow; reclassify?: boolean; test?: boolean };

/** Whether these options make a test run: any window but "since last check", re-classify, or asked for. */
export const isTestRun = (opts: RunOptions) => opts.test === true || (opts.window ?? { kind: "since" }).kind !== "since" || opts.reclassify === true;

/**
 * One run. Real runs hold a lock (best effort: KV isn't transactional) and throw RunInProgressError
 * when another real run started less than LOCK_TTL ago.
 */
export async function runDigest(env: RunEnv, opts: RunOptions = {}): Promise<Digest> {
	const now = opts.now ?? new Date();
	const test = isTestRun(opts);
	// Telemetry (telemetry.ts): this run's KV and AI calls go through counting wrappers.
	const stats = newRunStats(runId(now, test));
	return withRunStats(stats, async () => {
		const counted: RunEnv = { ...env, MAILBOX_KV: countingKV(env.MAILBOX_KV, stats), AI: countingAI(env.AI, stats) as Ai };
		let digest: Digest | undefined;
		let failure: string | undefined;
		try {
			digest = await (test ? runOnce(counted, opts, now, true) : lockedRun(counted, opts, now));
			return digest;
		} catch (e) {
			failure = e instanceof RunInProgressError ? "locked" : errorCode((e as Error).message);
			throw e;
		} finally {
			log("run-end", {
				ok: !failure,
				...(failure ? { failure } : {}),
				ms: since(stats.started),
				subrequests: stats.subrequests,
				ai: stats.ai,
				kv: stats.kv,
				rateLimitedParts: stats.rateLimitedParts,
				errors: stats.errors,
				...(digest
					? {
							items: digest.items.length,
							mailboxes: digest.accounts.map((a) => ({
								alias: a.alias,
								ok: a.ok,
								found: a.found,
								classified: a.newlyClassified,
								...(a.backlog ? { backlog: a.backlog } : {}),
								...(a.error ? { error: errorCode(a.error) } : {}),
							})),
						}
					: {}),
			});
			await saveRunLog(env.MAILBOX_KV, stats);
		}
	});
}

/** A real run holds the lock (best effort: KV isn't transactional). */
async function lockedRun(env: RunEnv, opts: RunOptions, now: Date): Promise<Digest> {
	const holder = await readLock(env.MAILBOX_KV);
	if (holder) throw new RunInProgressError(lockMessage(holder), holder);
	await takeLock(env.MAILBOX_KV, { at: now.toISOString() });
	try {
		return await runOnce(env, opts, now, false);
	} finally {
		await releaseLock(env.MAILBOX_KV);
	}
}

export interface MailboxRun {
	/** The cursor before this run. */
	before: Cursor | null;
	/** Arrival times of listed mail an earlier run already reported. */
	seenTimes: number[];
	/** Newer new mail was left for the next run (a backlog is worked oldest first). */
	backlog: boolean;
	/** Real runs: the share of mail this mailbox took, and the full share it could have taken. */
	share?: number;
	full?: number;
}

/** One run in one invocation: every mailbox, then the digest. Jobs (jobs.ts) do the same in steps. */
async function runOnce(env: RunEnv, opts: RunOptions, now: Date, test: boolean): Promise<Digest> {
	const ctx = await runContext(env, opts, now, test);
	log("run-start", { test, window: windowLabel(ctx.window), mailboxes: ctx.accounts.length, share: ctx.share });
	return assemble(env, ctx, await collect(env, ctx, ctx.accounts));
}

const windowLabel = (w: RunWindow) => (w.kind === "since" ? "since" : `${w.amount} ${w.kind}`);

/** What every part of a run works from; the same for each mailbox of it. A job rebuilds it each step. */
export interface RunContext {
	opts: RunOptions;
	window: RunWindow;
	now: Date;
	test: boolean;
	cfg: ReturnType<typeof digestConfig>;
	date: string;
	settings: Settings;
	/** The run's mailboxes (a job's: those still linked). */
	accounts: AccountRecord[];
	/** Each mailbox's share of the run's email budget (a retried job step lowers it). */
	share: number;
	/** The share before any lowering. */
	fullShare: number;
	/** Open items of the previous real run, re-decided: what carries over. */
	open: DigestItem[];
	openIfUnticked: DigestItem[];
	ticked: Set<string>;
	/** Set by a job's last step: the digest records which job made it (for its result page). */
	jobId?: string;
	/** The persisted digest ID, including any legacy format used when this job started. */
	jobRunId?: string;
}

/**
 * `aliases`: a job's mailboxes, fixed when it started (its share is counted over all of them, even if
 * one is unlinked meanwhile); otherwise every linked mailbox.
 */
export async function runContext(
	env: RunEnv,
	opts: RunOptions,
	now: Date,
	test: boolean,
	aliases?: string[],
	previousRun?: string | null,
): Promise<RunContext> {
	const window = opts.window ?? { kind: "since" };
	const cfg = digestConfig(env);
	const date = localDate(now, cfg.timeZone);
	const [linked, settings, previous] = await Promise.all([
		listAccounts(env.MAILBOX_KV),
		loadSettings(env.MAILBOX_KV),
		previousRealDigest(env.MAILBOX_KV, previousRun),
	]);
	const accounts = aliases ? linked.filter((a) => aliases.includes(a.alias)) : linked;
	// Re-decided first, so items that are no longer open (ticked, muted since) aren't carried.
	const ticked = new Set(previous?.items.filter((it) => it.done).map((it) => it.key));
	// What would carry if nothing were ticked: the ticked ones of these are re-checked before storing,
	// in case the owner switched one back while this run was going.
	const openIfUnticked = previous
		? applySettings({ ...previous, items: previous.items.map((it) => ({ ...it, done: false })) }, settings).items.filter(isOpen)
		: [];
	const open = previous ? applySettings(previous, settings).items.filter(isOpen) : [];
	const count = aliases?.length ?? accounts.length;
	const share = Math.max(1, Math.min(cfg.maxPerAccount, Math.floor(NEW_EMAILS_PER_RUN / Math.max(1, count))));
	return { opts, window, now, test, cfg, date, settings, accounts, share, fullShare: share, open, openIfUnticked, ticked };
}

/** One mailbox's part of a run, JSON-serialisable, so a job can keep it in KV between steps. */
export interface MailboxPartial {
	alias: string;
	status: AccountRunStatus;
	/** Its items: new, carried, re-checked and lapsed estimates, with `replied` set. */
	items: DigestItem[];
	/** Cache entries (final answers, seen marks) to write once the digest is stored. */
	toCache: [string, CachedClassification][];
	run?: MailboxRun;
	/** Real runs: the re-check list as read, the ids settled, and the ids estimated. */
	recheck?: { before: RecheckEntry[]; settled: string[]; estimated: string[] };
	/** What the model classified, for the history; and the history, if it was read (for estimates). */
	learned: HistoryEntry[];
	history?: HistoryEntry[];
	windowStart?: number;
	surfaced: string[];
	replacedCarried: string[];
	unavailable?: Unavailable;
	/** The model's errors (on one partial per model pass, so they aren't counted twice). */
	errors: string[];
	estimated: number;
	fromHistory: number;
	/** Couldn't be processed at all (a job step that died): its open items are carried as they were. */
	carryOnly?: true;
}

/**
 * Steps 1 to 3 for these mailboxes: list, fetch, classify (one model pass across them), estimate, and
 * read reply threads. Writes nothing; returns each mailbox's part. `modelOff`: the model is known to be
 * out (a job's earlier step ran out of allowance), so everything is estimated without calling it.
 */
export async function collect(
	env: RunEnv,
	ctx: RunContext,
	accounts: AccountRecord[],
	modelOff?: Unavailable,
	onProgress?: (done: number, total: number) => void | Promise<void>,
): Promise<MailboxPartial[]> {
	const { opts, window, now, test, cfg, date, settings, open, share } = ctx;
	const items: DigestItem[] = [];
	const pending: Pending[] = [];
	const statuses: AccountRunStatus[] = [];
	const windowStarts = new Map<string, number>();
	/** Per mailbox alias: thread states for new and carried items. */
	const states = new Map<string, Map<string, ThreadState>>();
	const mailboxes = new Map<string, MailboxRun>();
	const clients = new Map<string, GmailClient>();
	/** Per mailbox alias: its own addresses (primary plus send-as aliases), read only when there's new mail. */
	const ownAddresses = new Map<string, string[]>();
	/** Cache entries for this run's new mail, written only once a real run's digest is stored. */
	const toCache = new Map<string, CachedClassification>();
	/** Real runs, per mailbox alias: its re-check list as read (expired entries included). */
	const rechecks = new Map<string, RecheckEntry[]>();
	/** Keys of estimates that waited RECHECK_TTL in vain, shown once to check. */
	const surfaced = new Set<string>();
	/** Keys of re-checked items that replaced a carried copy: shown even when they no longer need the owner. */
	const replacedCarried = new Set<string>();
	/** Per mailbox alias: ids off the re-check list after this run (classified, or gone from Gmail). */
	const settled = new Map<string, Set<string>>();
	/** Per mailbox alias: ids this run estimated, to go on the re-check list. */
	const estimatedIds = new Map<string, string[]>();
	/** Per mailbox alias: what the model classified in this run, for the history. */
	const learned = new Map<string, HistoryEntry[]>();
	/** Per mailbox alias: its history, read (or seeded) once, when first needed. */
	const histories = new Map<string, Promise<HistoryEntry[]>>();
	const historyOf = (alias: string) => {
		if (!histories.has(alias)) {
			const account = accounts.find((a) => a.alias === alias);
			histories.set(alias, loadHistory(env.MAILBOX_KV, alias, account?.email ?? ""));
		}
		return histories.get(alias)!;
	};
	const add = <T>(m: Map<string, T[]>, alias: string, v: T) => m.set(alias, [...(m.get(alias) ?? []), v]);
	const settle = (alias: string, id: string) => settled.set(alias, (settled.get(alias) ?? new Set<string>()).add(id));

	const carry = (it: DigestItem) => items.push(carriedCopy(it, now));

	let stepTotal = 0;
	let stepDone = 0;
	const reportProgress = onProgress && accounts.length === 1 ? onProgress : undefined;
	const beginStep = async (total: number) => {
		if (!reportProgress || total <= 0) return;
		stepTotal = total;
		stepDone = 0;
		try {
			await reportProgress(0, stepTotal);
		} catch {
			// Progress hook failed; this mailbox step still finishes.
		}
	};
	const settleOne = async (n = 1) => {
		if (!reportProgress || stepTotal <= 0) return;
		stepDone += n;
		try {
			await reportProgress(stepDone, stepTotal);
		} catch {
			// Progress hook failed; this mailbox step still finishes.
		}
	};

	// 1. Per mailbox: list the window, skip what a real run already reported, reuse cached
	//    classifications, fetch the rest in full, and carry over still-open items.
	await Promise.all(
		accounts.map(async (account) => {
			const status: AccountRunStatus = { alias: account.alias, email: account.email, ok: true, found: 0, newlyClassified: 0 };
			statuses.push(status);
			// The same alias may since have been re-linked to another Google account.
			const carried = open.filter((it) => it.account === account.alias && it.accountEmail === account.email);
			// Telemetry: wall-clock ms per phase (across awaits) and counts; no content.
			const trace: Record<string, unknown> = { alias: account.alias };
			const ms: Record<string, number> = {};
			const timed = async <T>(phase: string, p: Promise<T>): Promise<T> => {
				const t0 = Date.now();
				try {
					return await p;
				} finally {
					ms[phase] = (ms[phase] ?? 0) + since(t0);
				}
			};
			let client: GmailClient | undefined;
			try {
				client = new GmailClient(env, account);
				let query = cfg.query;
				let listMax = share;
				const run: MailboxRun = { before: null, seenTimes: [], backlog: false };
				if (window.kind === "since") {
					run.before = await timed("cursor", env.MAILBOX_KV.get<Cursor>(cursorKey(account.alias), "json"));
					const from = run.before?.after !== undefined ? run.before.after - CURSOR_OVERLAP_MS : now.getTime() - FIRST_RUN_LOOKBACK_DAYS * 86_400_000;
					query = afterQuery(cfg.query, from);
					windowStarts.set(account.alias, from);
					listMax = Math.min(LIST_LIMIT, Math.floor(LIST_TOTAL / Math.max(1, accounts.length)));
				} else if (window.kind === "emails") {
					listMax = window.amount;
				} else {
					const from = now.getTime() - window.amount * (window.kind === "hours" ? 3_600_000 : 86_400_000);
					query = afterQuery(cfg.query, from);
					windowStarts.set(account.alias, from);
				}
				const { ids, truncated } = await timed("list", listWindow(client, query, listMax));
				const cached = await timed(
					"cache",
					getMany<CachedClassification>(
						env.MAILBOX_KV,
						ids.map((id) => clsKey(account.alias, id)),
						"json",
					),
				);
				trace.listed = ids.length;
				// An entry counts only for the Google account it was written for: the alias may have been re-linked.
				const current = (c: CachedClassification | null | undefined): c is CachedClassification =>
					c != null && c.v === CACHE_VERSION && (c.mailbox === undefined || c.mailbox === account.email.toLowerCase());
				// Final answers to show again; an estimated email's seen mark has none.
				const reusable = (c: CachedClassification | null | undefined): c is CachedClassification & { triage: Triage; addressing: Addressing } =>
					current(c) && c.triage !== undefined && c.addressing !== undefined;

				let take: string[];
				let recheckIds: string[] = [];
				if (test) {
					// Test runs show everything in their window, newest first, up to the run's share
					// (or exactly N for "last N emails").
					take = window.kind === "emails" ? ids : ids.slice(0, share);
					if (take.length < ids.length) status.truncated = true;
				} else {
					// An email a real run reported is cached with its arrival time. Entries without one were
					// written before runs had cursors: treated as unseen once, re-using their answers.
					const seen = (c: CachedClassification | null | undefined): c is CachedClassification =>
						current(c) && c.arrived !== undefined;
					const fresh = ids.filter((_, i) => !seen(cached[i]));
					run.seenTimes = cached.filter(seen).map((c) => c.arrived!);
					// Estimated by earlier runs: re-checked first, oldest first, from a slice of this run's share
					// (up to a third, or whatever new mail leaves).
					trace.fresh = fresh.length;
					const list = await timed("recheckList", loadRecheck(env.MAILBOX_KV, account.alias, now));
					rechecks.set(account.alias, [...list.live, ...list.expired]);
					const freshIds = new Set(fresh);
					const waiting = list.live.filter((e) => !freshIds.has(e.id));
					// A mailbox that had to shrink its share last time starts from twice what worked, back toward full.
					const mine = Math.max(1, Math.min(share, run.before?.share ? run.before.share * 2 : share));
					run.share = mine;
					run.full = ctx.fullShare;
					const reserve = Math.min(waiting.length, Math.max(Math.floor(mine / 3), mine - fresh.length));
					recheckIds = waiting.slice(0, reserve).map((e) => e.id);
					// Ids come newest first: over what's left of the share, take the oldest and leave the rest.
					const room = mine - reserve;
					take = fresh.length > room ? fresh.slice(fresh.length - room) : fresh;
					run.backlog = fresh.length > room;
					if (run.backlog) status.backlog = fresh.length - take.length;
					if (list.expired.length) {
						const found = await timed("lapsed", expiredEstimates(env.MAILBOX_KV, client, account, list.expired.map((e) => e.id)));
						trace.lapsed = list.expired.length;
						for (const id of found.settled) settle(account.alias, id);
						for (const it of found.items) {
							surfaced.add(it.key);
							// Shown in place of its carried copy: it keeps that copy's text.
							const was = carried.find((c) => c.key === it.key);
							if (was) Object.assign(it, readingOf({ excerpt: { text: was.text ?? "", cut: was.textCut }, to: was.to ?? null, cc: was.cc ?? null }));
							items.push(it);
						}
					}
				}
				status.found = take.length;
				if (truncated) status.truncated = true;
				mailboxes.set(account.alias, run);

				await beginStep(take.length + recheckIds.length);

				const byId = new Map(ids.map((id, i) => [id, cached[i]] as const));
				const missing: string[] = [];
				for (const id of take) {
					const c = byId.get(id);
					if (opts.reclassify || !reusable(c)) {
						missing.push(id);
						continue;
					}
					// An entry from before secrets were masked is masked now, before it goes anywhere (job marks too).
					const meta = redactMeta(c.meta);
					const item = redactItem(toItem(account, id, meta, c.triage, c.addressing));
					if (c.filed) item.filed = c.filed;
					items.push(item);
					// A real run reporting an old entry re-caches it with its arrival time, marking it seen.
					if (!test && c.arrived === undefined) {
						const arrived = c.meta.date ? Date.parse(c.meta.date) : Number.NaN;
						toCache.set(item.key, { ...c, meta, triage: redactTriage(c.triage, meta.security === true), arrived: Number.isFinite(arrived) ? arrived : undefined });
					}
					await settleOne();
				}
				const again = new Set(recheckIds);
				const fetchIds = [...missing, ...recheckIds];
				Object.assign(trace, { take: take.length, reused: take.length - missing.length, rechecks: recheckIds.length });
				if (fetchIds.length) {
					const { messages, failed } = await timed("fetch", client.getFullMany(fetchIds));
					Object.assign(trace, { fetched: messages.length, failed: failed.length });
					if (messages.length) ownAddresses.set(account.alias, await timed("sendAs", addressesOf(client)));
					for (const m of messages) pending.push({ account, message: m, ref: newRef(), ...(again.has(m.id) ? { recheck: true as const } : {}) });
					for (const f of failed) {
						// A re-check Gmail can't load: deleted (404) leaves the list; anything else waits for the next run.
						if (again.has(f.id)) {
							if (f.status === 404) settle(account.alias, f.id);
							await settleOne();
							continue;
						}
						items.push(
							unclassified(account, f.id, { threadId: f.id, from: "(couldn't load)", subject: `(Gmail error ${f.status})`, date: null, snippet: "" }),
						);
						await settleOne();
					}
				}

				const taken = new Set(take);
				const stillOpen = await timed(
					"lookups",
					withKnownThreads(
						client,
						carried.filter((it) => !taken.has(it.messageId)),
					),
				);
				// Read now only what the model needs (emails with earlier messages: Gmail names a thread
				// after its first message) and what carry-over needs. Threads of emails that could go into
				// "To action" are read after classification; most mail never needs its thread read.
				const threadIds = [
					...pending.filter((p) => p.account.alias === account.alias && p.message.threadId !== p.message.id).map((p) => p.message.threadId),
					...stillOpen.map((it) => it.threadId),
				];
				clients.set(account.alias, client);
				let byThread = new Map<string, ThreadState>();
				try {
					// Not cached: replies and archiving change between runs.
					byThread = await timed("threads", client.threadStates(threadIds));
					trace.threads = new Set(threadIds).size;
				} catch (e) {
					// Fail open: mail is treated as unreplied, and carried items as still in the inbox.
					console.warn(`thread check failed for ${account.alias}: ${(e as Error).message}`);
				}
				states.set(account.alias, byThread);
				for (const it of stillOpen) {
					// Shown again as a lapsed estimate, in place of its carried copy.
					if (surfaced.has(it.key)) continue;
					const state = byThread.get(it.threadId);
					// Archived or deleted in Gmail: no longer open.
					if (state && !state.inInbox.has(it.messageId)) continue;
					carry(it);
				}
				trace.carried = items.filter((it) => it.carried && it.account === account.alias).length;
			} catch (e) {
				status.ok = false;
				status.error = (e as Error).message;
				status.needsRelink = e instanceof AccountError ? e.needsRelink : undefined;
				trace.error = errorCode(status.error);
				// Fail open: a mailbox that couldn't be read keeps its open items until it can be.
				const already = new Set(items.map((it) => it.key));
				for (const it of carried) if (!already.has(it.key)) carry(it);
			}
			log("mailbox", { ...trace, ok: status.ok, gmailCalls: client?.calls ?? 0, ms });
		}),
	);

	// 2. Classify everything new in one pass across mailboxes. What the model couldn't classify is
	//    estimated: from the mailbox's history, or by rules (estimate.ts).
	const prepare = (p: Pending): Prepared => {
		const full = toFullMessage(p.account.alias, p.message, BODY_CHARS_FOR_MODEL);
		const state = states.get(p.account.alias)?.get(p.message.threadId);
		const addressing = addressingFor(p.message, ownAddresses.get(p.account.alias) ?? p.account.email);
		const arrived = arrivalOf(p.message) ?? Number.POSITIVE_INFINITY;
		// Sign-in codes and recovery links never reach the model, the item, the cache or the history.
		const meta = metaOf(p.message, full.body);
		const security = meta.security === true;
		const body = redactSecrets(full.body, security);
		return {
			meta,
			reading: readingOf({ ...full, excerpt: { ...full.excerpt, text: redactSecrets(full.excerpt.text, security) } }),
			addressing,
			features: featuresOf({
				from: full.from ?? "",
				subject: meta.subject,
				text: body,
				addressing,
				labelIds: p.message.labelIds,
				conversation: !!state?.messages.some((m) => m.byOwner && m.id !== p.message.id && m.at < arrived),
				attachments: full.attachments.map((a) => a.filename),
			}),
			email: {
				ref: p.ref,
				mailbox: p.account.email,
				thread: (state ? earlierInThread(state, p.message.id, THREAD_CONTEXT.messages) : []).map((m) => ({
					by: m.byOwner ? "owner" : "other",
					from: m.from.slice(0, THREAD_CONTEXT.fromChars),
					date: new Date(m.at).toISOString(),
					preview: redactSecrets(m.preview, isSecurityEmail("", m.from, m.preview)).slice(0, THREAD_CONTEXT.previewChars),
				})),
				from: full.from ?? "",
				to: full.to ?? "",
				cc: full.cc ?? "",
				subject: meta.subject,
				date: full.date ?? "",
				attachments: full.attachments.map((a) => a.filename),
				body,
			},
		};
	};
	const classify = (list: Prepared[]): Promise<TriageOutcome> =>
		list.length && modelOff
			? (async () => {
					if (reportProgress && list.length) await settleOne(list.length);
					return {
						results: new Map<string, Triage>(),
						modelByRef: new Map<string, string>(),
						failed: list.map((x) => x.email.ref),
						errors: [],
						unavailable: modelOff,
					};
				})()
			: list.length
				? triageEmails(
						env.AI,
						cfg.model,
						list.map((x) => x.email),
						{
							ownerEmail: env.OWNER_EMAIL,
							today: date,
							fallbackModel: cfg.fallbackModel,
							now: () => now,
							...(reportProgress ? { onSettled: (count) => settleOne(count) } : {}),
						},
					)
				: Promise.resolve({ results: new Map<string, Triage>(), modelByRef: new Map<string, string>(), failed: [], errors: [] });
	/** The final cache entry and history entry of an email the model classified. */
	const keep = (p: Pending, x: Prepared, item: DigestItem, triage: Triage, model: string) => {
		toCache.set(item.key, {
			v: CACHE_VERSION,
			arrived: arrivalOf(p.message),
			meta: x.meta,
			triage,
			addressing: x.addressing,
			model,
			mailbox: p.account.email.toLowerCase(),
			classifiedAt: now.toISOString(),
		});
		add(learned, p.account.alias, historyEntry(p.message.id, x.features, triage, { date: item.date, subject: item.subject }));
	};

	const prepared = pending.map(prepare);
	// Gmail filed it under Promotions or Social, the sender isn't important, and nothing in it calls for a
	// closer look (estimate.ts skipsModel): fixed answers, no model call.
	const isFiled = pending.map((p, i) => {
		const tab = p.recheck ? null : filedTab(p.message.labelIds);
		const from = header(p.message.payload?.headers, "From") ?? "";
		return tab && senderRule(from, settings) !== "important" && skipsModel(prepared[i]!.features) ? tab : null;
	});
	const toModel = pending.map((_, i) => i).filter((i) => !isFiled[i]);
	for (let i = 0; i < pending.length; i++) {
		if (isFiled[i]) await settleOne();
	}
	// Re-checks go first: if the allowance runs out part-way, they've had their turn.
	const order = [...toModel.filter((i) => pending[i]!.recheck), ...toModel.filter((i) => !pending[i]!.recheck)];
	const tModel = Date.now();
	const outcome = await classify(order.map((i) => prepared[i]!));
	if (reportProgress && !modelOff && outcome.failed.length) await settleOne(outcome.failed.length);
	log("model", {
		emails: order.length,
		rechecks: order.filter((i) => pending[i]!.recheck).length,
		ms: since(tModel),
		...(outcome.unavailable ? { unavailable: outcome.unavailable.reason } : {}),
		...(outcome.errors.length ? { errors: [...new Set(outcome.errors.map(errorCode))] } : {}),
	});
	/** Telemetry, per mailbox alias: what step 2 did with its mail. */
	const sorted = new Map<string, { filed: number; classified: number; estimated: number; fromHistory: number; rechecked: number; recheckFailed: number }>();
	const tally = (alias: string, k: "filed" | "classified" | "estimated" | "fromHistory" | "rechecked" | "recheckFailed") => {
		const t = sorted.get(alias) ?? { filed: 0, classified: 0, estimated: 0, fromHistory: 0, rechecked: 0, recheckFailed: 0 };
		t[k]++;
		sorted.set(alias, t);
	};
	const day = (iso: string) => dayLabel(iso, cfg.timeZone, now);
	for (const [i, p] of pending.entries()) {
		const x = prepared[i]!;
		const meta = x.meta;
		const mailbox = p.account.email.toLowerCase();
		const filed = isFiled[i];
		if (filed) {
			tally(p.account.alias, "filed");
			const triage = filedTriage(filed, meta.snippet);
			const item: DigestItem = { ...toItem(p.account, p.message.id, meta, triage, x.addressing), filed };
			items.push(item);
			toCache.set(item.key, {
				v: CACHE_VERSION,
				arrived: arrivalOf(p.message),
				meta,
				triage,
				addressing: x.addressing,
				source: "rule",
				filed,
				mailbox,
				classifiedAt: now.toISOString(),
			});
			continue;
		}
		// The model saw no codes, but its words are masked too, in case it made one up or rebuilt one.
		const answered = outcome.results.get(p.ref);
		const triage = answered && redactTriage(answered, meta.security === true);
		if (p.recheck) {
			// Not classified this time: it stays on the list, and its carried copy (if any) stays as it is.
			tally(p.account.alias, triage ? "rechecked" : "recheckFailed");
			if (!triage) continue;
			const item: DigestItem = { ...toItem(p.account, p.message.id, meta, triage, x.addressing), rechecked: true };
			keep(p, x, item, triage, outcome.modelByRef.get(p.ref) ?? cfg.model);
			settle(p.account.alias, p.message.id);
			// Archived since: its answers are kept, but there's nothing to show.
			if (!p.message.labelIds?.includes("INBOX")) continue;
			const was = items.findIndex((it) => it.key === item.key);
			if (was >= 0) {
				replacedCarried.add(item.key);
				items.splice(was, 1);
			}
			items.push(item);
			continue;
		}
		if (!triage) {
			const est = estimate(x.features, meta, await historyOf(p.account.alias), day);
			const item = toItem(p.account, p.message.id, meta, est.triage, x.addressing);
			item.estimated = { by: est.by, reason: est.reason, ...(est.check ? { check: true as const } : {}) };
			items.push(item);
			tally(p.account.alias, "estimated");
			if (est.by === "history") tally(p.account.alias, "fromHistory");
			// Seen, so it isn't reported as new again; no answers, since they aren't final. Re-checked later.
			toCache.set(item.key, {
				v: CACHE_VERSION,
				arrived: arrivalOf(p.message),
				meta,
				addressing: x.addressing,
				estimated: true,
				mailbox,
				classifiedAt: now.toISOString(),
			});
			add(estimatedIds, p.account.alias, p.message.id);
			continue;
		}
		const item = toItem(p.account, p.message.id, meta, triage, x.addressing);
		items.push(item);
		const status = statuses.find((s) => s.alias === p.account.alias);
		if (status) status.newlyClassified++;
		tally(p.account.alias, "classified");
		keep(p, x, item, triage, outcome.modelByRef.get(p.ref) ?? cfg.model);
	}
	for (const [alias, t] of sorted) log("sorted", { alias, ...t });
	// What each email fetched in this run says, for reading it in the digest.
	const reading = new Map(pending.map((p, i) => [`${p.account.alias}:${p.message.id}`, prepared[i]!.reading]));
	for (const it of items) {
		const r = it.carried ? undefined : reading.get(it.key);
		if (r) Object.assign(it, r);
	}

	// 3. Threads of emails that would otherwise go into "To action": has the owner answered them?
	const wouldAct = (it: DigestItem) =>
		decide(
			{ signals: it.signals, category: it.category, from: it.from, subject: it.subject, due: it.due, done: false, replied: false, check: it.estimated?.check === true },
			{ today: date, settings },
		).outcome === "action";
	await Promise.all(
		[...clients].map(async ([alias, client]) => {
			const known = states.get(alias) ?? new Map<string, ThreadState>();
			const need = items.filter((it) => it.account === alias && !known.has(it.threadId) && wouldAct(it)).map((it) => it.threadId);
			if (need.length === 0) return;
			try {
				const t0 = Date.now();
				for (const [thread, state] of await client.threadStates(need)) known.set(thread, state);
				log("reply-check", { alias, threads: new Set(need).size, ms: since(t0) });
			} catch (e) {
				// Fail open: these are treated as unanswered.
				console.warn(`thread check failed for ${alias}: ${(e as Error).message}`);
			}
			states.set(alias, known);
		}),
	);

	// Answered: the owner wrote in the conversation after this email.
	for (const it of items) {
		const state = states.get(it.account)?.get(it.threadId);
		if (state && repliedAfter(state, it.messageId, it.date ? Date.parse(it.date) : undefined)) it.replied = true;
		else delete it.replied;
	}

	const prefixed = (key: string, alias: string) => key.startsWith(`${alias}:`);
	const loaded = new Map(await Promise.all([...histories].map(async ([a, h]) => [a, await h] as const)));
	return accounts.map((account, i): MailboxPartial => {
		const a = account.alias;
		const t = sorted.get(a);
		return {
			alias: a,
			status: statuses.find((st) => st.alias === a)!,
			// Masked again on the way out: a mailbox's part is stored in its job mark until the digest is made.
			items: items.filter((it) => it.account === a).map(redactItem),
			toCache: [...toCache].filter(([key]) => prefixed(key, a)),
			...(mailboxes.has(a) ? { run: mailboxes.get(a)! } : {}),
			...(rechecks.has(a) ? { recheck: { before: rechecks.get(a)!, settled: [...(settled.get(a) ?? [])], estimated: estimatedIds.get(a) ?? [] } } : {}),
			learned: learned.get(a) ?? [],
			...(loaded.has(a) ? { history: loaded.get(a)! } : {}),
			...(windowStarts.has(a) ? { windowStart: windowStarts.get(a)! } : {}),
			surfaced: [...surfaced].filter((key) => prefixed(key, a)),
			replacedCarried: [...replacedCarried].filter((key) => prefixed(key, a)),
			...(outcome.unavailable ? { unavailable: outcome.unavailable } : {}),
			errors: i === 0 ? outcome.errors : [],
			estimated: t?.estimated ?? 0,
			fromHistory: t?.fromHistory ?? 0,
		};
	});
}

/**
 * Step 4 and on, from every mailbox's part: done marks, carry-over of items switched back, the digest
 * (stored), and only then, for real runs, the writes that mark mail seen and move the cursors.
 */
export async function assemble(env: RunEnv, ctx: RunContext, partials: MailboxPartial[], fence?: AssemblyFence): Promise<Digest> {
	const prepared = await prepareAssembly(env, ctx, partials);
	return writeAssembly(env, ctx, partials, prepared, fence);
}

/**
 * Called immediately before each group of persistent assembly writes. Job runs use this to prove
 * that the finalizer still owns its strongly-consistent coordinator claim. A failed fence stops
 * publication; it must never silently fall back to the eventually-consistent KV lock.
 */
export type AssemblyFence = () => Promise<void>;

/** A complete snapshot: keys present in `doneKeys` are done; all other keys are not done. */
export interface AssemblySnapshot {
	doneKeys: ReadonlySet<string>;
}

/** Builds the digest without writing state. Without a snapshot, reads the current done marks from KV. */
export async function prepareAssembly(env: RunEnv, ctx: RunContext, partials: MailboxPartial[], snapshot?: AssemblySnapshot) {
	const { window, now, test, cfg, date, settings, openIfUnticked, ticked } = ctx;
	const accounts = ctx.accounts;
	// applySettings and done-mark reconciliation update items in place. Do not modify stored partials.
	const items = partials.flatMap((p) => p.items.map((it) => ({ ...it })));
	// Fail open: a mailbox a job couldn't process keeps its open items, as a mailbox that couldn't be read does.
	for (const p of partials.filter((x) => x.carryOnly)) {
		for (const it of ctx.open) if (it.account === p.alias && it.accountEmail === p.status.email) items.push(carriedCopy(it, now));
	}
	const statuses = partials.map((p) => p.status);
	const toCache = new Map(partials.flatMap((p) => p.toCache));
	const surfaced = new Set(partials.flatMap((p) => p.surfaced));
	const replacedCarried = new Set(partials.flatMap((p) => p.replacedCarried));
	const learned = new Map(partials.filter((p) => p.learned.length).map((p) => [p.alias, p.learned] as const));
	const historyAliases = partials.filter((p) => p.learned.length || p.history).map((p) => p.alias);
	const historyBefore = new Map(partials.flatMap((p) => (p.history ? [[p.alias, p.history] as const] : [])));
	const windowStarts = partials.flatMap((p) => (p.windowStart === undefined ? [] : [p.windowStart]));
	const unavailable = partials.find((p) => p.unavailable)?.unavailable;
	const errors = partials.flatMap((p) => p.errors);
	const estimatedCount = partials.reduce((n, p) => n + p.estimated, 0);
	const fromHistory = partials.reduce((n, p) => n + p.fromHistory, 0);
	const mailboxes = new Map(partials.flatMap((p) => (p.run ? [[p.alias, p.run] as const] : [])));

	// What each re-check list will hold after this run: estimates leave it once re-checked, deleted or
	// shown after waiting too long; this run's estimates join it.
	const lists = new Map(
		partials.flatMap((p) => (p.recheck ? [[p.alias, nextRecheck(p.recheck.before, new Set(p.recheck.settled), p.recheck.estimated, now)] as const] : [])),
	);
	const waitingEntries = [...lists.values()].flatMap((l) => l.next);

	// 4. Done marks, then decide.
	const doneFlags = snapshot
		? items.map((it) => snapshot.doneKeys.has(it.key))
		: (await getMany<string>(env.MAILBOX_KV, items.map((it) => doneKey(it.key)), "text")).map((v) => v !== null);
	items.forEach((it, i) => {
		it.done = doneFlags[i]!;
	});

	// Ticked when this run started, switched back since: carried after all. Its thread isn't re-checked
	// at this point (fail open): the next run checks it as usual.
	const reTicked = openIfUnticked.filter((it) => ticked.has(it.key) && !items.some((i) => i.key === it.key));
	const marksNow = snapshot
		? reTicked.map((it) => snapshot.doneKeys.has(it.key))
		: (await getMany<string>(env.MAILBOX_KV, reTicked.map((it) => doneKey(it.key)), "text")).map((v) => v !== null);
	reTicked.forEach((it, i) => {
		const linked = accounts.some((a) => a.alias === it.account && a.email === it.accountEmail);
		if (!marksNow[i] && linked) items.push(carriedCopy(it, now, { done: false }));
	});

	const legacyId = runId(now, test);
	const id = ctx.jobRunId ?? legacyId;
	if (id !== legacyId && id !== runId(now, test, ctx.jobId)) throw new Error("Digest ID does not match the job");
	const digest = applySettings(
		{
			id,
			date,
			test: test || undefined,
			window,
			windowFrom: windowStarts.length ? new Date(Math.min(...windowStarts)).toISOString() : null,
			generatedAt: now.toISOString(),
			model: cfg.fallbackModel ? `${cfg.model} (fallback ${cfg.fallbackModel})` : cfg.model,
			query: cfg.query,
			items,
			accounts: statuses.sort((a, b) => a.alias.localeCompare(b.alias)),
			...(ctx.jobId ? { job: ctx.jobId } : {}),
			modelErrors: errors.slice(0, 5),
			...aiNote({
				unavailable,
				estimated: estimatedCount,
				fromHistory,
				waiting: waitingEntries.length,
				oldestWaiting: waitingEntries.length ? new Date(Math.min(...waitingEntries.map((e) => e.added))).toISOString() : undefined,
				expired: surfaced.size,
			}),
		},
		settings,
	);
	// Carried items that are no longer open (replied, ticked, muted) aren't repeated.
	// A re-checked email is shown when it needs the owner, or in place of the carried copy it replaced.
	// A lapsed estimate is shown once, only while it's open (not done).
	digest.items = digest.items.filter(
		(it) => (!it.carried || isOpen(it)) && (!it.rechecked || isOpen(it) || replacedCarried.has(it.key)) && (!surfaced.has(it.key) || isOpen(it)),
	);
	return { digest, lists, toCache, historyAliases, historyBefore, learned, statuses, mailboxes };
}

/** Persists a prepared digest before advancing the associated mailbox state. */
async function writeAssembly(
	env: RunEnv,
	ctx: RunContext,
	partials: MailboxPartial[],
	prepared: Awaited<ReturnType<typeof prepareAssembly>>,
	fence?: AssemblyFence,
): Promise<Digest> {
	const { digest, lists, toCache, historyAliases, historyBefore, learned, statuses, mailboxes } = prepared;
	const { now, test, accounts } = ctx;
	const id = digest.id;
	await fence?.();
	await saveDigest(env.MAILBOX_KV, digest);
	if (test) {
		// A test run writes no run state; it only records that it read these mailboxes ("last checked").
		await Promise.all(partials.filter((p) => p.status.ok && p.run).map((p) => env.MAILBOX_KV.put(checkedKey(p.alias), String(now.getTime()))));
		return digest;
	}

	// 5. Real runs: only now that the digest holds them, mark this run's mail seen (by caching it) and
	//    move each healthy mailbox's cursor. A crash before this point just repeats the run.
	//    The re-check lists go first: an estimate's seen mark must never exist without its list entry,
	//    or a crash in between would leave it seen but never re-checked.
	// A newer real run stored its digest meanwhile (this one was left too long): this digest is kept as
	// an earlier run, but it writes no state, so that run's last-run, seen marks and cursors stand.
	const current = await env.MAILBOX_KV.get(LAST_RUN_KEY);
	if (current && DIGEST_ID.test(current) && current > id) {
		log("superseded", { by: current });
		return digest;
	}
	const tWrites = Date.now();
	await fence?.();
	await env.MAILBOX_KV.put(LAST_RUN_KEY, id);
	// Rewritten on every real run that read it, even unchanged: that renews its TTL, so a list can't
	// expire while entries on it are waiting (or waiting to be shown after lapsing).
	await fence?.();
	await Promise.all([...lists].map(([alias, l]) => (l.changed || l.next.length ? writeRecheck(env.MAILBOX_KV, alias, l.next) : undefined)));
	await fence?.();
	await Promise.all(
		[...toCache].map(([key, value]) => {
			const [alias, messageId] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
			// Arrival in the metadata: a history seeded later picks the newest entries from the key list alone.
			return env.MAILBOX_KV.put(clsKey(alias, messageId), JSON.stringify(value), {
				expirationTtl: CLASSIFICATION_TTL,
				...(value.arrived !== undefined ? { metadata: { arrived: value.arrived } } : {}),
			});
		}),
	);
	// Histories: one write per mailbox.
	await fence?.();
	await Promise.all(
		historyAliases.map(async (alias) =>
			saveHistory(
				env.MAILBOX_KV,
				alias,
				historyBefore.get(alias) ?? (await loadHistory(env.MAILBOX_KV, alias, accounts.find((a) => a.alias === alias)?.email ?? "")),
				learned.get(alias) ?? [],
			),
		),
	);
	await fence?.();
	await Promise.all(
		statuses
			.filter((s) => s.ok && mailboxes.has(s.alias))
			.map((s) => advanceCursor(env.MAILBOX_KV, s.alias, mailboxes.get(s.alias)!, digest.items, now)),
	);
	log("writes", { cache: toCache.size, recheckLists: [...lists.values()].filter((l) => l.changed || l.next.length).length, histories: historyAliases.length, ms: since(tWrites) });
	return digest;
}

export type AssemblyWrite =
	| { kind: "put"; key: string; value: string; expirationTtl?: number; metadata?: { arrived: number } }
	| { kind: "delete"; key: string };

/** Complete, consistent inputs for planning. A null cursor or failure record means known absent. */
export interface AssemblyStateSnapshot {
	lastRun: string | null;
	indexedRuns: readonly string[];
	cursors: Readonly<Record<string, Cursor | null>>;
	failureHolds: Readonly<Record<string, Readonly<Record<string, number>> | null>>;
	/** Complete history, including any required cache seeding, for every history this run updates. */
	histories: Readonly<Record<string, readonly HistoryEntry[]>>;
}

/** Captures every mutable input used by the pure assembly planner from one request-scoped store. */
export async function captureAssemblySnapshot(
	kv: KVNamespace,
	ctx: RunContext,
	partials: readonly MailboxPartial[],
): Promise<{ done: AssemblySnapshot; state: AssemblyStateSnapshot }> {
	const doneCandidates = [...new Set([...partials.flatMap((partial) => partial.items.map((item) => item.key)), ...ctx.openIfUnticked.map((item) => item.key)])];
	const aliases = [...new Set(partials.map((partial) => partial.alias))];
	const historiesNeeded = [...new Set(partials.filter((partial) => partial.learned.length || partial.history).map((partial) => partial.alias))];
	const [doneValues, lastRun, indexedRuns, cursorValues, failureValues, historyValues] = await Promise.all([
		getMany<string>(kv, doneCandidates.map(doneKey), "text"),
		kv.get(LAST_RUN_KEY),
		readRuns(kv),
		getMany<Cursor>(kv, aliases.map(cursorKey), "json"),
		getMany<Record<string, number>>(kv, aliases.map(failuresKey), "json"),
		Promise.all(historiesNeeded.map(async (alias) => [alias, await loadHistory(kv, alias, ctx.accounts.find((account) => account.alias === alias)?.email ?? "")] as const)),
	]);
	return {
		done: { doneKeys: new Set(doneCandidates.filter((_, index) => doneValues[index] !== null)) },
		state: {
			lastRun,
			indexedRuns,
			cursors: Object.fromEntries(aliases.map((alias, index) => [alias, cursorValues[index] ?? null])),
			failureHolds: Object.fromEntries(aliases.map((alias, index) => [alias, failureValues[index] ?? null])),
			histories: Object.fromEntries(historyValues),
		},
	};
}

/** Bounds for a future staging protocol, not a guarantee that a single storage transaction can hold it. */
export const ASSEMBLY_MANIFEST_LIMITS = { operations: ATOMIC_GENERATION_MAX_ENTRIES, bytes: 8 * 1024 * 1024 } as const;

/** Reject oversized input before JSON encoding can allocate a large serialized copy. */
function checkManifestValue(value: unknown, budget: number): void {
	const pending: { value: unknown; depth: number }[] = [{ value, depth: 0 }];
	let minimum = 0;
	let nodes = 0;
	while (pending.length) {
		const current = pending.pop()!;
		if (++nodes > 100_000 || current.depth > 100) throw new Error("Assembly manifest exceeds limits");
		if (typeof current.value === "string") minimum += current.value.length;
		else if (current.value && typeof current.value === "object") {
			const keys = Object.keys(current.value);
			minimum += keys.length;
			if (minimum > budget || pending.length + keys.length > 100_000) throw new Error("Assembly manifest exceeds limits");
			for (const key of keys) {
				minimum += key.length;
				pending.push({ value: (current.value as Record<string, unknown>)[key], depth: current.depth + 1 });
			}
		} else minimum++;
		if (minimum > budget) throw new Error("Assembly manifest exceeds limits");
	}
}

/**
 * Plans the complete run-managed state with no I/O. The caller must publish every write atomically
 * against the same snapshot: applying this list to KV, even in order, is not a safe commit protocol.
 * In particular re-check records and their seen marks must become visible together.
 */
export function buildAssemblyManifest(
	ctx: RunContext,
	partials: readonly MailboxPartial[],
	prepared: Awaited<ReturnType<typeof prepareAssembly>>,
	snapshot: AssemblyStateSnapshot,
	job?: { id: string; result: RunResult },
	limits: { operations: number; bytes: number } = ASSEMBLY_MANIFEST_LIMITS,
): { atomicPublicationRequired: true; writes: AssemblyWrite[]; encodedBytes: number } {
	if (!Number.isSafeInteger(limits.operations) || limits.operations < 1 || limits.operations > ATOMIC_GENERATION_MAX_ENTRIES || !Number.isSafeInteger(limits.bytes) || limits.bytes < 1 || limits.bytes > 32 * 1024 * 1024) throw new Error("Invalid assembly manifest limits");
	if (!snapshot || !Object.hasOwn(snapshot, "lastRun") || (snapshot.lastRun !== null && typeof snapshot.lastRun !== "string") || !Array.isArray(snapshot.indexedRuns) || snapshot.indexedRuns.some((id) => typeof id !== "string")) {
		throw new Error("Incomplete assembly snapshot");
	}
	const { digest, lists, toCache, historyAliases, learned, statuses, mailboxes } = prepared;
	if (ctx.jobId || digest.job || job) {
		if (!job || !/^[A-Za-z0-9_-]{22}$/.test(job.id) || ctx.jobId !== job.id || digest.job !== job.id ||
			job.result?.job !== job.id || job.result.digest !== digest.id || job.result.test !== ctx.test) {
			throw new Error("Missing or mismatched assembly job result");
		}
	}
	const writes: AssemblyWrite[] = [];
	let estimatedBytes = 0;
	const encoder = new TextEncoder();
	const add = (write: AssemblyWrite) => {
		estimatedBytes += encoder.encode(JSON.stringify(write)).byteLength + 1;
		if (writes.length >= limits.operations || estimatedBytes > limits.bytes) throw new Error("Assembly manifest exceeds limits");
		writes.push(write);
	};
	const put = (key: string, value: unknown, expirationTtl?: number, metadata?: { arrived: number }) => {
		if (writes.length >= limits.operations) throw new Error("Assembly manifest exceeds limits");
		checkManifestValue(value, limits.bytes - estimatedBytes);
		add({ kind: "put", key, value: JSON.stringify(value), ...(expirationTtl === undefined ? {} : { expirationTtl }), ...(metadata ? { metadata } : {}) });
	};
	// Check before redaction and index construction as well as before JSON serialization.
	checkManifestValue(digest, limits.bytes);
	checkManifestValue(snapshot.indexedRuns, limits.bytes);
	const redacted = { ...digest, items: digest.items.map(redactItem) };
	put(digestKey(digest.id), redacted, DIGEST_TTL);
	const at = Date.parse(digest.generatedAt);
	const live = [...snapshot.indexedRuns, ...(snapshot.lastRun && DIGEST_ID.test(snapshot.lastRun) ? [snapshot.lastRun] : [])].filter((id) => !(expiresAt(id) <= at));
	put(RUNS_INDEX, sortRuns([digest.id, ...live]));
	if (ctx.test) {
		for (const p of partials.filter((p) => p.status.ok && p.run)) add({ kind: "put", key: checkedKey(p.alias), value: String(ctx.now.getTime()) });
	} else if (!(snapshot.lastRun && DIGEST_ID.test(snapshot.lastRun) && snapshot.lastRun > digest.id)) {
		add({ kind: "put", key: LAST_RUN_KEY, value: digest.id });
		for (const [alias, list] of lists) {
			if (!list.changed && !list.next.length) continue;
			if (list.next.length) put(recheckKey(alias), list.next, RECHECK_TTL + 7 * 24 * 60 * 60);
			else add({ kind: "delete", key: recheckKey(alias) });
		}
		for (const [key, value] of toCache) {
			const split = key.indexOf(":");
			put(clsKey(key.slice(0, split), key.slice(split + 1)), value, CLASSIFICATION_TTL, value.arrived === undefined ? undefined : { arrived: value.arrived });
		}
		for (const alias of historyAliases) {
			const before = snapshot.histories && Object.hasOwn(snapshot.histories, alias) ? snapshot.histories[alias] : undefined;
			if (!Array.isArray(before)) throw new Error(`Missing history snapshot for ${alias}`);
			const added = learned.get(alias) ?? [];
			const ids = new Set(added.map((entry) => entry.id));
			const next = [...[...added].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")), ...before.filter((entry) => !ids.has(entry.id))].slice(0, HISTORY_MAX);
			put(historyKey(alias), next, DIGEST_TTL);
		}
		for (const status of statuses.filter((s) => s.ok && mailboxes.has(s.alias))) {
			const alias = status.alias;
			if (!snapshot.cursors || !Object.hasOwn(snapshot.cursors, alias) || (snapshot.cursors[alias] !== null && typeof snapshot.cursors[alias] !== "object")) throw new Error(`Missing cursor snapshot for ${alias}`);
			const run = mailboxes.get(alias)!;
			const mine = digest.items.filter((it) => it.account === alias && !it.carried && !it.rechecked);
			const failures = mine.filter((it) => !it.classified && !it.done);
			let held: DigestItem[] = [];
			if (failures.length) {
				if (!snapshot.failureHolds || !Object.hasOwn(snapshot.failureHolds, alias) || (snapshot.failureHolds[alias] !== null && typeof snapshot.failureHolds[alias] !== "object")) throw new Error(`Missing failure snapshot for ${alias}`);
				const result = calculateHeldFailures(failures, snapshot.failureHolds[alias] ?? {}, ctx.now);
				held = result.held;
				put(failuresKey(alias), result.next, CLASSIFICATION_TTL);
			}
			put(cursorKey(alias), calculateCursor(run, mine, held, ctx.now, snapshot.cursors[alias] ?? run.before));
		}
	}
	if (job) {
		put(`job-result:${job.id}`, job.result, DIGEST_TTL);
		add({ kind: "put", key: `job-done:${job.id}`, value: digest.id, expirationTtl: DIGEST_TTL });
	}
	const manifest = { atomicPublicationRequired: true as const, writes, encodedBytes: 0 };
	// Account for the envelope and the encodedBytes field itself, including multibyte text.
	let bytes = encoder.encode(JSON.stringify(manifest)).byteLength;
	while (bytes !== manifest.encodedBytes) {
		manifest.encodedBytes = bytes;
		bytes = encoder.encode(JSON.stringify(manifest)).byteLength;
	}
	if (manifest.encodedBytes > limits.bytes) throw new Error("Assembly manifest exceeds limits");
	return manifest;
}

/**
 * Moves the cursor to the newest mail this run handled, but never past an email that failed to load
 * or classify (it stays uncached and is retried) for FAILURE_HOLD_MS, never past now, and never
 * backwards. A failure ticked done, or failing for longer, no longer holds it: it's in this digest,
 * and is carried as still open from here.
 */
async function advanceCursor(kv: KVNamespace, alias: string, run: MailboxRun, items: DigestItem[], now: Date): Promise<void> {
	// Re-checked mail was handled by an earlier run; estimated mail counts as handled (it's re-checked).
	const mine = items.filter((it) => it.account === alias && !it.carried && !it.rechecked);
	const failed = await heldFailures(kv, alias, mine.filter((it) => !it.classified && !it.done), now);
	// Re-read after writing the failure hold, as before, to use the newest available cursor.
	const latest = (await kv.get<Cursor>(cursorKey(alias), "json")) ?? run.before;
	const cursor = calculateCursor(run, mine, failed, now, latest);
	await kv.put(cursorKey(alias), JSON.stringify(cursor));
}

/** Calculates the cursor from a caller-supplied snapshot; performs no I/O or mutation. */
export function calculateCursor(run: MailboxRun, mine: readonly DigestItem[], failed: readonly DigestItem[], now: Date, latest: Cursor | null): Cursor {
	const time = (it: DigestItem) => (it.date ? Date.parse(it.date) : Number.NaN);
	const ok = mine.filter((it) => it.classified).map(time).filter(Number.isFinite);
	// With a backlog, newer unprocessed mail sits above everything this run took; seen mail may not.
	let next = Math.max(...ok, ...(run.backlog ? [] : run.seenTimes));
	if (failed.length) next = Math.min(next, Math.min(...failed.map(time)) - 1);
	next = Math.min(next, now.getTime());
	// A failure with no known arrival time could be anywhere in the window: keep the cursor.
	const moves = !failed.some((it) => Number.isNaN(time(it))) && Number.isFinite(next) && next > 0;
	const forward = moves && (latest?.after === undefined || next > latest.after);
	const shrunk = run.share !== undefined && run.full !== undefined && run.share < run.full;
	// Written every run the mailbox was read, moved or not, for "last checked": one write per mailbox,
	// where before a run with nothing new wrote none. The share hint is kept unless the cursor moved.
	return {
		...(forward ? { after: next } : latest?.after !== undefined ? { after: latest.after } : {}),
		...(forward ? (shrunk ? { share: run.share } : {}) : latest?.share !== undefined ? { share: latest.share } : {}),
		checked: now.getTime(),
	};
}

/**
 * A message Gmail failed to load was stored under its own id as its thread id, since its thread was
 * unknown; the archive and reply checks need the real one. Looks those messages up (thread id and
 * labels only): gone (404) or archived, they're no longer open; otherwise they get their real thread.
 * Any other failure leaves them as they are (fail open).
 */
async function withKnownThreads(client: GmailClient, items: DigestItem[]): Promise<DigestItem[]> {
	const unknown = new Set(items.filter((it) => !it.classified && it.threadId === it.messageId));
	if (unknown.size === 0) return items;
	let found: Awaited<ReturnType<GmailClient["getMinimalMany"]>>;
	try {
		found = await client.getMinimalMany([...unknown].map((it) => it.messageId));
	} catch (e) {
		console.warn(`message lookup failed for ${client.account.alias}: ${(e as Error).message}`);
		return items;
	}
	const byId = new Map(found.messages.map((m) => [m.id, m]));
	const gone = new Set(found.failed.filter((f) => f.status === 404).map((f) => f.id));
	return items.flatMap((it) => {
		if (!unknown.has(it)) return [it];
		if (gone.has(it.messageId)) return [];
		const m = byId.get(it.messageId);
		if (!m) return [it];
		if (!m.labelIds?.includes("INBOX")) return [];
		return [{ ...it, threadId: m.threadId }];
	});
}

/**
 * The mailbox's own addresses, so mail to an alias or send-as address counts as addressed to the
 * owner. Fails open to the primary address alone.
 */
async function addressesOf(client: GmailClient): Promise<string[]> {
	try {
		return [client.account.email, ...(await client.sendAsAddresses())];
	} catch (e) {
		console.warn(`send-as addresses failed for ${client.account.alias}: ${(e as Error).message}`);
		return [client.account.email];
	}
}

/**
 * The failures that still hold the cursor. Remembers when each first failed, and forgets the ones
 * that didn't fail this run. No KV operations when nothing failed.
 */
async function heldFailures(kv: KVNamespace, alias: string, failed: DigestItem[], now: Date): Promise<DigestItem[]> {
	if (failed.length === 0) return [];
	const before = (await kv.get<Record<string, number>>(failuresKey(alias), "json")) ?? {};
	const { held, next } = calculateHeldFailures(failed, before, now);
	await kv.put(failuresKey(alias), JSON.stringify(next), { expirationTtl: CLASSIFICATION_TTL });
	return held;
}

/** Calculates failure holds and their next record without reading or writing storage. */
export function calculateHeldFailures(failed: readonly DigestItem[], before: Readonly<Record<string, number>>, now: Date): { held: DigestItem[]; next: Record<string, number> | null } {
	if (failed.length === 0) return { held: [], next: null };
	const since: Record<string, number> = {};
	for (const it of failed) since[it.messageId] = before[it.messageId] ?? now.getTime();
	return { held: failed.filter((it) => now.getTime() - since[it.messageId]! < FAILURE_HOLD_MS), next: since };
}

// --- History and re-check lists --------------------------------------------------------------

/**
 * A mailbox's history, newest first. Missing (first run with this version, or the mailbox was
 * re-linked), it's seeded once from the classification cache: one list call and at most 5 bulk reads,
 * for the newest HISTORY_MAX entries (Gmail ids grow with time, and KV lists keys in order).
 */
async function loadHistory(kv: KVNamespace, alias: string, email: string): Promise<HistoryEntry[]> {
	const stored = await kv.get<HistoryEntry[]>(historyKey(alias), "json");
	if (stored) return stored;
	// Every cache key of the mailbox (up to SEED_LIST_PAGES list calls), newest first by arrival (kept in
	// the key's metadata) or, for entries written before that, by when it was written (its expiry).
	const prefix = `cls:${alias}:`;
	const listed: { name: string; at: number }[] = [];
	let cursor: string | undefined;
	for (let page = 0; page < SEED_LIST_PAGES; page++) {
		const res = await kv.list<{ arrived?: number }>({ prefix, cursor });
		for (const k of res.keys) listed.push({ name: k.name, at: k.metadata?.arrived ?? ((k.expiration ?? 0) - CLASSIFICATION_TTL) * 1000 });
		if (res.list_complete) break;
		cursor = res.cursor;
	}
	const keys = listed.sort((a, b) => b.at - a.at).slice(0, HISTORY_MAX).map((k) => k.name);
	const cached = await getMany<CachedClassification>(kv, keys, "json");
	const seeded: HistoryEntry[] = [];
	cached.forEach((c, i) => {
		if (!c || c.v !== CACHE_VERSION || !c.triage || !c.addressing || c.source === "rule") return;
		if (c.mailbox !== undefined && c.mailbox !== email.toLowerCase()) return;
		const f = featuresOf({ from: c.meta.from, subject: c.meta.subject, text: c.meta.snippet, addressing: c.addressing, conversation: false, attachments: [] });
		seeded.push(historyEntry(keys[i]!.slice(prefix.length), f, c.triage, c.meta));
	});
	return seeded.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? ""));
}

/** List calls (1,000 keys each) when seeding a history: the newest 500 of up to 5,000 cache entries. */
const SEED_LIST_PAGES = 5;

/** Adds what the model classified this run, newest first, keeping HISTORY_MAX. One write; kept as long as a digest. */
async function saveHistory(kv: KVNamespace, alias: string, before: HistoryEntry[], added: HistoryEntry[]): Promise<void> {
	const ids = new Set(added.map((e) => e.id));
	const next = [...[...added].sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")), ...before.filter((e) => !ids.has(e.id))].slice(0, HISTORY_MAX);
	await kv.put(historyKey(alias), JSON.stringify(next), { expirationTtl: DIGEST_TTL });
}

interface RecheckEntry {
	id: string;
	/** When it was estimated (ms). */
	added: number;
}

/** A mailbox's re-check list, oldest first: entries still waiting, and those that waited RECHECK_TTL. */
async function loadRecheck(kv: KVNamespace, alias: string, now: Date): Promise<{ live: RecheckEntry[]; expired: RecheckEntry[] }> {
	const list = ((await kv.get<RecheckEntry[]>(recheckKey(alias), "json")) ?? []).sort((a, b) => a.added - b.added);
	const lapsed = (e: RecheckEntry) => now.getTime() - e.added >= RECHECK_TTL * 1000;
	return { live: list.filter((e) => !lapsed(e)), expired: list.filter(lapsed) };
}

/** Takes settled ids off the list and adds newly estimated ones. */
function nextRecheck(before: RecheckEntry[], settledIds: Set<string> | undefined, added: string[], now: Date): { next: RecheckEntry[]; changed: boolean } {
	const kept = before.filter((e) => !settledIds?.has(e.id));
	const known = new Set(before.map((e) => e.id));
	const fresh = added.filter((id) => !known.has(id)).map((id) => ({ id, added: now.getTime() }));
	return { next: [...kept, ...fresh], changed: kept.length !== before.length || fresh.length > 0 };
}

async function writeRecheck(kv: KVNamespace, alias: string, next: RecheckEntry[]): Promise<void> {
	// Renewed by every real run that reads it, and kept a week past an entry's lapse: a mailbox that
	// can't be read for a few days around then still gets its lapsed estimates shown once it can.
	if (next.length === 0) await kv.delete(recheckKey(alias));
	else await kv.put(recheckKey(alias), JSON.stringify(next), { expirationTtl: RECHECK_TTL + 7 * 24 * 60 * 60 });
}

const NEVER_RECHECKED = `The AI model couldn't re-check this estimate within ${RECHECK_TTL / 86_400} days; check it`;

/**
 * Estimates that waited RECHECK_TTL without the model: each is shown once more, in To action to check,
 * unless it's gone from the inbox (or deleted). Built from its seen mark; Gmail is asked only for its
 * thread and labels. `settled`: ids to take off the list; any other lookup failure leaves them on it.
 */
async function expiredEstimates(kv: KVNamespace, client: GmailClient, account: AccountRecord, ids: string[]): Promise<{ items: DigestItem[]; settled: string[] }> {
	let found: Awaited<ReturnType<GmailClient["getMinimalMany"]>>;
	try {
		found = await client.getMinimalMany(ids);
	} catch (e) {
		console.warn(`lapsed estimates lookup failed for ${account.alias}: ${(e as Error).message}`);
		return { items: [], settled: [] };
	}
	const marks = await getMany<CachedClassification>(kv, ids.map((id) => clsKey(account.alias, id)), "json");
	const byId = new Map(found.messages.map((m) => [m.id, m]));
	const gone = new Set(found.failed.filter((f) => f.status === 404).map((f) => f.id));
	const out = { items: [] as DigestItem[], settled: [] as string[] };
	ids.forEach((id, i) => {
		if (gone.has(id)) out.settled.push(id);
		const m = byId.get(id);
		if (!m) return;
		out.settled.push(id);
		if (!m.labelIds?.includes("INBOX")) return;
		const mark = marks[i];
		const meta: MessageMeta = mark?.meta
			? { ...mark.meta, threadId: m.threadId }
			: { ...metaOf(m), from: "(unknown sender)", subject: "(no subject)" };
		const triage: Triage = {
			sender: "automated",
			request: "none",
			stakes: "none",
			action: "Check this email (estimated; the AI model never re-checked it)",
			category: "other",
			due: null,
			summary: snippetSummary(meta.snippet),
		};
		out.items.push({ ...toItem(account, id, meta, triage, mark?.addressing ?? "not_named"), estimated: { by: "rules", reason: NEVER_RECHECKED, check: true } });
	});
	return out;
}

/** Header lines kept on an item for reading are capped at this many characters (a long Cc list). */
const ADDRESS_LINE_CHARS = 500;

type Reading = Pick<DigestItem, "text" | "textCut" | "to" | "cc">;

/** A carried item keeps the email's text, To and Cc this long after it arrived; then only its summary. */
export const CARRIED_TEXT_DAYS = 14;

/**
 * An open item carried into the next run. Past CARRIED_TEXT_DAYS it drops the text, To and Cc (the
 * page then says to open it in Gmail), so carry-over can't grow a digest toward KV's value limit.
 */
function carriedCopy(it: DigestItem, now: Date, extra: Partial<DigestItem> = {}): DigestItem {
	const copy: DigestItem = { ...it, carried: true, decision: undefined, ...extra };
	const at = it.date ? Date.parse(it.date) : Number.NaN;
	if (!(now.getTime() - at <= CARRIED_TEXT_DAYS * 86_400_000)) {
		delete copy.text;
		delete copy.textCut;
		delete copy.to;
		delete copy.cc;
	}
	return copy;
}

/** The text, To and Cc an item keeps: only what's there. */
function readingOf(full: { excerpt: Excerpt; to: string | null; cc: string | null }): Reading {
	const line = (v: string | null) => (v && v.trim() ? truncateLine(v.trim(), ADDRESS_LINE_CHARS) : undefined);
	const out: Reading = {};
	if (full.excerpt.text) {
		out.text = full.excerpt.text;
		if (full.excerpt.cut) out.textCut = full.excerpt.cut;
	}
	const to = line(full.to);
	const cc = line(full.cc);
	if (to) out.to = to;
	if (cc) out.cc = cc;
	return out;
}

const truncateLine = (v: string, max: number) => (v.length <= max ? v : `${v.slice(0, max - 1)}…`);

/** needsAction, urgency and decision are filled in by applySettings. */
function toItem(account: AccountRecord, id: string, meta: MessageMeta, t: Triage, addressing: Addressing): DigestItem {
	return {
		key: `${account.alias}:${id}`,
		account: account.alias,
		accountEmail: account.email,
		messageId: id,
		...meta,
		needsAction: false,
		action: t.action,
		urgency: "low",
		category: t.category,
		due: t.due,
		summary: t.summary,
		classified: true,
		done: false,
		signals: { sender: t.sender, request: t.request, stakes: t.stakes, addressing },
	};
}

/** Fail open: anything we couldn't classify is shown as needing a look, never silently dropped. */
function unclassified(account: AccountRecord, id: string, meta: MessageMeta): DigestItem {
	return {
		key: `${account.alias}:${id}`,
		account: account.alias,
		accountEmail: account.email,
		messageId: id,
		...meta,
		needsAction: true,
		action: "Check manually (couldn't be classified)",
		urgency: "medium",
		category: "other",
		due: null,
		summary: meta.snippet.slice(0, 200),
		classified: false,
		done: false,
	};
}

// --- Reading and updating stored digests --------------------------------------------------------

export async function getDigest(kv: KVNamespace, id: string): Promise<Digest | null> {
	if (!DIGEST_ID.test(id)) return null;
	const d = await kv.get<Digest>(digestKey(id), "json");
	// Digests stored before runs had ids were keyed by date.
	if (d && !d.id) d.id = id;
	// Defence in depth: digests stored before secrets were masked, and anything that slipped through.
	if (d && Array.isArray(d.items)) d.items = d.items.map(redactItem);
	return d;
}

/** Stored digest ids, newest first. */
export async function listDigests(kv: KVNamespace, limit = 14): Promise<string[]> {
	return (await readRuns(kv)).slice(0, limit);
}

/**
 * Ids of stored digests, in one key: the page reads it on every view, where a KV list would be
 * eventually consistent and count against the free plan's daily list budget. Kept by saveDigest.
 */
const RUNS_INDEX = "runs-index";
/**
 * Ids kept in the index, the oldest going first: real runs enough for 60 days of frequent runs (ids
 * are short), and test runs apart, so they can never push real runs out.
 */
const RUNS_INDEX_MAX = { real: 1_000, test: 30 };

/** When a digest stored under `id` expires (ms); NaN if the id isn't a time. */
function expiresAt(id: string): number {
	return Date.parse(id.length === 10 ? `${id}T00:00:00Z` : id.slice(0, 20)) + DIGEST_TTL * 1000;
}

function sortRuns(ids: string[]): string[] {
	const all = [...new Set(ids)].sort().reverse();
	const real = all.filter((id) => !id.endsWith("-test")).slice(0, RUNS_INDEX_MAX.real);
	const test = all.filter((id) => id.endsWith("-test")).slice(0, RUNS_INDEX_MAX.test);
	return [...real, ...test].sort().reverse();
}

/**
 * The index, newest first. Missing (a deployment from before it), it's seeded once from a list of the
 * digest keys. Ids whose digest has expired are dropped when the next digest is saved.
 */
async function readRuns(kv: KVNamespace): Promise<string[]> {
	let ids = await kv.get<string[]>(RUNS_INDEX, "json");
	if (!ids) {
		ids = sortRuns(await listedRuns(kv));
		await kv.put(RUNS_INDEX, JSON.stringify(ids));
	}
	return ids;
}

/**
 * Stores a digest and adds it to the index, dropping ids whose digest has expired by then (DIGEST_TTL
 * after their run, measured from this digest's run). A merge, not an overwrite: the index as read (which
 * may be a little stale), this id, and `last-run`'s. Whatever a race still drops, the daily reconcile
 * (reconcileRunsIndex) puts back. With no run for DIGEST_TTL, the page may list a run whose digest is
 * gone; opening it says so.
 */
export async function saveDigest(kv: KVNamespace, d: Digest): Promise<void> {
	// Items built from older cache entries (stored before secrets were masked) are masked here.
	if (Array.isArray(d.items)) d.items = d.items.map(redactItem);
	await kv.put(digestKey(d.id), JSON.stringify(d), { expirationTtl: DIGEST_TTL });
	const at = Date.parse(d.generatedAt);
	const [indexed, last] = await Promise.all([readRuns(kv), kv.get(LAST_RUN_KEY)]);
	const live = [...indexed, ...(last && DIGEST_ID.test(last) ? [last] : [])].filter((id) => !(expiresAt(id) <= at));
	await kv.put(RUNS_INDEX, JSON.stringify(sortRuns([d.id, ...live])));
}

/** Digest ids listed with KV keys (paged); lists are eventually consistent, so a just-saved one may be missing. */
async function listedRuns(kv: KVNamespace): Promise<string[]> {
	const ids: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: "digest:", cursor });
		for (const k of page.keys) ids.push(k.name.slice("digest:".length));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return ids;
}

/** A listing can lag this long behind a write; an index id younger than this is never dropped for being unlisted. */
const LIST_LAG_MS = 60 * 60 * 1000;

/**
 * Self-healing, once a day (the scheduled run): adds digests the index lost to a race, and drops ids
 * whose digest is gone (unlisted, and older than LIST_LAG_MS). One paged list. Returns what changed.
 */
export async function reconcileRunsIndex(kv: KVNamespace, now: Date): Promise<{ added: number; removed: number }> {
	const [indexed, listed] = await Promise.all([readRuns(kv), listedRuns(kv)]);
	const onList = new Set(listed);
	const inIndex = new Set(indexed);
	const added = listed.filter((id) => !inIndex.has(id));
	const removed = indexed.filter((id) => !onList.has(id) && !(now.getTime() - (expiresAt(id) - DIGEST_TTL * 1000) < LIST_LAG_MS));
	if (added.length || removed.length) {
		const gone = new Set(removed);
		await kv.put(RUNS_INDEX, JSON.stringify(sortRuns([...indexed.filter((id) => !gone.has(id)), ...added])));
	}
	return { added: added.length, removed: removed.length };
}

/**
 * Sets each item's done flag from its done mark. The marks are the single source of truth: the done
 * switches write only them, never the stored digest. Bulk reads: one KV operation per 100 items.
 */
export async function withDoneMarks(kv: KVNamespace, d: Digest): Promise<Digest> {
	const marks = await getMany<string>(kv, d.items.map((it) => doneKey(it.key)), "text");
	d.items.forEach((it, i) => {
		it.done = marks[i] !== null;
	});
	return d;
}

/**
 * Sets (done) or clears the done marks of these item keys. Each key is its own KV entry, so switching
 * two items in quick succession can't overwrite one with the other. Returns the keys whose state changed.
 */
export async function setDoneMarks(kv: KVNamespace, keys: string[], done: boolean): Promise<string[]> {
	const unique = [...new Set(keys)];
	const marks = await getMany<string>(kv, unique.map(doneKey), "text");
	const changed = unique.filter((_, i) => (marks[i] !== null) !== done);
	await Promise.all(changed.map((k) => (done ? kv.put(doneKey(k), "1", { expirationTtl: DONE_TTL }) : kv.delete(doneKey(k)))));
	return changed;
}

/** Marks items of a stored digest done (only keys that are in it). Returns the keys changed. */
export async function markDone(kv: KVNamespace, id: string, keys: string[]): Promise<string[]> {
	return setDoneMarks(kv, await knownKeys(kv, id, keys), true);
}

/** Undoes markDone. Returns the keys changed. */
export async function markUndone(kv: KVNamespace, id: string, keys: string[]): Promise<string[]> {
	return setDoneMarks(kv, await knownKeys(kv, id, keys), false);
}

async function knownKeys(kv: KVNamespace, id: string, keys: string[]): Promise<string[]> {
	const digest = await getDigest(kv, id);
	const known = new Set(digest?.items.map((i) => i.key));
	return keys.filter((k) => known.has(k));
}
