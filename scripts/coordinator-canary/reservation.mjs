// Standalone, in-memory SQLite. No network, account, persistent DB, or platform credentials.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { GenerationStore } from "../../src/generation-store.ts";
import { JobStateCore } from "../../src/job-state-core.ts";

const block = Buffer.alloc(64 * 1024, 0x31);
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const max = 8 * 1024 * 1024;

function chunks(size) {
  const refs = [];
  for (let remaining = size; remaining > 0; remaining -= block.length) {
    const piece = block.subarray(0, Math.min(block.length, remaining));
    refs.push({ hash: digest(piece), bytes: piece.length });
  }
  return refs;
}

function fixture() {
  const db = new DatabaseSync(":memory:");
  const sql = { exec(query, ...args) {
    const rows = db.prepare(query).all(...args);
    return { toArray: () => rows };
  } };
  const storage = {
    sql,
    transactionSync(run) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = run();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  let store, core;
  function reopen() {
    store = new GenerationStore(storage, (_, m) => m.changes.every(c => c.key === "digest:" + m.digest));
    core = new JobStateCore(storage, store.atomicCommit());
  }
  reopen();
  function begin(previous) {
    const job = randomUUID(), generation = randomUUID(), token = randomUUID(), digestId = "synthetic-" + job;
    assert.equal(core.create({ job, generation, driver: "web", mailboxes: [] }).ok, true);
    assert.equal(core.claimFinal(job, generation, token), true);
    function plan(size, version, expectedPreparation = null) {
      return {
        job, generation, token, digest: digestId, previous, preparation: randomUUID(), expectedPreparation,
        versions: [{ key: "done", version }], changes: [{ key: "digest:" + digestId, kind: "put", chunks: chunks(size) }],
      };
    }
    return { plan };
  }
  function rotate(m) {
    sql.exec("UPDATE core_final SET deadline=0 WHERE job=?", m.job);
    const token = randomUUID();
    assert.equal(core.claimFinal(m.job, m.generation, token), true);
    return token;
  }
  function edit(version) { sql.exec("INSERT OR REPLACE INTO gen_versions (key,version) VALUES ('done',?)", version); }
  function stage(m, index) {
    const change = m.changes[0];
    return store.stage(m.job, m.generation, m.token, m.preparation, change.key, index, block.subarray(0, change.chunks[index].bytes));
  }
  function finish(m) { return core.finalize(m.job, m.generation, m.token, m.digest, m.preparation); }
  function abandon(m, token = m.token) { return store.abandon(m.job, m.generation, token, m.preparation); }
  function reclaim(m, limit, token = m.token) { return store.reclaim(m.job, m.generation, token, m.preparation, limit); }
  function read(m, head) { return store.read(m.changes[0].key, head, 0); }
  function accounting(generation) {
    return sql.exec("SELECT COUNT(*) AS attempts, COALESCE(SUM(reserved),0) AS reserved FROM gen_prepared WHERE generation=?", generation).toArray()[0];
  }
  return { begin, rotate, edit, stage, finish, abandon, reclaim, read, reopen, accounting, close: () => db.close(), get store() { return store; } };
}

async function revisionConflict() {
  const f = fixture();
  try {
    f.edit(1);
    const prior = f.begin(null).plan(15, 1);
    assert.equal(f.store.prepare(prior), true);
    assert.equal(await f.stage(prior, 0), true);
    assert.equal(f.finish(prior), true);
    const run = f.begin(prior.generation), old = run.plan(7_251_618, 1);
    assert.equal(f.store.prepare(old), true);
    assert.equal(f.store.prepare(old), true);
    for (let i = 0; i < old.changes[0].chunks.length; i++) assert.equal(await f.stage(old, i), true);
    // Lease can survive a process restart. Allocation must survive it as well.
    f.reopen();
    assert.equal(f.accounting(old.generation).reserved, 7_251_618);
    f.edit(2);
    assert.throws(() => f.finish(old), /stale|version/);
    const revised = run.plan(7_251_618, 2, old.preparation);
    assert.equal(f.store.prepare({ ...revised, expectedPreparation: randomUUID() }), false);
    assert.equal(f.store.prepare({ ...revised, token: randomUUID() }), false);
    assert.equal(f.store.prepare(old), true);
    assert.equal(f.store.prepare(revised), false);
    assert.equal(f.store.head(), prior.generation);
    assert.deepEqual(Buffer.from(f.read(prior, prior.generation).bytes), block.subarray(0, 15));
    assert.equal(f.read(revised, prior.generation).kind, "missing");
    assert.equal(f.abandon(old, randomUUID()), false);
    assert.equal(f.reclaim(old, 16, randomUUID()), null);
    assert.deepEqual(f.reclaim(old, 16), { ok: false, remaining: 0 });
    assert.equal(f.abandon(old), true);
    assert.equal(f.abandon(old), true);
    assert.equal(f.reclaim(old, 17), null);
    assert.equal(f.reclaim(old, 0), null);
    // Abandoning drops the selected pointer. The re-preparation must CAS against null.
    revised.expectedPreparation = null;
    assert.equal(f.store.prepare(revised), false);
    assert.throws(() => f.finish(old));
    assert.equal(await f.stage(old, 0), false);
    const total = old.changes[0].chunks.length;
    const firstBatch = f.reclaim(old, 16);
    assert.deepEqual(firstBatch, { ok: true, remaining: total - 16 });
    assert.equal(f.accounting(old.generation).reserved, 7_251_618);
    f.reopen();
    const successor = f.rotate(old);
    assert.equal(f.reclaim(old, 16), null);
    assert.equal(f.abandon(old), false);
    revised.token = successor;
    let remaining = firstBatch.remaining, batches = 1;
    while (remaining > 0) {
      const cleaned = f.reclaim(old, 16, successor);
      assert.deepEqual(cleaned, { ok: true, remaining: Math.max(0, remaining - 16) });
      remaining = cleaned.remaining;
      batches++;
    }
    assert.deepEqual(f.reclaim(old, 16, successor), { ok: true, remaining: 0 });
    assert.equal(f.accounting(old.generation).attempts, 0);
    assert.equal(f.accounting(old.generation).reserved, 0);
    assert.equal(f.store.prepare({ ...old, token: successor }), false);
    assert.equal(f.store.prepare(revised), true);
    assert.equal(f.abandon(old), false);
    assert.equal(f.abandon(prior), false);
    assert.equal(f.reclaim(prior, 16), null);
    assert.equal(await f.stage(old, 1), false);
    assert.equal(f.store.prepare(old), false);
    for (let i = 0; i < revised.changes[0].chunks.length; i++) assert.equal(await f.stage(revised, i), true);
    assert.equal(f.finish(revised), true);
    assert.equal(f.finish(revised), true);
    assert.equal(f.finish(old), false);
    f.reopen();
    assert.equal(f.store.head(), revised.generation);
    assert.equal(f.read(prior, prior.generation).kind, "changed");
    assert.deepEqual(Buffer.from(f.read(prior, revised.generation).bytes), block.subarray(0, 15));
    return { chunks: total, cleanupBatches: batches };
  } finally { f.close(); }
}

async function oldWriter() {
  const f = fixture();
  try {
    f.edit(1);
    const run = f.begin(null), first = run.plan(32, 1);
    assert.equal(f.store.prepare(first), true);
    const second = run.plan(32, 1, first.preparation);
    assert.equal(f.store.prepare(second), true);
    assert.equal(f.store.prepare(first), false);
    const lateStage = await f.stage(first, 0);
    assert.throws(() => f.finish(first));
    assert.throws(() => f.finish(second), /incomplete/);
    assert.equal(f.store.head(), null);
    assert.equal(await f.stage(second, 0), true);
    assert.equal(f.finish(second), true);
    return lateStage;
  } finally { f.close(); }
}

function limits() {
  const f = fixture();
  try {
    f.edit(1);
    const run = f.begin(null), exact = run.plan(max, 1);
    assert.equal(f.store.prepare(run.plan(max + 1, 1)), false);
    assert.equal(f.store.prepare(exact), true);
    assert.equal(f.store.prepare(exact), true);
    assert.equal(f.accounting(exact.generation).reserved, max);
    assert.equal(f.store.prepare({ ...exact, changes: run.plan(1, 1).changes }), false);
    assert.equal(f.store.head(), null);
  } finally { f.close(); }
}

limits();
const reclaimed = await revisionConflict(), lateStage = await oldWriter();
assert.equal(lateStage, false);
console.log(JSON.stringify({ fullReservationLimitBytes: max, revisedBytes: 7_251_618, ...reclaimed, recoveredAfterEdit: true, supersededLateStageAccepted: lateStage }));
