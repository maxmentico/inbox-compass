// Opt-in, synthetic only: node --expose-gc node_modules/vite-node/vite-node.mjs scripts/benchmark-assembly.ts
// Local wall and process CPU times are not Cloudflare Worker CPU measurements.
import { performance } from "node:perf_hooks";
import { buildAssemblyManifest } from "../src/digest";

const now = new Date("2026-10-24T06:30:00.000Z");
const mailboxes = 10;
const perMailbox = 50;
const make = (excerptChars: number) => {
	const items: any[] = [];
	const statuses: any[] = [];
	const caches = new Map<string, any>();
	const runs = new Map<string, any>();
	const histories: Record<string, any[]> = {};
	const lists = new Map<string, any>();
	const learned = new Map<string, any[]>();
	const cursors: Record<string, null> = {};
	for (let m = 0; m < mailboxes; m++) {
		const alias = `mail${m}`;
		statuses.push({ alias, email: `${alias}@example.com`, ok: true, found: perMailbox, newlyClassified: perMailbox });
		runs.set(alias, { before: null, seenTimes: [], backlog: false });
		cursors[alias] = null;
		const history = (i: number) => ({ id: `${alias}-old-${i}`, sender: "sender@example.com", domain: "example.com", subject: "Synthetic invoice", date: now.toISOString(), snippet: "A synthetic message." });
		histories[alias] = Array.from({ length: 500 }, (_, i) => history(i));
		learned.set(alias, Array.from({ length: perMailbox }, (_, i) => history(500 + i)));
		lists.set(alias, { changed: true, next: Array.from({ length: 50 }, (_, i) => ({ id: `${alias}-pending-${i}`, added: now.getTime() })) });
		for (let i = 0; i < perMailbox; i++) {
			const id = `${alias}-msg-${i}`;
			const meta = { threadId: id, from: "Sender <sender@example.com>", subject: "Synthetic invoice", date: now.toISOString(), snippet: "Synthetic message for the benchmark." };
			items.push({ ...meta, key: `${alias}:${id}`, account: alias, accountEmail: `${alias}@example.com`, messageId: id, needsAction: true, action: "Review invoice", urgency: "medium", category: "payment", due: null, summary: "Review the synthetic invoice.", classified: true, done: false, text: "a".repeat(excerptChars) });
			caches.set(`${alias}:${id}`, { v: 3, meta, classifiedAt: now.toISOString(), arrived: now.getTime(), triage: { sender: "automated", request: "required", stakes: "some", action: "Review invoice", category: "payment", due: null, summary: "Review the synthetic invoice." } });
		}
	}
	const digest = { id: "2026-10-24T06:30:00Z", date: "2026-10-24", generatedAt: now.toISOString(), model: "synthetic", query: "in:inbox", items, accounts: statuses, modelErrors: [] };
	const prepared = { digest, lists, toCache: caches, historyAliases: [...runs.keys()], historyBefore: new Map(), learned, statuses, mailboxes: runs };
	const snapshot = { lastRun: null, indexedRuns: [], cursors, failureHolds: {}, histories };
	return { ctx: { now, test: false, accounts: [] } as any, prepared: prepared as any, snapshot };
};

for (const excerptChars of [200, 3_000]) {
	const { ctx, prepared, snapshot } = make(excerptChars);
	for (let i = 0; i < 3; i++) buildAssemblyManifest(ctx, [], prepared, snapshot);
	const wall: number[] = [];
	const cpu: number[] = [];
	const heapDelta: number[] = [];
	let manifestBytes = 0;
	for (let i = 0; i < 10; i++) {
		globalThis.gc?.();
		const heap = process.memoryUsage().heapUsed;
		const startCpu = process.cpuUsage();
		const start = performance.now();
		const manifest = buildAssemblyManifest(ctx, [], prepared, snapshot);
		wall.push(performance.now() - start);
		const used = process.cpuUsage(startCpu);
		cpu.push((used.user + used.system) / 1_000);
		heapDelta.push(process.memoryUsage().heapUsed - heap);
		manifestBytes = manifest.encodedBytes;
	}
	const range = (n: number[]) => { const s = n.toSorted((a, b) => a - b); return { median: s[5], max: s[9] }; };
	console.log(JSON.stringify({ items: 500, mailboxes, excerptChars, manifestBytes, wallMs: range(wall), cpuMs: range(cpu), heapDeltaBytes: range(heapDelta), processMaxRssBytes: process.resourceUsage().maxRSS * 1024, samples: 10, gcAvailable: typeof globalThis.gc === "function" }));
}
