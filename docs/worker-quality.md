# Worker quality targets and measurement

These are proposed service objectives, not measured results or guarantees. Establish a baseline before changing the model or concurrency. Report the sample size, time window, workload, model and settings with every result. Measure end-to-end outcomes, not just model answers: Gmail pre-filtering, estimates, conversation handling and rules can also change what the owner sees.

| Measure | Proposed target | Definition |
|---|---:|---|
| High-consequence action recall | At least 99%; investigate every miss | Of independently labelled, actionable emails with a material consequence or hard deadline, the share surfaced for action or clearly flagged for manual review. Report phishing separately. |
| Action recall | At least 98% | Of all independently labelled emails requiring the owner, the share surfaced for action or manual review. |
| Action precision | At least 90% | Of emails surfaced for action, the share independently judged to require owner action. Report estimates separately so a safe fallback is not penalised as if it were a model decision. |
| Phishing recall | At least 99% on the labelled security set | Of labelled phishing emails, the share shown as possible phishing. Also report false positives and injection attacks separately. |
| Digest completion | At least 99.9% of eligible runs over 30 days | Runs that produce a digest with every eligible mailbox processed or an explicit, actionable failure notice, divided by eligible starts. Report fully successful runs separately. |
| Freshness | At least 99% of scheduled runs completed within 15 minutes of schedule over 30 days | Count missed schedules and runs with incomplete mailbox processing as failures; exclude only documented provider-wide outages and report those separately. |
| Interactive latency | p50 ≤ 30 s and p95 ≤ 120 s for up to 100 new emails across up to 3 mailboxes | Time from Run now to a usable digest, including Gmail, model, retries and persistence. Track larger backlogs in separate workload bands and report incomplete runs. |
| Classification availability | At least 99% of eligible emails classified by a model on the first run | Model-classified emails divided by emails sent to the model, including errors, invalid output and quota failures. Separately track estimated emails and time to re-check. |
| Data loss | Zero confirmed skipped emails due to cursor advancement after an unhandled failure | Exercise failures and retries in tests; reconcile user-visible completeness against a controlled mailbox. |

Quality and latency objectives are starting points for discussion and should be revised after representative measurements. Missing an important email is more costly than an extra item to check, so recall takes precedence over precision. A small synthetic test cannot establish a 99% production rate: for example, even zero misses among 300 independent positive examples leaves the approximate one-sided 95% upper bound on the miss rate at 1%. Use enough labelled cases and confidence intervals, including per-language and rare high-stakes slices; report both the numerator and denominator. Triage labels should be independently reviewed and disagreements resolved before comparing models.

## Evaluation protocol

1. Use synthetic mail for automated regression, adversarial prompt-injection checks and reproducible model comparisons. Include personal requests, ordinary notifications, marketing, money, deadlines, phishing, multilingual mail, threads and malformed outputs. Keep training examples separate from held-out evaluation cases.
2. For representative quality, the owner can independently label a stratified sample from their own mail in a private environment. Do not send live mail, digest contents, run logs or secrets to coding agents. Compare the final visible outcome, including fallbacks and pre-filtering, against those labels.
3. Compare candidates on the same cases, production prompts, parsing, rules and batching. Measure quality, output validity, p50/p95 latency, fallback frequency and cost on the actual Workers AI deployment. Repeat runs to capture variance. A candidate must meet the recall and security targets before speed or cost can justify replacing the current model.
4. Use synthetic mailboxes and injected Gmail, KV and model failures to exercise retry, duplicate delivery, quota exhaustion, stale locks, partial batches and recovery. Test scheduled and interactive runs separately. Never infer production reliability from passing unit tests alone.
5. Record aggregate counts and durations only; do not log message text, addresses, subjects, tokens, or model prompts. Review targets over a rolling 30-day window, and retain raw sample sizes alongside rates.

Current repository baseline: no labelled production evaluation or measured end-to-end latency distribution is available to this review. The current model selection should therefore be treated as a hypothesis, not an established optimum.
