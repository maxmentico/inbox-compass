// Runs in steps: one mailbox per request, so a run with several busy mailboxes never has to fit one
// Worker invocation's limits (on the free plan, about 10 ms of CPU and 50 subrequests).
//
// A job lives in KV: `job:<id>` (its options, fixed time and mailboxes), and one key per mailbox,
// `job:<id>:<alias>`, which is first a "running" mark and then the mailbox's part of the run
// (digest.ts MailboxPartial). Each step does one mailbox: collect() for it alone, writing nothing
// else. The last step assembles the digest from the parts exactly as a one-shot run does, stores it,
// and only then marks mail seen and moves cursors. Real runs hold the run lock from the first step to
// the last, renewed on each step. The owner's browser drives a job (meta refresh, no script); the
// morning run drives its own through a service binding to this Worker, each step a new invocation.
//
// A step that dies (exceeded CPU, say) leaves its "running" mark: once it's stale, the mailbox is
// tried again with a much smaller share of mail (RETRY_SHARES), so a busy mailbox drains its backlog
// oldest first rather than dying the same way every day; only when the smallest share also dies is it
// marked failed ("took too long"), its open items carried over as they were and its cursor left alone.
//
// A real job runs only while it holds the run lock. If the lock lapsed (the tab was left longer than
// LOCK_TTL) or another run holds it, the job is stopped for good: it never steps or finishes again, so
// it can't overwrite a newer run (assemble() also refuses to write state behind a newer last-run).

import { listAccounts } from "./accounts";
import { randomToken, sha256Hex, timingSafeEqual } from "./crypto";
import {
	type AccountRunStatus,
	applySettings,
	assemble,
	buildAssemblyManifest,
	captureAssemblySnapshot,
	collect,
	type Digest,
	getDigest,
	isTestRun,
	latestRealRun,
	LOCK_TTL,
	type LockHolder,
	lockMessage,
	type MailboxPartial,
	readLock,
	prepareAssembly,
	releaseLock,
	type RunEnv,
	RunInProgressError,
	type RunOptions,
	type RunWindow,
	runContext,
	runId,
	takeLock,
} from "./digest";
import { AtomicGenerationClient } from "./atomic-generation-authority";
import { ATOMIC_GENERATION_MAX_BYTES, ATOMIC_GENERATION_MAX_ENTRIES } from "./atomic-limits";
import { pinAtomicState } from "./atomic-kv";
import type { Unavailable } from "./llm";
import {
	JOB_AUTHORITY_CLAIM_MAX_MS,
	JOB_AUTHORITY_CLAIM_MIN_MS,
	JobAuthorityClient,
} from "./job-authority";
import { countingAI, countingKV, errorCode, log, newRunStats, noteError, type RunStats, saveRunLog, since, withRunStats } from "./telemetry";

export interface Job {
	id: string;
	/** The digest id this job will store. */
	run: string;
	test: boolean;
	window: RunWindow;
	reclassify: boolean;
	/** The run's time, fixed for every step: windows, cursors and the digest are as of it. */
	now: string;
	aliases: string[];
	/** Each mailbox's address when the job started: a mailbox that fails carries only its own open items. */
	emails: Record<string, string>;
	/** Hash of each sealed refresh-token record; fences unlink/relink, including the same address. */
	identities?: Record<string, string>;
	/** Who steps it: the owner's browser, or the morning run (the page only shows it, unless it stalls). */
	driver: "web" | "cron";
	/** The real run it carries over from, fixed at the start (a retried last step must not see itself). */
	previous: string | null;
	/** When it was created (ms, wall clock; `now` is the run's time, which tests can pin). */
	createdAt?: number;
}

export type RowState = "todo" | "running" | "done" | "failed";
export interface JobRow {
	alias: string;
	state: RowState;
	/** Completed: new mail, and how much of it is in To action. */
	summary?: { fresh: number; toAction: number; estimated: number };
	/** Failed: why, in a few plain words. */
	reason?: string;
}
export interface JobView {
	job: Job;
	rows: JobRow[];
	/** Mailboxes completed or failed. */
	finished: number;
}

type Mark =
	| { state: "running"; attempt: number; startedAt: number }
	| { state: "done"; attempt: number; partial: MailboxPartial; summary?: JobRow["summary"]; reason?: string; at?: number };

/** Unguessable: 128 random bits, base64url. */
export const JOB_ID = /^[A-Za-z0-9_-]{22}$/;
/** Jobs and their parts are kept an hour; a job's lock lapses far sooner if nobody steps it. */
const JOB_TTL = 60 * 60;
/** A "running" mark older than this belongs to a step that died. */
export const STEP_STALE_MS = 2 * 60_000;
/** Each try's cap on a mailbox's share of mail: the full share, then much smaller ones after a step died. */
export const RETRY_SHARES = [Number.POSITIVE_INFINITY, 15, 5] as const;
/** Tries per mailbox: one per share above. */
export const MAX_ATTEMPTS = RETRY_SHARES.length;

const jobKey = (id: string) => `job:${id}`;
const markKey = (id: string, alias: string) => `job:${id}:${alias}`;
/** Set once the job's digest is stored: later visits go to it. Kept as long as the digest. */
const jobDoneKey = (id: string) => `job-done:${id}`;
/** The finished job's result page (rows and totals), kept as long as its digest: "View last run result". */
const jobResultKey = (id: string) => `job-result:${id}`;
const RESULT_TTL = 60 * 24 * 60 * 60;
const FINALIZATION_DIAGNOSTIC_TTL = 7 * 24 * 60 * 60;

export type FinalizationPhase = "snapshot" | "prepare" | "manifest" | "publish";
export interface FinalizationDiagnostic {
	version: 1;
	status: "running" | "failed" | "complete";
	phase: FinalizationPhase;
	updatedAt: number;
	elapsedMs: number;
	mailboxes: number;
	candidates: number;
	cacheWrites: number;
	done?: number;
	items?: number;
	operations?: number;
	bytes?: number;
	code?: string;
}

const finalizationDiagnosticKey = (id: string) => `job-diagnostic:${id}`;

/** Content-free finalizer checkpoint for the owner-facing run page. */
export async function readFinalizationDiagnostic(kv: KVNamespace, id: string): Promise<FinalizationDiagnostic | null> {
	if (!JOB_ID.test(id)) return null;
	const value = await kv.get<Record<string, unknown>>(finalizationDiagnosticKey(id), "json");
	if (!value || value.version !== 1 || !["running", "failed", "complete"].includes(String(value.status)) || !["snapshot", "prepare", "manifest", "publish"].includes(String(value.phase))) return null;
	const integer = (name: string): number | undefined => Number.isSafeInteger(value[name]) && (value[name] as number) >= 0 ? value[name] as number : undefined;
	const updatedAt = integer("updatedAt"), elapsedMs = integer("elapsedMs"), mailboxes = integer("mailboxes"), candidates = integer("candidates"), cacheWrites = integer("cacheWrites");
	if ([updatedAt, elapsedMs, mailboxes, candidates, cacheWrites].some((entry) => entry === undefined)) return null;
	const code = typeof value.code === "string" && /^[a-z0-9 -]{1,64}$/.test(value.code) ? value.code : undefined;
	return {
		version: 1,
		status: value.status as FinalizationDiagnostic["status"],
		phase: value.phase as FinalizationPhase,
		updatedAt: updatedAt!, elapsedMs: elapsedMs!, mailboxes: mailboxes!, candidates: candidates!, cacheWrites: cacheWrites!,
		...(["done", "items", "operations", "bytes"] as const).reduce<Partial<FinalizationDiagnostic>>((out, name) => {
			const number = integer(name); if (number !== undefined) out[name] = number; return out;
		}, {}),
		...(code ? { code } : {}),
	};
}

/** What a finished job's result page shows: every mailbox's final row, and when the run started and ended. */
export interface RunResult {
	job: string;
	digest: string;
	driver: Job["driver"];
	test: boolean;
	rows: JobRow[];
	/** ms, wall clock. */
	started: number;
	finished: number;
}

export async function readResult(kv: KVNamespace, id: string): Promise<RunResult | null> {
	return JOB_ID.test(id) ? kv.get<RunResult>(jobResultKey(id), "json") : null;
}

type JobEnv = RunEnv;

const authorityOf = (env: JobEnv): JobAuthorityClient | null =>
	env.JOB_AUTHORITY ? new JobAuthorityClient(env.JOB_AUTHORITY) : null;

/** Stable per-job capability; never stored, logged, returned to the browser or put in a URL. */
async function authorityOwner(env: Pick<JobEnv, "TOKEN_ENCRYPTION_KEY">, job: string): Promise<string> {
	return sha256Hex(`job-authority-v1|${env.TOKEN_ENCRYPTION_KEY}|${job}`);
}

/** The running holder for UI only. The authority never returns its owner/attempt capabilities. */
export async function readJobLock(env: JobEnv): Promise<LockHolder | null> {
	const authority = authorityOf(env);
	if (!authority) return readLock(env.MAILBOX_KV);
	const view = await authority.inspect();
	return view?.ok ? (view.holder ?? null) : readLock(env.MAILBOX_KV);
}

/**
 * Starts a job for these run options. A real run takes the run lock (RunInProgressError, with the
 * holder, if another run has it). Nothing else is written but the job itself.
 */
export async function startJob(env: JobEnv, opts: RunOptions, now: Date, driver: Job["driver"]): Promise<Job> {
	const kv = env.MAILBOX_KV;
	const test = isTestRun(opts);
	const id = randomToken(16);
	const authority = !test ? authorityOf(env) : null;
	const owner = authority ? await authorityOwner(env, id) : null;
	if (!test) {
		if (authority && owner) {
			// Cutover guard: an invocation of the previous Worker version may still hold only KV.
			const legacy = await readLock(kv);
			if (legacy) throw new RunInProgressError(lockMessage(legacy), legacy);
			const holder = { at: now.toISOString(), job: id, driver } as const;
			// A lost response is retried with the same capability; acquire is idempotent.
			const acquired = (await authority.acquire(owner, holder)) ?? (await authority.acquire(owner, holder));
			if (!acquired?.ok) {
				const current = await authority.inspect();
				if (!current?.ok) throw new Error("Run coordinator is unavailable. Try again in a moment.");
				const held = current.holder;
				if (held) throw new RunInProgressError(lockMessage(held), held);
				throw new Error("Run coordinator rejected the run. Try again in a moment.");
			}
		} else {
			const held = await readLock(kv);
			if (held) throw new RunInProgressError(lockMessage(held), held);
		}
	}
	try {
		// Kept during the transition so an in-flight previous Worker version also sees the run.
		if (!test) await takeLock(kv, { at: now.toISOString(), job: id, driver });
		const [accounts, previous] = await Promise.all([listAccounts(kv), latestRealRun(kv)]);
		if (authority && accounts.length > 63) throw new Error("At most 63 mailboxes can be coordinated in one run.");
		const job: Job = {
			id,
			run: runId(now, test, id),
			test,
			window: opts.window ?? { kind: "since" },
			reclassify: opts.reclassify === true,
			now: now.toISOString(),
			aliases: accounts.map((a) => a.alias),
			emails: Object.fromEntries(accounts.map((a) => [a.alias, a.email])),
			identities: Object.fromEntries(await Promise.all(accounts.map(async (a) => [a.alias, await sha256Hex(a.sealedRefreshToken)] as const))),
			driver,
			previous,
			createdAt: Date.now(),
		};
		await kv.put(jobKey(id), JSON.stringify(job), { expirationTtl: JOB_TTL });
		log("job-start", { job: id, run: job.run, test, driver, mailboxes: job.aliases.length });
		return job;
	} catch (error) {
		if (!test) {
			if (authority && owner) await authority.release(owner);
			if ((await readLock(kv))?.job === id) await releaseLock(kv);
		}
		throw error;
	}
}

export type StepPlan =
	| { kind: "missing" }
	/** The job finished: its digest. */
	| { kind: "done"; digestId: string }
	/** A real job whose lock lapsed or was taken by another run: it never goes on. */
	| { kind: "stopped"; view: JobView }
	/** A step for it is under way elsewhere, or it's the morning run's to step: show progress, wait. */
	| { kind: "wait"; view: JobView }
	/** Do this mailbox: `work` runs the step and returns the new view. */
	| {
			kind: "process";
			view: JobView;
			alias: string;
			work: (opts?: { onProgress?: (done: number, total: number) => void | Promise<void> }) => Promise<JobView>;
		}
	/** Every mailbox is done or failed: `work` assembles and stores the digest. */
	| { kind: "finish"; view: JobView; work: () => Promise<Digest> };

/**
 * What the next step of a job is. `sequential`: the caller is the only one stepping it (the morning
 * run), so a "running" mark can only be a step that died. `observe`: never step it, only show it.
 * `observeCron`: the page's view of the morning run's job: only shown, unless it stalled (nothing has
 * happened in it for STEP_STALE_MS), when the page takes over. Writes only the "failed" mark of a
 * mailbox whose tries are used up.
 */
export async function planStep(
	env: JobEnv,
	id: string,
	opts: { now: Date; sequential?: boolean; observe?: boolean; observeCron?: boolean },
): Promise<StepPlan> {
	const kv = env.MAILBOX_KV;
	if (!JOB_ID.test(id)) return { kind: "missing" };
	// Finished jobs go to their digest; they're never assembled twice.
	const [job, digestId] = await Promise.all([kv.get<Job>(jobKey(id), "json"), kv.get(jobDoneKey(id))]);
	if (digestId) return { kind: "done", digestId };
	if (!job) return { kind: "missing" };
	const marks = await readMarks(kv, job);
	const view = viewOf(job, marks);
	if (!job.test && !(await holdsRun(env, job, marks, opts.now))) return { kind: "stopped", view };
	if (opts.observe) return { kind: "wait", view };
	if (opts.observeCron && job.driver === "cron" && opts.now.getTime() - lastActivity(job, marks) <= STEP_STALE_MS) return { kind: "wait", view };

	let next: string | undefined;
	for (const alias of job.aliases) {
		const m = marks.get(alias);
		if (m?.state !== "running") continue;
		const stale = opts.sequential || opts.now.getTime() - m.startedAt > STEP_STALE_MS;
		if (!stale) return { kind: "wait", view };
		if (m.attempt >= MAX_ATTEMPTS && !authorityOf(env)) {
			const failed: Mark = { state: "done", attempt: m.attempt, partial: lostPartial(alias, job.emails[alias] ?? ""), reason: "took too long", at: Date.now() };
			await kv.put(markKey(job.id, alias), JSON.stringify(failed), { expirationTtl: JOB_TTL });
			marks.set(alias, failed);
			log("step-failed", { job: job.id, alias, reason: "took too long", attempts: m.attempt });
		} else next ??= alias;
	}
	next ??= job.aliases.find((a) => !marks.has(a));
	const now = viewOf(job, marks);
	if (next) {
		const alias = next;
		const attempt = (marks.get(alias)?.attempt ?? 0) + 1;
		const running = { ...now, rows: now.rows.map((r) => (r.alias === alias ? { alias, state: "running" as const } : r)) };
		return {
			kind: "process",
			view: running,
			alias,
			work: (opts) => stepMailbox(env, job, alias, attempt, marks, opts?.onProgress),
		};
	}
	return { kind: "finish", view: now, work: () => finishJob(env, job, marks) };
}

/** Whether this (real) job holds the run lock: for releasing it. */
async function ownsLock(env: JobEnv, job: Job): Promise<boolean> {
	const authority = authorityOf(env);
	if (!authority) return (await readLock(env.MAILBOX_KV))?.job === job.id;
	const view = await authority.snapshot(await authorityOwner(env, job.id));
	return view?.ok === true && view.holder?.job === job.id;
}

/**
 * Whether this (real) job may go on. Held by another run: no. Missing: it lapsed, unless the job did
 * something within LOCK_TTL (a KV read can lag a write, right after the job started, say) and no newer
 * run has stored its digest; then it goes on (and takes the lock again).
 */
async function holdsRun(env: JobEnv, job: Job, marks: Map<string, Mark>, now: Date): Promise<boolean> {
	const authority = authorityOf(env);
	if (authority) {
		const view = await authority.snapshot(await authorityOwner(env, job.id));
		return view?.ok === true && view.holder?.job === job.id;
	}
	const kv = env.MAILBOX_KV;
	const [held, last] = await Promise.all([readLock(kv), kv.get(LAST_RUN)]);
	if (held) return held.job === job.id;
	if (last && last > job.run) return false;
	return now.getTime() - Math.max(job.createdAt ?? 0, lastActivity(job, marks)) <= LOCK_TTL * 1000;
}
const LAST_RUN = "last-run";

/** When anything last happened in a job: its start, a step starting, or a step ending (ms). */
function lastActivity(job: Job, marks: Map<string, Mark>): number {
	let t = Date.parse(job.now);
	for (const m of marks.values()) t = Math.max(t, m.state === "running" ? m.startedAt : (m.at ?? 0));
	return t;
}

type AuthorityClaim = {
	authority: JobAuthorityClient;
	owner: string;
	step: string;
	attempt: string;
	generation: number;
};

type ClaimOutcome = { kind: "legacy" } | { kind: "busy" } | { kind: "complete"; resultKey: string } | { kind: "claimed"; claim: AuthorityClaim };

/**
 * Atomically claims a mailbox or finalizer. Result bodies stay in KV under immutable keys; the
 * Durable Object holds only the accepted generation and key. A lost claim response is retried with
 * the same attempt capability.
 */
async function claimAuthority(env: JobEnv, job: Job, step: string, ttlMs: number): Promise<ClaimOutcome> {
	const authority = authorityOf(env);
	if (!authority) return { kind: "legacy" };
	const owner = await authorityOwner(env, job.id);
	const view = await authority.snapshot(owner);
	if (!view?.ok || view.holder?.job !== job.id || !view.steps) throw new JobStoppedError("This run no longer owns the coordinator.");
	let current = view.steps.find((entry) => entry.step === step);
	if (current?.state === "complete") {
		if (!current.resultKey) throw new JobStoppedError("The accepted step result is unavailable.");
		return { kind: "complete", resultKey: current.resultKey };
	}
	if (current?.state === "running") {
		if ((current.deadline ?? 0) > Date.now()) return { kind: "busy" };
		const failed = await authority.failExpired(owner, step, current.generation);
		if (!failed?.ok) return { kind: "busy" };
		current = { ...current, state: "failed", deadline: null };
	}
	const expected = current?.generation ?? 0;
	const attempt = randomToken(16);
	const claimed = (await authority.claim(owner, step, attempt, expected, ttlMs)) ?? (await authority.claim(owner, step, attempt, expected, ttlMs));
	if (!claimed?.ok || claimed.generation === undefined) return { kind: "busy" };
	return { kind: "claimed", claim: { authority, owner, step, attempt, generation: claimed.generation } };
}

async function renewClaim(claim: AuthorityClaim): Promise<void> {
	const renewed = await claim.authority.renew(claim.owner, claim.step, claim.attempt);
	if (!renewed?.ok) throw new JobStoppedError("This run's coordinator claim expired.");
}

async function renewClaimIfPresent(claim: AuthorityClaim | null): Promise<void> {
	if (claim) await renewClaim(claim);
}

async function completeClaim(claim: AuthorityClaim, resultKey: string): Promise<void> {
	const completed = (await claim.authority.complete(claim.owner, claim.step, claim.attempt, resultKey))
		?? (await claim.authority.complete(claim.owner, claim.step, claim.attempt, resultKey));
	if (!completed?.ok) throw new JobStoppedError("A newer attempt replaced this result.");
}

async function recoveredMark(kv: KVNamespace, outcome: Extract<ClaimOutcome, { kind: "complete" }>): Promise<Mark | null> {
	return kv.get<Mark>(outcome.resultKey, "json");
}

/** Thrown by a step's work when its job no longer holds the lock: nothing was done. */
export class JobStoppedError extends Error {}

async function readMarks(kv: KVNamespace, job: Job): Promise<Map<string, Mark>> {
	const keys = job.aliases.map((a) => markKey(job.id, a));
	const out = new Map<string, Mark>();
	for (let i = 0; i < keys.length; i += 100) {
		const chunk = keys.slice(i, i + 100);
		const found = (await kv.get(chunk, "json")) as Map<string, Mark | null>;
		chunk.forEach((k, j) => {
			const m = found.get(k);
			if (m) out.set(job.aliases[i + j]!, m);
		});
	}
	return out;
}

function viewOf(job: Job, marks: Map<string, Mark>): JobView {
	const rows = job.aliases.map((alias): JobRow => {
		const m = marks.get(alias);
		if (!m) return { alias, state: "todo" };
		if (m.state === "running") return { alias, state: "running" };
		if (m.reason || !m.partial.status.ok) return { alias, state: "failed", reason: m.reason ?? reasonOf(m.partial.status) };
		return { alias, state: "done", ...(m.summary ? { summary: m.summary } : {}) };
	});
	return { job, rows, finished: rows.filter((r) => r.state === "done" || r.state === "failed").length };
}

/** A failed mailbox's reason, in a few plain words: never the error's text, which can carry details. */
export function reasonOf(status: AccountRunStatus): string {
	if (status.needsRelink) return "needs re-linking";
	const code = errorCode(status.error ?? "");
	if (code === "http 429" || code === "429") return "Gmail rate-limited";
	if (code === "too many subrequests") return "too many requests for one step";
	if (code === "exceeded cpu") return "took too long";
	if (status.error === "not linked any more") return "not linked any more";
	return code.startsWith("http ") ? `Gmail error ${code.slice(5)}` : "failed";
}

/**
 * The part of a mailbox no step could finish: its open items carry over as they were (fail open), and
 * nothing else; the cursor stays. `email`: the account's address, which carried items must match.
 */
function lostPartial(alias: string, email: string, error = "took too long"): MailboxPartial {
	const status: AccountRunStatus = { alias, email, ok: false, found: 0, newlyClassified: 0, error };
	return { alias, status, items: [], toCache: [], learned: [], surfaced: [], replacedCarried: [], errors: [], estimated: 0, fromHistory: 0, carryOnly: true };
}

/** The run's KV and AI, counted for this step's telemetry. */
function counted(env: JobEnv, stats: RunStats): JobEnv {
	return { ...env, MAILBOX_KV: countingKV(env.MAILBOX_KV, stats), AI: countingAI(env.AI, stats) as Ai };
}

const optionsOf = (job: Job): RunOptions => ({ window: job.window, reclassify: job.reclassify, test: job.test });

/** One mailbox: marked running, collected alone, stored as its part. */
async function stepMailbox(
	env: JobEnv,
	job: Job,
	alias: string,
	attempt: number,
	marks: Map<string, Mark>,
	onProgress?: (done: number, total: number) => void | Promise<void>,
): Promise<JobView> {
	const kv = env.MAILBOX_KV;
	const step = [...marks.values()].filter((m) => m.state === "done").length + 1;
	const stats = newRunStats(job.run, { id: job.id, step });
	return withRunStats(stats, () => logged(kv, stats, "step", async () => {
		let activeAttempt = attempt;
		let claim: AuthorityClaim | null = null;
		// Renewed only while it's still ours: a lapsed or taken lock stops the job (planStep says so next).
		if (!job.test) {
			if (!(await holdsRun(env, job, marks, new Date()))) throw new JobStoppedError("This run was stopped: it was left too long, or another run started.");
			const outcome = await claimAuthority(env, job, alias, JOB_AUTHORITY_CLAIM_MIN_MS);
			if (outcome.kind === "busy") return viewOf(job, marks);
			if (outcome.kind === "complete") {
				const accepted = await recoveredMark(kv, outcome);
				if (!accepted) return viewOf(job, marks);
				marks.set(alias, accepted);
				await kv.put(markKey(job.id, alias), JSON.stringify(accepted), { expirationTtl: JOB_TTL });
				return viewOf(job, marks);
			}
			if (outcome.kind === "claimed") {
				claim = outcome.claim;
				activeAttempt = claim.generation;
			}
			await takeLock(kv, { at: job.now, job: job.id, driver: job.driver });
		}
		await kv.put(markKey(job.id, alias), JSON.stringify({ state: "running", attempt: activeAttempt, startedAt: Date.now() } satisfies Mark), { expirationTtl: JOB_TTL });
		const env2 = counted(env, stats);
		let mark: Mark;
		let renewedAt = Date.now();
		const progress = async (done: number, total: number) => {
			if (claim && Date.now() - renewedAt >= 60_000) {
				await renewClaim(claim);
				renewedAt = Date.now();
			}
			await onProgress?.(done, total);
		};
		if (claim && activeAttempt > MAX_ATTEMPTS) {
			mark = {
				state: "done",
				attempt: activeAttempt,
				partial: lostPartial(alias, job.emails[alias] ?? ""),
				reason: "took too long",
				at: Date.now(),
			};
		} else try {
			const ctx = await runContext(env2, optionsOf(job), new Date(job.now), job.test, job.aliases, job.previous);
			// A retry after a step died takes much less mail, so it fits; the rest is a backlog for later runs.
			ctx.share = Math.min(ctx.share, RETRY_SHARES[Math.min(activeAttempt, MAX_ATTEMPTS) - 1] ?? 5);
			const account = ctx.accounts.find((a) => a.alias === alias);
			if (!account) {
				const { carryOnly: _none, ...unlinked } = lostPartial(alias, "", "not linked any more");
				mark = { state: "done", attempt: activeAttempt, partial: unlinked, at: Date.now() };
			} else {
				if (["active", "migrate"].includes(env.ATOMIC_STATE_MODE ?? "") && (!job.identities?.[alias] || job.identities[alias] !== await sha256Hex(account.sealedRefreshToken))) throw new JobStoppedError("This mailbox was relinked after the run started.");
				// Once a step has run out of the model's allowance, later steps don't try it again.
				const quota = [...marks.values()].find((m): m is Extract<Mark, { state: "done" }> => m.state === "done" && m.partial.unavailable?.reason === "quota");
				const modelOff: Unavailable | undefined = quota?.partial.unavailable;
				const [partial] = await collect(env2, ctx, [account], modelOff, progress);
				const p = partial!;
				const decided = applySettings({ id: job.run, date: ctx.date, generatedAt: job.now, model: "", query: "", items: p.items.map((it) => ({ ...it })), accounts: [], modelErrors: [] }, ctx.settings);
				const fresh = decided.items.filter((it) => !it.carried);
				mark = {
					state: "done",
					attempt: activeAttempt,
					partial: p,
					summary: { fresh: fresh.length, toAction: fresh.filter((it) => it.needsAction).length, estimated: p.estimated },
					at: Date.now(),
				};
			}
		} catch (e) {
			// Anything collect doesn't catch itself: this mailbox failed; the job goes on.
			const code = errorCode((e as Error).message);
			mark = {
				state: "done",
				attempt: activeAttempt,
				partial: lostPartial(alias, job.emails[alias] ?? "", code),
				reason: code === "error" ? "failed" : reasonOf({ alias, email: "", ok: false, found: 0, newlyClassified: 0, error: (e as Error).message }),
				at: Date.now(),
			};
		}
		if (claim) {
			const resultKey = `${markKey(job.id, alias)}:result:${claim.generation}:${randomToken(16)}`;
			await kv.put(resultKey, JSON.stringify(mark), { expirationTtl: JOB_TTL });
			await completeClaim(claim, resultKey);
		}
		await kv.put(markKey(job.id, alias), JSON.stringify(mark), { expirationTtl: JOB_TTL });
		marks.set(alias, mark);
		log("step-end", { alias, attempt: activeAttempt, ok: mark.state === "done" && !mark.reason && mark.partial.status.ok, ...stepTotals(stats) });
		return viewOf(job, marks);
	}));
}

/** A step's work, then its log saved (telemetry.ts saveRunLog); a step that throws logs why first. */
async function logged<T>(kv: KVNamespace, stats: RunStats, source: string, work: () => Promise<T>): Promise<T> {
	try {
		return await work();
	} catch (e) {
		noteError(source, e instanceof JobStoppedError ? "stopped" : errorCode((e as Error).message));
		throw e;
	} finally {
		await saveRunLog(kv, stats);
	}
}

const stepTotals = (s: RunStats) => ({ ms: since(s.started), subrequests: s.subrequests, ai: s.ai, kv: s.kv, rateLimitedParts: s.rateLimitedParts, errors: s.errors });

/** The last step: the digest from every part, stored; then (real runs) seen marks and cursors; the lock released. */
async function finishJob(env: JobEnv, job: Job, marks: Map<string, Mark>): Promise<Digest> {
	const kv = env.MAILBOX_KV;
	const stats = newRunStats(job.run, { id: job.id, step: job.aliases.length + 1 });
	return withRunStats(stats, () => logged(kv, stats, "finish", async () => {
		let claim: AuthorityClaim | null = null;
		let atomicHead: { generation: string; seq: number } | null = null;
		if (!job.test) {
			if (!(await holdsRun(env, job, marks, new Date()))) throw new JobStoppedError("This run was stopped: it was left too long, or another run started.");
			const outcome = await claimAuthority(env, job, "final", JOB_AUTHORITY_CLAIM_MAX_MS);
			if (outcome.kind === "busy") throw new JobStoppedError("Another request is storing this digest.");
			if (outcome.kind === "complete") {
				const digestId = await kv.get(outcome.resultKey);
				const existing = digestId ? await getDigest(kv, digestId) : null;
				if (existing) return existing;
				throw new JobStoppedError("This digest was already finalized but is not visible yet. Try again in a moment.");
			}
			if (outcome.kind === "claimed") claim = outcome.claim;
			if (claim && ["active", "migrate"].includes(env.ATOMIC_STATE_MODE ?? "")) {
				atomicHead = (await new AtomicGenerationClient(env.JOB_AUTHORITY!).head())?.head ?? null;
				if (!atomicHead) throw new JobStoppedError("Atomic state has not been imported; publication is closed.");
				await pinAtomicState(env.MAILBOX_KV, atomicHead.seq);
			}
			await takeLock(kv, { at: job.now, job: job.id, driver: job.driver });
		}
		const env2 = counted(env, stats);
		// The same context every time: a last step retried after it failed part-way assembles the same
		// digest and redoes the same writes (each is idempotent), carrying over from the same run.
		const ctx = await runContext(env2, optionsOf(job), new Date(job.now), job.test, job.aliases, job.previous);
		const partials = job.aliases.flatMap((a) => {
			const m = marks.get(a);
			return m?.state === "done" ? [m.partial] : [];
		});
		if (!job.test && ["active", "migrate"].includes(env.ATOMIC_STATE_MODE ?? "")) {
			if (!job.identities) throw new JobStoppedError("This run predates the atomic account fence.");
			for (const alias of job.aliases) {
				const account = ctx.accounts.find((candidate) => candidate.alias === alias);
				if (!account || job.identities[alias] !== await sha256Hex(account.sealedRefreshToken)) throw new JobStoppedError("A mailbox was unlinked or relinked after the run started.");
			}
		}
		ctx.jobId = job.id;
		ctx.jobRunId = job.run;
		let digest: Digest;
		if (!job.test && claim && ["active", "migrate"].includes(env.ATOMIC_STATE_MODE ?? "")) {
			const atomic = new AtomicGenerationClient(env.JOB_AUTHORITY!);
			const started = Date.now();
			const counts = {
				mailboxes: partials.length,
				candidates: partials.reduce((sum, partial) => sum + partial.items.length, 0),
				cacheWrites: partials.reduce((sum, partial) => sum + partial.toCache.length, 0),
			};
			let phase: FinalizationPhase = "snapshot";
			let diagnostic: FinalizationDiagnostic = { version: 1, status: "running", phase, updatedAt: started, elapsedMs: 0, ...counts };
			const checkpoint = async (update: Partial<FinalizationDiagnostic>) => {
				diagnostic = { ...diagnostic, ...update, updatedAt: Date.now(), elapsedMs: Date.now() - started };
				try { await kv.put(finalizationDiagnosticKey(job.id), JSON.stringify(diagnostic), { expirationTtl: FINALIZATION_DIAGNOSTIC_TTL }); }
				catch (error) { noteError("diagnostic", errorCode((error as Error).message)); }
			};
			try {
				await checkpoint({ phase });
				log("finalize", { phase, state: "start", ...counts });
				const captured = await captureAssemblySnapshot(env2.MAILBOX_KV, ctx, partials);
				await checkpoint({ done: captured.done.doneKeys.size });
				log("finalize", { phase, state: "complete", done: captured.done.doneKeys.size, ...counts });
				phase = "prepare";
				await checkpoint({ phase });
				const prepared = await prepareAssembly(env2, ctx, partials, captured.done);
				await checkpoint({ items: prepared.digest.items.length });
				const provisionalResult: RunResult = {
					job: job.id,
					digest: prepared.digest.id,
					driver: job.driver,
					test: false,
					rows: viewOf(job, marks).rows,
					started: job.createdAt ?? Date.parse(job.now),
					finished: Date.now(),
				};
				phase = "manifest";
				await checkpoint({ phase });
				const manifest = buildAssemblyManifest(ctx, partials, prepared, captured.state, { id: job.id, result: provisionalResult }, { operations: ATOMIC_GENERATION_MAX_ENTRIES, bytes: ATOMIC_GENERATION_MAX_BYTES });
				await checkpoint({ operations: manifest.writes.length, bytes: manifest.encodedBytes });
				log("finalize", { phase, state: "complete", operations: manifest.writes.length, bytes: manifest.encodedBytes, items: prepared.digest.items.length, ...counts });
				phase = "publish";
				await checkpoint({ phase });
				await atomic.publish({ owner: claim.owner, attempt: claim.attempt, parentSeq: atomicHead!.seq, writes: manifest.writes, ttlBaseMs: Date.now(), token: () => randomToken(16), heartbeat: () => renewClaim(claim) });
				await checkpoint({ status: "complete" });
				log("finalize", { phase, state: "complete", operations: manifest.writes.length, bytes: manifest.encodedBytes, ...counts });
				digest = prepared.digest;
			} catch (e) {
				const code = errorCode((e as Error).message);
				await checkpoint({ status: "failed", phase: phase as FinalizationPhase, code });
				noteError("finalize", code, { phase, ...counts });
				throw e;
			}
		} else {
			digest = await assemble(env2, ctx, partials, claim ? () => renewClaim(claim) : undefined);
		}
		const result: RunResult = {
			job: job.id,
			digest: digest.id,
			driver: job.driver,
			test: job.test,
			rows: viewOf(job, marks).rows,
			started: job.createdAt ?? Date.parse(job.now),
			finished: Date.now(),
		};
		if (!(!job.test && claim && ["active", "migrate"].includes(env.ATOMIC_STATE_MODE ?? ""))) {
			await renewClaimIfPresent(claim);
			await kv.put(jobResultKey(job.id), JSON.stringify(result), { expirationTtl: RESULT_TTL });
			await renewClaimIfPresent(claim);
			await kv.put(jobDoneKey(job.id), digest.id, { expirationTtl: RESULT_TTL });
			if (claim) await completeClaim(claim, jobDoneKey(job.id));
		}
		if (!job.test) {
			const authority = authorityOf(env);
			const owner = authority ? await authorityOwner(env, job.id) : null;
			const released = authority && owner
				? ((await authority.release(owner)) ?? (await authority.release(owner)))?.ok === true
				: true;
			if (released) {
				const held = await readLock(kv);
				if (held?.job === job.id) await releaseLock(kv);
			}
		}
		log("run-end", { ok: true, items: digest.items.length, mailboxes: digest.accounts.map((a) => ({ alias: a.alias, ok: a.ok, found: a.found })), ...stepTotals(stats) });
		return digest;
}));
}

// --- The morning run's steps, through a service binding to this Worker --------------------------

/** The host the morning run calls itself on. Public requests never carry it: Cloudflare routes them by their real host. */
export const INTERNAL_HOST = "self.internal";
export const STEP_HEADER = "x-step-signature";

/** HMAC-SHA256 of the job id, with a key derived from TOKEN_ENCRYPTION_KEY. Never logged. */
export async function stepSignature(env: Pick<Env, "TOKEN_ENCRYPTION_KEY">, id: string): Promise<string> {
	const material = new TextEncoder().encode(await sha256Hex(`internal-step|${env.TOKEN_ENCRYPTION_KEY}`));
	const key = await crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`step:${id}`));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function validStepRequest(env: Pick<Env, "TOKEN_ENCRYPTION_KEY">, req: Request, id: string): Promise<boolean> {
	if (new URL(req.url).hostname !== INTERNAL_HOST) return false;
	const given = req.headers.get(STEP_HEADER) ?? "";
	return timingSafeEqual(given, await stepSignature(env, id));
}

export type StepOutcome = { state: "processed"; alias: string; finished: number; total: number } | { state: "finished"; digest: string } | { state: "missing" | "stopped" | "wait" | "error" };

/** One step of a job, as the morning run (sequentially) asks for it. */
export async function runStep(env: JobEnv, id: string): Promise<StepOutcome> {
	const plan = await planStep(env, id, { now: new Date(), sequential: true });
	if (plan.kind === "process") {
		const view = await plan.work();
		return { state: "processed", alias: plan.alias, finished: view.finished, total: view.rows.length };
	}
	if (plan.kind === "finish") return { state: "finished", digest: (await plan.work()).id };
	if (plan.kind === "done") return { state: "finished", digest: plan.digestId };
	return { state: plan.kind };
}

/** A way to call this Worker as a separate invocation: ctx.exports loopback, or the SELF binding. */
type Loopback = { path: "exports" | "self"; fetch: (req: Request) => Promise<Response> };

function loopbackOf(env: { SELF?: Fetcher }, ctx?: ExecutionContext): Loopback | null {
	// ctx.exports (compatibility flag enable_ctx_exports) calls this Worker's own fetch as a new invocation.
	const exported = (ctx as unknown as { exports?: { default?: { fetch?: (r: Request) => Promise<Response> } } } | undefined)?.exports?.default;
	if (exported?.fetch) return { path: "exports", fetch: (r) => exported.fetch!(r) };
	if (env.SELF) return { path: "self", fetch: (r) => env.SELF!.fetch(r) };
	return null;
}

/**
 * Failed calls (thrown, or not 2xx) in a row that moved the job no further, after which the loopback
 * is given up on. A step that died still moves it (its mailbox's next try, or its failure, is recorded),
 * so one heavy mailbox never counts against the loopback: only a loopback that doesn't reach the job.
 */
const LOOPBACK_FAILURES = 3;

/** Where a job stands: each mailbox's state and try. Changes whenever a step starts, ends or gives up. */
async function progressOf(kv: KVNamespace, job: Job): Promise<string> {
	const marks = await readMarks(kv, job);
	return job.aliases.map((a) => {
		const m = marks.get(a);
		return `${a}:${m?.state ?? "todo"}:${m?.attempt ?? 0}`;
	}).join(",");
}

/**
 * The morning run's driver: steps the job through a loopback to this Worker, one invocation per step,
 * until its digest is stored. A call that throws or fails counts as a step that died (the next call
 * retries that mailbox with a smaller share). If the loopback keeps failing, isn't there, or the tries
 * run out, the mailboxes not done are given up on (their open items carry over) and only the last step
 * runs here: there is always a digest, and the email goes out. Returns the digest id, or null if the
 * job was stopped.
 */
export async function driveJob(env: JobEnv & { SELF?: Fetcher }, job: Job, ctx?: ExecutionContext): Promise<string | null> {
	const loop = loopbackOf(env, ctx);
	log("drive", { job: job.id, path: loop?.path ?? "finish-only" });
	if (loop) {
		let failures = 0;
		let before = await progressOf(env.MAILBOX_KV, job);
		for (let i = 0; i < job.aliases.length * (MAX_ATTEMPTS + 1) + 2 && failures < LOOPBACK_FAILURES; i++) {
			let out: StepOutcome;
			try {
				const resp = await loop.fetch(
					new Request(`https://${INTERNAL_HOST}/internal/step/${job.id}`, {
						method: "POST",
						headers: { [STEP_HEADER]: await stepSignature(env as Pick<Env, "TOKEN_ENCRYPTION_KEY">, job.id) },
					}),
				);
				out = resp.ok ? ((await resp.json()) as StepOutcome) : { state: "error" };
			} catch (e) {
				noteError("loopback", errorCode((e as Error).message));
				out = { state: "error" };
			}
			if (out.state === "finished") return out.digest;
			if (out.state === "missing" || out.state === "stopped") return null;
			const after = await progressOf(env.MAILBOX_KV, job);
			failures = out.state === "error" && after === before ? failures + 1 : 0;
			before = after;
		}
		log("drive", { job: job.id, path: "finish-only", after: loop.path });
	}
	return finishOnly(env, job);
}

/** Gives up on the mailboxes not done (open items carried as they were) and runs only the last step, here. */
export async function finishOnly(env: JobEnv, job: Job): Promise<string | null> {
	const kv = env.MAILBOX_KV;
	const plan = await planStep(env, job.id, { now: new Date(), sequential: true });
	if (plan.kind === "done") return plan.digestId;
	if (plan.kind === "missing" || plan.kind === "stopped") return null;
	const marks = await readMarks(kv, job);
	for (const alias of job.aliases) {
		if (marks.get(alias)?.state === "done") continue;
		const lost: Mark = { state: "done", attempt: 0, partial: lostPartial(alias, job.emails[alias] ?? "", "not reached"), reason: "not reached", at: Date.now() };
		await kv.put(markKey(job.id, alias), JSON.stringify(lost), { expirationTtl: JOB_TTL });
		marks.set(alias, lost);
	}
	return (await finishJob(env, job, marks)).id;
}

/** Releases the run lock if this job still holds it (after a morning run that failed outright). */
export async function releaseJobLock(env: JobEnv, job: Job): Promise<void> {
	if (!job.test && (await ownsLock(env, job))) {
		const authority = authorityOf(env);
		const owner = authority ? await authorityOwner(env, job.id) : null;
		const released = authority && owner
			? ((await authority.release(owner)) ?? (await authority.release(owner)))?.ok === true
			: true;
		if (released) await releaseLock(env.MAILBOX_KV);
	}
}

export type { LockHolder };
