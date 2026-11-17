// Run telemetry: one-line JSON logs (Workers Logs, `wrangler tail`) with counts, aliases, ids and
// timings only. Never email content, subjects, addresses or tokens.
//
// Per run, it counts outbound subrequests (every Google/Gmail fetch goes through netFetch), Workers AI
// calls, and KV operations (the run's KV binding is wrapped), so a run can be checked against the
// plan's per-invocation limits. The counters live in an AsyncLocalStorage scope (nodejs_compat), so
// concurrent requests in one isolate don't mix their counts.
//
// Timings are wall-clock ms across awaits: Workers advance Date.now() only on I/O, so a span of pure
// CPU work reads as 0 ms.
//
// When a run (or one step of a job) ends, its lines are also saved to KV (saveRunLog): every line in
// `runlog:<run>`, and its error lines apart in `runerrors:<run>`, written only when there are any. A
// job's steps append to their run's keys. Only the last RUN_LOGS_KEPT runs are kept: `runlogs-index`
// lists them, and a new run deletes the keys of the runs that fall off it.

import { AsyncLocalStorage } from "node:async_hooks";

export interface RunStats {
	run: string;
	/** A job's id and step (1-based), when the run is done in steps (jobs.ts). */
	job?: string;
	step?: number;
	started: number;
	/** Outbound fetches (Google OAuth, Gmail API and batch calls). */
	subrequests: number;
	/** env.AI.run calls (counted apart: bindings may or may not count as subrequests). */
	ai: number;
	kv: { reads: number; writes: number; deletes: number; lists: number };
	/** Error codes seen, by source, with counts: "http 400", "ai 4006", "fetch too many subrequests", ... */
	errors: Record<string, number>;
	/** Gmail batch parts that came back rate-limited (429), before retries. */
	rateLimitedParts: number;
	/** This run's log lines, and those of them that report an error or a failure, for saveRunLog. */
	lines: string[];
	errorLines: string[];
}

const scope = new AsyncLocalStorage<RunStats>();

export function newRunStats(run: string, job?: { id: string; step: number }): RunStats {
	return { run, ...(job ? { job: job.id, step: job.step } : {}), started: Date.now(), subrequests: 0, ai: 0, kv: { reads: 0, writes: 0, deletes: 0, lists: 0 }, errors: {}, rateLimitedParts: 0, lines: [], errorLines: [] };
}

/** Runs `fn` with `stats` as the current run's counters. */
export function withRunStats<T>(stats: RunStats, fn: () => Promise<T>): Promise<T> {
	return scope.run(stats, fn);
}

export const currentStats = (): RunStats | undefined => scope.getStore();

/** One JSON line. `fields` must hold counts, ids, aliases and codes only. */
export function log(evt: string, fields: Record<string, unknown> = {}): void {
	const s = currentStats();
	const line = JSON.stringify({ evt, ...(s ? { run: s.run } : {}), ...(s?.job ? { job: s.job, step: s.step } : {}), ...fields });
	console.log(line);
	if (!s) return;
	s.lines.push(line);
	if (isErrorLine(evt, fields)) s.errorLines.push(line);
}

/** An error, or a phase, step or mailbox that didn't go through. */
function isErrorLine(evt: string, fields: Record<string, unknown>): boolean {
	if (evt === "error" || fields.ok === false) return true;
	return Array.isArray(fields.mailboxes) && fields.mailboxes.some((m: { ok?: boolean }) => m?.ok === false);
}

/** How many runs' saved logs are kept (real and test runs alike). */
const RUN_LOGS_KEPT = 10;
/** A backstop, for a run an index race dropped: no saved log outlives this. */
const RUN_LOG_TTL = 30 * 24 * 60 * 60;
const RUN_LOGS_INDEX = "runlogs-index";
const runLogKey = (run: string) => `runlog:${run}`;
const runErrorsKey = (run: string) => `runerrors:${run}`;

/**
 * Saves the run's log lines once it (or a step of it) has ended, after any lines earlier steps saved:
 * all of them, and the error lines apart (only when there are any). A run's first save rotates the
 * logs. Takes the plain KV binding, so the save isn't counted in the run it records. Never throws: a
 * failed save is only logged.
 */
export async function saveRunLog(kv: KVNamespace, s: RunStats): Promise<void> {
	try {
		const before = await kv.get(runLogKey(s.run));
		await kv.put(runLogKey(s.run), appended(before, s.lines), { expirationTtl: RUN_LOG_TTL });
		if (s.errorLines.length) {
			const errors = await kv.get(runErrorsKey(s.run));
			await kv.put(runErrorsKey(s.run), appended(errors, s.errorLines), { expirationTtl: RUN_LOG_TTL });
		}
		if (before === null) await rotateRunLogs(kv, s.run);
	} catch (e) {
		console.log(JSON.stringify({ evt: "error", run: s.run, source: "run-log", code: errorCode((e as Error).message) }));
	}
}

const appended = (before: string | null, lines: string[]) => [...(before ? [before] : []), ...lines].join("\n");

/** Adds the run to the index; deletes the logs of all but the newest RUN_LOGS_KEPT runs (ids sort by time). */
async function rotateRunLogs(kv: KVNamespace, run: string): Promise<void> {
	const runs = [...new Set([...((await kv.get<string[]>(RUN_LOGS_INDEX, "json")) ?? []), run])].sort();
	const dropped = runs.slice(0, Math.max(0, runs.length - RUN_LOGS_KEPT));
	await Promise.all(dropped.flatMap((r) => [kv.delete(runLogKey(r)), kv.delete(runErrorsKey(r))]));
	await kv.put(RUN_LOGS_INDEX, JSON.stringify(runs.slice(dropped.length)));
}

/** A short, content-free code for an error message: a Workers AI or HTTP code, or a known runtime error. */
export function errorCode(message: string): string {
	if (/too many subrequests/i.test(message)) return "too many subrequests";
	if (/exceeded cpu/i.test(message)) return "exceeded cpu";
	const ai = /\b(3\d{3}|4\d{3}|5\d{3})\b(?=:)/.exec(message);
	if (ai) return ai[1]!;
	const http = /HTTP (\d{3})/.exec(message);
	return http ? `http ${http[1]}` : "error";
}

/** Counts an error code for the run, and logs the first of each kind. */
export function noteError(source: string, code: string, fields: Record<string, unknown> = {}): void {
	const s = currentStats();
	const key = `${source} ${code}`;
	if (s) s.errors[key] = (s.errors[key] ?? 0) + 1;
	if (!s || s.errors[key] === 1) log("error", { source, code, ...fields });
}

/** fetch, counted as a subrequest of the current run. HTTP errors and thrown errors are noted by code. */
export async function netFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
	const s = currentStats();
	if (s) s.subrequests++;
	const host = hostOf(input);
	try {
		const resp = await fetch(input, init);
		if (resp.status >= 400) noteError("http", String(resp.status), { host });
		return resp;
	} catch (e) {
		noteError("fetch", errorCode((e as Error).message), { host });
		throw e;
	}
}

function hostOf(input: RequestInfo | URL): string {
	try {
		return new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url).host;
	} catch {
		return "";
	}
}

/** The KV binding, counting each operation (a bulk get of up to 100 keys is one read, as Workers counts it). */
export function countingKV(kv: KVNamespace, s: RunStats): KVNamespace {
	const k = kv as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
	return {
		get: (...args: unknown[]) => {
			s.kv.reads++;
			return k.get!.apply(kv, args);
		},
		getWithMetadata: (...args: unknown[]) => {
			s.kv.reads++;
			return k.getWithMetadata!.apply(kv, args);
		},
		put: (...args: unknown[]) => {
			s.kv.writes++;
			return k.put!.apply(kv, args);
		},
		delete: (...args: unknown[]) => {
			s.kv.deletes++;
			return k.delete!.apply(kv, args);
		},
		list: (...args: unknown[]) => {
			s.kv.lists++;
			return k.list!.apply(kv, args);
		},
	} as unknown as KVNamespace;
}

/** The AI binding, counting calls and noting failures by code (4006: daily allowance used up). */
export function countingAI(ai: Pick<Ai, "run">, s: RunStats): Pick<Ai, "run"> {
	const run = ai.run.bind(ai) as (...args: unknown[]) => Promise<unknown>;
	return {
		run: (async (...args: unknown[]) => {
			s.ai++;
			try {
				return await run(...args);
			} catch (e) {
				noteError("ai", errorCode((e as Error).message));
				throw e;
			}
		}) as Ai["run"],
	};
}

/** Milliseconds since `t0` (wall clock: only I/O advances it on Workers). */
export const since = (t0: number) => Date.now() - t0;
