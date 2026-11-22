import { saveAccount } from "../src/accounts";
import { GMAIL_MODIFY_SCOPE } from "../src/config";

// In-memory KVNamespace sufficient for these tests (get/put/delete/list with prefix, json type).
/** In-memory KV. `ops` counts operations the way Workers does: a bulk get of up to 100 keys is one. */
export function memoryKV(): KVNamespace & { store: Map<string, string>; ops: number; failPut?: (key: string) => boolean } {
	const store = new Map<string, string>();
	/** Per key: what `list` returns besides the name (expiry in seconds, metadata), as Workers KV does. */
	const extra = new Map<string, { expiration?: number; metadata?: unknown }>();
	/** Expired keys read as missing, as in Workers KV (by Date.now(), which tests can fake). */
	const live = (key: string) => {
		const exp = extra.get(key)?.expiration;
		if (exp !== undefined && exp * 1000 <= Date.now()) {
			store.delete(key);
			extra.delete(key);
		}
		return store.has(key);
	};
	const read = (key: string, t: string | undefined) => {
		if (!live(key)) return null;
		const v = store.get(key);
		if (v === undefined) return null;
		return t === "json" ? JSON.parse(v) : v;
	};
	const kv = {
		store,
		ops: 0,
		async get(key: string | string[], type?: unknown) {
			kv.ops++;
			const t = typeof type === "string" ? type : (type as { type?: string } | undefined)?.type;
			if (Array.isArray(key)) {
				if (key.length > 100) throw new Error("KV bulk get takes at most 100 keys");
				return new Map(key.map((k) => [k, read(k, t)]));
			}
			return read(key, t);
		},
		/** A test can make writes of some keys fail, as a crash part-way through a run would. */
		failPut: undefined as ((key: string) => boolean) | undefined,
		async put(key: string, value: string, opts: { expirationTtl?: number; expiration?: number; metadata?: unknown } = {}) {
			kv.ops++;
			if (kv.failPut?.(key)) throw new Error(`KV put failed: ${key}`);
			store.set(key, value);
			const expiration = opts.expiration ?? (opts.expirationTtl ? Math.floor(Date.now() / 1000) + opts.expirationTtl : undefined);
			extra.set(key, { ...(expiration ? { expiration } : {}), ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}) });
		},
		async delete(key: string) {
			kv.ops++;
			store.delete(key);
			extra.delete(key);
		},
		async list(opts: { prefix?: string } = {}) {
			kv.ops++;
			const keys = [...store.keys()].filter((k) => k.startsWith(opts.prefix ?? "") && live(k)).sort().map((name) => ({ name, ...extra.get(name) }));
			return { keys, list_complete: true, cacheStatus: null };
		},
	};
	return kv as unknown as KVNamespace & { store: Map<string, string>; ops: number; failPut?: (key: string) => boolean };
}

export function b64url(s: string | Uint8Array): string {
	const bytes = typeof s === "string" ? new TextEncoder().encode(s) : s;
	return Buffer.from(bytes).toString("base64url");
}

export const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

export type FakeAi = { run: ReturnType<typeof import("vitest").vi.fn> };

export function makeEnv(overrides: Partial<Env> = {}): Env & { MAILBOX_KV: ReturnType<typeof memoryKV> } {
	return {
		MAILBOX_KV: memoryKV(),
		LOGIN_RATE_LIMITER: { limit: async () => ({ success: true }) },
		AI: { run: async () => ({}) } as unknown as Ai,
		GOOGLE_CLIENT_ID: "cid",
		GOOGLE_CLIENT_SECRET: "secret",
		TOKEN_ENCRYPTION_KEY: TEST_KEY,
		OWNER_EMAIL: "owner@example.com",
		ENABLE_MARK_READ: "true",
		DIGEST_TIMEZONE: "Europe/London",
		...overrides,
	} as Env & { MAILBOX_KV: ReturnType<typeof memoryKV> };
}

export async function linkAccount(env: Env, alias: string, refreshToken = `rt-${alias}`, scopes = [GMAIL_MODIFY_SCOPE]) {
	return saveAccount(env, { alias, email: `${alias}@example.com`, scopes, refreshToken });
}

/** Default arrival time of test messages: within the first-run lookback of the dates tests run on. */
export const MESSAGE_TIME = Date.parse("2026-10-23T12:00:00Z");

/** Gmail batch response with the given parts. */
export function batchResponse(parts: { id: string; status: number; body: unknown }[]): Response {
	const b = "batch_resp";
	const text =
		parts
			.map(
				(p) =>
					`--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${p.id}>\r\n\r\nHTTP/1.1 ${p.status} X\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(p.body)}\r\n`,
			)
			.join("") + `--${b}--\r\n`;
	return new Response(text, { status: 200, headers: { "Content-Type": `multipart/mixed; boundary=${b}` } });
}

export function fullMessage(
	id: string,
	opts: {
		ms?: number;
		subject?: string;
		from?: string;
		to?: string;
		body?: string;
		threadId?: string;
		headers?: { name: string; value: string }[];
		/** Gmail labels besides UNREAD and INBOX, e.g. CATEGORY_PROMOTIONS or IMPORTANT. */
		labels?: string[];
		snippet?: string;
	} = {},
) {
	return {
		id,
		threadId: opts.threadId ?? `t-${id}`,
		internalDate: String(opts.ms ?? MESSAGE_TIME),
		snippet: opts.snippet ?? `snippet ${id}`,
		labelIds: ["UNREAD", "INBOX", ...(opts.labels ?? [])],
		payload: {
			mimeType: "text/plain",
			headers: [
				{ name: "From", value: opts.from ?? "Alice <alice@client.com>" },
				{ name: "To", value: opts.to ?? "me@example.com" },
				{ name: "Subject", value: opts.subject ?? `Subject ${id}` },
				{ name: "Content-Type", value: "text/plain; charset=utf-8" },
				...(opts.headers ?? []),
			],
			body: { data: b64url(opts.body ?? `Body of ${id}`) },
		},
	};
}

/** The ids sent in a Gmail batch request body. */
export function idsInBatch(body: string): string[] {
	return [...body.matchAll(/messages\/([^?]+)\?/g)].map((m) => decodeURIComponent(m[1]!));
}

/**
 * The fastest of three timed runs of `f` (ms), after one warm-up. For "stays fast" tests: a quadratic
 * pattern is slow every time, while a busy test machine only slows some runs.
 */
export function bestOf3(f: () => void): number {
	f();
	let best = Number.POSITIVE_INFINITY;
	for (let i = 0; i < 3; i++) {
		const t = performance.now();
		f();
		best = Math.min(best, performance.now() - t);
	}
	return best;
}
