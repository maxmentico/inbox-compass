// Synthetic, opt-in: node --expose-gc node_modules/vite-node/vite-node.mjs scripts/benchmark-assembly-input.ts
import { performance } from "node:perf_hooks";
import { parseAssemblyInputBatch } from "../src/assembly-input";

const scope = "a".repeat(22);
const sourceId = "b".repeat(64);
const encoder = new TextEncoder();
const records = Array.from({ length: 500 }, (_, sequence) => encoder.encode(JSON.stringify({
	version: 1, scope, sequence, kind: "item", collection: "partial", key: `mail:m${sequence}`, account: "mail", accountEmail: "mail@example.com", messageId: `m${sequence}`, threadId: `t${sequence}`,
	from: "Sender <sender@example.com>", subject: "Synthetic invoice", snippet: "Synthetic message", summary: "Review invoice", action: "Review invoice", text: "x".repeat(3000), date: "2026-10-24T06:00:00Z", classified: true, done: false, needsAction: true, urgency: "medium", category: "payment", due: null,
})));
const wall: number[] = [];
const cpu: number[] = [];
let maxHeapDelta = 0;
for (let round = 0; round < 11; round++) {
	globalThis.gc?.();
	const heap = process.memoryUsage().heapUsed;
	let checkpoint = { sourceId, scope, nextSequence: 0, seenKeys: new Set<string>() };
	for (let i = 0; i < records.length; i += 16) {
		const startCpu = process.cpuUsage();
		const start = performance.now();
		const result = parseAssemblyInputBatch(records.slice(i, i + 16), sourceId, checkpoint);
		if (round) {
			wall.push(performance.now() - start);
			const used = process.cpuUsage(startCpu);
			cpu.push((used.user + used.system) / 1000);
		}
		checkpoint = { ...checkpoint, nextSequence: result.nextSequence, seenKeys: result.seenKeys };
	}
	maxHeapDelta = Math.max(maxHeapDelta, process.memoryUsage().heapUsed - heap);
}
const stats = (values: number[]) => { const s = values.toSorted((a, b) => a - b); return { p50: s[Math.floor(s.length * 0.5)], p95: s[Math.floor(s.length * 0.95)], max: s.at(-1) }; };
console.log(JSON.stringify({ syntheticRecords: 500, recordsPerBatch: 16, excerptChars: 3000, measuredBatches: wall.length, wallMs: stats(wall), processCpuMs: stats(cpu), maxRoundHeapDeltaBytes: maxHeapDelta, processMaxRssBytes: process.resourceUsage().maxRSS * 1024, gcAvailable: typeof globalThis.gc === "function" }));

// Cost of copying the largest permitted prior duplicate-key checkpoint on every batch.
const checkpoint = { sourceId, scope, nextSequence: 0, seenKeys: new Set(Array.from({ length: 20_000 }, (_, i) => `prior:${i}`)) };
const largeWall: number[] = [];
const largeCpu: number[] = [];
for (let i = 0; i < 50; i++) {
	const startCpu = process.cpuUsage();
	const start = performance.now();
	parseAssemblyInputBatch([], sourceId, checkpoint);
	largeWall.push(performance.now() - start);
	const used = process.cpuUsage(startCpu);
	largeCpu.push((used.user + used.system) / 1000);
}
console.log(JSON.stringify({ priorSeenKeys: 20_000, records: 0, wallMs: stats(largeWall), processCpuMs: stats(largeCpu), note: "checkpoint-copy only; process CPU is not Workers CPU" }));
