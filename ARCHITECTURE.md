# Inbox Compass architecture

Inbox Compass is a **single-owner, self-hosted email triage system**, not an autonomous mail agent. The Cloudflare Worker reads Gmail, sends bounded untrusted content to Workers AI for **classification only**, then applies deterministic rules. It never lets a model send mail or decide what is marked read.

```text
Google OAuth (verified owner) ──▶ session cookie ──▶ owner-only web UI
          │                                           │
     linked mailboxes                             Run now / cron
          │                                           │
   Gmail API (read) ──▶ per-mailbox job steps ──▶ classification cache
                               │                   │
                               │            unseen email excerpts
                               │                   │
                               └──────────▶ Workers AI JSON schema
                                                   │
                                     validation + link stripping
                                                   │
                                  deterministic rules + threading
                                                   │
                                durable digest + re-check queue
                                                   │
                                   owner marks item done
                                                   │
                         optional Gmail mark-read, never model-driven
```

## Boundaries and trade-offs

| Boundary | Implementation | Why |
|---|---|---|
| Owner authentication | Google OAuth identity checked against `OWNER_EMAIL`, short-lived state, encrypted HttpOnly session cookie and CSRF checks | Self-hosting has no central user database |
| OAuth initiation | Native Cloudflare `LOGIN_RATE_LIMITER` applied **before** creating OAuth state | Reduces unauthenticated KV-write abuse; approximate per Cloudflare location and IP, not a strict distributed limit |
| Mailbox credentials | Per-mailbox refresh tokens sealed with AES-256-GCM and bound to their alias | A KV export alone does not provide usable refresh tokens |
| Model | Workers AI only; schema-constrained outputs, no tools, validated refs and values | Email text is attacker-controlled, so classifications are *suggestions*, not authority |
| Final decisions | `rules.ts` decides attention/urgency; phishing is isolated; failure of the model shows estimates or manual review | Prevents unvalidated model output silently hiding work |
| Storage | KV holds digests, cache and cursor state. The job authority uses Durable Object SQLite for coordination and atomic publication | KV is eventually consistent; jobs may be retried or interrupted |
| Side effects | Owner's CSRF-protected Done action may mark Gmail read, when `gmail.modify` is enabled | The model cannot act on external systems |
| Privacy | Model receives capped and redacted message text; output is HTML-escaped; secret-like tokens and recovery links are masked | Avoid unnecessary disclosure and XSS |
| Failure recovery | Model fallback, quota estimation and later re-check, bounded mailbox backlog, idempotent job steps | A failed batch should not silently lose mail |

## Code map

- `src/index.ts`, `src/web.ts`, `src/pages.ts`: entrypoints, owner-only routes and HTML rendering.
- `src/google.ts`, `src/accounts.ts`, `src/gmail.ts`, `src/session.ts`: OAuth, encrypted tokens, Gmail requests and sessions.
- `src/digest.ts`, `src/llm.ts`, `src/rules.ts`, `src/estimate.ts`, `src/secrets.ts`: classification, safety, fallbacks and digest assembly.
- `src/jobs.ts`, `src/job-authority.ts`, `src/atomic-*.ts`: distributed job coordination and publication integrity.
- `test/`: unit and integration-style tests; `scripts/test-*-runtime.mjs`: synthetic Workers/SQLite runtime tests.
- `scripts/model-eval/`: *small synthetic* paired model evaluation. Do not infer production accuracy from its 24 labelled emails.

## How to verify

```bash
npm ci
npm run check                      # type-check and Vitest
npm run test:coordinator-runtime   # complete local Workers/SQLite suite
```

CI runs the first check and the runtime suite in four shards on every PR. The demo at `demo/index.html` uses entirely invented mail and does not call Gmail, Cloudflare, or an LLM.

## What is *not* proven

The synthetic evaluation and passing tests do **not** prove real-mail accuracy, production latency, global abuse protection or that no message will ever be missed. See [quality targets](docs/worker-quality.md) for the proposed measurement protocol.
