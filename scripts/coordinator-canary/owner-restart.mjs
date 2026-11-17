// Synthetic local SQLite regression. Run with ./node_modules/.bin/vite-node scripts/coordinator-canary/owner-restart.mjs
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CoordinatedAccounts } from "../../src/coordinated-accounts.ts";
import { OwnerState } from "../../src/owner-state.ts";

const directory = await mkdtemp(join(tmpdir(), "openinbox-owner-restart-"));
const filename = join(directory, "invented.sqlite");
const fixtureEmail = "invented@example.invalid";
const identity = createHash("sha256").update(fixtureEmail).digest("hex");
const authorization = { head: "invented-head", accounts: { mail: 1 } };
const item = "mail:synthetic-item";
const newClaim = () => randomBytes(18).toString("base64url");
function syntheticRecord(alias) {
  return { alias, email: fixtureEmail, scopes: [], linkedAt: "2026-11-09T01:00:00Z", sealedRefreshToken: "v1." + "a".repeat(16) + "." + newClaim() };
}
function open() {
  const db = new DatabaseSync(filename);
  const sql = {
    exec(query, ...args) {
      const rows = db.prepare(query).all(...args);
      return { toArray: () => rows };
    },
  };
  const storage = {
    sql,
    transactionSync(action) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = action();
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
  db.exec("CREATE TABLE IF NOT EXISTS gen_head (singleton INTEGER PRIMARY KEY, generation TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS fixture_members (head TEXT NOT NULL, item TEXT NOT NULL, incarnation INTEGER NOT NULL, PRIMARY KEY(head,item))");
  const accounts = new CoordinatedAccounts(storage);
  const owner = new OwnerState(storage, (tx, head, key) => tx.exec("SELECT incarnation FROM fixture_members WHERE head=? AND item=?", head, key).toArray()[0]?.incarnation ?? null);
  return { db, accounts, owner };
}

let state = open();
try {
  const original = syntheticRecord("mail");
  // The caller-owned request can change while link awaits hashing.
  const pending = state.accounts.link(original, identity, 0, 0);
  original.email = "different@example.invalid";
  original.scopes.push("mutated");
  assert.equal(await pending, 1);
  assert.equal(state.accounts.get("mail").email, fixtureEmail);
  assert.deepEqual(state.accounts.get("mail").scopes, []);
  state.db.exec("INSERT INTO gen_head VALUES (1,'invented-head')");
  state.db.prepare("INSERT INTO fixture_members SELECT 'invented-head',?,version FROM coordinated_incarnations WHERE alias='mail'").run(item);

  const contenders = [syntheticRecord("mail"), syntheticRecord("mail")];
  const rotations = await Promise.allSettled(contenders.map(record => state.accounts.rotate(record, identity, 1, 0)));
  assert.equal(rotations.filter(outcome => outcome.status === "fulfilled").length, 1);
  const winner = contenders[rotations.findIndex(outcome => outcome.status === "fulfilled")];
  assert.deepEqual(state.accounts.get("mail"), winner);
  assert.deepEqual(state.owner.setDone([item], true, 0, authorization), { revision: 1, changed: [item] });

  const changes = [
    { deadlineDays: 4, important: ["@alpha.invalid"], muted: [] },
    { deadlineDays: 5, important: [], muted: ["@bravo.invalid"] },
  ];
  const edits = await Promise.allSettled(changes.map(settings => state.owner.setSettings(settings, 0)));
  assert.equal(edits.filter(outcome => outcome.status === "fulfilled").length, 1);
  const winningSettings = changes[edits.findIndex(outcome => outcome.status === "fulfilled")];
  assert.deepEqual(state.owner.getSettings(), { revision: 1, settings: winningSettings });

  // Abort at the last domain update. Neither a queued revocation nor an incarnation change may escape.
  state.db.exec("CREATE TRIGGER fixture_fail_unlink BEFORE UPDATE ON coordinated_accounts WHEN NEW.purge_pending=1 BEGIN SELECT RAISE(ABORT,'injected unlink failure'); END");
  assert.throws(() => state.accounts.unlink("mail", 2), /injected unlink failure/);
  assert.deepEqual(state.accounts.get("mail"), winner);
  assert.equal(state.accounts.flowBarrier(), 0);
  assert.equal(state.accounts.revocationStatus("mail", 3), null);
  assert.equal(state.db.prepare("SELECT version FROM coordinated_incarnations WHERE alias='mail'").get().version, 1);
  state.db.exec("DROP TRIGGER fixture_fail_unlink");

  assert.deepEqual(state.owner.setDone([item], false, 1, authorization), { revision: 2, changed: [item] });
  assert.deepEqual(state.accounts.unlink("mail", 2), { epoch: 3, removed: true });
  // This fixture has no cache or mailbox data. Require its single done mark to be gone.
  const noMarks = sql => sql.exec("SELECT item FROM owner_done LIMIT 1").toArray().length === 0;
  assert.equal(state.accounts.finishPurge("mail", 3, noMarks), true);
  const claim = newClaim();
  assert.equal(state.accounts.claimRevocation("mail", 3, claim)?.sealed, winner.sealedRefreshToken);
  state.db.close();
  state = open();
  assert.equal(state.accounts.get("mail"), null);
  assert.deepEqual(state.owner.getSettings(), { revision: 1, settings: winningSettings });
  assert.equal(state.accounts.revocationStatus("mail", 3)?.state, "uncertain");
  assert.equal(state.accounts.claimRevocation("mail", 3, newClaim()), null);
  assert.equal(state.db.prepare("SELECT sealed FROM coordinated_revocations").get().sealed, null);
  assert.equal(state.accounts.finishRevocation("mail", 3, true, newClaim()), false);
  await assert.rejects(state.accounts.link(syntheticRecord("elsewhere"), identity, 0, state.accounts.flowBarrier()), /pending/);
  state.db.exec("UPDATE coordinated_revocations SET expires_at=0");
  assert.deepEqual(state.accounts.cleanupRevocations(), { removed: 0, remaining: false, uncertain: true });
  assert.equal(state.accounts.finishRevocation("mail", 3, false, claim), false);
  assert.equal(state.accounts.finishRevocation("mail", 3, true, claim), true);

  await assert.rejects(state.accounts.link(syntheticRecord("mail"), identity, 3, 1), /stale/);
  assert.equal(await state.accounts.link(syntheticRecord("mail"), identity, 3, 2), 4);
  assert.throws(() => state.owner.setDone([item], true, 2, authorization), /mailbox changed/);
  assert.throws(() => state.owner.setDone([item], true, 2, { ...authorization, accounts: { mail: 3 } }), /mailbox changed/);
  assert.throws(() => state.accounts.unlink("mail", 2), /Account changed/);
  console.log("Owner restart regression passed: competing edits, rollback, revocation recovery, rotation and alias reuse.");
} finally {
  state.db.close();
  await rm(directory, { recursive: true, force: true });
}
