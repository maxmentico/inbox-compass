// EXPERIMENTAL: a cache-only projection, not a complete assembly or commit protocol.
import { acceptAssemblyInventoryBatch, finishAssemblyInventory, type AssemblyInventoryCheckpoint } from "./assembly-inventory";
import { ASSEMBLY_INPUT_LIMITS } from "./assembly-input";
import { readInputSnapshotPage, type InputSnapshotManifest, type InputSnapshotSource } from "./input-snapshot";
import type { AssemblyWrite } from "./digest";

const CLASSIFICATION_TTL = 30 * 24 * 60 * 60;
export interface CacheAdapterPage {
	/** Writes are provisional until `complete` and an atomic coordinator publication. */
	writes: AssemblyWrite[];
	checkpoint: CacheAdapterCheckpoint;
	complete: boolean;
}
export interface CacheAdapterCheckpoint { inventory: AssemblyInventoryCheckpoint; nextFragment: number; complete: boolean }

/**
 * Projects at most one verified bounded snapshot page of cache DTOs into reference-compatible writes.
 * Each fragment contains a JSON array of up to 16 DTO records. The inventory and checkpoint come from a
 * trusted coordinator and be persisted together with staged output under a generation-fenced CAS.
 * A content ID alone proves bytes, not that the coordinator captured the complete source state.
 */
export async function projectCacheSnapshotPage(
	source: InputSnapshotSource,
	manifest: InputSnapshotManifest,
	checkpoint: CacheAdapterCheckpoint,
): Promise<CacheAdapterPage> {
	if (!source || typeof source.read !== "function" || !manifest || !checkpoint || !checkpoint.inventory?.inventory) throw new Error("Missing cache snapshot proof");
	const inventory = checkpoint.inventory.inventory;
	if (manifest.id !== inventory.sourceId || checkpoint.complete !== false || !Number.isSafeInteger(checkpoint.nextFragment) || checkpoint.nextFragment < 0 || checkpoint.nextFragment > manifest.fragments.length) throw new Error("Cache snapshot and inventory mismatch");
	// The cache-only adapter cannot apply other lists or deletions; do not silently ignore them.
	if (inventory.lists.some((list) => !list.key.startsWith("cache:") || list.state === "tombstone")) throw new Error("Unsupported cache inventory list");
	const page = await readInputSnapshotPage(source, manifest, inventory.sourceId, checkpoint.nextFragment, { maxBytes: 64 * 1024, maxFragments: 1 });
	let values: unknown[] = [];
	if (page.fragments.length) {
		let decoded: unknown;
		try { decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(page.fragments[0])); } catch { throw new Error("Invalid packed cache fragment"); }
		if (!Array.isArray(decoded) || decoded.length === 0 || decoded.length > ASSEMBLY_INPUT_LIMITS.batchRecords) throw new Error("Invalid packed cache fragment");
		values = decoded;
	}
	const encoder = new TextEncoder();
	const parsed = acceptAssemblyInventoryBatch(checkpoint.inventory, values.map((value) => encoder.encode(JSON.stringify(value))), inventory.sourceId);
	const writes: AssemblyWrite[] = parsed.records.map((record) => {
		if (record.kind !== "cache") throw new Error("Unsupported cache snapshot record");
		return {
			kind: "put",
			key: `cls:${record.account}:${record.messageId}`,
			value: JSON.stringify(record.value),
			expirationTtl: CLASSIFICATION_TTL,
			...(record.value.arrived === undefined ? {} : { metadata: { arrived: record.value.arrived } }),
		};
	});
	const complete = page.next === null;
	if (complete) finishAssemblyInventory(parsed.checkpoint);
	return { writes, checkpoint: { inventory: parsed.checkpoint, nextFragment: page.next ?? manifest.fragments.length, complete }, complete };
}
