import { describe, expect, it } from "vitest";
import { projectCacheSnapshotPage } from "../src/assembly-cache-adapter";
import { beginAssemblyInventory } from "../src/assembly-inventory";
import { buildAssemblyManifest } from "../src/digest";
import { createInputSnapshot, type InputSnapshotSource } from "../src/input-snapshot";

const scope = "a".repeat(22);
const encoder = new TextEncoder();
const encode = (value: unknown) => encoder.encode(JSON.stringify(value));
const cache = (i: number) => ({ v: 3, arrived: 1000 + i, meta: { threadId: `t${i}`, from: "Sender <sender@example.com>", subject: "Invoice", date: "2026-10-24T06:00:00Z", snippet: "Invoice attached" }, triage: { sender: "automated", request: "required", stakes: "some", action: "Review invoice", category: "payment", due: null, summary: "Invoice" }, classifiedAt: "2026-10-24T06:30:00Z" });

async function fixture(count: number) {
	const records = Array.from({ length: count }, (_, sequence) => ({ version: 1, scope, sequence, kind: "cache", account: "mail", messageId: `m${sequence}`, value: cache(sequence) }));
	const fragments = Array.from({ length: Math.ceil(count / 16) }, (_, i) => encode(records.slice(i * 16, i * 16 + 16)));
	const manifest = await createInputSnapshot(fragments);
	const inventory = { version: 1, sourceId: manifest.id, scope, totalRecords: count, lists: [{ key: "cache:mail", state: "present", count }] };
	const state = beginAssemblyInventory(encode(inventory), { sourceId: manifest.id, scope, requiredLists: new Set(["cache:mail"]) });
	const source: InputSnapshotSource = { read: async (_id, i) => fragments[i] ?? null };
	return { records, fragments, manifest, source, checkpoint: { inventory: state, nextFragment: 0, complete: false } };
}

describe("bounded cache-only manifest projection", () => {
	it("packs 500 records into bounded fragments and matches the reference cache writes", async () => {
		const f = await fixture(500);
		expect(f.fragments).toHaveLength(32);
		expect(Math.max(...f.fragments.map((v) => v.byteLength))).toBeLessThanOrEqual(64 * 1024);
		const writes = [];
		let state = f.checkpoint;
		let complete = false;
		while (!complete) {
			const page = await projectCacheSnapshotPage(f.source, f.manifest, state);
			expect(page.writes.length).toBeLessThanOrEqual(16);
			writes.push(...page.writes);
			state = page.checkpoint;
			complete = page.complete;
		}
		expect(state.inventory.nextSequence).toBe(500);
		const digest = { id: "2026-10-24T06:30:00Z", date: "2026-10-24", generatedAt: "2026-10-24T06:30:00Z", model: "synthetic", query: "in:inbox", items: [], accounts: [], modelErrors: [] };
		const prepared = { digest, lists: new Map(), toCache: new Map(f.records.map((r) => [`mail:${r.messageId}`, r.value])), historyAliases: [], historyBefore: new Map(), learned: new Map(), statuses: [], mailboxes: new Map() };
		const snapshot = { lastRun: null, indexedRuns: [], cursors: {}, failureHolds: {}, histories: {} };
		const reference = buildAssemblyManifest({ now: new Date(digest.generatedAt), test: false } as any, [], prepared as any, snapshot);
		expect(writes).toEqual(reference.writes.filter((w) => w.key.startsWith("cls:")));
	});

	it("rejects missing proof, corrupt or missing pages, mismatches, and resumed replay", async () => {
		const f = await fixture(20);
		await expect(projectCacheSnapshotPage(null as any, f.manifest, f.checkpoint)).rejects.toThrow(/proof/);
		await expect(projectCacheSnapshotPage(f.source, { ...f.manifest, id: "0".repeat(64) }, f.checkpoint)).rejects.toThrow(/mismatch/);
		const first = await projectCacheSnapshotPage(f.source, f.manifest, f.checkpoint);
		expect(first.complete).toBe(false);
		expect(first.checkpoint.nextFragment).toBe(1);
		const missing: InputSnapshotSource = { read: async () => null };
		await expect(projectCacheSnapshotPage(missing, f.manifest, first.checkpoint)).rejects.toThrow(/Missing or corrupt/);
		const corrupt: InputSnapshotSource = { read: async () => new Uint8Array(f.fragments[1]!.length).fill(1) };
		await expect(projectCacheSnapshotPage(corrupt, f.manifest, first.checkpoint)).rejects.toThrow(/corrupt/);
		const replay = { ...first.checkpoint, nextFragment: 0 };
		await expect(projectCacheSnapshotPage(f.source, f.manifest, replay)).rejects.toThrow(/sequence/);
		const second = await projectCacheSnapshotPage(f.source, f.manifest, first.checkpoint);
		expect(second.complete).toBe(true);
		expect(second.checkpoint.inventory.nextSequence).toBe(20);
		await expect(projectCacheSnapshotPage(f.source, f.manifest, second.checkpoint)).rejects.toThrow(/mismatch/);
	});

	it("rejects unsupported lists and invalid packing instead of silently omitting them", async () => {
		const f = await fixture(1);
		const state = structuredClone(f.checkpoint);
		state.inventory.inventory.lists[0]!.state = "tombstone";
		await expect(projectCacheSnapshotPage(f.source, f.manifest, state)).rejects.toThrow(/Unsupported/);
		const fragment = encode(Array.from({ length: 17 }, (_, i) => f.records[0]));
		const manifest = await createInputSnapshot([fragment]);
		const inventory = { version: 1, sourceId: manifest.id, scope, totalRecords: 1, lists: [{ key: "cache:mail", state: "present", count: 1 }] };
		const checkpoint = { inventory: beginAssemblyInventory(encode(inventory), { sourceId: manifest.id, scope, requiredLists: new Set(["cache:mail"]) }), nextFragment: 0, complete: false };
		await expect(projectCacheSnapshotPage({ read: async () => fragment }, manifest, checkpoint)).rejects.toThrow(/packed/);
	});
});
