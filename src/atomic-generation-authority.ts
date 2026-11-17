// Strongly consistent generation storage for run-managed state. This component shares the
// InboxJobAuthority SQLite database so the finalizer fence and head flip occur in one transaction.

import { ATOMIC_GENERATION_MAX_BYTES, ATOMIC_GENERATION_MAX_ENTRIES } from "./atomic-limits";

const CAP = /^[A-Za-z0-9_-]{22,128}$/;
const KEY = /^[A-Za-z0-9:_.@/-]{1,512}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_CHUNK_BYTES = 96 * 1024;
const MAX_CHUNKS_PER_VALUE = 160;
const MAX_STAGE_ENTRIES = ATOMIC_GENERATION_MAX_ENTRIES;
const MAX_STAGE_BYTES = ATOMIC_GENERATION_MAX_BYTES;
const PIN_MS = 5 * 60_000;

type Head = { generation: string; seq: number };
type Stage = { stage: string; owner: string; attempt: string; generation: string; parent_seq: number; state: string; entries: number; bytes: number };
type Entry = { key: string; kind: "put" | "delete"; chunks: number; bytes: number; expires_at: number | null; metadata: string | null };

export type AtomicHead = Head | null;
export type AtomicWrite = { kind: "put"; key: string; value: string; expirationTtl?: number; metadata?: { arrived: number } } | { kind: "delete"; key: string };

const b64 = (bytes: Uint8Array) => {
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(out);
};
const unb64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const sha = async (bytes: Uint8Array) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer))].map((v) => v.toString(16).padStart(2, "0")).join("");

export class AtomicGenerationAuthority {
	private readonly sql: SqlStorage;
	constructor(private readonly storage: DurableObjectStorage) {
		this.sql = storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), generation TEXT, seq INTEGER NOT NULL)");
		this.sql.exec("INSERT OR IGNORE INTO atomic_control VALUES (1,NULL,0)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_generations (seq INTEGER PRIMARY KEY, generation TEXT UNIQUE NOT NULL, parent_seq INTEGER NOT NULL, created_at INTEGER NOT NULL, job_owner TEXT, final_attempt TEXT)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_values (seq INTEGER NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, stage TEXT NOT NULL, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL, expires_at INTEGER, metadata TEXT, PRIMARY KEY(seq,key))");
		this.sql.exec("CREATE INDEX IF NOT EXISTS atomic_values_lookup ON atomic_values(key,seq DESC)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_stages (stage TEXT PRIMARY KEY, owner TEXT NOT NULL, attempt TEXT NOT NULL, generation TEXT UNIQUE NOT NULL, parent_seq INTEGER NOT NULL, state TEXT NOT NULL, entries INTEGER NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_stage_entries (stage TEXT NOT NULL, key TEXT NOT NULL, kind TEXT NOT NULL, chunks INTEGER NOT NULL, bytes INTEGER NOT NULL, expires_at INTEGER, metadata TEXT, PRIMARY KEY(stage,key))");
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_stage_chunks (stage TEXT NOT NULL, key TEXT NOT NULL, idx INTEGER NOT NULL, hash TEXT NOT NULL, bytes INTEGER NOT NULL, data BLOB NOT NULL, PRIMARY KEY(stage,key,idx))");
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_pins (pin TEXT PRIMARY KEY, seq INTEGER NOT NULL, expires_at INTEGER NOT NULL)");
		this.sql.exec("CREATE INDEX IF NOT EXISTS atomic_pins_expiry ON atomic_pins(expires_at)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_barriers (operation TEXT PRIMARY KEY, kind TEXT NOT NULL, expires_at INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS atomic_bridge_ops (operation TEXT PRIMARY KEY, kind TEXT NOT NULL, state TEXT NOT NULL, started_at INTEGER NOT NULL, finished_at INTEGER)");
	}
	private head(): Head | null {
		const row = this.sql.exec<{ generation: string | null; seq: number }>("SELECT generation,seq FROM atomic_control WHERE singleton=1").toArray()[0];
		return row?.generation ? { generation: row.generation, seq: row.seq } : null;
	}
	private stage(id: string): Stage | undefined {
		return this.sql.exec<Stage>("SELECT stage,owner,attempt,generation,parent_seq,state,entries,bytes FROM atomic_stages WHERE stage=?", id).toArray()[0];
	}
	private finalizer(owner: string, attempt: string): boolean {
		const now = Date.now();
		const row = this.sql.exec<{ expires: number; deadline: number }>("SELECT l.expires,s.deadline FROM job_authority_lease l JOIN job_authority_steps s ON s.owner=l.owner WHERE l.id=1 AND l.owner=? AND s.step='final' AND s.state='running' AND s.attempt=?", owner, attempt).toArray()[0];
		return !!row && row.expires > now && row.deadline > now && !this.sql.exec("SELECT operation FROM atomic_barriers WHERE expires_at>? LIMIT 1", now).toArray().length;
	}
	private authorized(stage: Stage): boolean {
		return stage.owner === stage.attempt ? this.head() === null : this.finalizer(stage.owner, stage.attempt);
	}
	getHead(): AtomicHead { return this.storage.transactionSync(() => this.head()); }
	begin(input: { stage: string; owner: string; attempt: string; generation: string; parentSeq: number }): boolean {
		if (![input.stage, input.owner, input.attempt, input.generation].every((v) => typeof v === "string" && CAP.test(v)) || !Number.isSafeInteger(input.parentSeq) || input.parentSeq < 0) return false;
		return this.storage.transactionSync(() => {
			if (!this.finalizer(input.owner, input.attempt) || (this.head()?.seq ?? 0) !== input.parentSeq) return false;
			const prior = this.stage(input.stage);
			if (prior) return prior.owner === input.owner && prior.attempt === input.attempt && prior.generation === input.generation && prior.parent_seq === input.parentSeq && prior.state === "staging";
			this.sql.exec("INSERT INTO atomic_stages VALUES (?,?,?,?,?,'staging',0,0,?)", input.stage, input.owner, input.attempt, input.generation, input.parentSeq, Date.now());
			return true;
		});
	}
	beginBootstrap(input: { stage: string; capability: string; generation: string }): boolean {
		if (![input.stage, input.capability, input.generation].every((v) => typeof v === "string" && CAP.test(v))) return false;
		return this.storage.transactionSync(() => {
			if (this.head() !== null || this.sql.exec("SELECT operation FROM atomic_bridge_ops WHERE state='open' LIMIT 1").toArray().length) return false;
			const prior = this.stage(input.stage);
			if (prior) return prior.owner === input.capability && prior.attempt === input.capability && prior.generation === input.generation && prior.parent_seq === 0 && prior.state === "staging";
			// Cutover stops every pre-generation attempt in the same serialized authority. A paused old
			// invocation may still write KV, but generation readers never consult those mutable keys.
			this.sql.exec("UPDATE job_authority_steps SET state='failed',deadline=NULL WHERE state='running'");
			this.sql.exec("DELETE FROM job_authority_lease");
			this.sql.exec("INSERT INTO atomic_stages VALUES (?,?,?,?,0,'staging',0,0,?)", input.stage, input.capability, input.capability, input.generation, Date.now());
			return true;
		});
	}
	async putChunk(input: { stage: string; key: string; index: number; total: number; data: string }): Promise<boolean> {
		if (!CAP.test(input.stage) || !KEY.test(input.key) || !Number.isSafeInteger(input.index) || !Number.isSafeInteger(input.total) || input.total < 1 || input.total > MAX_CHUNKS_PER_VALUE || input.index < 0 || input.index >= input.total || typeof input.data !== "string") return false;
		let bytes: Uint8Array;
		try { bytes = unb64(input.data); } catch { return false; }
		if (!bytes.length || bytes.length > MAX_CHUNK_BYTES) return false;
		const hash = await sha(bytes);
		return this.storage.transactionSync(() => {
			const stage = this.stage(input.stage);
			if (!stage || stage.state !== "staging" || !this.authorized(stage)) return false;
			const existing = this.sql.exec<{ hash: string; bytes: number }>("SELECT hash,bytes FROM atomic_stage_chunks WHERE stage=? AND key=? AND idx=?", input.stage, input.key, input.index).toArray()[0];
			if (existing) return existing.hash === hash && existing.bytes === bytes.length;
			const entry = this.sql.exec<Entry>("SELECT key,kind,chunks,bytes,expires_at,metadata FROM atomic_stage_entries WHERE stage=? AND key=?", input.stage, input.key).toArray()[0];
			if (entry && (entry.kind !== "put" || entry.chunks !== input.total)) return false;
			if (!entry) {
				if (stage.entries >= MAX_STAGE_ENTRIES) return false;
				this.sql.exec("INSERT INTO atomic_stage_entries VALUES (?,?,'put',?,0,NULL,NULL)", input.stage, input.key, input.total);
				this.sql.exec("UPDATE atomic_stages SET entries=entries+1 WHERE stage=?", input.stage);
			}
			if (stage.bytes + bytes.length > MAX_STAGE_BYTES) return false;
			this.sql.exec("INSERT INTO atomic_stage_chunks VALUES (?,?,?,?,?,?)", input.stage, input.key, input.index, hash, bytes.length, bytes.buffer);
			this.sql.exec("UPDATE atomic_stage_entries SET bytes=bytes+? WHERE stage=? AND key=?", bytes.length, input.stage, input.key);
			this.sql.exec("UPDATE atomic_stages SET bytes=bytes+? WHERE stage=?", bytes.length, input.stage);
			return true;
		});
	}
	async putBatch(input: { stage: string; items: ({ key: string; kind: "delete" } | { key: string; kind: "put"; data: string; expiresAt?: number; metadata?: { arrived: number } })[] }): Promise<boolean> {
		if (!CAP.test(input.stage) || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 24) return false;
		for (const item of input.items) {
			if (!item || !KEY.test(item.key)) return false;
			if (item.kind === "delete") {
				if (!this.setEntry({ stage: input.stage, key: item.key, kind: "delete", chunks: 0, bytes: 0 })) return false;
				continue;
			}
			let bytes: Uint8Array; try { bytes = unb64(item.data); } catch { return false; }
			if (!bytes.length || bytes.length > 32 * 1024) return false;
			if (!await this.putChunk({ stage: input.stage, key: item.key, index: 0, total: 1, data: item.data })) return false;
			if (!this.setEntry({ stage: input.stage, key: item.key, kind: "put", chunks: 1, bytes: bytes.length, ...(item.expiresAt === undefined ? {} : { expiresAt: item.expiresAt }), ...(item.metadata ? { metadata: item.metadata } : {}) })) return false;
		}
		return true;
	}
	setEntry(input: { stage: string; key: string; kind: "put" | "delete"; chunks: number; bytes: number; expiresAt?: number; metadata?: { arrived: number } }): boolean {
		if (!CAP.test(input.stage) || !KEY.test(input.key) || !["put", "delete"].includes(input.kind) || !Number.isSafeInteger(input.chunks) || input.chunks < 0 || input.chunks > MAX_CHUNKS_PER_VALUE || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || input.bytes > MAX_STAGE_BYTES || (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0)) || (input.metadata !== undefined && (!Number.isSafeInteger(input.metadata.arrived) || input.metadata.arrived < 0))) return false;
		return this.storage.transactionSync(() => {
			const stage = this.stage(input.stage);
			if (!stage || stage.state !== "staging" || !this.authorized(stage)) return false;
			const row = this.sql.exec<Entry>("SELECT key,kind,chunks,bytes,expires_at,metadata FROM atomic_stage_entries WHERE stage=? AND key=?", input.stage, input.key).toArray()[0];
			if (input.kind === "delete") {
				if (input.chunks !== 0 || input.bytes !== 0 || this.sql.exec("SELECT idx FROM atomic_stage_chunks WHERE stage=? AND key=? LIMIT 1", input.stage, input.key).toArray().length) return false;
				if (!row) { if (stage.entries >= MAX_STAGE_ENTRIES) return false; this.sql.exec("INSERT INTO atomic_stage_entries VALUES (?,?,'delete',0,0,NULL,NULL)", input.stage, input.key); this.sql.exec("UPDATE atomic_stages SET entries=entries+1 WHERE stage=?", input.stage); }
				return !row || row.kind === "delete";
			}
			if (!row || row.kind !== "put" || row.chunks !== input.chunks || row.bytes !== input.bytes) return false;
			const stats = this.sql.exec<{ count: number; bytes: number; first: number | null; last: number | null }>("SELECT COUNT(*) AS count,COALESCE(SUM(bytes),0) AS bytes,MIN(idx) AS first,MAX(idx) AS last FROM atomic_stage_chunks WHERE stage=? AND key=?", input.stage, input.key).toArray()[0];
			if (!stats || stats.count !== input.chunks || stats.bytes !== input.bytes || stats.first !== 0 || stats.last !== input.chunks - 1) return false;
			this.sql.exec("UPDATE atomic_stage_entries SET expires_at=?,metadata=? WHERE stage=? AND key=?", input.expiresAt ?? null, input.metadata ? JSON.stringify(input.metadata) : null, input.stage, input.key);
			return true;
		});
	}
	seal(stageId: string, entries: number, bytes: number): boolean {
		if (!CAP.test(stageId) || !Number.isSafeInteger(entries) || entries < 1 || entries > MAX_STAGE_ENTRIES || !Number.isSafeInteger(bytes) || bytes < 0 || bytes > MAX_STAGE_BYTES) return false;
		return this.storage.transactionSync(() => {
			const stage = this.stage(stageId);
			if (!stage || !["staging", "sealed"].includes(stage.state) || !this.authorized(stage) || stage.entries !== entries || stage.bytes !== bytes) return false;
			const invalid = this.sql.exec("SELECT key FROM atomic_stage_entries e WHERE e.stage=? AND e.kind='put' AND ((SELECT COUNT(*) FROM atomic_stage_chunks c WHERE c.stage=e.stage AND c.key=e.key)<>e.chunks OR (SELECT COALESCE(SUM(c.bytes),0) FROM atomic_stage_chunks c WHERE c.stage=e.stage AND c.key=e.key)<>e.bytes) LIMIT 1", stageId).toArray().length;
			if (invalid) return false;
			if (stage.state === "staging") this.sql.exec("UPDATE atomic_stages SET state='sealed' WHERE stage=?", stageId);
			return true;
		});
	}
	commit(stageId: string): { ok: boolean; generation?: string; seq?: number; reason?: string } {
		if (!CAP.test(stageId)) return { ok: false, reason: "invalid" };
		return this.storage.transactionSync(() => {
			const stage = this.stage(stageId);
			if (!stage) return { ok: false, reason: "missing" };
			const existing = this.sql.exec<{ seq: number }>("SELECT seq FROM atomic_generations WHERE generation=?", stage.generation).toArray()[0];
			if (existing) return { ok: true, generation: stage.generation, seq: existing.seq };
			if (stage.state !== "sealed" || !this.authorized(stage) || (this.head()?.seq ?? 0) !== stage.parent_seq || (stage.owner === stage.attempt && this.sql.exec("SELECT operation FROM atomic_bridge_ops WHERE state='open' LIMIT 1").toArray().length)) return { ok: false, reason: "stale" };
			const seq = stage.parent_seq + 1;
			this.sql.exec("INSERT INTO atomic_generations VALUES (?,?,?,?,?,?)", seq, stage.generation, stage.parent_seq, Date.now(), stage.owner, stage.attempt);
			this.sql.exec("INSERT INTO atomic_values SELECT ?,key,kind,stage,chunks,bytes,expires_at,metadata FROM atomic_stage_entries WHERE stage=?", seq, stageId);
			this.sql.exec("UPDATE atomic_control SET generation=?,seq=? WHERE singleton=1", stage.generation, seq);
			this.sql.exec("UPDATE atomic_stages SET state='committed' WHERE stage=?", stageId);
			if (stage.owner !== stage.attempt) this.sql.exec("UPDATE job_authority_steps SET state='complete',deadline=NULL,result_key=? WHERE owner=? AND step='final' AND attempt=? AND state='running'", `atomic:${stage.generation}`, stage.owner, stage.attempt);
			return { ok: true, generation: stage.generation, seq };
		});
	}
	pin(pin: string, requested?: number): { pin: string; head: AtomicHead; expiresAt: number } | null {
		if (!CAP.test(pin) || (requested !== undefined && (!Number.isSafeInteger(requested) || requested < 1))) return null;
		return this.storage.transactionSync(() => {
			const now = Date.now();
			const prior = this.sql.exec<{ seq: number; expires_at: number }>("SELECT seq,expires_at FROM atomic_pins WHERE pin=?", pin).toArray()[0];
			const head = this.head();
			if (!head) return null;
			const seq = prior?.seq ?? requested ?? head.seq;
			const generation = this.sql.exec<{ generation: string }>("SELECT generation FROM atomic_generations WHERE seq=?", seq).toArray()[0]?.generation;
			if (!generation || (prior && prior.expires_at <= now)) return null;
			const expiresAt = now + PIN_MS;
			this.sql.exec("INSERT OR REPLACE INTO atomic_pins VALUES (?,?,?)", pin, seq, expiresAt);
			return { pin, head: { generation, seq }, expiresAt };
		});
	}
	read(seq: number, key: string): { kind: "missing" | "delete" } | { kind: "value"; chunks: { data: Uint8Array; hash: string; bytes: number }[]; metadata: string | null; expiresAt: number | null } {
		if (!Number.isSafeInteger(seq) || seq < 1 || !KEY.test(key)) return { kind: "missing" };
		return this.storage.transactionSync(() => {
			const row = this.sql.exec<{ kind: string; stage: string; chunks: number; expires_at: number | null; metadata: string | null }>("SELECT kind,stage,chunks,expires_at,metadata FROM atomic_values WHERE key=? AND seq<=? ORDER BY seq DESC LIMIT 1", key, seq).toArray()[0];
			if (!row || (row.expires_at !== null && row.expires_at <= Date.now())) return { kind: "missing" };
			if (row.kind === "delete") return { kind: "delete" };
			const parts = this.sql.exec<{ idx: number; data: ArrayBuffer; hash: string; bytes: number }>("SELECT idx,data,hash,bytes FROM atomic_stage_chunks WHERE stage=? AND key=? ORDER BY idx", row.stage, key).toArray();
			if (parts.length !== row.chunks || parts.some((part, i) => part.idx !== i)) throw new Error("Corrupt committed generation");
			return { kind: "value", chunks: parts.map((part) => ({ data: new Uint8Array(part.data), hash: part.hash, bytes: part.bytes })), metadata: row.metadata, expiresAt: row.expires_at };
		});
	}
	async mutate(input: { operation: string; generation: string; key: string; kind: "put" | "delete"; data?: string; expiresAt?: number; metadata?: { arrived: number } }): Promise<{ ok: boolean; seq?: number }> {
		if (![input.operation, input.generation].every((value) => typeof value === "string" && CAP.test(value)) || !KEY.test(input.key) || !["put", "delete"].includes(input.kind) || (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt < 0)) || (input.metadata !== undefined && (!Number.isSafeInteger(input.metadata.arrived) || input.metadata.arrived < 0))) return { ok: false };
		let bytes = new Uint8Array();
		if (input.kind === "put") {
			if (typeof input.data !== "string") return { ok: false };
			try { bytes = unb64(input.data); } catch { return { ok: false }; }
			if (bytes.length > MAX_CHUNK_BYTES) return { ok: false };
		}
		const digest = input.kind === "put" ? await sha(bytes) : "";
		return this.storage.transactionSync(() => {
			const prior = this.sql.exec<{ seq: number }>("SELECT seq FROM atomic_generations WHERE generation=?", input.generation).toArray()[0];
			if (prior) return { ok: true, seq: prior.seq };
			const head = this.head(); if (!head) return { ok: false };
			const seq = head.seq + 1;
			this.sql.exec("INSERT INTO atomic_stages VALUES (?,?,?,?,?,'committed',1,?,?)", input.operation, input.operation, input.operation, input.generation, head.seq, bytes.length, Date.now());
			this.sql.exec("INSERT INTO atomic_stage_entries VALUES (?,?,?,?,?,?,?,?)", input.operation, input.key, input.kind, input.kind === "put" ? 1 : 0, bytes.length, input.expiresAt ?? null, input.metadata ? JSON.stringify(input.metadata) : null);
			if (input.kind === "put") this.sql.exec("INSERT INTO atomic_stage_chunks VALUES (?,?,0,?,?,?)", input.operation, input.key, digest, bytes.length, bytes.buffer);
			this.sql.exec("INSERT INTO atomic_generations VALUES (?,?,?,?,NULL,NULL)", seq, input.generation, head.seq, Date.now());
			this.sql.exec("INSERT INTO atomic_values VALUES (?,?,?,?,?,?,?,?)", seq, input.key, input.kind, input.operation, input.kind === "put" ? 1 : 0, bytes.length, input.expiresAt ?? null, input.metadata ? JSON.stringify(input.metadata) : null);
			this.sql.exec("UPDATE atomic_control SET generation=?,seq=? WHERE singleton=1", input.generation, seq);
			return { ok: true, seq };
		});
	}
	list(seq: number, prefix: string, after: string | null, limit: number): { keys: { name: string; expiration?: number; metadata?: unknown }[]; complete: boolean; cursor?: string } | null {
		if (!Number.isSafeInteger(seq) || seq < 1 || typeof prefix !== "string" || prefix.length > 256 || (after !== null && (typeof after !== "string" || after.length > 512)) || !Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) return null;
		return this.storage.transactionSync(() => {
			const rows = this.sql.exec<{ key: string; kind: string; expires_at: number | null; metadata: string | null }>("SELECT key,kind,expires_at,metadata FROM (SELECT key,kind,expires_at,metadata,ROW_NUMBER() OVER (PARTITION BY key ORDER BY seq DESC) AS rank FROM atomic_values WHERE seq<=? AND key>=? AND key<?) WHERE rank=1 AND key>? ORDER BY key LIMIT ?", seq, prefix, `${prefix}\uffff`, after ?? "", limit + 1).toArray();
			const now = Date.now(), page = rows.slice(0, limit), visible = page.filter((row) => row.kind === "put" && (row.expires_at === null || row.expires_at > now));
			const complete = rows.length <= limit;
			return { keys: visible.map((row) => ({ name: row.key, ...(row.expires_at === null ? {} : { expiration: Math.floor(row.expires_at / 1000) }), ...(row.metadata ? { metadata: JSON.parse(row.metadata) } : {}) })), complete, ...(!complete && page.length ? { cursor: page[page.length - 1]!.key } : {}) };
		});
	}
	barrierBegin(operation: string, generation: string, kind: string): { ok: boolean; seq?: number } {
		if (!CAP.test(operation) || !CAP.test(generation) || !/^(?:account|migration)$/.test(kind)) return { ok: false };
		return this.storage.transactionSync(() => {
			const prior = this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM atomic_barriers WHERE operation=?", operation).toArray()[0];
			if (prior) return { ok: true, seq: this.head()?.seq };
			const head = this.head(); if (!head) return { ok: false };
			const seq = head.seq + 1;
			this.sql.exec("INSERT INTO atomic_generations VALUES (?,?,?,?,NULL,NULL)", seq, generation, head.seq, Date.now());
			this.sql.exec("INSERT INTO atomic_barriers VALUES (?,?,?)", operation, kind, Date.now() + 5 * 60_000);
			this.sql.exec("UPDATE atomic_control SET generation=?,seq=? WHERE singleton=1", generation, seq);
			return { ok: true, seq };
		});
	}
	barrierEnd(operation: string, generation: string): { ok: boolean; seq?: number } {
		if (!CAP.test(operation) || !CAP.test(generation)) return { ok: false };
		return this.storage.transactionSync(() => {
			if (!this.sql.exec("SELECT operation FROM atomic_barriers WHERE operation=?", operation).toArray().length) return { ok: true, seq: this.head()?.seq };
			const head = this.head(); if (!head) return { ok: false };
			const seq = head.seq + 1;
			this.sql.exec("INSERT INTO atomic_generations VALUES (?,?,?,?,NULL,NULL)", seq, generation, head.seq, Date.now());
			this.sql.exec("DELETE FROM atomic_barriers WHERE operation=?", operation);
			this.sql.exec("UPDATE atomic_control SET generation=?,seq=? WHERE singleton=1", generation, seq);
			return { ok: true, seq };
		});
	}
	bridgeBegin(operation: string, kind: string): boolean {
		if (!CAP.test(operation) || !/^(?:web|job|scheduled)$/.test(kind)) return false;
		return this.storage.transactionSync(() => {
			if (this.head() || this.sql.exec("SELECT stage FROM atomic_stages WHERE owner=attempt AND state IN ('staging','sealed') LIMIT 1").toArray().length) return false;
			const prior = this.sql.exec<{ kind: string; state: string }>("SELECT kind,state FROM atomic_bridge_ops WHERE operation=?", operation).toArray()[0];
			if (prior) return prior.kind === kind && prior.state === "open";
			this.sql.exec("INSERT INTO atomic_bridge_ops VALUES (?,?,'open',?,NULL)", operation, kind, Date.now());
			return true;
		});
	}
	bridgeEnd(operation: string): boolean {
		if (!CAP.test(operation)) return false;
		return this.storage.transactionSync(() => this.sql.exec("UPDATE atomic_bridge_ops SET state='closed',finished_at=? WHERE operation=? AND state IN ('open','closed') RETURNING operation", Date.now(), operation).toArray().length === 1);
	}
	cleanup(limit = 16): boolean {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32) return false;
		return this.storage.transactionSync(() => {
			const now = Date.now();
			this.sql.exec("DELETE FROM atomic_pins WHERE pin IN (SELECT pin FROM atomic_pins WHERE expires_at<=? LIMIT ?)", now, limit);
			this.sql.exec("DELETE FROM atomic_barriers WHERE operation IN (SELECT operation FROM atomic_barriers WHERE expires_at<=? LIMIT ?)", now, limit);
			this.sql.exec("DELETE FROM atomic_bridge_ops WHERE operation IN (SELECT operation FROM atomic_bridge_ops WHERE state='closed' AND finished_at<? LIMIT ?)", now - 24 * 60 * 60_000, limit);
			this.sql.exec("DELETE FROM atomic_stage_chunks WHERE rowid IN (SELECT c.rowid FROM atomic_stage_chunks c JOIN atomic_values v ON v.stage=c.stage AND v.key=c.key WHERE v.expires_at IS NOT NULL AND v.expires_at<=? LIMIT ?)", now, limit);
			const head = this.head();
			if (head) {
				const pinned = this.sql.exec<{ seq: number }>("SELECT MIN(seq) AS seq FROM atomic_pins WHERE expires_at>?", now).toArray()[0]?.seq;
				const floor = Math.min(pinned ?? head.seq, Math.max(1, head.seq - 128));
				this.sql.exec("DELETE FROM atomic_values WHERE rowid IN (SELECT old.rowid FROM atomic_values old WHERE old.seq<? AND EXISTS (SELECT 1 FROM atomic_values newer WHERE newer.key=old.key AND newer.seq>old.seq AND newer.seq<=?) LIMIT ?)", floor, floor, limit);
				this.sql.exec("DELETE FROM atomic_generations WHERE seq IN (SELECT seq FROM atomic_generations WHERE seq<? AND seq NOT IN (SELECT seq FROM atomic_pins WHERE expires_at>?) LIMIT ?)", floor, now, limit);
			}
			this.sql.exec("DELETE FROM atomic_stage_chunks WHERE rowid IN (SELECT c.rowid FROM atomic_stage_chunks c JOIN atomic_stages s ON s.stage=c.stage LEFT JOIN atomic_values v ON v.stage=c.stage AND v.key=c.key WHERE s.state='committed' AND v.stage IS NULL LIMIT ?)", limit);
			this.sql.exec("DELETE FROM atomic_stage_entries WHERE rowid IN (SELECT e.rowid FROM atomic_stage_entries e JOIN atomic_stages s ON s.stage=e.stage LEFT JOIN atomic_values v ON v.stage=e.stage AND v.key=e.key WHERE s.state='committed' AND v.stage IS NULL AND NOT EXISTS (SELECT 1 FROM atomic_stage_chunks c WHERE c.stage=e.stage AND c.key=e.key) LIMIT ?)", limit);
			this.sql.exec("DELETE FROM atomic_stages WHERE stage IN (SELECT s.stage FROM atomic_stages s WHERE s.state='committed' AND NOT EXISTS (SELECT 1 FROM atomic_stage_entries e WHERE e.stage=s.stage) AND NOT EXISTS (SELECT 1 FROM atomic_stage_chunks c WHERE c.stage=s.stage) LIMIT ?)", limit);
			const abandonedBefore = now - 24 * 60 * 60_000;
			this.sql.exec("DELETE FROM atomic_stage_chunks WHERE rowid IN (SELECT c.rowid FROM atomic_stage_chunks c JOIN atomic_stages s ON s.stage=c.stage WHERE s.state<>'committed' AND s.created_at<? LIMIT ?)", abandonedBefore, limit);
			this.sql.exec("DELETE FROM atomic_stage_entries WHERE rowid IN (SELECT e.rowid FROM atomic_stage_entries e JOIN atomic_stages s ON s.stage=e.stage WHERE s.state<>'committed' AND s.created_at<? AND NOT EXISTS (SELECT 1 FROM atomic_stage_chunks c WHERE c.stage=e.stage AND c.key=e.key) LIMIT ?)", abandonedBefore, limit);
			this.sql.exec("DELETE FROM atomic_stages WHERE stage IN (SELECT s.stage FROM atomic_stages s WHERE s.state<>'committed' AND s.created_at<? AND NOT EXISTS (SELECT 1 FROM atomic_stage_entries e WHERE e.stage=s.stage) LIMIT ?)", abandonedBefore, limit);
			return !!this.sql.exec("SELECT 1 AS pending FROM atomic_pins WHERE expires_at<=? UNION ALL SELECT 1 FROM atomic_barriers WHERE expires_at<=? UNION ALL SELECT 1 FROM atomic_stages WHERE state<>'committed' AND created_at<? LIMIT 1", now, now, abandonedBefore).toArray().length;
		});
	}
}

export class AtomicGenerationClient {
	private readonly stub: DurableObjectStub;
	constructor(namespace: DurableObjectNamespace, private readonly onRequest?: () => void) { this.stub = namespace.get(namespace.idFromName("owner")); }
	private async json<T>(op: string, body: unknown): Promise<T | null> {
		this.onRequest?.();
		const response = await this.stub.fetch(`https://atomic.internal/state/${op}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
		return response.ok ? response.json<T>() : null;
	}
	head() { return this.json<{ head: AtomicHead }>("head", {}); }
	begin(body: { stage: string; owner: string; attempt: string; generation: string; parentSeq: number }) { return this.json<{ ok: boolean }>("begin", body); }
	beginBootstrap(body: { stage: string; capability: string; generation: string }) { return this.json<{ ok: boolean }>("bootstrap", body); }
	chunk(body: { stage: string; key: string; index: number; total: number; data: string }) { return this.json<{ ok: boolean }>("chunk", body); }
	batch(body: { stage: string; items: ({ key: string; kind: "delete" } | { key: string; kind: "put"; data: string; expiresAt?: number; metadata?: { arrived: number } })[] }) { return this.json<{ ok: boolean }>("batch", body); }
	entry(body: { stage: string; key: string; kind: "put" | "delete"; chunks: number; bytes: number; expiresAt?: number; metadata?: { arrived: number } }) { return this.json<{ ok: boolean }>("entry", body); }
	seal(body: { stage: string; entries: number; bytes: number }) { return this.json<{ ok: boolean }>("seal", body); }
	commit(stage: string) { return this.json<{ ok: boolean; generation?: string; seq?: number; reason?: string }>("commit", { stage }); }
	mutate(body: { operation: string; generation: string; key: string; kind: "put" | "delete"; data?: string; expiresAt?: number; metadata?: { arrived: number } }) { return this.json<{ ok: boolean; seq?: number }>("mutate", body); }
	list(seq: number, prefix: string, after: string | null, limit: number) { return this.json<{ keys: { name: string; expiration?: number; metadata?: unknown }[]; complete: boolean; cursor?: string }>("list", { seq, prefix, after, limit }); }
	barrierBegin(operation: string, generation: string, kind: "account" | "migration") { return this.json<{ ok: boolean; seq?: number }>("barrier-begin", { operation, generation, kind }); }
	barrierEnd(operation: string, generation: string) { return this.json<{ ok: boolean; seq?: number }>("barrier-end", { operation, generation }); }
	bridgeBegin(operation: string, kind: "web" | "job" | "scheduled") { return this.json<{ ok: boolean }>("bridge-begin", { operation, kind }); }
	bridgeEnd(operation: string) { return this.json<{ ok: boolean }>("bridge-end", { operation }); }
	pin(pin: string, seq?: number) { return this.json<{ pin: string; head: Head; expiresAt: number }>("pin", { pin, ...(seq === undefined ? {} : { seq }) }); }
	async read(seq: number, key: string): Promise<{ value: string | null; metadata?: unknown }> {
		const result = await this.json<{ kind: string; data?: string; metadata?: string | null }>("read", { seq, key });
		if (!result || result.kind !== "value" || typeof result.data !== "string") return { value: null };
		return { value: new TextDecoder().decode(unb64(result.data)), ...(result.metadata ? { metadata: JSON.parse(result.metadata) } : {}) };
	}
	async readMany(seq: number, keys: string[]): Promise<Map<string, { value: string | null; metadata?: unknown }> | null> {
		const found = new Map<string, { value: string | null; metadata?: unknown }>();
		for (let offset = 0; offset < keys.length; offset += 100) {
			const requested = keys.slice(offset, offset + 100);
			const result = await this.json<{ items: { key: string; kind: string; data?: string; metadata?: string | null }[] }>("read-many", { seq, keys: requested });
			if (!result || !Array.isArray(result.items) || result.items.length !== requested.length) return null;
			const expected = new Set(requested);
			for (const item of result.items) {
				if (!item || typeof item.key !== "string" || !expected.delete(item.key) || !["missing", "delete", "value"].includes(item.kind)) return null;
				if (item.kind !== "value") { found.set(item.key, { value: null }); continue; }
				if (typeof item.data !== "string") return null;
				try {
					found.set(item.key, { value: new TextDecoder().decode(unb64(item.data)), ...(item.metadata ? { metadata: JSON.parse(item.metadata) } : {}) });
				} catch { return null; }
			}
			if (expected.size) return null;
		}
		return found;
	}
	async publish(input: { owner: string; attempt: string; parentSeq: number; writes: AtomicWrite[]; ttlBaseMs: number; token: () => string; heartbeat?: () => Promise<void> }): Promise<{ generation: string; seq: number }> {
		const stage = input.token(), generation = input.token();
		if (!(await this.begin({ stage, owner: input.owner, attempt: input.attempt, generation, parentSeq: input.parentSeq }))?.ok) throw new Error("Atomic publication was not admitted");
		let totalBytes = 0, batchBytes = 0;
		let batch: ({ key: string; kind: "delete" } | { key: string; kind: "put"; data: string; expiresAt?: number; metadata?: { arrived: number } })[] = [];
		let calls = 0;
		const beat = async () => { if (++calls % 24 === 0) await input.heartbeat?.(); };
		const flush = async () => { if (batch.length && !(await this.batch({ stage, items: batch }))?.ok) throw new Error("Atomic value batch staging failed"); if (batch.length) await beat(); batch = []; batchBytes = 0; };
		for (const write of input.writes) {
			if (write.kind === "delete") {
				batch.push({ key: write.key, kind: "delete" }); if (batch.length >= 24) await flush();
				continue;
			}
			const bytes = new TextEncoder().encode(write.value), expiresAt = write.expirationTtl === undefined ? undefined : input.ttlBaseMs + write.expirationTtl * 1000;
			if (bytes.length <= 32 * 1024) {
				if (batch.length >= 24 || batchBytes + bytes.length > 96 * 1024) await flush();
				batch.push({ key: write.key, kind: "put", data: b64(bytes), ...(expiresAt === undefined ? {} : { expiresAt }), ...(write.metadata ? { metadata: write.metadata } : {}) }); batchBytes += bytes.length; totalBytes += bytes.length; continue;
			}
			await flush();
			const total = Math.max(1, Math.ceil(bytes.length / MAX_CHUNK_BYTES));
			for (let index = 0; index < total; index++) {
				const part = bytes.slice(index * MAX_CHUNK_BYTES, Math.min(bytes.length, (index + 1) * MAX_CHUNK_BYTES));
				if (!(await this.chunk({ stage, key: write.key, index, total, data: b64(part) }))?.ok) throw new Error("Atomic value staging failed");
				await beat();
			}
			totalBytes += bytes.length;
			if (!(await this.entry({ stage, key: write.key, kind: "put", chunks: total, bytes: bytes.length, ...(expiresAt === undefined ? {} : { expiresAt }), ...(write.metadata ? { metadata: write.metadata } : {}) }))?.ok) throw new Error("Atomic value sealing failed");
		}
		await flush();
		if (!(await this.seal({ stage, entries: input.writes.length, bytes: totalBytes }))?.ok) throw new Error("Atomic publication sealing failed");
		const committed = await this.commit(stage);
		if (!committed?.ok || !committed.generation || committed.seq === undefined) throw new Error(`Atomic publication failed: ${committed?.reason ?? "unavailable"}`);
		return { generation: committed.generation, seq: committed.seq };
	}
	async bootstrap(input: { writes: AtomicWrite[]; ttlBaseMs: number; token: () => string }): Promise<{ generation: string; seq: number }> {
		const stage = input.token(), capability = input.token(), generation = input.token();
		if (!(await this.beginBootstrap({ stage, capability, generation }))?.ok) throw new Error("Atomic baseline already exists or publication is busy");
		let totalBytes = 0, batchBytes = 0;
		let batch: ({ key: string; kind: "delete" } | { key: string; kind: "put"; data: string; expiresAt?: number; metadata?: { arrived: number } })[] = [];
		const flush = async () => { if (batch.length && !(await this.batch({ stage, items: batch }))?.ok) throw new Error("Atomic baseline batch failed"); batch = []; batchBytes = 0; };
		for (const write of input.writes) {
			if (write.kind === "delete") {
				batch.push({ key: write.key, kind: "delete" }); if (batch.length >= 24) await flush();
				continue;
			}
			const bytes = new TextEncoder().encode(write.value), expiresAt = write.expirationTtl === undefined ? undefined : input.ttlBaseMs + write.expirationTtl * 1000;
			if (bytes.length <= 32 * 1024) {
				if (batch.length >= 24 || batchBytes + bytes.length > 96 * 1024) await flush();
				batch.push({ key: write.key, kind: "put", data: b64(bytes), ...(expiresAt === undefined ? {} : { expiresAt }), ...(write.metadata ? { metadata: write.metadata } : {}) }); batchBytes += bytes.length; totalBytes += bytes.length; continue;
			}
			await flush();
			const total = Math.max(1, Math.ceil(bytes.length / MAX_CHUNK_BYTES));
			for (let index = 0; index < total; index++) {
				const part = bytes.slice(index * MAX_CHUNK_BYTES, Math.min(bytes.length, (index + 1) * MAX_CHUNK_BYTES));
				if (!(await this.chunk({ stage, key: write.key, index, total, data: b64(part) }))?.ok) throw new Error("Atomic baseline staging failed");
			}
			totalBytes += bytes.length;
			if (!(await this.entry({ stage, key: write.key, kind: "put", chunks: total, bytes: bytes.length, ...(expiresAt === undefined ? {} : { expiresAt }), ...(write.metadata ? { metadata: write.metadata } : {}) }))?.ok) throw new Error("Atomic baseline value failed");
		}
		await flush();
		if (!(await this.seal({ stage, entries: input.writes.length, bytes: totalBytes }))?.ok) throw new Error("Atomic baseline sealing failed");
		const committed = await this.commit(stage);
		if (!committed?.ok || !committed.generation || committed.seq === undefined) throw new Error(`Atomic baseline commit failed: ${committed?.reason ?? "unavailable"}`);
		return { generation: committed.generation, seq: committed.seq };
	}
}
