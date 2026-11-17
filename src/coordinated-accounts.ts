// Isolated account mutation primitive; no production binding or migration. Account cleanup must
// be proved inside the same SQLite transaction before a previously unlinked alias can be reused.
import { ALIAS_PATTERN } from "./config";
import { sha256Hex } from "./crypto";
import type { AccountRecord } from "./accounts";

const IDENTITY = /^[a-f0-9]{64}$/;
const CLAIM = /^[A-Za-z0-9_-]{22,128}$/;
const CIPHERTEXT = /^v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{22,}$/;
const REVOCATION_TTL_MS = 24 * 60 * 60 * 1000;
/** Trusted synchronous proof: true only when every account-scoped authoritative value is gone. */
export type AccountPurgeProof = (sql: SqlStorage, alias: string) => boolean;
/** Trusted synchronous namespace binder; called within the same transaction as account linking. */
export type AccountNamespaceBinding = (sql: SqlStorage, alias: string, incarnation: number, namespace: string) => true;
/** Read-only replay verifier: must never create or change a binding. */
export type AccountNamespaceReplay = (sql: SqlStorage, alias: string, incarnation: number, namespace: string) => boolean;

export class CoordinatedAccounts {
	private readonly sql: SqlStorage;
	constructor(private readonly storage: DurableObjectStorage, private readonly namespaceBinding?: AccountNamespaceBinding, private readonly namespaceReplay?: AccountNamespaceReplay) {
		this.sql = storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS domain_accounts (alias TEXT PRIMARY KEY, identity TEXT, epoch INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS coordinated_incarnations (alias TEXT PRIMARY KEY NOT NULL, version INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS gen_versions (key TEXT PRIMARY KEY, version INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS coordinated_accounts (alias TEXT PRIMARY KEY NOT NULL, value TEXT, purge_pending INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS coordinated_identities (identity TEXT PRIMARY KEY NOT NULL, alias TEXT UNIQUE NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS coordinated_revocations (alias TEXT NOT NULL, epoch INTEGER NOT NULL, identity TEXT NOT NULL, sealed TEXT, expires_at INTEGER NOT NULL, claim_token TEXT, PRIMARY KEY(alias,epoch))");
		this.sql.exec("CREATE INDEX IF NOT EXISTS coordinated_revocations_expiry ON coordinated_revocations(expires_at)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS coordinated_oauth_barrier (singleton INTEGER PRIMARY KEY CHECK (singleton=1), version INTEGER NOT NULL)");
		this.sql.exec("INSERT OR IGNORE INTO coordinated_oauth_barrier (singleton,version) VALUES (1,0)");
	}

	/** Capture when the OAuth flow starts; unlink/revocation invalidates pending flows. */
	flowBarrier(): number {
		const version = this.sql.exec<{ version: number }>("SELECT version FROM coordinated_oauth_barrier WHERE singleton=1").toArray()[0]?.version;
		if (!Number.isSafeInteger(version) || version! < 0) throw new Error("OAuth barrier unavailable");
		return version!;
	}

	private bumpFlowBarrier(): void {
		const next = this.flowBarrier() + 1;
		if (!Number.isSafeInteger(next)) throw new Error("OAuth barrier exhausted");
		this.sql.exec("UPDATE coordinated_oauth_barrier SET version=? WHERE singleton=1", next);
	}

	private bumpIncarnation(alias: string): void {
		const before = this.sql.exec<{ version: number }>("SELECT version FROM coordinated_incarnations WHERE alias=?", alias).toArray()[0]?.version ?? 0;
		const next = before + 1;
		if (!Number.isSafeInteger(next)) throw new Error("Mailbox incarnation exhausted");
		this.sql.exec("INSERT OR REPLACE INTO coordinated_incarnations (alias,version) VALUES (?,?)", alias, next);
	}

	/** A new link is accepted only for a clean alias. Updates must unlink and finish purge first. */
	async link(record: AccountRecord, identity: string, expectedEpoch: number, expectedBarrier: number): Promise<number> {
		return this.linkInternal(record, identity, expectedEpoch, expectedBarrier);
	}

	/** Explicit fail-closed scoped-link path. Never falls back to unscoped link. */
	async linkScoped(record: AccountRecord, identity: string, expectedEpoch: number, expectedBarrier: number, namespace: string): Promise<number> {
		if (!this.namespaceBinding || typeof namespace !== 'string' || !CLAIM.test(namespace)) throw new Error('Namespace binding unavailable');
		return this.linkInternal(record, identity, expectedEpoch, expectedBarrier, namespace);
	}

	private async linkInternal(record: AccountRecord, identity: string, expectedEpoch: number, expectedBarrier: number, namespace?: string): Promise<number> {
		if (!record || typeof record.alias !== "string" || !ALIAS_PATTERN.test(record.alias) || typeof identity !== "string" || !IDENTITY.test(identity) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 || !Number.isSafeInteger(expectedBarrier) || expectedBarrier < 0 || typeof record.email !== "string" || record.email.length < 3 || record.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(record.email) || !Array.isArray(record.scopes) || record.scopes.length > 32 || record.scopes.some((scope) => typeof scope !== "string" || !scope.length || scope.length > 512) || typeof record.sealedRefreshToken !== "string" || record.sealedRefreshToken.length > 65_536 || !CIPHERTEXT.test(record.sealedRefreshToken) || typeof record.linkedAt !== "string" || !Number.isFinite(Date.parse(record.linkedAt))) throw new Error("Invalid account");
		// Pin all caller-owned data before yielding to the digest operation.
		const pinned = { alias: record.alias, email: record.email, scopes: [...record.scopes], sealedRefreshToken: record.sealedRefreshToken, linkedAt: record.linkedAt };
		const value = JSON.stringify(pinned);
		if (await sha256Hex(pinned.email.trim().toLowerCase()) !== identity) throw new Error("Account identity mismatch");
		return this.storage.transactionSync(() => {
			if (this.flowBarrier() !== expectedBarrier) throw new Error("OAuth flow is stale; start again");
			const stored = this.sql.exec<{ value: string | null; purge_pending: number }>("SELECT value,purge_pending FROM coordinated_accounts WHERE alias=?", pinned.alias).toArray()[0];
			const existing = this.sql.exec<{ identity: string | null; epoch: number }>("SELECT identity,epoch FROM domain_accounts WHERE alias=?", pinned.alias).toArray()[0];
			// A lost success response may be retried without minting another account epoch.
			if (stored?.value === value && !stored.purge_pending && existing?.identity === identity && existing.epoch === expectedEpoch + 1) {
				if (namespace !== undefined) {
					const incarnation = this.sql.exec<{version:number}>("SELECT version FROM coordinated_incarnations WHERE alias=?",pinned.alias).toArray()[0]?.version;
					if (!incarnation || !this.namespaceReplay || this.namespaceReplay(this.sql,pinned.alias,incarnation,namespace)!==true) throw new Error('Namespace replay not verified');
				}
				return existing.epoch;
			}
			if ((existing?.epoch ?? 0) !== expectedEpoch) throw new Error("Account changed; retry with the current epoch");
			if (stored?.value || stored?.purge_pending) throw new Error("Account must be unlinked and purged before linking");
			if (this.sql.exec("SELECT alias FROM coordinated_revocations WHERE alias=? OR identity=? LIMIT 1", pinned.alias, identity).toArray().length) throw new Error("Account revocation is pending");
			if (this.sql.exec("SELECT alias FROM coordinated_identities WHERE identity=? LIMIT 1", identity).toArray().length) throw new Error("Mailbox is already linked");
			const before = existing?.epoch ?? 0;
			const epoch = before + 1;
			if (!Number.isSafeInteger(epoch)) throw new Error("Account epoch exhausted");
			this.sql.exec("INSERT OR REPLACE INTO coordinated_accounts (alias,value,purge_pending) VALUES (?,?,0)", pinned.alias, value);
			this.sql.exec("INSERT INTO coordinated_identities (identity,alias) VALUES (?,?)", identity, pinned.alias);
			this.bumpIncarnation(pinned.alias);
			this.sql.exec("INSERT OR REPLACE INTO domain_accounts (alias,identity,epoch) VALUES (?,?,?)", pinned.alias, identity, epoch);
			this.sql.exec("INSERT OR REPLACE INTO gen_versions (key,version) VALUES (?,?)", `account:${pinned.alias}`, epoch);
			if (namespace !== undefined) {
				const incarnation = this.sql.exec<{version:number}>("SELECT version FROM coordinated_incarnations WHERE alias=?",pinned.alias).toArray()[0]?.version;
				if (!incarnation || this.namespaceBinding!(this.sql,pinned.alias,incarnation,namespace)!==true) throw new Error('Namespace binding failed');
			}
			return epoch;
		});
	}

	/** Rotate an active grant for the same verified mailbox without revoking its old token. */
	async rotate(record: AccountRecord, identity: string, expectedEpoch: number, expectedBarrier: number): Promise<number> {
		if (!record || typeof record.alias !== "string" || !ALIAS_PATTERN.test(record.alias) || typeof identity !== "string" || !IDENTITY.test(identity) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 1 || !Number.isSafeInteger(expectedBarrier) || expectedBarrier < 0 || typeof record.email !== "string" || record.email.length < 3 || record.email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(record.email) || !Array.isArray(record.scopes) || record.scopes.length > 32 || record.scopes.some((scope) => typeof scope !== "string" || !scope.length || scope.length > 512) || typeof record.sealedRefreshToken !== "string" || record.sealedRefreshToken.length > 65_536 || !CIPHERTEXT.test(record.sealedRefreshToken) || typeof record.linkedAt !== "string" || !Number.isFinite(Date.parse(record.linkedAt))) throw new Error("Invalid account");
		const pinned = { alias: record.alias, email: record.email, scopes: [...record.scopes], sealedRefreshToken: record.sealedRefreshToken, linkedAt: record.linkedAt };
		const value = JSON.stringify(pinned);
		if (await sha256Hex(pinned.email.trim().toLowerCase()) !== identity) throw new Error("Account identity mismatch");
		return this.storage.transactionSync(() => {
			if (this.flowBarrier() !== expectedBarrier) throw new Error("OAuth flow is stale; start again");
			const stored = this.sql.exec<{ value: string | null; purge_pending: number }>("SELECT value,purge_pending FROM coordinated_accounts WHERE alias=?", pinned.alias).toArray()[0];
			const existing = this.sql.exec<{ identity: string | null; epoch: number }>("SELECT identity,epoch FROM domain_accounts WHERE alias=?", pinned.alias).toArray()[0];
			if (!stored?.value || stored.purge_pending || !existing || existing.identity !== identity) throw new Error("Mailbox changed; start again");
			if (existing.epoch === expectedEpoch + 1 && stored.value === value) return existing.epoch;
			if (existing.epoch !== expectedEpoch) throw new Error("Account changed; retry with the current epoch");
			if (this.sql.exec("SELECT alias FROM coordinated_revocations WHERE identity=? LIMIT 1", identity).toArray().length) throw new Error("Account revocation is pending");
			const epoch = existing.epoch + 1;
			if (!Number.isSafeInteger(epoch)) throw new Error("Account epoch exhausted");
			this.sql.exec("UPDATE coordinated_accounts SET value=? WHERE alias=?", value, pinned.alias);
			this.sql.exec("UPDATE domain_accounts SET epoch=? WHERE alias=?", epoch, pinned.alias);
			this.sql.exec("INSERT OR REPLACE INTO gen_versions (key,version) VALUES (?,?)", `account:${pinned.alias}`, epoch);
			return epoch;
		});
	}

	/** Returns the encrypted record only to trusted Worker code, never to a public route. */
	get(alias: string): AccountRecord | null {
		if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias)) throw new Error("Invalid alias");
		const row = this.sql.exec<{ value: string | null }>("SELECT value FROM coordinated_accounts WHERE alias=?", alias).toArray()[0];
		return row?.value ? JSON.parse(row.value) as AccountRecord : null;
	}

	/** Invalidate in-flight jobs and remove the encrypted record before asynchronous Google revocation. */
	unlink(alias: string, expectedEpoch: number): { epoch: number; removed: boolean } {
		if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0) throw new Error("Invalid account epoch");
		return this.storage.transactionSync(() => {
			const stored = this.sql.exec<{ value: string | null; purge_pending: number }>("SELECT value,purge_pending FROM coordinated_accounts WHERE alias=?", alias).toArray()[0];
			const account = this.sql.exec<{ epoch: number; identity: string | null }>("SELECT epoch,identity FROM domain_accounts WHERE alias=?", alias).toArray()[0];
			const before = account?.epoch ?? 0;
			if (!stored?.value && stored?.purge_pending && before === expectedEpoch + 1) return { epoch: before, removed: false };
			if (before !== expectedEpoch) throw new Error("Account changed; retry with the current epoch");
			if (!stored?.value) return { epoch: before, removed: false };
			const epoch = before + 1;
			if (!Number.isSafeInteger(epoch)) throw new Error("Account epoch exhausted");
			const old = JSON.parse(stored.value) as AccountRecord;
			if (typeof old.sealedRefreshToken !== "string" || !CIPHERTEXT.test(old.sealedRefreshToken) || !account?.identity) throw new Error("Stored account ciphertext or identity is invalid");
			this.sql.exec("INSERT INTO coordinated_revocations (alias,epoch,identity,sealed,expires_at) VALUES (?,?,?,?,?)", alias, epoch, account.identity, old.sealedRefreshToken, Date.now() + REVOCATION_TTL_MS);
			this.bumpIncarnation(alias);
			this.bumpFlowBarrier();
			this.sql.exec("DELETE FROM coordinated_identities WHERE identity=? AND alias=?", account.identity, alias);
			this.sql.exec("UPDATE coordinated_accounts SET value=NULL,purge_pending=1 WHERE alias=?", alias);
			this.sql.exec("INSERT OR REPLACE INTO domain_accounts (alias,identity,epoch) VALUES (?,NULL,?)", alias, epoch);
			this.sql.exec("INSERT OR REPLACE INTO gen_versions (key,version) VALUES (?,?)", `account:${alias}`, epoch);
			return { epoch, removed: true };
		});
	}

	/** A trustworthy proof must inspect all account-scoped state; async callbacks are rejected. */
	finishPurge(alias: string, expectedEpoch: number, proof: AccountPurgeProof): boolean {
		if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias) || !Number.isSafeInteger(expectedEpoch) || expectedEpoch < 0 || typeof proof !== "function") throw new Error("Invalid purge proof");
		return this.storage.transactionSync(() => {
			const stored = this.sql.exec<{ value: string | null; purge_pending: number }>("SELECT value,purge_pending FROM coordinated_accounts WHERE alias=?", alias).toArray()[0];
			const epoch = this.sql.exec<{ epoch: number }>("SELECT epoch FROM domain_accounts WHERE alias=?", alias).toArray()[0]?.epoch ?? 0;
			if (epoch !== expectedEpoch) throw new Error("Account changed; purge stopped");
			if (!stored || stored.value || !stored.purge_pending || proof(this.sql, alias) !== true) return false;
			this.sql.exec("UPDATE coordinated_accounts SET purge_pending=0 WHERE alias=?", alias);
			return true;
		});
	}

	/** Grant a single trusted dispatcher an encrypted handle. A lost response stays blocked. */
	claimRevocation(alias: string, epoch: number, claimToken: string): { sealed: string; expiresAt: number } | null {
		if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias) || !Number.isSafeInteger(epoch) || epoch < 1 || typeof claimToken !== "string" || !CLAIM.test(claimToken)) throw new Error("Invalid revocation");
		return this.storage.transactionSync(() => {
			const row = this.sql.exec<{ sealed: string | null; expires_at: number; claim_token: string | null }>("SELECT sealed,expires_at,claim_token FROM coordinated_revocations WHERE alias=? AND epoch=?", alias, epoch).toArray()[0];
			if (!row || !row.sealed || row.claim_token || row.expires_at <= Date.now()) return null;
			// The durable record keeps no ciphertext after handing the only copy to the dispatcher.
			this.sql.exec("UPDATE coordinated_revocations SET sealed=NULL,claim_token=? WHERE alias=? AND epoch=?", claimToken, alias, epoch);
			return { sealed: row.sealed, expiresAt: row.expires_at };
		});
	}

	/** Safe status for recovery UI; never returns the ciphertext or claim token. */
	revocationStatus(alias: string, epoch: number): { state: "pending" | "expired" | "uncertain"; expiresAt: number } | null {
		if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias) || !Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Invalid revocation");
		const row = this.sql.exec<{ expires_at: number; claim_token: string | null }>("SELECT expires_at,claim_token FROM coordinated_revocations WHERE alias=? AND epoch=?", alias, epoch).toArray()[0];
		return row ? { state: row.claim_token ? "uncertain" : row.expires_at <= Date.now() ? "expired" : "pending", expiresAt: row.expires_at } : null;
	}

	/** Call only after confirmed revocation, or after the bounded outbox retention has elapsed. */
	finishRevocation(alias: string, epoch: number, confirmed: boolean, claimToken?: string): boolean {
		if (typeof alias !== "string" || !ALIAS_PATTERN.test(alias) || !Number.isSafeInteger(epoch) || epoch < 1 || typeof confirmed !== "boolean" || (claimToken !== undefined && (typeof claimToken !== "string" || !CLAIM.test(claimToken)))) throw new Error("Invalid revocation");
		return this.storage.transactionSync(() => {
			const row = this.sql.exec<{ expires_at: number; claim_token: string | null }>("SELECT expires_at,claim_token FROM coordinated_revocations WHERE alias=? AND epoch=?", alias, epoch).toArray()[0];
			if (!row) return true;
			// An in-flight or uncertain revocation must never expire into permission to relink.
			if (row.claim_token ? !confirmed || row.claim_token !== claimToken : confirmed || row.expires_at > Date.now()) return false;
			this.sql.exec("DELETE FROM coordinated_revocations WHERE alias=? AND epoch=?", alias, epoch);
			this.bumpFlowBarrier();
			return true;
		});
	}

	/** Bounded cleanup for expired encrypted handles; revocation after expiry remains best effort. */
	cleanupRevocations(limit = 100): { removed: number; remaining: boolean; uncertain: boolean } {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid cleanup limit");
		return this.storage.transactionSync(() => {
			const now = Date.now();
			const rows = this.sql.exec<{ alias: string; epoch: number }>("SELECT alias,epoch FROM coordinated_revocations WHERE claim_token IS NULL AND expires_at<=? ORDER BY expires_at,alias,epoch LIMIT ?", now, limit).toArray();
			for (const row of rows) this.sql.exec("DELETE FROM coordinated_revocations WHERE alias=? AND epoch=?", row.alias, row.epoch);
			if (rows.length) this.bumpFlowBarrier();
			return { removed: rows.length, remaining: this.sql.exec("SELECT alias FROM coordinated_revocations WHERE claim_token IS NULL AND expires_at<=? LIMIT 1", now).toArray().length > 0, uncertain: this.sql.exec("SELECT alias FROM coordinated_revocations WHERE claim_token IS NOT NULL LIMIT 1").toArray().length > 0 };
		});
	}
}
