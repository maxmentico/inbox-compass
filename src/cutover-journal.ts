// Private SQLite primitive for the compatibility Worker. Every legacy mutation must register
// before writing and finish after all of its writes settle. Ungated workers are outside its scope.
const ID = /^[A-Za-z0-9_-]{22,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const operationKinds = ["job", "mailbox", "finalize", "settings", "done", "account", "index", "notification"] as const;
type Kind = typeof operationKinds[number];
type Phase = "admitted" | "writing" | "uncertain" | "applied" | "cancelled";
export type CutoverFreeze = { epoch: number; id: string; highWater: number };
type Control = { epoch: number; freeze_id: string | null; last_seq: number };
type Entry = { seq: number; epoch: number; operation: string; kind: Kind; intent: string; phase: Phase; result: string | null };
type Admission = { kind: "admitted"; seq: number } | { kind: "existing"; seq: number; phase: Phase; result: string | null } | { kind: "closed" | "conflict" };
const validEpoch = (value: number) => Number.isSafeInteger(value) && value >= 1;
const validId = (value: string) => typeof value === "string" && ID.test(value);

/** This journal proves quiescence of registered writers. It cannot certify KV completeness or promote authority. */
export class CutoverJournal {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage) {
    this.sql = storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS cutover_control (singleton INTEGER PRIMARY KEY CHECK(singleton=1), epoch INTEGER NOT NULL, freeze_id TEXT, last_seq INTEGER NOT NULL)");
    this.sql.exec("INSERT OR IGNORE INTO cutover_control VALUES (1,1,NULL,0)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS cutover_ops (seq INTEGER PRIMARY KEY, epoch INTEGER NOT NULL, operation TEXT UNIQUE NOT NULL, kind TEXT NOT NULL, intent TEXT NOT NULL, owner TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN ('admitted','writing','uncertain','applied','cancelled')), result TEXT)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS cutover_open ON cutover_ops(seq) WHERE phase IN ('admitted','writing','uncertain')");
    this.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS cutover_owner ON cutover_ops(owner)");
  }

  private control(): Control {
    const row = this.sql.exec<Control>("SELECT epoch,freeze_id,last_seq FROM cutover_control WHERE singleton=1").toArray()[0];
    if (!row || !validEpoch(row.epoch) || !Number.isSafeInteger(row.last_seq) || row.last_seq < 0) throw new Error("Invalid cutover journal control");
    return row;
  }

  status(): {epoch:number;frozen:boolean;highWater:number;outstanding:boolean} {
    return this.storage.transactionSync(() => {
      const c=this.control();
      const outstanding=this.sql.exec("SELECT seq FROM cutover_ops WHERE phase IN ('admitted','writing','uncertain') LIMIT 1").toArray().length>0;
      return {epoch:c.epoch,frozen:c.freeze_id!==null,highWater:c.last_seq,outstanding};
    });
  }

  /** A logical operation can only receive one owner. Replays never return another write permit. */
  admit(epoch: number, operation: string, owner: string, kind: Kind, intent: string): Admission {
    if (!validEpoch(epoch) || !validId(operation) || !validId(owner) || !operationKinds.includes(kind) || typeof intent !== "string" || !HASH.test(intent)) return {kind:"conflict"};
    return this.storage.transactionSync(() => {
      const old = this.sql.exec<Entry>("SELECT seq,epoch,kind,intent,phase,result FROM cutover_ops WHERE operation=?", operation).toArray()[0];
      if (old) {
        if (old.kind !== kind || old.intent !== intent || old.epoch !== epoch) return {kind:"conflict"};
        return {kind:"existing",seq:old.seq,phase:old.phase,result:old.result};
      }
      const current = this.control();
      if (current.freeze_id !== null || current.epoch !== epoch) return {kind:"closed"};
      if (this.sql.exec("SELECT seq FROM cutover_ops WHERE owner=?", owner).toArray().length) return {kind:"conflict"};
      const seq = current.last_seq + 1;
      if (!Number.isSafeInteger(seq)) throw new Error("Cutover journal exhausted");
      this.sql.exec("INSERT INTO cutover_ops VALUES (?,?,?,?,?,?,'admitted',NULL)", seq,epoch,operation,kind,intent,owner);
      this.sql.exec("UPDATE cutover_control SET last_seq=? WHERE singleton=1", seq);
      return {kind:"admitted",seq};
    });
  }

  /** Exactly one invocation may start this operation's external writes. A lost reply must be reconciled. */
  start(operation: string, owner: string): boolean {
    if (!validId(operation) || !validId(owner)) return false;
    return this.sql.exec("UPDATE cutover_ops SET phase='writing' WHERE operation=? AND owner=? AND phase='admitted' RETURNING seq",operation,owner).toArray().length === 1;
  }

  /** Cancellation is allowed only while the external write permit has never been issued. */
  cancel(operation: string, owner: string): boolean {
    if (!validId(operation) || !validId(owner)) return false;
    return this.sql.exec("UPDATE cutover_ops SET phase='cancelled' WHERE operation=? AND owner=? AND phase IN ('admitted','cancelled') RETURNING seq",operation,owner).toArray().length === 1;
  }

  /** Failure after dispatch remains outstanding, including timeouts with an unknown write outcome. */
  uncertain(operation: string, owner: string): boolean {
    if (!validId(operation) || !validId(owner)) return false;
    return this.sql.exec("UPDATE cutover_ops SET phase='uncertain' WHERE operation=? AND owner=? AND phase IN ('writing','uncertain') RETURNING seq",operation,owner).toArray().length === 1;
  }

  /** The original owner calls this after positive acknowledgement of all writes and side effects. */
  applied(operation: string, owner: string, result: string): boolean {
    if (!validId(operation) || !validId(owner) || typeof result !== "string" || !HASH.test(result)) return false;
    return this.sql.exec("UPDATE cutover_ops SET phase='applied',result=? WHERE operation=? AND owner=? AND (phase IN ('writing','uncertain') OR (phase='applied' AND result=?)) RETURNING seq",result,operation,owner,result).toArray().length === 1;
  }

  /** Freeze admission before capturing the high-water mark. Pending writers continue to block drain. */
  freeze(epoch: number, id: string): CutoverFreeze | null {
    if (!validEpoch(epoch) || !validId(id)) return null;
    return this.storage.transactionSync(() => {
      const control = this.control();
      if (control.epoch !== epoch || (control.freeze_id !== null && control.freeze_id !== id)) return null;
      if (control.freeze_id === null) this.sql.exec("UPDATE cutover_control SET freeze_id=? WHERE singleton=1",id);
      return {epoch,id,highWater:control.last_seq};
    });
  }

  private matches(f: CutoverFreeze): boolean {
    if (!f || !validId(f.id) || !validEpoch(f.epoch) || !Number.isSafeInteger(f.highWater) || f.highWater<0) return false;
    const control = this.control();
    return control.epoch === f.epoch && control.freeze_id === f.id && control.last_seq === f.highWater;
  }

  /** Same-transaction precondition for a separate verified import/promotion. All previous epochs count. */
  drainedInTransaction(sql: SqlStorage, f: CutoverFreeze): boolean {
    if (sql !== this.sql || !this.matches(f)) return false;
    return this.sql.exec("SELECT seq FROM cutover_ops WHERE phase IN ('admitted','writing','uncertain') LIMIT 1").toArray().length === 0;
  }

  /** Exposes metadata and digests only. Pages of an already-drained freeze are immutable. */
  page(f: CutoverFreeze, after: number, limit: number): { entries: Entry[]; next: number | null } | null {
    if (!Number.isSafeInteger(after) || after<0 || !Number.isSafeInteger(limit) || limit<1 || limit>64) return null;
    return this.storage.transactionSync(() => {
      if (!this.drainedInTransaction(this.sql, f) || after>f.highWater) return null;
      const entries = this.sql.exec<Entry>("SELECT seq,epoch,operation,kind,intent,phase,result FROM cutover_ops WHERE seq>? AND seq<=? ORDER BY seq LIMIT ?",after,f.highWater,limit).toArray();
      if (entries.length !== Math.min(limit,f.highWater-after) || entries.some((e,i)=>e.seq!==after+i+1)) throw new Error("Incomplete cutover journal");
      return { entries, next: after+entries.length<f.highWater ? after+entries.length : null };
    });
  }

  /** Reopen the legacy authority after aborting a rehearsal. Never reuse an admission epoch. */
  reopenLegacy(f: CutoverFreeze): number | null {
    return this.storage.transactionSync(() => {
      if (!this.drainedInTransaction(this.sql, f)) return null;
      const next = f.epoch+1;
      if (!validEpoch(next)) throw new Error("Cutover epoch exhausted");
      this.sql.exec("UPDATE cutover_control SET epoch=?,freeze_id=NULL WHERE singleton=1",next);
      return next;
    });
  }
}
