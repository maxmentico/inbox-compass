// EXPERIMENTAL: not bound or exported by the production Worker. This is not a commit fence:
// published digests and other mutable state still use KV. Staged values currently persist until
// synthetic publications expire after 24 hours. This TTL is ONLY for this synthetic prototype;
// authoritative cursors must not expire this way, and real digest retention differs. Do not put
// mail in this object until production-specific retention and atomic publication are implemented.
// Never expose this internal API publicly: lease
// and attempt tokens are returned in internal responses and must remain secret.
//
// A singleton Durable Object serializes real-run leases. SQLite statements below execute
// synchronously, so no request can interleave between the read and conditional write.
// The owner must be a fresh, unguessable token for each attempt, never a reusable job name.

import { SyntheticSnapshotStore } from "./synthetic-snapshot-store";

const LEASE_MS = 6 * 60_000;
const OWNER = /^[A-Za-z0-9_-]{22,128}$/;
const STEP = /^[A-Za-z0-9_-]{1,128}$/;
const MAX_RESULT_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_REQUEST_BYTES = MAX_RESULT_BYTES + 16 * 1024;
const MAX_STEPS = 200;
const PUBLICATION_TTL_MS = 24 * 60 * 60_000;
const CLEANUP_BATCH = 10;
const MAX_PUBLICATIONS = 3;
type Holder = { at: string; job?: string; driver?: "web" | "cron" };
type Lease = { owner: string; holder: Holder; expiresAt: number };
type ManifestEntry = { step: string; generation: number };

function validManifest(value: unknown): value is ManifestEntry[] {
	if (!Array.isArray(value) || value.length > MAX_STEPS) return false;
	const seen = new Set<string>();
	for (const entry of value) {
		if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).some((k) => k !== "step" && k !== "generation")) return false;
		if (typeof entry.step !== "string" || !STEP.test(entry.step) || seen.has(entry.step) || !Number.isSafeInteger(entry.generation) || entry.generation < 1) return false;
		seen.add(entry.step);
	}
	return true;
}

function canonicalManifest(manifest: ManifestEntry[]): string {
	return JSON.stringify(manifest.map(({ step, generation }) => ({ step, generation })).sort((a, b) => a.step < b.step ? -1 : a.step > b.step ? 1 : 0));
}

function validHolder(value: unknown): value is Holder {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const h = value as Record<string, unknown>;
	return Object.keys(h).every((k) => ["at", "job", "driver"].includes(k)) &&
		typeof h.at === "string" && h.at.length <= 40 && Number.isFinite(Date.parse(h.at)) &&
		(h.job === undefined || (typeof h.job === "string" && OWNER.test(h.job))) &&
		(h.driver === undefined || h.driver === "web" || h.driver === "cron");
}

export class RunCoordinator {
	private readonly sql: SqlStorage;
	private readonly storage: DurableObjectStorage;
	private alarmQueue: Promise<void> = Promise.resolve();
	readonly syntheticSnapshots: SyntheticSnapshotStore;

	constructor(state: DurableObjectState) {
		this.storage = state.storage;
		this.sql = state.storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS lease (id INTEGER PRIMARY KEY CHECK (id = 1), owner TEXT NOT NULL, holder TEXT NOT NULL, expires_at INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS steps (step TEXT PRIMARY KEY, owner TEXT NOT NULL, generation INTEGER NOT NULL, attempt TEXT NOT NULL, result TEXT, bytes INTEGER NOT NULL DEFAULT 0)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS owners (owner TEXT PRIMARY KEY, released INTEGER NOT NULL DEFAULT 0)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS publication_ids (id TEXT PRIMARY KEY, owner TEXT NOT NULL, manifest TEXT NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS publications (id TEXT PRIMARY KEY, manifest TEXT NOT NULL, expires_at INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS publication_chunks (id TEXT NOT NULL, step TEXT NOT NULL, generation INTEGER NOT NULL, result TEXT NOT NULL, PRIMARY KEY (id, step))");
		this.sql.exec("CREATE TABLE IF NOT EXISTS publication_head (singleton INTEGER PRIMARY KEY CHECK(singleton = 1), id TEXT NOT NULL)");
		this.syntheticSnapshots = new SyntheticSnapshotStore(this.storage, (when) => this.ensureAlarm(when));
	}

	async fetch(request: Request): Promise<Response> {
		const op = new URL(request.url).pathname.slice(1);
		if (request.method !== "POST" || !["acquire", "inspect", "renew", "release", "claim", "stage", "read", "publish", "published"].includes(op)) return new Response(null, { status: 404 });
		let body: unknown;
		try { body = await boundedJson(request); } catch (e) { return new Response(null, { status: e instanceof RangeError ? 413 : 400 }); }
		if (!body || typeof body !== "object" || Array.isArray(body)) return new Response(null, { status: 400 });
		const data = body as Record<string, unknown>;
		const keys = op === "acquire" ? ["owner", "holder"] : op === "inspect" ? [] : op === "claim" ? ["owner", "step", "attempt", "expectedGeneration"] : op === "stage" ? ["owner", "step", "attempt", "generation", "result"] : op === "read" ? ["owner", "step"] : op === "publish" ? ["owner", "id", "manifest"] : op === "published" ? ["id", "step"] : ["owner"];
		if (Object.keys(data).some((k) => !keys.includes(k)) || (!["inspect", "published"].includes(op) && (typeof data.owner !== "string" || !OWNER.test(data.owner))) || (op === "acquire" && !validHolder(data.holder))) return new Response(null, { status: 400 });
		if (["claim", "stage", "read"].includes(op) && (typeof data.step !== "string" || !STEP.test(data.step))) return new Response(null, { status: 400 });
		if (["claim", "stage"].includes(op) && (typeof data.attempt !== "string" || !OWNER.test(data.attempt))) return new Response(null, { status: 400 });
		if (op === "claim" && (!Number.isSafeInteger(data.expectedGeneration) || (data.expectedGeneration as number) < 0)) return new Response(null, { status: 400 });
		if (op === "stage" && (!Number.isSafeInteger(data.generation) || (data.generation as number) < 1 || typeof data.result !== "string" || new TextEncoder().encode(data.result).length > MAX_RESULT_BYTES)) return new Response(null, { status: 400 });
		if (op === "publish" && (typeof data.id !== "string" || !OWNER.test(data.id) || !validManifest(data.manifest))) return new Response(null, { status: 400 });
		if (op === "published" && ((data.id !== undefined && (typeof data.id !== "string" || !OWNER.test(data.id))) || (data.step !== undefined && (typeof data.step !== "string" || !STEP.test(data.step))))) return new Response(null, { status: 400 });
		// Establish a durable cleanup wakeup before accepting any synthetic content. Never
		// postpone an already earlier alarm; serialize these short storage operations per object.
		if (op === "stage") await this.ensureAlarm(Date.now() + LEASE_MS);
		if (op === "claim") await this.ensureAlarm(Date.now() + LEASE_MS);
		if (op === "publish") await this.ensureAlarm(Date.now() + PUBLICATION_TTL_MS);
		if (op === "acquire") await this.ensureAlarm(Date.now() + 1000);
		if (op === "release") await this.ensureAlarm(Date.now() + 1000);

		// transactionSync rolls back every statement together on failure. There is no I/O or
		// promise yield in the transaction; parsing is complete before the lease is checked.
		return this.storage.transactionSync(() => {
			const now = Date.now();
			const row = this.sql.exec<{ owner: string; holder: string; expires_at: number }>("SELECT owner, holder, expires_at FROM lease WHERE id = 1").toArray()[0];
			let lease: Lease | null = row && row.expires_at > now ? { owner: row.owner, holder: JSON.parse(row.holder) as Holder, expiresAt: row.expires_at } : null;
			let ok = true;
			if (op === "published") {
				const id = data.id ?? this.sql.exec<{ id: string }>("SELECT id FROM publication_head WHERE singleton = 1").toArray()[0]?.id;
				if (!id) return Response.json({ ok: false });
				const publication = this.sql.exec<{ manifest: string; expires_at: number }>("SELECT manifest, expires_at FROM publications WHERE id = ?", id as string).toArray()[0];
				if (!publication || publication.expires_at <= now) return Response.json({ ok: false });
				if (data.step !== undefined) {
					const chunk = this.sql.exec<{ generation: number; result: string }>("SELECT generation, result FROM publication_chunks WHERE id = ? AND step = ?", id as string, data.step as string).toArray()[0];
					return chunk ? Response.json({ ok: true, id, ...chunk }) : Response.json({ ok: false });
				}
				return Response.json({ ok: true, id, manifest: JSON.parse(publication.manifest), expiresAt: publication.expires_at });
			}
			if (op === "publish") {
				const id = data.id as string;
				const manifest = canonicalManifest(data.manifest as ManifestEntry[]);
				const prior = this.sql.exec<{ owner: string; manifest: string }>("SELECT owner, manifest FROM publication_ids WHERE id = ?", id).toArray()[0];
				if (prior) {
					const retained = this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM publications WHERE id = ?", id).toArray()[0];
					return Response.json({ ok: prior.owner === data.owner && prior.manifest === manifest && !!retained && retained.expires_at > now, id });
				}
				if (!lease || lease.owner !== data.owner) return Response.json({ ok: false });
				const staged = this.sql.exec<{ step: string; generation: number; result: string | null }>("SELECT step, generation, result FROM steps ORDER BY step").toArray();
				const requested = JSON.parse(manifest) as ManifestEntry[];
				if (staged.length !== requested.length || staged.some((s, i) => s.step !== requested[i]?.step || s.generation !== requested[i]?.generation || s.result === null)) return Response.json({ ok: false, reason: "incomplete" });
				// Never bulk-delete content in the publishing invocation. Expired publications
				// are removed in bounded alarm batches; backpressure prevents unbounded storage.
				const publicationCount = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publications").toArray()[0]?.count ?? 0;
				if (publicationCount >= MAX_PUBLICATIONS) return Response.json({ ok: false, reason: "capacity" });
				this.sql.exec("INSERT INTO publication_ids (id, owner, manifest) VALUES (?, ?, ?)", id, data.owner as string, manifest);
				this.sql.exec("INSERT INTO publications (id, manifest, expires_at) VALUES (?, ?, ?)", id, manifest, now + PUBLICATION_TTL_MS);
				this.sql.exec("INSERT INTO publication_chunks (id, step, generation, result) SELECT ?, step, generation, result FROM steps", id);
				this.sql.exec("INSERT OR REPLACE INTO publication_head (singleton, id) VALUES (1, ?)", id);
				return Response.json({ ok: true, id });
			}
			if (op === "acquire") {
				// A caller that lost the response may retry with its unique token. This does not
				// extend the lease or alter its holder; only an explicit renewal does that.
				if (lease) ok = lease.owner === data.owner;
				else if (this.sql.exec("SELECT owner FROM owners WHERE owner = ?", data.owner as string).toArray().length) ok = false;
				else {
					const stages = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM steps").toArray()[0]?.count ?? 0;
					const snapshots = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM synthetic_snapshots").toArray()[0]?.count ?? 0;
					if (stages || snapshots) return Response.json({ ok: false, reason: "cleanup" });
					this.sql.exec("INSERT INTO owners (owner) VALUES (?)", data.owner as string);
					lease = { owner: data.owner as string, holder: data.holder as Holder, expiresAt: now + LEASE_MS };
					this.sql.exec("INSERT OR REPLACE INTO lease (id, owner, holder, expires_at) VALUES (1, ?, ?, ?)", lease.owner, JSON.stringify(lease.holder), lease.expiresAt);
				}
			} else if (op === "renew") {
				if (!lease || lease.owner !== data.owner) ok = false;
				else {
					lease.expiresAt = now + LEASE_MS;
					this.sql.exec("UPDATE lease SET expires_at = ? WHERE id = 1", lease.expiresAt);
				}
			} else if (op === "release") {
				if (!lease || lease.owner !== data.owner) {
					const prior = this.sql.exec<{ released: number }>("SELECT released FROM owners WHERE owner = ?", data.owner as string).toArray()[0];
					ok = prior?.released === 1;
				}
				else {
					this.sql.exec("UPDATE owners SET released = 1 WHERE owner = ?", data.owner as string);
					this.sql.exec("DELETE FROM lease WHERE id = 1");
					lease = null;
				}
			} else if (["claim", "stage", "read"].includes(op)) {
				// Lease ownership fences every step operation. A step generation is an explicit
				// compare-and-swap: a delayed claim cannot supersede a newer attempt.
				if (!lease || lease.owner !== data.owner) return Response.json({ ok: false });
				const step = data.step as string;
				const current = this.sql.exec<{ owner: string; generation: number; attempt: string; result: string | null; bytes: number }>("SELECT owner, generation, attempt, result, bytes FROM steps WHERE step = ?", step).toArray()[0];
				if (op === "read") return Response.json({ ok: true, generation: current?.generation ?? 0, result: current?.result ?? null });
				if (op === "claim") {
					if (current && current.attempt === data.attempt) return Response.json({ ok: true, generation: current.generation, result: current.result });
					if (current?.result !== null && current?.result !== undefined || (current?.generation ?? 0) !== data.expectedGeneration) return Response.json({ ok: false, generation: current?.generation ?? 0 });
					const count = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM steps").toArray()[0]?.count ?? 0;
					if (!current && count >= MAX_STEPS) return Response.json({ ok: false, reason: "capacity" });
					const generation = (current?.generation ?? 0) + 1;
					this.sql.exec("INSERT OR REPLACE INTO steps (step, owner, generation, attempt, result, bytes) VALUES (?, ?, ?, ?, NULL, 0)", step, data.owner as string, generation, data.attempt as string);
					return Response.json({ ok: true, generation, result: null });
				}
				if (!current || current.owner !== data.owner || current.generation !== data.generation || current.attempt !== data.attempt) return Response.json({ ok: false });
				if (current.result !== null) return Response.json({ ok: current.result === data.result });
				const bytes = new TextEncoder().encode(data.result as string).length;
				const total = this.sql.exec<{ total: number }>("SELECT COALESCE(SUM(bytes), 0) AS total FROM steps").toArray()[0]?.total ?? 0;
				if (total + bytes > MAX_TOTAL_BYTES) return Response.json({ ok: false, reason: "capacity" });
				this.sql.exec("UPDATE steps SET result = ?, bytes = ? WHERE step = ?", data.result as string, bytes, step);
				return Response.json({ ok: true });
			}
			return Response.json({ ok, lease });
		});
	}

	private async ensureAlarm(when: number): Promise<void> {
		const schedule = this.alarmQueue.catch(() => {}).then(async () => {
			const existing = await this.storage.getAlarm();
			if (existing === null || existing > when) await this.storage.setAlarm(when);
		});
		this.alarmQueue = schedule;
		await schedule;
	}

	/** Deletes only expired synthetic state, at most CLEANUP_BATCH rows of each kind per alarm. */
	async alarm(): Promise<void> {
		const now = Date.now();
		const next = this.storage.transactionSync(() => {
			this.sql.exec("DELETE FROM lease WHERE expires_at <= ?", now);
			const active = this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM lease WHERE id = 1").toArray()[0];
			if (!active) this.sql.exec("DELETE FROM steps WHERE step IN (SELECT step FROM steps LIMIT ?)", CLEANUP_BATCH);
			if (!active) {
				this.sql.exec("DELETE FROM synthetic_fragments WHERE rowid IN (SELECT rowid FROM synthetic_fragments LIMIT ?)", CLEANUP_BATCH);
				this.sql.exec("DELETE FROM synthetic_checkpoints WHERE id IN (SELECT s.id FROM synthetic_snapshots s WHERE NOT EXISTS (SELECT 1 FROM synthetic_fragments f WHERE f.id = s.id) LIMIT ?)", CLEANUP_BATCH);
				this.sql.exec("DELETE FROM synthetic_snapshots WHERE id IN (SELECT s.id FROM synthetic_snapshots s WHERE NOT EXISTS (SELECT 1 FROM synthetic_fragments f WHERE f.id = s.id) LIMIT ?)", CLEANUP_BATCH);
			}
			this.sql.exec("DELETE FROM publication_chunks WHERE rowid IN (SELECT c.rowid FROM publication_chunks c JOIN publications p ON p.id = c.id WHERE p.expires_at <= ? LIMIT ?)", now, CLEANUP_BATCH);
			this.sql.exec("DELETE FROM publications WHERE id IN (SELECT p.id FROM publications p WHERE p.expires_at <= ? AND NOT EXISTS (SELECT 1 FROM publication_chunks c WHERE c.id = p.id) LIMIT ?)", now, CLEANUP_BATCH);
			this.sql.exec("DELETE FROM publication_head WHERE id NOT IN (SELECT id FROM publications)");
			const expired = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM publications WHERE expires_at <= ?", now).toArray()[0]?.count ?? 0;
			const stages = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM steps").toArray()[0]?.count ?? 0;
			const snapshots = this.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM synthetic_snapshots").toArray()[0]?.count ?? 0;
			if (expired || (!active && (stages || snapshots))) return now + 1000;
			const publication = this.sql.exec<{ earliest: number | null }>("SELECT MIN(expires_at) AS earliest FROM publications").toArray()[0]?.earliest;
			return Math.min(publication ?? Number.POSITIVE_INFINITY, active && (stages || snapshots) ? active.expires_at : Number.POSITIVE_INFINITY);
		});
		if (Number.isFinite(next)) await this.ensureAlarm(next);
	}
}

/** Stream and count raw bytes rather than trusting Content-Length or allocating an unbounded body. */
async function boundedJson(request: Request): Promise<unknown> {
	const reader = request.body?.getReader();
	if (!reader) throw new SyntaxError("missing body");
	const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });
	let size = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		size += value.byteLength;
		if (size > MAX_REQUEST_BYTES) {
			void reader.cancel().catch(() => {});
			throw new RangeError("request too large");
		}
		text += decoder.decode(value, { stream: true });
	}
	text += decoder.decode();
	return JSON.parse(text) as unknown;
}
