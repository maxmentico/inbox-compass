# Coordinator deployment smoke test

From the repository root, run:

```sh
node scripts/coordinator-canary/run.mjs --local
node scripts/coordinator-canary/run.mjs --remote
```

Remote mode requires an authenticated Wrangler account. It bundles the current job and generation stores, deploys a randomly named private Worker with one new SQLite Durable Object class, and invokes it through a temporary service binding. Both Workers.dev and version-preview URLs are disabled. The Worker accepts only a bodyless `POST /run`, runs one fixed workload and returns aggregate counts. Requests with payloads and unknown paths must return 404. No KV, AI, Gmail, cron or production bindings are configured.

Ten invented mailboxes contribute 50 messages each. The scenario checks duplicate claim rejection, stage/accept, accepted partial readback, and invisibility before publication. It commits 500 cache values and a ten-part synthetic digest, replays finalization, then verifies every published part by SHA-256 and reconstructs the message count. Its verifier checks this fixture's keys. Production domain verification, migration and Gmail/AI behavior need their own tests.

Each invocation uses a new object and deletes its data in a finally block. The remote runner closes the service binding, deploys a class deletion migration and deletes the uniquely named test Worker. If cleanup fails after deployment, the runner retains the configuration path and prints it with the exact Worker name for recovery.

## Observed on 7 November 2026

| Measurement | Local workerd | Deployed Cloudflare |
|---|---:|---:|
| Reconstructed messages / expected | 500/500 | 500/500 |
| Committed values | 501 | 501 |
| Generation payload staged | 574,310 bytes | 574,310 bytes |
| SQLite database size before cleanup | 1,597,440 bytes | 1,601,536 bytes |
| SQL statements issued | 4,878 | 4,878 |
| Application SQL rows read / written | 4,996 / 2,157 | 4,996 / 2,157 |
| Elapsed time, single client request | 139 ms | 602 ms |

Cloudflare uploaded version `274a090f-36bc-45de-9566-4281c0340511` with only the `CANARY` binding and reported no public deployment targets. Cleanup deployed the class deletion in version `aa2b0459-efe9-4a73-be35-33bb138bfd24` and confirmed deletion of Worker `openinbox-canary-adea57a2197dedba7cf97d31c386140e`.

The remote timing includes the developer proxy and network. The application row counters use SQLite cursors, exclude platform operations and cleanup, and are unsuitable as an invoice. CPU time, peak isolate memory, production latency percentiles and the account billing tier were unmeasured. Wrangler's listed permissions did not include Analytics Read.

For capacity testing, run independent trials of the actual production execution path on the intended plan and report the sample size. Include retries, maximum message size, expiring data and retained generations. Use namespace-scoped Cloudflare Analytics to measure billed duration, CPU, sampled memory and request counts over the exact test window. Compare those with application row counts and peak retained bytes. [Durable Objects metrics and analytics](https://developers.cloudflare.com/durable-objects/observability/metrics-and-analytics/) · [Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [SQLite storage and cursor metrics](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)

## Offline production assembly capacity

Run `./node_modules/.bin/vite-node scripts/coordinator-canary/capacity.ts` from the repository root. This uses `prepareAssembly`, `buildAssemblyManifest`, the history builder and the real redactor. Each of 10 synthetic mailboxes contributes 50 newly classified messages containing 3,000 body characters each, 50 learned examples, and 500 existing history entries. All mailboxes participate in cursor and history updates. The script runs 12 combinations using 0, 7,000 or 14,000 pre-existing rechecks across all mailboxes. A 7,000-entry queue represents 14 days at 500 estimates per day. More frequent runs can exceed it, as the queue has an age cutoff and no count cap.

| Bodies and existing history subjects | Pending rechecks | Serialized manifest | Generation values |
|---|---:|---:|---:|
| ASCII, short subjects | 0 | 4,420,427 B | 3,951,613 B |
| ASCII, short subjects | 7,000 | 4,763,154 B | 4,251,618 B |
| CJK, short subjects | 7,000 | 7,763,154 B | 7,251,618 B |
| CJK, short subjects | 14,000 | 8,110,155 B | 7,556,619 B |
| CJK, longer English subjects | 0 / 7,000 / 14,000 | Refused at 8 MiB | — |
| JSON-escaped control characters, short subjects | 0 / 7,000 / 14,000 | Refused at 8 MiB | — |

Six of twelve cases produced a manifest. The CJK case with longer subjects exceeded the cap even with an empty recheck queue. A full short-subject CJK mailbox in the 7,000-recheck case required 741,912 bytes for its partial, versus a maximum 64 KiB per single `stage` call. Integration must use the chunked partial API. The small deployed smoke test took the single-part path. The sizing matrix does not include carried items or prior digests, test-run publication, or 60 days of retained state. The materialized reference projector can use more memory than these serialized sizes.

Release gates for the private integration test:

1. Run each case through the actual reader, projector, coordinator and digest renderer with invented data. Add a large carried-forward list and a run with one failed or relinked mailbox. Require exact digest, history, cursor and estimate/recheck parity with the trusted reference for 100% of supported inputs. Preserve the previous committed head on every failure. An explicit product limit needs a recoverable, visible outcome.
2. Change a done mark or setting after staging and immediately before commit. Require one fresh successful publication carrying the edit, zero stale publications, and complete cleanup. Two 7,251,618-byte preparations exceed the current 8 MiB aggregate reservation. Exercise a bounded reclamation or fenced restart. Test a crash, expiry and duplicate retry in each phase.
3. Exercise 20,000 and 20,001 input records, the 1,000-key and 1,024-chunk ceilings, retries through a full retention window, and storage saturation. Check that the user retains access to earlier committed digests. Require retained bytes to plateau after cleanup and record maximum bytes per object.
4. Measure the distinct mail Worker and DO invocation CPU and wall times plus SQLite rows, GB-seconds, DO requests/alarms, and stored bytes for every stage. Start with one remote sample per scenario after local checks pass. Collect repeated measurements within the remaining allowance and report sample counts. Include retry, expiry and cleanup costs. Deduct other account usage before estimating daily headroom.

On Workers Free the daily DO limits include 100,000 writes, 5 million reads, 100,000 requests and 13,000 GB-seconds. Deletes and alarm scheduling count as writes. The present private smoke used 2,157 application rows written before cleanup; its counts cannot forecast a full-state run. For the actual integration use P95 metered consumption including cleanup multiplied by the expected peak daily run count. Start with a target below 80% of the remaining allowance in every dimension, and below 80% of the intended object storage cap over the configured retention period. On Paid, apply the published monthly included allocations, unit rounding and overage rates to total account usage. [Cloudflare Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/) · [Cloudflare Durable Objects limits](https://developers.cloudflare.com/durable-objects/platform/limits/)

## Reservation recovery after an edit

Run `./node_modules/.bin/vite-node scripts/coordinator-canary/reservation.mjs` on Node 22.13+ with SQLite enabled. The test uses the repository's actual job and generation stores with a transactional in-memory database. It recreates the store objects on the same database to simulate loss of process-local state. Cloudflare billing, crash durability and alarms need separate platform tests.

The test stages every byte of a 7,251,618-byte synthetic generation (111 chunks), then changes the done revision. The old manifest fails finalization and a second equally large reservation is refused. The supported recovery sequence is:

1. Keep the previously published head readable. Use the current finalizer token to abandon the exact selected preparation and clear its selection atomically. New stages or commits for the superseded ID must fail.
2. Reclaim its unpublished chunks in batches of at most 16. Keep the whole reservation until the last batch completes. Repeat the cleanup after a crash or lost response. An expired finalizer cannot participate. A replacement finalizer must obtain a fresh token and use the same authorized job and generation.
3. Recapture the authoritative head, account epochs, settings, done revisions and complete input snapshot. Build a new immutable preparation ID with `expectedPreparation: null`. Preserve the abandoned ID's tombstone. Re-stage and revalidate against current state, then publish once. If the job expires, a separately fenced cleanup must finish reclaiming its orphaned storage.

The local test required seven cleanup batches, rotated the finalizer token after the first batch, reopened the store, completed publication and verified the earlier generation's untouched digest. It also checks idempotent retries, unauthorized cleanup, exact 8 MiB admission, one-byte overflow, wrong expected selection, stale stages, reuse of an abandoned ID, invisible incomplete output and idempotent finalization. This exercises persistence of transaction state across object reconstruction. No user-facing finalizer drives this recovery protocol yet.

Capacity planning needs the full retained state. With 7,251,618 generation bytes per run, 60 daily runs that retain every payload would require about 580 MB in base64 chunk text alone. At two daily runs the same scenario exceeds 1.16 GB before job partials, SQLite pages, snapshots or indexes. These are stress projections; reachability-based expiry can remove many superseded values. For the Free deployment target, record `databaseSize` over a simulated 60-day window, measure old-cache expiry, retain every live key-head target, and remove abandoned snapshots, partials and tombstones after stale callbacks are permanently fenced. Measure cleanup and replacement costs before setting a maximum retry rate. [Cloudflare per-object storage limits](https://developers.cloudflare.com/durable-objects/platform/limits/) · [Cloudflare SQLite and alarm billing](https://developers.cloudflare.com/durable-objects/platform/pricing/)

## Segmented generation compaction

Run `node scripts/coordinator-canary/compaction.mjs` locally. The fixture uses invented values in workerd SQLite and restarts the runtime between index pages and cleanup batches. It exercises 17 publications, an old pinned multi-part read, deleted and expired keys, metadata, a failed cleanup transaction, replay and byte-budget accounting. It compares the authenticated inventory before and after compaction, resumes an interrupted inventory, then verifies one-entry keyset pages and every returned chunk hash at the seventeenth head. Source revocation and expiry invalidate the completed inventory. Another process restarts a scan captured while a value was live and advances the clock to its expiry before the first visit. Both the overlay and compacted-index scans reject the stale capture. A fresh authorized capture at the same instant sees the tombstone.

The compacted index maps each visible key to the immutable generation containing its bytes. Building it processes at most 16 keys per checkpoint, retaining a key-only marker for deletion or expiry so authenticated inventories can distinguish those keys from values that never existed. Newer publications extend the compacted index without changing digest membership or moving the head during compaction. Read pins survive process restarts and expire after five minutes. Cleanup conservatively suspends while any pin is active. Reclaiming an obsolete generation or superseded index requires an independent same-transaction retention proof. Scopes remain reserved against reuse. The fixture uses a synthetic retention proof and does not measure production cost.

## Legacy writer drain rehearsal

Run `node scripts/coordinator-canary/cutover-journal.mjs` from the repository root. It starts a private local workerd SQLite fixture, races admission with a freeze, injects a rollback, and verifies the same frozen high-water mark and outstanding write after restarting the runtime.

In the compatibility Worker, each logical mutation must acquire its durable operation ID and intent digest before any writes. Only the first successful `start` may dispatch. The owner records `applied` after every write has acknowledged, or `uncertain` for an ambiguous outcome. Cancellation is legal only before dispatch. A freeze allows existing owners to finish and blocks new admissions. Its sequence can be paged after every entry reaches a terminal state. Use `drainedInTransaction` inside the same transaction as a separately verified import and authority switch. Reopening legacy admission invalidates the previous epoch. The fixture exercises these journal guarantees using generated digests.

Pending pre-bridge traffic, KV baseline completeness, retention of the journal, unresolved outcomes whose original owner was lost, and application route wiring still need explicit implementation for cutover. The journal stores operation metadata and hashes. It cannot reconstruct KV values, detect writes made by older binaries or reconcile a remote write from elapsed time.
