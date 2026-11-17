// EXPERIMENTAL: no production wiring. The coordinator must authenticate the inventory and expected
// list set from one strongly consistent generation; hashing a producer's own inventory is not proof
// that the producer captured all intended data.
import { z } from "zod";
import { ASSEMBLY_INPUT_LIMITS, parseAssemblyInputBatch, type AssemblyInputRecord } from "./assembly-input";

const scopeSchema = z.string().regex(/^[A-Za-z0-9_-]{22,128}$/);
const listKey = z.string().regex(/^[A-Za-z0-9_:-]{1,360}$/);
const entry = z.object({ key: listKey, state: z.enum(["present", "absent", "tombstone"]), count: z.number().int().min(0).max(ASSEMBLY_INPUT_LIMITS.records) }).strict();
const schema = z.object({
	version: z.literal(1), sourceId: z.string().regex(/^[a-f0-9]{64}$/), scope: scopeSchema,
	totalRecords: z.number().int().min(0).max(ASSEMBLY_INPUT_LIMITS.records), lists: z.array(entry).max(512),
}).strict();
export type AssemblyInventory = z.infer<typeof schema>;
export interface AssemblyInventoryCheckpoint {
	inventory: AssemblyInventory;
	/** A pinned local encoding; integrity depends on coordinator-owned checkpoint storage. */
	inventoryEncoding: string;
	nextSequence: number;
	seenKeys: Set<string>;
	counts: Map<string, number>;
}

/** Maps every supported record to exactly one independently inventoried list. */
export function assemblyRecordList(record: AssemblyInputRecord): string {
	switch (record.kind) {
		case "item": return `item:${record.collection}:${record.account}`;
		case "cache": case "failure": case "seen-times": return `${record.kind}:${record.account}`;
		case "history": case "recheck": return `${record.kind}:${record.account}:${record.list}`;
		case "sender-rule": case "item-flag": return `${record.kind}:${record.list}`;
		default: return record.kind;
	}
}

/**
 * `requiredLists` must come from the coordinator's authenticated job/snapshot plan, not from the
 * same untrusted producer that supplies the inventory. Presence with count 0 is distinct from absent
 * and tombstone. The last two cannot carry records and have different application semantics.
 */
export function beginAssemblyInventory(raw: Uint8Array, expected: { sourceId: string; scope: string; requiredLists: ReadonlySet<string> }): AssemblyInventoryCheckpoint {
	if (expected.requiredLists.size > 512) throw new Error("Assembly inventory exceeds limits");
	if (!(raw instanceof Uint8Array) || raw.byteLength === 0 || raw.byteLength > 64 * 1024) throw new Error("Invalid assembly inventory size");
	let value: unknown;
	try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(raw)); } catch { throw new Error("Invalid assembly inventory JSON"); }
	const parsed = schema.safeParse(value);
	if (!parsed.success || parsed.data.sourceId !== expected.sourceId || parsed.data.scope !== expected.scope) throw new Error("Invalid assembly inventory identity");
	const inventory = parsed.data;
	const keys = new Set<string>();
	let total = 0;
	for (const list of inventory.lists) {
		if (keys.has(list.key) || !expected.requiredLists.has(list.key) || (list.state !== "present" && list.count !== 0)) throw new Error("Invalid assembly inventory list");
		keys.add(list.key);
		total += list.count;
		if (total > ASSEMBLY_INPUT_LIMITS.records) throw new Error("Assembly inventory exceeds limits");
	}
	if (keys.size !== expected.requiredLists.size || total !== inventory.totalRecords) throw new Error("Incomplete assembly inventory");
	const inventoryEncoding = JSON.stringify(inventory);
	if (new TextEncoder().encode(inventoryEncoding).byteLength > 64 * 1024) throw new Error("Assembly inventory exceeds limits");
	return { inventory, inventoryEncoding, nextSequence: 0, seenKeys: new Set(), counts: new Map() };
}

/** Validate one bounded page and return a new checkpoint; the caller must persist it atomically. */
export function acceptAssemblyInventoryBatch(checkpoint: AssemblyInventoryCheckpoint, records: readonly Uint8Array[], verifiedSourceId: string): { checkpoint: AssemblyInventoryCheckpoint; records: AssemblyInputRecord[] } {
	if (JSON.stringify(checkpoint.inventory) !== checkpoint.inventoryEncoding) throw new Error("Assembly inventory changed");
	const inventory = checkpoint.inventory;
	const parsed = parseAssemblyInputBatch(records, verifiedSourceId, { sourceId: inventory.sourceId, scope: inventory.scope, nextSequence: checkpoint.nextSequence, seenKeys: checkpoint.seenKeys });
	const lists = new Map(inventory.lists.map((l) => [l.key, l]));
	const counts = new Map(checkpoint.counts);
	for (const record of parsed.records) {
		const key = assemblyRecordList(record);
		const list = lists.get(key);
		const next = (counts.get(key) ?? 0) + 1;
		if (!list || list.state !== "present" || next > list.count) throw new Error("Assembly record outside inventory");
		counts.set(key, next);
	}
	if (parsed.nextSequence > inventory.totalRecords) throw new Error("Assembly inventory record overflow");
	return { checkpoint: { ...checkpoint, nextSequence: parsed.nextSequence, seenKeys: parsed.seenKeys, counts }, records: parsed.records };
}

/** Returns presence metadata only after every declared record has been received and checked. */
export function finishAssemblyInventory(checkpoint: AssemblyInventoryCheckpoint): AssemblyInventory {
	if (JSON.stringify(checkpoint.inventory) !== checkpoint.inventoryEncoding) throw new Error("Assembly inventory changed");
	if (checkpoint.nextSequence !== checkpoint.inventory.totalRecords || checkpoint.inventory.lists.some((list) => (checkpoint.counts.get(list.key) ?? 0) !== list.count)) throw new Error("Incomplete assembly inventory");
	return structuredClone(checkpoint.inventory);
}
