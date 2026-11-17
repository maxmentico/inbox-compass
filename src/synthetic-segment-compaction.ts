// Internal synthetic coordinator storage. Only certified, immutable segmented generations may be indexed.
const PAGE = 16;
const ID = /^[A-Za-z0-9_-]{22,128}$/;
const PIN_MS = 5 * 60_000;
type Checkpoint = { cursor_scope: string; after_key: string; revision: number; complete: number; captured_at: number; depth: number };
type Progress = { revision: number; complete: boolean };
type KeySource = { key: string; source: string | null; tombstone_expiry: number | null };
/** Must verify every reference outside this store, including pending export, proof and retention jobs. */
export type CollectionProof = (sql: SqlStorage, currentHead: string, candidate: string) => boolean;

export class SegmentCompaction {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS seg_flat (head TEXT PRIMARY KEY, cursor_scope TEXT NOT NULL, after_key TEXT NOT NULL, revision INTEGER NOT NULL, complete INTEGER NOT NULL, captured_at INTEGER NOT NULL, depth INTEGER NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS seg_flat_keys (head TEXT NOT NULL, key TEXT NOT NULL, source TEXT, tombstone_expiry INTEGER, PRIMARY KEY(head,key))");
    if (!this.sql.exec<{name:string}>("PRAGMA table_info(seg_flat_keys)").toArray().some(c=>c.name==="tombstone_expiry")) {
      // Existing null references may encode either a delete or expired put. -1 explicitly requires repair.
      this.sql.exec("ALTER TABLE seg_flat_keys ADD COLUMN tombstone_expiry INTEGER DEFAULT -1");
    }
    this.sql.exec("CREATE INDEX IF NOT EXISTS seg_flat_sources ON seg_flat_keys(head,source)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS seg_reader_pins (id TEXT PRIMARY KEY, head TEXT NOT NULL, expires_at INTEGER NOT NULL)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS seg_pin_expiry ON seg_reader_pins(expires_at)");
  }

  private head(): string | undefined {
    return this.sql.exec<{generation: string}>("SELECT generation FROM gen_head WHERE singleton=1").toArray()[0]?.generation;
  }

  complete(head: string): boolean {
    return this.sql.exec<{complete: number}>("SELECT complete FROM seg_flat WHERE head=?", head).toArray()[0]?.complete === 1;
  }

  /** Use only after complete() in the same synchronous transaction. Null includes missing keys and tombstones. */
  source(head: string, key: string): string | null {
    return this.sql.exec<KeySource>("SELECT source FROM seg_flat_keys WHERE head=? AND key=?", head, key).toArray()[0]?.source ?? null;
  }

  /** Each call processes at most 16 keys from one immutable ancestor. The last page publishes only the covering index. */
  step(head: string, expectedRevision: number): Progress | null {
    if (typeof head !== "string" || !ID.test(head) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return null;
    return this.storage.transactionSync(() => {
      if (this.head() !== head) return null;
      if (!this.sql.exec("SELECT scope FROM sgen_committed WHERE scope=?", head).toArray().length) return null;
      if (expectedRevision === 0) this.sql.exec("INSERT OR IGNORE INTO seg_flat VALUES (?,?,'',0,0,?,1)", head, head, Date.now());
      const row = this.sql.exec<Checkpoint>("SELECT * FROM seg_flat WHERE head=?", head).toArray()[0];
      if (!row || expectedRevision > row.revision) return null;
      if (row.complete || expectedRevision < row.revision) return { revision: row.revision, complete: !!row.complete };
      const older = this.sql.exec<{previous: string | null}>("SELECT previous FROM sgen_committed WHERE scope=?", row.cursor_scope).toArray()[0];
      if (!older || row.depth > 16) throw new Error("Invalid segmented ancestry");
      const covered = row.cursor_scope !== head && this.complete(row.cursor_scope);
      // First occurrence wins. An expired write still masks an earlier put of the same key.
      const keys = covered
        ? this.sql.exec<KeySource>("SELECT key,source,tombstone_expiry FROM seg_flat_keys WHERE head=? AND key>? ORDER BY key LIMIT ?", row.cursor_scope, row.after_key, PAGE + 1).toArray()
        : this.sql.exec<KeySource>("SELECT key,CASE WHEN kind='put' AND (expires_at IS NULL OR expires_at>?) THEN scope END AS source, CASE WHEN kind='put' AND expires_at<=? THEN expires_at END AS tombstone_expiry FROM sgen_index WHERE scope=? AND key>? ORDER BY key LIMIT ?", row.captured_at, row.captured_at, row.cursor_scope, row.after_key, PAGE + 1).toArray();
      const page = keys.slice(0, PAGE);
      for (const item of page) {
        if (covered && item.source !== null) {
          const op = this.sql.exec<{expires_at: number | null}>("SELECT expires_at FROM sgen_index WHERE scope=? AND key=?", item.source, item.key).toArray()[0];
          if (!op) throw new Error("Missing compacted value");
          if (op.expires_at !== null && op.expires_at <= row.captured_at) {
            item.source = null;
            item.tombstone_expiry = op.expires_at;
          }
        }
        this.sql.exec("INSERT OR IGNORE INTO seg_flat_keys (head,key,source,tombstone_expiry) VALUES (?,?,?,?)", head, item.key, item.source, item.source === null ? item.tombstone_expiry : null);
      }
      const moreKeys = keys.length > PAGE;
      const nextScope = moreKeys || covered ? row.cursor_scope : older.previous;
      // A proved source inventory must distinguish deletion/expiry from a key that never existed.
      const complete = !moreKeys && (covered || nextScope === null);
      this.sql.exec("UPDATE seg_flat SET cursor_scope=?,after_key=?,revision=revision+1,complete=?,depth=? WHERE head=?",
        nextScope ?? row.cursor_scope, moreKeys ? page[PAGE - 1]!.key : "", complete ? 1 : 0, nextScope && nextScope !== row.cursor_scope ? row.depth + 1 : row.depth, head);
      return { revision: row.revision + 1, complete };
    });
  }

  /** The caller may complete a read from this immutable generation after the current head moves. */
  pin(head: string): string | null {
    return this.storage.transactionSync(() => {
      if (this.head() !== head || !this.sql.exec("SELECT scope FROM sgen_committed WHERE scope=?", head).toArray().length) return null;
      const now = Date.now();
      this.sql.exec("DELETE FROM seg_reader_pins WHERE expires_at<=?", now);
      if (this.sql.exec<{n: number}>("SELECT COUNT(*) AS n FROM seg_reader_pins").toArray()[0]!.n >= 32) return null;
      const pin = crypto.randomUUID();
      this.sql.exec("INSERT INTO seg_reader_pins VALUES (?,?,?)", pin, head, now + PIN_MS);
      return pin;
    });
  }

  pinned(head: string | null, pin: string): boolean {
    return typeof pin === "string" && ID.test(pin) && !!head && this.sql.exec("SELECT id FROM seg_reader_pins WHERE id=? AND head=? AND expires_at>?", pin, head, Date.now()).toArray().length === 1;
  }

  release(pin: string): void {
    if (typeof pin === "string" && ID.test(pin)) this.sql.exec("DELETE FROM seg_reader_pins WHERE id=?", pin);
  }

  /** A new complete index supersedes old lookup metadata even when its underlying values are still live. */
  discardIndex(head: string, old: string, proof?: CollectionProof): "blocked" | "progress" | "done" {
    if (!proof || head === old || !ID.test(head) || !ID.test(old)) return "blocked";
    return this.storage.transactionSync(() => {
      if (this.head() !== head || !this.complete(head) ||
        this.sql.exec("SELECT id FROM seg_reader_pins WHERE expires_at>? LIMIT 1", Date.now()).toArray().length ||
        proof(this.sql, head, old) !== true) return "blocked";
      this.sql.exec("DELETE FROM seg_flat WHERE head=?", old);
      const oldKeys = this.sql.exec<{key: string}>("SELECT key FROM seg_flat_keys WHERE head=? LIMIT ?", old, PAGE).toArray();
      for (const row of oldKeys) this.sql.exec("DELETE FROM seg_flat_keys WHERE head=? AND key=?", old, row.key);
      return oldKeys.length === PAGE ? "progress" : "done";
    });
  }

  /** Delete ≤16 rows in one indexed table. The caller retries until done. Preserve scope identities permanently. */
  collect(head: string, scope: string, proof?: CollectionProof): "blocked" | "progress" | "done" {
    if (!proof || head === scope || !ID.test(scope) || !ID.test(head)) return "blocked";
    return this.storage.transactionSync(() => {
      if (this.head() !== head || !this.complete(head)) return "blocked";
      if (!this.sql.exec("SELECT scope FROM sgen_committed WHERE scope=?", scope).toArray().length) return "blocked";
      if (this.sql.exec("SELECT id FROM seg_reader_pins WHERE expires_at>? LIMIT 1", Date.now()).toArray().length) return "blocked";
      if (this.sql.exec("SELECT key FROM seg_flat_keys WHERE head=? AND source=? LIMIT 1", head, scope).toArray().length) return "blocked";
      if (proof(this.sql, head, scope) !== true) return "blocked";
      this.sql.exec("DELETE FROM seg_flat WHERE head=?", scope);
      // A future head extends this covering index. No new head can introduce a reference to a retired scope.
      const parts = this.sql.exec<{idx: number; bytes: number}>("SELECT idx,bytes FROM seg_parts WHERE scope=? ORDER BY idx LIMIT ?", scope, PAGE).toArray();
      if (parts.length) {
        const freed = parts.reduce((sum, part) => sum + part.bytes, 0);
        const budget = this.sql.exec<{job: string; stored: number; reserved: number}>("SELECT o.job,o.bytes AS stored,b.bytes AS reserved FROM seg_outputs o JOIN seg_budget b ON b.job=o.job WHERE o.scope=?", scope).toArray()[0];
        if (!budget || budget.stored < freed || budget.reserved < freed) throw new Error("Inconsistent retention budget");
        for (const part of parts) this.sql.exec("DELETE FROM seg_parts WHERE scope=? AND idx=?", scope, part.idx);
        this.sql.exec("UPDATE seg_budget SET bytes=bytes-? WHERE job=?", freed, budget.job);
        this.sql.exec("UPDATE seg_outputs SET bytes=bytes-?,state='retired' WHERE scope=?", freed, scope);
        return "progress";
      }
      for (const [table, column] of [["sgen_index", "scope"], ["sgen_pages", "scope"], ["seg_flat_keys", "head"]] as const) {
        const rows = this.sql.exec<{id: number}>(`SELECT rowid AS id FROM ${table} WHERE ${column}=? LIMIT ?`, scope, PAGE).toArray();
        if (!rows.length) continue;
        for (const row of rows) this.sql.exec(`DELETE FROM ${table} WHERE rowid=?`, row.id);
        return "progress";
      }
      return "done";
    });
  }
}
