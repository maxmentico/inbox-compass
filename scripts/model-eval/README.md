# Compare Workers AI models on synthetic inboxes

From the repository root, use an authenticated Wrangler account and run:

```sh
npx --no-install vite-node scripts/model-eval/run.ts
```

The default run makes nine billed inference requests (three batches of eight per model). Only the AI binding is configured. No Gmail access, stored digests, job invocation, published endpoint, production secrets or KV namespace are involved. Restrict the fixture file to invented mail.

All three candidates receive the same 24 pre-labelled items and random refs in each round. The script rotates candidate order between batches, uses production prompts, settings, parsing and placement rules, and runs each model separately so a fallback cannot conceal a failure. It excludes the Gmail pre-filter, history, caching and outage estimates to isolate the model's contribution. The fixture set includes English and Russian, follow-ups, explicit deadlines, phishing, and an instruction targeting neighboring emails.

Recall and precision are reported as numerators and denominators. Missing outputs count against classification coverage and the recall of their expected class. Due-date accuracy uses only the five labelled deadlines. Latency is wall time per binding call including the local proxy. The cost estimate uses prompt and completion tokens actually reported by the binding, with list pricing before free allowances. Missing usage produces a null cost. Each model reports the fixture labels where its placement or explicit deadline disagreed.

For a preliminary p95, set `EVAL_REPEATS=7` (63 total requests; 21 batches per model). Repetition measures timing and generation variability. It does not increase the number of independent labelled cases. Use a larger representative private evaluation and the [Worker quality targets](../../docs/worker-quality.md) before promoting a candidate. Cloudflare may change prices and capacity. See [pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) and the model cards for [GPT-OSS-120B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-120b/), [Gemma 4](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/) and [GPT-OSS-20B](https://developers.cloudflare.com/workers-ai/models/gpt-oss-20b/).

## Live screening result, 6 November 2026

One paired pass on the deployed Cloudflare model service, with fallback disabled in each arm. These are measurements of the fixed synthetic cases and include the local proxy in batch times. Cost is an estimate from reported token counts.

| Model | Valid items | Action recall / precision | Phishing found | Exact explicit deadline | Batch median / maximum (3 calls) | USD per 100 valid |
|---|---:|---:|---:|---:|---:|---:|
| GPT-OSS-120B | 24/24 | 10/10 / 10/10 | 3/3 | 5/5 | 10.96 s / 16.62 s | 0.01741 |
| Gemma 4 26B A4B | 24/24 | 10/10 / 10/10 | 3/3 | 5/5 | 11.98 s / 12.70 s | 0.00427 |
| GPT-OSS-20B | 0/24 | 0/10 / undefined | 0/3 | 0/5 | 9.03 s / 23.79 s | undefined |

Prompt/completion token totals were 4,646/3,403 (120B), 5,085/1,723 (Gemma) and 4,664/2,602 (20B). Every call reported usage. The production parser accepted zero results from the smaller GPT-OSS candidate. A fourth diagnostic request for its first batch finished normally and returned a bare array where the contract requires an object with an `items` array. This identifies an integration issue and leaves its underlying classification quality unmeasured. The harness exits with code 1 if any candidate produces zero valid items in an entire run.

Retain 120B as primary and Gemma as fallback. Gemma matched all labels at roughly one quarter of the list cost here, and warrants a larger paired comparison. The observed median favors 120B by about one second, with only three timing samples per model. This run cannot establish a reliable ordering for tail latency or hard real-world mail.
