// SYNTHETIC ONLY: no production binding, no output semantic verification or publication.
// Staging validates a sealed source and same-SQL job/account revisions; it does NOT prove the
// staged output was actually derived from that source. A separate independent verifier is required.
import { type AtomicStageStorage, type StageTransaction, type StageCursor, STAGE_PAGE_LIMITS } from "./atomic-stage-page";
import { SyntheticAtomicStageSqlite } from "./synthetic-atomic-stage-sqlite";

const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const HASH = /^[a-f0-9]{64}$/;
type Binding = { scope: string; job: string; generation: string; attempt: string; source_id: string; versions: string };
/** Independent trusted same-transaction proof that this sealed snapshot belongs to these revisions. */
export type SyntheticSourceAuthority = (sql: SqlStorage, job: string, generation: string, sourceId: string, versions: string) => boolean;

/** Isolated adapter sharing one SQLite database with the synthetic core, gate and snapshot store. */
export class SyntheticJobBoundStage implements AtomicStageStorage {
	private readonly sql: SqlStorage;
	private readonly pages: SyntheticAtomicStageSqlite;
	constructor(private readonly storage: DurableObjectStorage, private readonly sourceAuthority?: SyntheticSourceAuthority, private readonly sourceKind: 'snapshot' | 'coordinator' = 'snapshot') {
		this.sql = storage.sql;
		this.pages = new SyntheticAtomicStageSqlite(storage);
		this.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_job_stage_binding (scope TEXT PRIMARY KEY, job TEXT NOT NULL, generation TEXT NOT NULL, attempt TEXT NOT NULL, source_id TEXT NOT NULL, versions TEXT NOT NULL)");
	}

	/** Runs only within the caller's SQLite transaction. */
	private capture(job: string, generation: string, attempt: string, sourceId: string): { versions: string; expiresAt: number } | null {
		const now = Date.now();
		const active = this.sql.exec<{ expires: number; deadline: number }>("SELECT j.expires, f.deadline FROM core_jobs j JOIN core_active a ON a.singleton=1 AND a.job=j.job JOIN core_final f ON f.job=j.job WHERE j.job=? AND j.generation=? AND j.state='running' AND f.token=?", job, generation, attempt).toArray()[0];
		const lease = this.sql.exec<{ expires_at: number }>("SELECT expires_at FROM lease WHERE id=1 AND owner=?", generation).toArray()[0];
		const snapshot = this.sourceKind === 'snapshot' ? this.sql.exec<{ sealed: number }>("SELECT sealed FROM synthetic_snapshots WHERE id=? AND owner=?", sourceId, generation).toArray()[0] : null;
		const binding = this.sql.exec<{ generation: string }>("SELECT generation FROM domain_job_bindings WHERE job=?", job).toArray()[0];
		if (!active || active.expires <= now || active.deadline <= now || !lease || lease.expires_at <= now || (this.sourceKind === 'snapshot' && (!snapshot || snapshot.sealed !== 1)) || binding?.generation !== generation) return null;
		const rows = this.sql.exec<{ alias: string; identity: string; state: string }>("SELECT alias,identity,state FROM core_steps WHERE job=? ORDER BY alias", job).toArray();
		const versions: { key: string; value: number }[] = [];
		for (const row of rows) {
			if (row.state !== "done" && row.state !== "failed") return null;
			const original = this.sql.exec<{ identity: string; epoch: number }>("SELECT identity,epoch FROM domain_job_accounts WHERE job=? AND alias=?", job, row.alias).toArray()[0];
			const current = this.sql.exec<{ identity: string | null; epoch: number }>("SELECT identity,epoch FROM domain_accounts WHERE alias=?", row.alias).toArray()[0];
			if (!original || !current || original.identity !== row.identity || current.identity !== row.identity || original.epoch !== current.epoch) return null;
			versions.push({ key: `account:${row.alias}`, value: current.epoch });
		}
		for (const key of ["settings", "done"]) {
			const row = this.sql.exec<{ version: number }>("SELECT version FROM gen_versions WHERE key=?", key).toArray()[0];
			if (!row || !Number.isSafeInteger(row.version) || row.version < 0) return null;
			versions.push({ key, value: row.version });
		}
		return { versions: JSON.stringify(versions), expiresAt: Math.min(active.expires, active.deadline, lease.expires_at) };
	}

	/** Initializes output and binds scope to job, finalizer, source and revisions in one transaction. */
	initialize(input: { scope: string; job: string; generation: string; attempt: string; sourceId: string; totalRecords: number }): boolean {
		if (!input || !TOKEN.test(input.scope) || !TOKEN.test(input.job) || !TOKEN.test(input.generation) || !TOKEN.test(input.attempt) || !HASH.test(input.sourceId) || !Number.isSafeInteger(input.totalRecords) || input.totalRecords < 0 || input.totalRecords > STAGE_PAGE_LIMITS.records) return false;
		return this.storage.transactionSync(() => {
			const captured = this.capture(input.job, input.generation, input.attempt, input.sourceId);
			if (!captured || !this.sourceAuthority || this.sourceAuthority(this.sql, input.job, input.generation, input.sourceId, captured.versions) !== true || this.sql.exec("SELECT token FROM core_tokens WHERE token=?", input.scope).toArray().length) return false;
			this.sql.exec("INSERT INTO core_tokens (token) VALUES (?)", input.scope);
			this.sql.exec("INSERT INTO synthetic_job_stage_binding VALUES (?, ?, ?, ?, ?, ?)", input.scope, input.job, input.generation, input.attempt, input.sourceId, captured.versions);
			this.sql.exec("INSERT INTO synthetic_stage_cursor VALUES (?, ?, 1, ?, ?, 0, 0, ?, 0)", input.scope, input.sourceId, input.attempt, captured.expiresAt, input.totalRecords);
			return true;
		});
	}

	transactionSync<T>(work: (tx: StageTransaction) => T): T {
		return this.pages.transactionSync((tx) => {
			let permitted: string | null = null;
			const requireScope = (scope: string) => { if (permitted !== scope) throw new Error("Unverified synthetic job stage"); };
			return work({
				readCursor: (scope): StageCursor | null => {
					const binding = this.sql.exec<Binding>("SELECT * FROM synthetic_job_stage_binding WHERE scope=?", scope).toArray()[0];
					if (!binding) return null;
					const captured = this.capture(binding.job, binding.generation, binding.attempt, binding.source_id);
					if (!captured || captured.versions !== binding.versions || !this.sourceAuthority || this.sourceAuthority(this.sql, binding.job, binding.generation, binding.source_id, captured.versions) !== true) return null;
					const cursor = tx.readCursor(scope);
					if (!cursor || cursor.sourceId !== binding.source_id || cursor.attempt !== binding.attempt || cursor.generation !== 1) return null;
					permitted = scope;
					return { ...cursor, expiresAt: Math.min(cursor.expiresAt, captured.expiresAt) };
				},
				readPage: (scope, page) => { requireScope(scope); return tx.readPage(scope, page); },
				writePage: (scope, page, value) => { requireScope(scope); tx.writePage(scope, page, value); },
				writeCursor: (scope, value) => { requireScope(scope); tx.writeCursor(scope, value); },
			});
		});
	}
}
