// SYNTHETIC ONLY. Exact-byte proof for a narrow source format; not a full DTO serializer, domain
// verifier, production source, retention policy or binding. Trusted inventory is coordinator-owned.
import { validateInputSnapshot, readInputSnapshotPage, type InputSnapshotManifest } from "./input-snapshot";
import type { SyntheticSnapshotStore } from "./synthetic-snapshot-store";
import type { SyntheticSourceAuthority } from "./synthetic-job-bound-stage";

const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const HASH = /^[a-f0-9]{64}$/;
export interface TrustedInventoryEntry { cursor: string; kind: "partial" | "state" | "missing" | "tombstone"; key: string; index: number; bytes: number; hash: string | null; expiresAt?: number | null; metadata?: unknown }
/** Implemented only by a coordinator-owned source, inside the caller's existing SQLite transaction. */
export interface TrustedInventoryReader {
	validateInTransaction(sql: SqlStorage, scope: string, token: string): boolean;
	inventoryPageInTransaction(sql: SqlStorage, scope: string, token: string, after: string | null, limit: number): { entries: TrustedInventoryEntry[]; next: string | null } | null;
}
type Proof = { scope: string; job: string; generation: string; attempt: string; source_id: string; manifest: string; next_idx: number; after_cursor: string | null; complete: number };
const encode = new TextEncoder();
/** Missing/deleted source state has an explicit canonical, nonempty representation. */
export function missingSourceFragment(entry: Pick<TrustedInventoryEntry, "kind" | "key" | "index">): Uint8Array {
	if (entry.kind !== "missing" && entry.kind !== "tombstone") throw new Error("Not an absent source entry");
	return encode.encode(JSON.stringify([1, entry.kind, entry.key, entry.index]));
}
/** A present zero-byte value is distinct from a missing key and a tombstone. */
export function emptySourceFragment(entry: Pick<TrustedInventoryEntry, "kind" | "key" | "index">): Uint8Array {
	if (entry.kind !== "state") throw new Error("Not an empty source value");
	return encode.encode(JSON.stringify([1, "empty", entry.key, entry.index]));
}
async function hash(value: Uint8Array): Promise<string> {
	const result = await crypto.subtle.digest("SHA-256", new Uint8Array(value).buffer);
	return [...new Uint8Array(result)].map((n) => n.toString(16).padStart(2, "0")).join("");
}
function normalized(manifest: InputSnapshotManifest): string {
	return JSON.stringify({ version: manifest.version, id: manifest.id, totalBytes: manifest.totalBytes, fragments: manifest.fragments.map((f) => ({ sha256: f.sha256, bytes: f.bytes })) });
}

export class SyntheticSourceProof {
	private readonly sql: SqlStorage;
	constructor(private readonly storage: DurableObjectStorage, private readonly trusted: TrustedInventoryReader, private readonly snapshots: SyntheticSnapshotStore) {
		this.sql = storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_source_proof (scope TEXT PRIMARY KEY, job TEXT NOT NULL, generation TEXT NOT NULL, attempt TEXT NOT NULL, source_id TEXT NOT NULL, manifest TEXT NOT NULL, next_idx INTEGER NOT NULL, after_cursor TEXT, complete INTEGER NOT NULL)");
	}
	private row(scope: string): Proof | undefined { return this.sql.exec<Proof>("SELECT * FROM synthetic_source_proof WHERE scope=?", scope).toArray()[0]; }
	/** Same-transaction proof prerequisites; sealed synthetic snapshots are immutable while owned. */
	private valid(row: Proof): boolean {
		const source = this.sql.exec<{ job: string; generation: string; token: string }>("SELECT job,generation,token FROM trusted_source WHERE scope=?", row.scope).toArray()[0];
		const stored = this.sql.exec<{ owner: string; sealed: number; manifest: string }>("SELECT owner,sealed,manifest FROM synthetic_snapshots WHERE id=?", row.source_id).toArray()[0];
		const lease = this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM lease WHERE id=1 AND owner=?", row.generation).toArray()[0];
		return !!source && source.job === row.job && source.generation === row.generation && source.token === row.attempt && !!stored && stored.owner === row.generation && stored.sealed === 1 && stored.manifest === row.manifest && !!lease && lease.expires_at > Date.now() && this.trusted.validateInTransaction(this.sql, row.scope, row.attempt);
	}
	/** Begin once only; proof scope must be a captured trusted source and job generation. */
	async begin(input: { scope: string; job: string; generation: string; attempt: string; manifest: InputSnapshotManifest }): Promise<boolean> {
		if (!input || ![input.scope, input.job, input.generation, input.attempt].every((v) => typeof v === "string" && TOKEN.test(v)) || !input.manifest || !HASH.test(input.manifest.id) || !Array.isArray(input.manifest.fragments) || input.manifest.fragments.length > 160) return false;
		const identity = { scope: input.scope, job: input.job, generation: input.generation, attempt: input.attempt };
		const pinned = { version: input.manifest.version, id: input.manifest.id, totalBytes: input.manifest.totalBytes, fragments: input.manifest.fragments.map((f) => ({ sha256: f.sha256, bytes: f.bytes })) };
		try { await validateInputSnapshot(pinned, pinned.id); } catch { return false; }
		const row: Proof = { ...identity, source_id: pinned.id, manifest: normalized(pinned), next_idx: 0, after_cursor: null, complete: 0 };
		return this.storage.transactionSync(() => {
			if (this.row(row.scope) || !this.valid(row)) return false;
			const first = this.trusted.inventoryPageInTransaction(this.sql, row.scope, row.attempt, null, 1);
			if (!first || (pinned.fragments.length === 0) !== (first.entries.length === 0 && first.next === null)) return false;
			this.sql.exec("INSERT INTO synthetic_source_proof VALUES (?, ?, ?, ?, ?, ?, 0, NULL, ?)", row.scope, row.job, row.generation, row.attempt, row.source_id, row.manifest, pinned.fragments.length === 0 ? 1 : 0);
			return true;
		});
	}
	/** Verifies one independent source entry and one snapshot fragment, then CAS-advances the proof. */
	async verifyNext(scope: string, attempt: string, expectedIndex: number): Promise<{ next: number; complete: boolean } | null> {
		if (!TOKEN.test(scope) || !TOKEN.test(attempt) || !Number.isSafeInteger(expectedIndex) || expectedIndex < 0 || expectedIndex >= 160) return null;
		const before = this.storage.transactionSync(() => {
			const row = this.row(scope);
			if (!row || row.attempt !== attempt || row.complete || row.next_idx !== expectedIndex || !this.valid(row)) return null;
			const page = this.trusted.inventoryPageInTransaction(this.sql, scope, attempt, row.after_cursor, 1);
			if (!page || page.entries.length !== 1) return null;
			return { row, entry: page.entries[0]!, next: page.next };
		});
		if (!before) return null;
		let manifest: InputSnapshotManifest;
		try { manifest = JSON.parse(before.row.manifest) as InputSnapshotManifest; } catch { return null; }
		const part = manifest.fragments[expectedIndex];
		if (!part) return null;
		const entry = before.entry;
		let expectedHash: string;
		let expectedBytes: number;
		if (entry.kind === "missing" || entry.kind === "tombstone") {
			const sentinel = missingSourceFragment(entry);
			expectedHash = await hash(sentinel); expectedBytes = sentinel.byteLength;
		} else if (entry.kind === "state" && entry.bytes === 0 && entry.hash === null) {
			const sentinel = emptySourceFragment(entry);
			expectedHash = await hash(sentinel); expectedBytes = sentinel.byteLength;
		} else {
			if (!entry.hash || !HASH.test(entry.hash) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || entry.bytes > 64 * 1024) return null;
			expectedHash = entry.hash; expectedBytes = entry.bytes;
		}
		if (part.sha256 !== expectedHash || part.bytes !== expectedBytes) return null;
		try { await readInputSnapshotPage(this.snapshots.source(before.row.generation), manifest, before.row.source_id, expectedIndex, { maxBytes: 64 * 1024, maxFragments: 1 }); } catch { return null; }
		return this.storage.transactionSync(() => {
			const row = this.row(scope);
			if (!row || row.attempt !== attempt || row.complete || row.next_idx !== expectedIndex || row.after_cursor !== before.row.after_cursor || row.manifest !== before.row.manifest || !this.valid(row)) return null;
			const current = this.trusted.inventoryPageInTransaction(this.sql, scope, attempt, row.after_cursor, 1);
			if (!current || current.entries.length !== 1 || JSON.stringify(current.entries[0]) !== JSON.stringify(entry) || current.next !== before.next) return null;
			const next = expectedIndex + 1, complete = current.next === null;
			if (complete !== (next === manifest.fragments.length)) return null;
			this.sql.exec("UPDATE synthetic_source_proof SET next_idx=?, after_cursor=?, complete=? WHERE scope=? AND next_idx=? AND complete=0", next, complete ? entry.cursor : current.next, complete ? 1 : 0, scope, expectedIndex);
			return { next, complete };
		});
	}
	/** For SyntheticJobBoundStage only: never substitutes for independent output verification. */
	authority(): SyntheticSourceAuthority {
		return (sql, job, generation, sourceId, versions) => {
			if (sql !== this.sql) return false;
			const rows = this.sql.exec<Proof>("SELECT * FROM synthetic_source_proof WHERE job=? AND generation=? AND source_id=? AND complete=1", job, generation, sourceId).toArray();
			return rows.some((row) => {
				if (!this.valid(row)) return false;
				const source = this.sql.exec<{ payload: string }>("SELECT payload FROM trusted_source WHERE scope=?", row.scope).toArray()[0];
				if (!source) return false;
				try {
					const captured = JSON.parse(source.payload).versions as { key: string; version: number }[];
					const expected = (JSON.parse(versions) as { key: string; value: number }[]).map((v) => ({ key: v.key, version: v.value })).sort((a, b) => a.key.localeCompare(b.key));
					return JSON.stringify([...captured].sort((a, b) => a.key.localeCompare(b.key))) === JSON.stringify(expected);
				} catch { return false; }
			});
		};
	}
}
