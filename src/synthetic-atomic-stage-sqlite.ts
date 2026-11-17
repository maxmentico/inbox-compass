// SYNTHETIC ONLY. No production binding, retention policy, source proof, final domain verification,
// lease authority integration or publication. A complete cursor is a producer checkpoint, not proof.
import { STAGE_PAGE_LIMITS, type AtomicStageStorage, type StageCursor, type StageTransaction, type StagedPage } from "./atomic-stage-page";

const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const b64 = (bytes: Uint8Array) => {
	let raw = "";
	for (let i = 0; i < bytes.length; i += 8192) raw += String.fromCharCode(...bytes.subarray(i, i + 8192));
	return btoa(raw);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Adapter for an isolated SQLite Durable Object. The owner controls initialization and access. */
export class SyntheticAtomicStageSqlite implements AtomicStageStorage {
	private readonly sql: SqlStorage;
	constructor(private readonly storage: DurableObjectStorage) {
		this.sql = storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_stage_cursor (scope TEXT PRIMARY KEY, source_id TEXT NOT NULL, generation INTEGER NOT NULL, attempt TEXT NOT NULL, expires_at INTEGER NOT NULL, next_page INTEGER NOT NULL, next_sequence INTEGER NOT NULL, total_records INTEGER NOT NULL, complete INTEGER NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_stage_page (scope TEXT NOT NULL, page INTEGER NOT NULL, digest TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY (scope, page))");
	}

	/** Create once only; does not prove that a caller owns the job or the source snapshot. */
	initialize(cursor: StageCursor): boolean {
		if (!TOKEN.test(cursor.scope) || !HASH.test(cursor.sourceId) || !TOKEN.test(cursor.attempt) || !Number.isSafeInteger(cursor.generation) || cursor.generation < 1 || !Number.isSafeInteger(cursor.expiresAt) || cursor.expiresAt <= Date.now() || cursor.nextPage !== 0 || cursor.nextSequence !== 0 || cursor.complete !== false || !Number.isSafeInteger(cursor.totalRecords) || cursor.totalRecords < 0 || cursor.totalRecords > STAGE_PAGE_LIMITS.records) return false;
		return this.storage.transactionSync(() => {
			if (this.sql.exec("SELECT scope FROM synthetic_stage_cursor WHERE scope = ?", cursor.scope).toArray().length) return false;
			this.sql.exec("INSERT INTO synthetic_stage_cursor VALUES (?, ?, ?, ?, ?, 0, 0, ?, 0)", cursor.scope, cursor.sourceId, cursor.generation, cursor.attempt, cursor.expiresAt, cursor.totalRecords);
			return true;
		});
	}

	transactionSync<T>(work: (tx: StageTransaction) => T): T {
		return this.storage.transactionSync(() => work({
			readCursor: (scope) => {
				const row = this.sql.exec<{ scope: string; source_id: string; generation: number; attempt: string; expires_at: number; next_page: number; next_sequence: number; total_records: number; complete: number }>("SELECT * FROM synthetic_stage_cursor WHERE scope = ?", scope).toArray()[0];
				return row ? { scope: row.scope, sourceId: row.source_id, generation: row.generation, attempt: row.attempt, expiresAt: row.expires_at, nextPage: row.next_page, nextSequence: row.next_sequence, totalRecords: row.total_records, complete: row.complete === 1 } : null;
			},
			readPage: (scope, page) => {
				const row = this.sql.exec<{ digest: string; payload: string }>("SELECT digest, payload FROM synthetic_stage_page WHERE scope = ? AND page = ?", scope, page).toArray()[0];
				return row ? { digest: row.digest, bytes: unb64(row.payload) } : null;
			},
			writePage: (scope, page, value: StagedPage) => { this.sql.exec("INSERT INTO synthetic_stage_page VALUES (?, ?, ?, ?)", scope, page, value.digest, b64(value.bytes)); },
			writeCursor: (scope, value) => { this.sql.exec("UPDATE synthetic_stage_cursor SET next_page = ?, next_sequence = ?, complete = ? WHERE scope = ?", value.nextPage, value.nextSequence, value.complete ? 1 : 0, scope); },
		}));
	}
}
