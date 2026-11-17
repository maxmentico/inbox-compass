import { writeFile } from 'node:fs/promises';
// Offline requests use only generated data. Exercise production assembly and measure serialized bytes.
import { digestConfig } from "../../src/config";
import { ASSEMBLY_MANIFEST_LIMITS, buildAssemblyManifest, prepareAssembly, type MailboxPartial, type RunContext, type RunEnv } from "../../src/digest";
import { featuresOf, historyEntry } from "../../src/estimate";
import { DEFAULT_SETTINGS } from "../../src/rules";

const now = new Date("2026-11-07T06:00:00Z");
const date = now.toISOString();
const accounts = Array.from({ length: 10 }, (_, i) => ({
  alias: "box" + i, email: "box" + i + "@example.invalid", scopes: [], sealedRefreshToken: "", linkedAt: date,
}));
const job = "a".repeat(22);
const context: RunContext = {
  opts: {}, window: { kind: "since" }, now, date: date.slice(0, 10), test: false, cfg: digestConfig({}),
  settings: DEFAULT_SETTINGS, accounts, fullShare: 50, share: 50, open: [], openIfUnticked: [], ticked: new Set(), jobId: job,
};
const answer = { sender: "person", request: "direct", stakes: "some", summary: "Review the draft", action: "Reply", category: "reply", due: null } as const;
const encoder = new TextEncoder();
const bytes = (s: string) => encoder.encode(s).byteLength;
async function measure(glyph: string, totalWaiting: number, longHistory = false) {
  const text = glyph.repeat(3_000);
  const partials: MailboxPartial[] = accounts.map(({ alias, email }) => {
    const meta = { threadId: "", from: "Avery <avery@example.invalid>", subject: "Review requested", date, snippet: "The draft is ready for your review." };
    const historyMeta = { ...meta, subject: longHistory ? "Could you review the revised project estimates and dates before the planning meeting tomorrow morning with the team?" : meta.subject };
    const features = featuresOf({ from: meta.from, subject: historyMeta.subject, text: meta.snippet, addressing: "to_you", conversation: false, attachments: [] });
    const history = Array.from({ length: 500 }, (_, i) => historyEntry("old-" + i, features, answer, historyMeta));
    const entries = Array.from({ length: 50 }, (_, i) => {
      const messageId = "mail-" + i, itemMeta = { ...meta, threadId: "thread-" + i };
      return { messageId, itemMeta, key: alias + ":" + messageId };
    });
    return {
      alias, status: { alias, email, ok: true, found: entries.length, newlyClassified: entries.length },
      items: entries.map(({ messageId, itemMeta, key }) => ({
        ...itemMeta, key, account: alias, accountEmail: email, messageId, needsAction: true, action: answer.action,
        urgency: "medium", category: answer.category, due: null, summary: answer.summary, classified: true, done: false,
        text, signals: { sender: answer.sender, request: answer.request, stakes: answer.stakes, addressing: "to_you" },
      })),
      toCache: entries.map(({ key, itemMeta }) => [key, { v: 3, arrived: now.getTime(), meta: itemMeta, triage: answer, classifiedAt: date, mailbox: email, source: "model" }]),
      history, learned: entries.map(({ messageId }) => historyEntry(messageId, features, answer, historyMeta)),
      recheck: { before: Array.from({ length: totalWaiting / accounts.length }, (_, i) => ({ id: "pending-" + i, added: now.getTime() - 60_000 })), settled: [], estimated: [] },
      run: { before: null, seenTimes: [], backlog: false }, errors: [], estimated: 0, fromHistory: 0, surfaced: [], replacedCarried: [],
    };
  });
  const prepared = await prepareAssembly({} as RunEnv, context, partials, { doneKeys: new Set() });
  const snapshot = {
    lastRun: null, indexedRuns: [], cursors: Object.fromEntries(accounts.map(a => [a.alias, null])), failureHolds: {},
    histories: Object.fromEntries(partials.map(p => [p.alias, p.history!])),
  };
  const result = { job, digest: prepared.digest.id, driver: "web" as const, test: false, rows: accounts.map(a => ({ alias: a.alias, state: "done" as const })), started: now.getTime(), finished: now.getTime() };
  const sizes = {
    bodyBytes: bytes(text) * 500,
    largestAcceptedPartialBytes: Math.max(...partials.map(p => bytes(JSON.stringify(p)))),
    digestJsonBytes: bytes(JSON.stringify(prepared.digest)),
  };
  try {
    const manifest = buildAssemblyManifest(context, partials, prepared, snapshot, { id: job, result });
    await writeFile(process.argv[2]!, JSON.stringify(manifest));
    return { ...sizes, manifestBytes: manifest.encodedBytes, generationBytes: manifest.writes.reduce((sum, w) => sum + (w.kind === "put" ? bytes(w.value) : 0), 0), writes: manifest.writes.length };
  } catch (e) {
    if (!(e instanceof Error && e.message === "Assembly manifest exceeds limits")) throw e;
    return { ...sizes, refused: e.message };
  }
}

// Offline reference only: never changes the Worker’s production limit.
(ASSEMBLY_MANIFEST_LIMITS as unknown as { bytes: number }).bytes = 32 * 1024 * 1024;
console.log(JSON.stringify(await measure('界', 0, true)));
