import { describe, expect, it } from "vitest";
import { acceptAssemblyInventoryBatch, beginAssemblyInventory, finishAssemblyInventory } from "../src/assembly-inventory";

const scope = "a".repeat(22);
const sourceId = "b".repeat(64);
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const account = (sequence = 0, alias = "mail") => ({ version: 1, scope, sequence, kind: "account", alias, email: `${alias}@example.com`, identityVersion: "c".repeat(22) });
const lists = [
	{ key: "account", state: "present", count: 1 },
	{ key: "history:mail:before", state: "present", count: 0 },
	{ key: "history:mail:learned", state: "absent", count: 0 },
	{ key: "recheck:mail:before", state: "tombstone", count: 0 },
];
const inventory = () => ({ version: 1, sourceId, scope, totalRecords: 1, lists });
const expected = () => ({ sourceId, scope, requiredLists: new Set(lists.map((l) => l.key)) });

describe("coordinator-authenticated assembly inventories", () => {
	it("distinguishes empty, absent and tombstone lists after receiving all declared records", () => {
		const start = beginAssemblyInventory(encode(inventory()), expected());
		expect(() => finishAssemblyInventory(start)).toThrow(/Incomplete/);
		const page = acceptAssemblyInventoryBatch(start, [encode(account())], sourceId);
		expect(start.nextSequence).toBe(0);
		expect(finishAssemblyInventory(page.checkpoint).lists).toEqual(lists);
	});

	it("rejects a truncated inventory, invalid presence/count, and identity mismatch", () => {
		expect(() => beginAssemblyInventory(encode({ ...inventory(), lists: lists.slice(0, -1) }), expected())).toThrow(/Incomplete/);
		expect(() => beginAssemblyInventory(encode({ ...inventory(), lists: [lists[0], { key: "history:mail:before", state: "absent", count: 1 }, ...lists.slice(2)] }), expected())).toThrow(/list/);
		expect(() => beginAssemblyInventory(encode(inventory()), { ...expected(), sourceId: "f".repeat(64) })).toThrow(/identity/);
		expect(() => beginAssemblyInventory(encode({ ...inventory(), version: 2 }), expected())).toThrow(/identity/);
	});

	it("rejects missing pages, replay, over-counts and records in tombstoned lists", () => {
		const start = beginAssemblyInventory(encode(inventory()), expected());
		expect(() => acceptAssemblyInventoryBatch(start, [encode(account(1))], sourceId)).toThrow(/sequence/);
		const page = acceptAssemblyInventoryBatch(start, [encode(account())], sourceId);
		expect(() => acceptAssemblyInventoryBatch(page.checkpoint, [encode(account())], sourceId)).toThrow(/sequence/);
		expect(() => acceptAssemblyInventoryBatch(page.checkpoint, [encode(account(1, "other"))], sourceId)).toThrow(/inventory/);
		const deleted = { version: 1, scope, sequence: 1, kind: "recheck", account: "mail", list: "before", messageId: "m1", added: 1 };
		expect(() => acceptAssemblyInventoryBatch(page.checkpoint, [encode(deleted)], sourceId)).toThrow(/inventory/);
	});

	it("rejects changed inventory and credential fields", () => {
		const start = beginAssemblyInventory(encode(inventory()), expected());
		start.inventory.lists[0]!.count = 0;
		expect(() => acceptAssemblyInventoryBatch(start, [encode(account())], sourceId)).toThrow(/changed/);
		expect(() => beginAssemblyInventory(encode({ ...inventory(), sealedRefreshToken: "sentinel" }), expected())).toThrow(/identity/);
	});
});
