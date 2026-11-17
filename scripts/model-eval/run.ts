import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { BATCH_SIZE, triageEmails } from '../../src/llm';
import { addressingOf, decide, DEFAULT_SETTINGS } from '../../src/rules';
import { emailFor, fixtures, OWNER, TODAY } from './fixtures';

const { getPlatformProxy } = createRequire(import.meta.url)('wrangler') as typeof import('wrangler');
// USD per million prompt/completion tokens, before free allowance. See the model cards in README.md.
const rates: Record<string, [number, number]> = {
  '@cf/openai/gpt-oss-120b': [0.35, 0.75],
  '@cf/google/gemma-4-26b-a4b-it': [0.10, 0.30],
  '@cf/openai/gpt-oss-20b': [0.20, 0.30],
};
const repeats = Number(process.env.EVAL_REPEATS ?? 1);
if (!Number.isInteger(repeats) || repeats < 1 || repeats > 10) throw new Error('EVAL_REPEATS must be an integer from 1 to 10');

function totals() {
  return { samples: 0, classified: 0, actions: 0, predictedActions: 0, trueActions: 0, phishing: 0, phishingFound: 0,
    due: 0, dueCorrect: 0, calls: 0, callsWithUsage: 0, promptTokens: 0, completionTokens: 0,
    elapsed: [] as number[], failures: [] as string[] };
}
const stats = Object.fromEntries(Object.keys(rates).map(model => [model, totals()]));
const proxy = await getPlatformProxy<{ AI: Ai }>({
  configPath: fileURLToPath(new URL('./wrangler.jsonc', import.meta.url)), envFiles: [], persist: false,
}).catch((e: Error) => {
  // Wrangler's nested error may include its internal proxy setup. The top-level message suffices.
  throw new Error(e.message);
});
type ModelResponse = { usage?: { prompt_tokens: number; completion_tokens: number } };
const infer = proxy.env.AI.run.bind(proxy.env.AI) as (id: string, input: unknown, options?: unknown) => Promise<ModelResponse>;
try {
  const models = Object.keys(rates);
  for (let round = 0; round < repeats; round++) {
    // Reorder cases between rounds, preserving paired inputs and batch sizes for every model.
    const offset = round % fixtures.length;
    const rows = [...fixtures.slice(offset), ...fixtures.slice(0, offset)].map(f => ({ f, email: emailFor(f) }));
    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const batch = rows.slice(start, start + BATCH_SIZE);
      for (let i = 0; i < models.length; i++) {
        const model = models[(i + round + start / BATCH_SIZE) % models.length]!;
        const s = stats[model]!;
        const measured = { run: async (id: string, input: unknown, options?: unknown) => {
          s.calls++;
          const t = performance.now();
          try {
            const raw = await infer(id, input, options);
            if (raw?.usage && Number.isFinite(raw.usage.prompt_tokens) && Number.isFinite(raw.usage.completion_tokens)) {
              s.promptTokens += raw.usage.prompt_tokens;
              s.completionTokens += raw.usage.completion_tokens;
              s.callsWithUsage++;
            }
            return raw;
          } finally {
            s.elapsed.push(Math.round(performance.now() - t));
          }
        } };
        const result = await triageEmails(measured as Pick<Ai, 'run'>, model, batch.map(row => row.email), { today: TODAY, ownerEmail: OWNER });
        if (result.unavailable?.reason === 'quota') throw new Error('Shared daily AI quota exhausted. Stopped all evaluation requests.');
        for (const { f, email } of batch) {
          const triage = result.results.get(email.ref);
          const actual = triage && decide({ ...triage, signals: { ...triage, addressing: addressingOf(OWNER, { ...email, bulk: !!f.bulk }) },
            from: email.from, subject: email.subject, done: false, replied: false }, { today: TODAY, settings: DEFAULT_SETTINGS }).outcome;
          s.samples++;
          if (triage) s.classified++;
          if (f.outcome === 'action') s.actions++;
          if (actual === 'action') s.predictedActions++;
          if (actual === 'action' && f.outcome === 'action') s.trueActions++;
          if (f.outcome === 'phishing') s.phishing++;
          if (actual === 'phishing' && f.outcome === 'phishing') s.phishingFound++;
          if (f.due) {
            s.due++;
            if (triage?.due === f.due) s.dueCorrect++;
          }
          if (actual !== f.outcome || (f.due && f.due !== triage?.due)) s.failures.push(f.subject);
        }
        console.error(model, 'round', round + 1, 'batch', start / BATCH_SIZE + 1, 'classified', result.results.size, '/', batch.length);
        if (result.errors.length) console.error(result.errors);
      }
    }
  }
} finally {
  await proxy.dispose();
}
for (const [model, s] of Object.entries(stats)) {
  const [inputRate, outputRate] = rates[model]!;
  const sorted = s.elapsed.sort((a, b) => a - b);
  console.log(JSON.stringify({ model, classified: [s.classified, s.samples], actionRecall: [s.trueActions, s.actions],
    actionPrecision: [s.trueActions, s.predictedActions], phishingRecall: [s.phishingFound, s.phishing], dueAccuracy: [s.dueCorrect, s.due],
    calls: s.calls, batchMedianMs: sorted[Math.ceil(sorted.length / 2) - 1], batchMaxMs: sorted.at(-1),
    batchP95Ms: sorted.length >= 20 ? sorted[Math.ceil(sorted.length * 0.95) - 1] : null,
    callsWithUsage: s.callsWithUsage, promptTokens: s.promptTokens, completionTokens: s.completionTokens,
    estimatedUsdPer100Valid: s.callsWithUsage === s.calls && s.classified ? (s.promptTokens * inputRate + s.completionTokens * outputRate) / 1e6 * 100 / s.classified : null,
    mismatchedSyntheticSubjects: s.failures }));
  if (!s.classified) process.exitCode = 1;
}
