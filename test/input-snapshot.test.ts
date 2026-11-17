import { describe, expect, it } from "vitest";
import { createInputSnapshot, INPUT_SNAPSHOT_LIMITS, prepareInputSnapshot, readInputSnapshotPage, reconstructSmallInputSnapshot, startSnapshotVerification, validateInputSnapshot, verifyInputSnapshot, verifyNextSnapshotPage, type InputSnapshotSource, type SnapshotCheckpointStore } from "../src/input-snapshot";

const scope = "a".repeat(22);
const bytes = (s: string) => new TextEncoder().encode(s);
const sourceOf = (chunks: (Uint8Array | null)[]): InputSnapshotSource => ({ read: async (_id, index) => chunks[index] ?? null });
function checkpointStore(): SnapshotCheckpointStore {
	const states = new Map<string, { next: number; complete: boolean }>();
	return {
		create: async (id) => { if (states.has(id)) return false; states.set(id, { next: 0, complete: false }); return true; },
		read: async (id) => states.get(id) ?? null,
		compareAndAdvance: async (id, expected, next, complete) => {
			const state = states.get(id);
			if (!state || state.complete || state.next !== expected) return false;
			states.set(id, { next, complete });
			return true;
		},
	};
}

describe("content-addressed input snapshots", () => {
	it("pins fragment membership and bytes before asynchronous hashing", async () => {
		const chunks = Array.from({ length: INPUT_SNAPSHOT_LIMITS.fragments }, () => bytes("a"));
		const pending = prepareInputSnapshot(chunks);
		chunks[0]![0] = 98;
		chunks.push(bytes("extra"));
		const prepared = await pending;
		expect(prepared.fragments).toHaveLength(INPUT_SNAPSHOT_LIMITS.fragments);
		expect(prepared.fragments[0]).toEqual(bytes("a"));
		await expect(verifyInputSnapshot(sourceOf(prepared.fragments), prepared.manifest, prepared.manifest.id)).resolves.toBeUndefined();
	});
	it("reconstructs ordered UTF-8 fragments and changes identity for another version or order", async () => {
		const chunks = [bytes("one "), bytes("✓"), bytes(" three")];
		const manifest = await createInputSnapshot(chunks);
		expect(await reconstructSmallInputSnapshot(sourceOf(chunks), manifest, manifest.id)).toEqual(bytes("one ✓ three"));
		expect((await createInputSnapshot([chunks[2]!, chunks[1]!, chunks[0]!])).id).not.toBe(manifest.id);
		await expect(validateInputSnapshot({ ...manifest, version: 2 } as any, manifest.id)).rejects.toThrow(/version/);
		await expect(validateInputSnapshot(manifest, "0".repeat(64))).rejects.toThrow(/version/);
	});

	it("rejects missing, modified, reordered, and descriptor-tampered fragments", async () => {
		const chunks = [bytes("alpha"), bytes("bravo"), bytes("charlie")];
		const manifest = await createInputSnapshot(chunks);
		await expect(verifyInputSnapshot(sourceOf([chunks[0]!, null, chunks[2]!]), manifest, manifest.id)).rejects.toThrow(/Missing or corrupt/);
		await expect(verifyInputSnapshot(sourceOf([bytes("Alpha"), chunks[1]!, chunks[2]!]), manifest, manifest.id)).rejects.toThrow(/Missing or corrupt/);
		await expect(verifyInputSnapshot(sourceOf([chunks[1]!, chunks[0]!, chunks[2]!]), manifest, manifest.id)).rejects.toThrow(/Missing or corrupt/);
		const changed = structuredClone(manifest);
		changed.fragments.reverse();
		await expect(validateInputSnapshot(changed, manifest.id)).rejects.toThrow(/integrity/);
	});

	it("verifies full completeness through bounded pages and refuses undersized budgets", async () => {
		const chunks = Array.from({ length: 20 }, (_, i) => new Uint8Array(1024).fill(i));
		const manifest = await createInputSnapshot(chunks);
		const calls: number[] = [];
		const source: InputSnapshotSource = { read: async (_id, index) => { calls.push(index); return chunks[index] ?? null; } };
		const first = await readInputSnapshotPage(source, manifest, manifest.id, 0, { maxBytes: 2048, maxFragments: 2 });
		expect(first.next).toBe(2);
		expect(first.fragments).toHaveLength(2);
		expect(calls).toEqual([0, 1]);
		await expect(readInputSnapshotPage(source, manifest, manifest.id, 0, { maxBytes: 1023, maxFragments: 1 })).rejects.toThrow(/page budget/);
		await verifyInputSnapshot(source, manifest, manifest.id);
		expect(calls.slice(2)).toEqual(Array.from({ length: 20 }, (_, i) => i));
		await expect(verifyInputSnapshot(sourceOf([...chunks.slice(0, 19), null]), manifest, manifest.id)).rejects.toThrow(/Missing or corrupt/);
	});

	it("enforces fragment, page, descriptor and reconstruction bounds", async () => {
		await expect(createInputSnapshot([new Uint8Array(INPUT_SNAPSHOT_LIMITS.fragmentBytes + 1)])).rejects.toThrow(/size/);
		await expect(createInputSnapshot(Array.from({ length: INPUT_SNAPSHOT_LIMITS.fragments + 1 }, () => bytes("x")))).rejects.toThrow(/limit/);
		const chunks = Array.from({ length: 5 }, () => new Uint8Array(INPUT_SNAPSHOT_LIMITS.fragmentBytes));
		const manifest = await createInputSnapshot(chunks);
		await expect(reconstructSmallInputSnapshot(sourceOf(chunks), manifest, manifest.id)).rejects.toThrow(/reconstruction budget/);
		await expect(readInputSnapshotPage(sourceOf(chunks), manifest, manifest.id, 0, { maxBytes: INPUT_SNAPSHOT_LIMITS.pageBytes + 1, maxFragments: 1 })).rejects.toThrow(/bounds/);
	});

	it("returns a private verified copy even if the source later mutates", async () => {
		const chunks = [bytes("alpha")];
		const manifest = await createInputSnapshot(chunks);
		const page = await readInputSnapshotPage(sourceOf(chunks), manifest, manifest.id, 0, { maxBytes: 5, maxFragments: 1 });
		chunks[0]![0] = 0;
		expect(page.fragments[0]).toEqual(bytes("alpha"));
		await expect(verifyInputSnapshot(sourceOf(chunks), manifest, manifest.id)).rejects.toThrow(/corrupt/);
	});

	it("resumes from an atomic version-bound checkpoint and rejects skips and replays", async () => {
		const chunks = [bytes("a"), bytes("b"), bytes("c")];
		const manifest = await createInputSnapshot(chunks);
		const other = await createInputSnapshot([bytes("different")]);
		const store = checkpointStore();
		const source = sourceOf(chunks);
		const options = { maxBytes: 1, maxFragments: 1 };
		await startSnapshotVerification(store, manifest, manifest.id, scope);
		await expect(startSnapshotVerification(store, manifest, manifest.id, scope)).rejects.toThrow(/already started/);
		await expect(verifyNextSnapshotPage(store, source, manifest, manifest.id, scope, 1, options)).rejects.toThrow(/out of order/);
		await expect(verifyNextSnapshotPage(store, source, manifest, other.id, scope, 0, options)).rejects.toThrow(/version/);
		expect(await verifyNextSnapshotPage(store, source, manifest, manifest.id, scope, 0, options)).toEqual({ next: 1, complete: false });
		await expect(verifyNextSnapshotPage(store, source, manifest, manifest.id, scope, 0, options)).rejects.toThrow(/out of order/);
		// A lost response is reconciled from authoritative state; another generation starts separately.
		const otherScope = "b".repeat(22);
		await startSnapshotVerification(store, manifest, manifest.id, otherScope);
		expect(await store.read(`${otherScope}:${manifest.id}`)).toEqual({ next: 0, complete: false });
		expect(await store.read(`${scope}:${manifest.id}`)).toEqual({ next: 1, complete: false });
		await expect(verifyNextSnapshotPage(store, sourceOf([chunks[0]!, null, chunks[2]!]), manifest, manifest.id, scope, 1, options)).rejects.toThrow(/corrupt/);
		expect(await store.read(`${scope}:${manifest.id}`)).toEqual({ next: 1, complete: false });
		expect(await verifyNextSnapshotPage(store, source, manifest, manifest.id, scope, 1, options)).toEqual({ next: 2, complete: false });
		expect(await verifyNextSnapshotPage(store, source, manifest, manifest.id, scope, 2, options)).toEqual({ next: 3, complete: true });
		await expect(verifyNextSnapshotPage(store, source, manifest, manifest.id, scope, 3, options)).rejects.toThrow(/complete/);
	});

	it("accepts only one concurrent verifier for the same page", async () => {
		const chunks = [bytes("a"), bytes("b")];
		const manifest = await createInputSnapshot(chunks);
		const store = checkpointStore();
		await startSnapshotVerification(store, manifest, manifest.id, scope);
		const verify = () => verifyNextSnapshotPage(store, sourceOf(chunks), manifest, manifest.id, scope, 0, { maxBytes: 1, maxFragments: 1 });
		const result = await Promise.allSettled([verify(), verify()]);
		expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(result.filter((r) => r.status === "rejected")).toHaveLength(1);
		expect(await store.read(`${scope}:${manifest.id}`)).toEqual({ next: 1, complete: false });
	});
});
