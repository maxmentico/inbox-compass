import { AtomicGenerationClient, type AtomicWrite } from "./atomic-generation-authority";
import { randomToken, sha256Hex } from "./crypto";
import { listAccounts } from "./accounts";

const DIGEST_TTL_SECONDS = 60 * 24 * 60 * 60;
const MAX_BASELINE_BYTES = 32 * 1024 * 1024;
const MAX_BASELINE_ITEMS = 900;

type StoredDigest = { id: string; generatedAt: string; items: { key: string }[] };

function remainingDigestTtl(digest: StoredDigest, now: number): number {
	const generated = Date.parse(digest.generatedAt);
	if (!Number.isFinite(generated)) throw new Error("Stored digest has an invalid generation time");
	return Math.max(60, Math.floor((generated + DIGEST_TTL_SECONDS * 1000 - now) / 1000));
}

/**
 * Imports a conservative baseline without returning or logging live contents. Cursor, cache,
 * history, failure and recheck state intentionally start absent together, so migration may repeat
 * mail but cannot skip it or preserve a seen mark without its recheck entry.
 */
export async function ensureAtomicBaseline(env: Env): Promise<void> {
	if (env.ATOMIC_STATE_MODE !== "migrate" || !env.JOB_AUTHORITY) return;
	const atomic = new AtomicGenerationClient(env.JOB_AUTHORITY);
	if ((await atomic.head())?.head) return;
	const [lastRun, runsIndex, settings, accounts] = await Promise.all([
		env.MAILBOX_KV.get("last-run"),
		env.MAILBOX_KV.get("runs-index"),
		env.MAILBOX_KV.get("settings"),
		listAccounts(env.MAILBOX_KV),
	]);
	const digestText = lastRun ? await env.MAILBOX_KV.get(`digest:${lastRun}`) : null;
	const writes: AtomicWrite[] = [{ kind: "put", key: "atomic-mode", value: "1" }];
	for (const account of accounts) writes.push({ kind: "put", key: `account-state:${account.alias}`, value: JSON.stringify({ email: account.email.toLowerCase(), sealedHash: await sha256Hex(account.sealedRefreshToken) }) });
	if (settings !== null) writes.push({ kind: "put", key: "settings", value: settings });
	if (runsIndex !== null) writes.push({ kind: "put", key: "runs-index", value: runsIndex });
	if (lastRun !== null && digestText !== null) {
		if (new TextEncoder().encode(digestText).byteLength > MAX_BASELINE_BYTES) throw new Error("Stored digest exceeds the atomic import budget");
		const digest = JSON.parse(digestText) as StoredDigest;
		if (digest.id !== lastRun || !Array.isArray(digest.items) || digest.items.length > MAX_BASELINE_ITEMS || digest.items.some((item) => !item || typeof item.key !== "string" || item.key.length > 256)) throw new Error("Stored digest cannot be imported safely");
		const ttl = remainingDigestTtl(digest, Date.now());
		writes.push({ kind: "put", key: `digest:${lastRun}`, value: digestText, expirationTtl: ttl });
		writes.push({ kind: "put", key: "last-run", value: lastRun });
		const doneKeys = digest.items.map((item) => `done:${item.key}`);
		for (let offset = 0; offset < doneKeys.length; offset += 100) {
			const chunk = doneKeys.slice(offset, offset + 100);
			const values = await env.MAILBOX_KV.get(chunk, "text") as Map<string, string | null>;
			for (const key of chunk) if (values.get(key) !== null) writes.push({ kind: "put", key, value: "1", expirationTtl: ttl });
		}
	}
	if (!writes.some((write) => write.key === "runs-index")) writes.push({ kind: "put", key: "runs-index", value: lastRun ? JSON.stringify([lastRun]) : "[]" });
	try {
		await atomic.bootstrap({ writes, ttlBaseMs: Date.now(), token: () => randomToken(16) });
	} catch (error) {
		// Concurrent first requests can observe the empty head together. Only one imports; the rest
		// wait for its atomic head rather than exposing a transient cutover error to anonymous users.
		for (let attempt = 0; attempt < 100; attempt++) {
			if ((await atomic.head())?.head) return;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw error;
	}
}

/** A retained bridge release follows the SQLite head after cutover, so code rollback cannot revive KV authority. */
export async function resolveAtomicMode(env: Env): Promise<Env> {
	if (env.ATOMIC_STATE_MODE !== "bridge" || !env.JOB_AUTHORITY) return env;
	return (await new AtomicGenerationClient(env.JOB_AUTHORITY).head())?.head ? { ...env, ATOMIC_STATE_MODE: "active" } : env;
}
