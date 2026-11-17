// Linked mailbox records in MAILBOX_KV, and per-isolate access-token caching.

import { ALIAS_PATTERN } from "./config";
import { decryptString, encryptString, randomToken, sha256Hex } from "./crypto";
import { AtomicGenerationClient } from "./atomic-generation-authority";
import { GoogleAuthError, refreshAccessToken, revokeToken } from "./google";

const ACCOUNT_PREFIX = "account:";
const base64Text = (value: string): string => {
	const bytes = new TextEncoder().encode(value); let raw = "";
	for (let index = 0; index < bytes.length; index += 0x8000) raw += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(raw);
};

export interface AccountRecord {
	alias: string;
	email: string;
	/** Scopes Google actually granted (users can untick scopes on the consent screen). */
	scopes: string[];
	/** AES-GCM sealed refresh token, bound to `account:<alias>`. */
	sealedRefreshToken: string;
	linkedAt: string;
}

export type PublicAccount = Omit<AccountRecord, "sealedRefreshToken">;

export class AccountError extends Error {
	constructor(
		message: string,
		readonly alias: string,
		readonly needsRelink = false,
	) {
		super(message);
		this.name = "AccountError";
	}
}

function keyFor(alias: string): string {
	return `${ACCOUNT_PREFIX}${alias}`;
}

export function validateAlias(alias: string): string {
	const a = alias.trim().toLowerCase();
	if (!ALIAS_PATTERN.test(a)) {
		throw new Error("Alias must be 1-32 chars: lowercase letters, digits, hyphens; starting with a letter or digit.");
	}
	return a;
}

export async function getAccount(kv: KVNamespace, alias: string): Promise<AccountRecord | null> {
	const [record, mode, marker] = await Promise.all([kv.get<AccountRecord>(keyFor(alias), "json"), kv.get("atomic-mode"), kv.get<{ email: string; sealedHash: string }>(`account-state:${alias}`, "json")]);
	if (!record || mode === null) return record;
	return marker?.email === record.email.toLowerCase() && marker.sealedHash === await sha256Hex(record.sealedRefreshToken) ? record : null;
}

/**
 * Linked aliases, in one key. KV lists are eventually consistent (a key can take up to a minute to
 * appear in one) and count against the free plan's daily list budget; a get sees this location's own
 * writes at once. Kept by saveAccount and removeAccount.
 */
const INDEX_KEY = "accounts-index";

/** Aliases listed with KV keys (paged); lists are eventually consistent. */
async function listedAliases(kv: KVNamespace): Promise<string[]> {
	const aliases: string[] = [];
	let cursor: string | undefined;
	do {
		const page = await kv.list({ prefix: ACCOUNT_PREFIX, cursor });
		for (const k of page.keys) aliases.push(k.name.slice(ACCOUNT_PREFIX.length));
		cursor = page.list_complete ? undefined : page.cursor;
	} while (cursor);
	return aliases;
}

/** The index; missing (a deployment from before it), seeded once from a list of the account keys. */
async function readIndex(kv: KVNamespace): Promise<string[]> {
	const stored = await kv.get<string[]>(INDEX_KEY, "json");
	if (stored) return stored;
	const aliases = (await listedAliases(kv)).sort();
	await kv.put(INDEX_KEY, JSON.stringify(aliases));
	return aliases;
}

/**
 * Self-healing, once a day (the scheduled run): puts back any stored account the index lost to a race.
 * Only adds: a listing can lag a fresh link or unlink, and an alias without a record is skipped anyway.
 * One paged list. Returns the aliases added.
 */
export async function reconcileAccountIndex(kv: KVNamespace): Promise<string[]> {
	const [indexed, listed] = await Promise.all([readIndex(kv), listedAliases(kv)]);
	const missing = listed.filter((a) => !indexed.includes(a));
	if (missing.length) await kv.put(INDEX_KEY, JSON.stringify([...indexed, ...missing].sort()));
	return missing;
}

async function setIndexed(kv: KVNamespace, alias: string, linked: boolean): Promise<void> {
	const current = await readIndex(kv);
	if (current.includes(alias) === linked) return;
	const next = linked ? [...current, alias].sort() : current.filter((a) => a !== alias);
	await kv.put(INDEX_KEY, JSON.stringify(next));
}

/** One read of the index, then the records in bulk (100 per read). */
export async function listAccounts(kv: KVNamespace): Promise<AccountRecord[]> {
	return (await listWithChecks(kv, false)).accounts;
}

/**
 * The same, with when each mailbox was last checked (ms), from the same bulk reads: a mailbox costs
 * three keys (its record, cursor and test-run check) instead of one, so up to 33 mailboxes are still one
 * read after the index.
 */
export async function listAccountsWithChecks(kv: KVNamespace): Promise<{ accounts: AccountRecord[]; checked: Map<string, number> }> {
	return listWithChecks(kv, true);
}

async function listWithChecks(kv: KVNamespace, checks: boolean): Promise<{ accounts: AccountRecord[]; checked: Map<string, number> }> {
	const aliases = await readIndex(kv);
	const atomicMode = (await kv.get("atomic-mode")) !== null;
	const accounts: AccountRecord[] = [];
	const checked = new Map<string, number>();
	const per = checks ? 25 : 50;
	for (let i = 0; i < aliases.length; i += per) {
		const chunk = aliases.slice(i, i + per);
		const keys = chunk.flatMap((a) => (checks ? [keyFor(a), cursorKey(a), checkedKey(a), `account-state:${a}`] : [keyFor(a), `account-state:${a}`]));
		const found = (await kv.get(keys, "json")) as Map<string, unknown>;
		for (const a of chunk) {
			const r = found.get(keyFor(a)) as AccountRecord | null | undefined;
			const marker = found.get(`account-state:${a}`) as { email?: string; sealedHash?: string } | null | undefined;
			if (r && (!atomicMode || (marker?.email === r.email.toLowerCase() && marker.sealedHash === await sha256Hex(r.sealedRefreshToken)))) accounts.push(r);
			if (!checks) continue;
			const at = lastCheckOf(found.get(cursorKey(a)), found.get(checkedKey(a)));
			if (at !== undefined) checked.set(a, at);
		}
	}
	return { accounts: accounts.sort((a, b) => a.alias.localeCompare(b.alias)), checked };
}

/** The later of a real run's check (in the cursor) and a test run's, or undefined if neither. */
function lastCheckOf(cursor: unknown, test: unknown): number | undefined {
	const real = typeof (cursor as { checked?: unknown } | null)?.checked === "number" ? (cursor as { checked: number }).checked : undefined;
	const t = typeof test === "number" ? test : undefined;
	return real === undefined ? t : t === undefined ? real : Math.max(real, t);
}

/** When each of these mailboxes was last checked (ms): one bulk read. */
export async function lastChecks(kv: KVNamespace, aliases: string[]): Promise<Map<string, number>> {
	const out = new Map<string, number>();
	for (let i = 0; i < aliases.length; i += 50) {
		const chunk = aliases.slice(i, i + 50);
		const found = (await kv.get(chunk.flatMap((a) => [cursorKey(a), checkedKey(a)]), "json")) as Map<string, unknown>;
		for (const a of chunk) {
			const at = lastCheckOf(found.get(cursorKey(a)), found.get(checkedKey(a)));
			if (at !== undefined) out.set(a, at);
		}
	}
	return out;
}

export function toPublic(r: AccountRecord): PublicAccount {
	const { sealedRefreshToken: _omit, ...rest } = r;
	return rest;
}

export async function saveAccount(
	env: Pick<Env, "MAILBOX_KV" | "TOKEN_ENCRYPTION_KEY" | "JOB_AUTHORITY" | "ATOMIC_STATE_MODE">,
	input: { alias: string; email: string; scopes: string[]; refreshToken: string },
): Promise<AccountRecord> {
	const record: AccountRecord = {
		alias: input.alias,
		email: input.email,
		scopes: input.scopes,
		sealedRefreshToken: await encryptString(input.refreshToken, env.TOKEN_ENCRYPTION_KEY, keyFor(input.alias)),
		linkedAt: new Date().toISOString(),
	};
	const atomic = ["active", "migrate"].includes(env.ATOMIC_STATE_MODE ?? "") && env.JOB_AUTHORITY ? new AtomicGenerationClient(env.JOB_AUTHORITY) : null;
	const operation = atomic ? randomToken(16) : null;
	if (atomic && operation && !(await atomic.barrierBegin(operation, randomToken(16), "account"))?.ok) throw new Error("Account state is busy. Try again.");
	try {
		await env.MAILBOX_KV.put(keyFor(input.alias), JSON.stringify(record));
		await setIndexed(env.MAILBOX_KV, input.alias, true);
		if (atomic && !(await atomic.mutate({ operation: randomToken(16), generation: randomToken(16), key: `account-state:${record.alias}`, kind: "put", data: base64Text(JSON.stringify({ email: record.email.toLowerCase(), sealedHash: await sha256Hex(record.sealedRefreshToken) })) }))?.ok) throw new Error("Account identity publication failed");
	} finally {
		if (atomic && operation && !(await atomic.barrierEnd(operation, randomToken(16)))?.ok) throw new Error("Account state could not be finalized. Try again.");
	}
	accessTokenCache.delete(input.alias);
	return record;
}

/** Deletes the record and revokes the old refresh token at Google (best effort). */
export async function removeAccount(
	env: Pick<Env, "MAILBOX_KV" | "TOKEN_ENCRYPTION_KEY" | "JOB_AUTHORITY" | "ATOMIC_STATE_MODE">,
	record: AccountRecord,
): Promise<void> {
	try {
		const rt = await decryptString(record.sealedRefreshToken, env.TOKEN_ENCRYPTION_KEY, keyFor(record.alias));
		await revokeToken(rt);
	} catch {
		// A token we can't decrypt can't be revoked from here; the user can revoke at myaccount.google.com.
	}
	const atomic = ["active", "migrate"].includes(env.ATOMIC_STATE_MODE ?? "") && env.JOB_AUTHORITY ? new AtomicGenerationClient(env.JOB_AUTHORITY) : null;
	const operation = atomic ? randomToken(16) : null;
	if (atomic && operation && !(await atomic.barrierBegin(operation, randomToken(16), "account"))?.ok) throw new Error("Account state is busy. Try again.");
	try {
		await env.MAILBOX_KV.delete(keyFor(record.alias));
		await setIndexed(env.MAILBOX_KV, record.alias, false);
		// The alias may be linked again to another account, which must start from its own backlog.
		await env.MAILBOX_KV.delete(cursorKey(record.alias));
		// Its history and re-check list describe the old account's mail.
		await env.MAILBOX_KV.delete(historyKey(record.alias));
		await env.MAILBOX_KV.delete(recheckKey(record.alias));
		await env.MAILBOX_KV.delete(checkedKey(record.alias));
		if (atomic && !(await atomic.mutate({ operation: randomToken(16), generation: randomToken(16), key: `account-state:${record.alias}`, kind: "delete" }))?.ok) throw new Error("Account identity deletion failed");
	} finally {
		if (atomic && operation && !(await atomic.barrierEnd(operation, randomToken(16)))?.ok) throw new Error("Account state could not be finalized. Try again.");
	}
	accessTokenCache.delete(record.alias);
}

/** Where the run pipeline keeps a mailbox's "last check" cursor. */
export const cursorKey = (alias: string) => `cursor:${alias}`;
/** When a test run last read a mailbox (ms). Real runs keep it in the cursor (`checked`). */
export const checkedKey = (alias: string) => `checked:${alias}`;
/** A mailbox's recent model-classified emails, which estimates are made from (digest.ts). */
export const historyKey = (alias: string) => `history:${alias}`;
/** A mailbox's estimated emails, waiting for the model to re-check them (digest.ts). */
export const recheckKey = (alias: string) => `recheck:${alias}`;

// --- access tokens -----------------------------------------------------------------------------

interface CachedToken {
	token: string;
	expiresAt: number;
	/** Identifies which stored refresh token minted this, so a re-link invalidates the cache. */
	sealed: string;
}

// Lives as long as the isolate. Never persisted, so access tokens are never written anywhere.
const accessTokenCache = new Map<string, CachedToken>();

const EXPIRY_SKEW_MS = 60_000;

export async function getAccessToken(
	env: Pick<Env, "TOKEN_ENCRYPTION_KEY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">,
	record: AccountRecord,
	opts: { forceRefresh?: boolean } = {},
): Promise<string> {
	const cached = accessTokenCache.get(record.alias);
	if (
		!opts.forceRefresh &&
		cached &&
		cached.sealed === record.sealedRefreshToken &&
		cached.expiresAt - EXPIRY_SKEW_MS > Date.now()
	) {
		return cached.token;
	}

	let refreshToken: string;
	try {
		refreshToken = await decryptString(record.sealedRefreshToken, env.TOKEN_ENCRYPTION_KEY, keyFor(record.alias));
	} catch {
		throw new AccountError(
			`Stored token for "${record.alias}" can't be decrypted (was TOKEN_ENCRYPTION_KEY changed?). Re-link it.`,
			record.alias,
			true,
		);
	}

	try {
		const t = await refreshAccessToken({
			clientId: env.GOOGLE_CLIENT_ID,
			clientSecret: env.GOOGLE_CLIENT_SECRET,
			refreshToken,
		});
		accessTokenCache.set(record.alias, {
			token: t.access_token,
			expiresAt: Date.now() + t.expires_in * 1000,
			sealed: record.sealedRefreshToken,
		});
		return t.access_token;
	} catch (e) {
		if (e instanceof GoogleAuthError && e.code === "invalid_grant") {
			throw new AccountError(
				`Google rejected the stored token for "${record.alias}" (revoked, password changed, unused for 6 months, or the OAuth app is still in Testing mode). Re-link it.`,
				record.alias,
				true,
			);
		}
		throw new AccountError(`Couldn't refresh access for "${record.alias}": ${(e as Error).message}`, record.alias);
	}
}

/** Test hook. */
export function _clearAccessTokenCache(): void {
	accessTokenCache.clear();
}
