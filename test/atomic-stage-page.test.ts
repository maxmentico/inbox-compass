import { describe, expect, it } from "vitest";
import { stageVerifiedOutputPage, STAGE_PAGE_LIMITS, type AtomicStageStorage, type StageCursor, type StagedPage } from "../src/atomic-stage-page";

const scope = "a".repeat(22);
const attempt = "b".repeat(22);
const sourceId = "c".repeat(64);
const bytes = (s: string) => new TextEncoder().encode(s);

function store(totalRecords = 2) {
	let cursor: StageCursor = { scope, sourceId, generation: 1, attempt, expiresAt: Date.now() + 60_000, nextPage: 0, nextSequence: 0, totalRecords, complete: false };
	let pages = new Map<number, StagedPage>();
	let failCursor = false;
	const storage: AtomicStageStorage = { transactionSync: (work) => {
		let nextCursor = structuredClone(cursor);
		const nextPages = structuredClone(pages);
		const result = work({
			readCursor: () => structuredClone(nextCursor),
			readPage: (_scope, index) => nextPages.get(index) ?? null,
			writePage: (_scope, index, page) => { nextPages.set(index, structuredClone(page)); },
			writeCursor: (_scope, value) => { if (failCursor) throw new Error("injected crash"); nextCursor = structuredClone(value); },
		});
		cursor = nextCursor;
		pages = nextPages;
		return result;
	} };
	return { storage, cursor: () => structuredClone(cursor), pages: () => structuredClone(pages), crash: (v: boolean) => { failCursor = v; }, expire: () => { cursor.expiresAt = Date.now(); } };
}
const page = (index: number, value: string, final = false) => ({ scope, sourceId, generation: 1, attempt, page: index, startSequence: index, endSequence: index + 1, final, bytes: bytes(value) });

describe("atomic provisional output staging contract", () => {
	it("atomically stages pages with a cursor; exact retries are idempotent", async () => {
		const s = store();
		const first = page(0, "first");
		expect(await stageVerifiedOutputPage(s.storage, first)).toBe("staged");
		expect(s.cursor()).toMatchObject({ nextPage: 1, nextSequence: 1, complete: false });
		expect(await stageVerifiedOutputPage(s.storage, first)).toBe("already-staged");
		await expect(stageVerifiedOutputPage(s.storage, { ...first, bytes: bytes("other") })).rejects.toThrow(/Conflicting/);
		expect(await stageVerifiedOutputPage(s.storage, page(1, "second", true))).toBe("staged");
		expect(s.cursor()).toMatchObject({ nextPage: 2, nextSequence: 2, complete: true });
		await expect(stageVerifiedOutputPage(s.storage, page(2, "late", true))).rejects.toThrow(/Out-of-order/);
	});

	it("rolls back both page and cursor on a transaction failure, then accepts a retry", async () => {
		const s = store();
		s.crash(true);
		await expect(stageVerifiedOutputPage(s.storage, page(0, "first"))).rejects.toThrow(/injected crash/);
		expect(s.cursor()).toMatchObject({ nextPage: 0, nextSequence: 0 });
		expect(s.pages().size).toBe(0);
		s.crash(false);
		expect(await stageVerifiedOutputPage(s.storage, page(0, "first"))).toBe("staged");
	});

	it("rejects stale attempts, generation, source, skipped pages and oversized work", async () => {
		const s = store();
		await expect(stageVerifiedOutputPage(s.storage, { ...page(0, "x"), attempt: "d".repeat(22) })).rejects.toThrow(/Stale/);
		await expect(stageVerifiedOutputPage(s.storage, { ...page(0, "x"), generation: 2 })).rejects.toThrow(/Stale/);
		await expect(stageVerifiedOutputPage(s.storage, { ...page(0, "x"), sourceId: "e".repeat(64) })).rejects.toThrow(/Stale/);
		await expect(stageVerifiedOutputPage(s.storage, page(1, "skip", true))).rejects.toThrow(/Out-of-order/);
		await expect(stageVerifiedOutputPage(s.storage, { ...page(0, "x"), bytes: new Uint8Array(STAGE_PAGE_LIMITS.bytes + 1) })).rejects.toThrow(/Invalid/);
		s.expire();
		await expect(stageVerifiedOutputPage(s.storage, page(0, "expired"))).rejects.toThrow(/Stale/);
	});

	it("pins page bytes before hashing and serializes competing retries", async () => {
		const s = store();
		const input = page(0, "first");
		const first = stageVerifiedOutputPage(s.storage, input);
		input.bytes.fill(0);
		expect(await first).toBe("staged");
		expect(s.pages().get(0)?.bytes).toEqual(bytes("first"));
		const concurrent = await Promise.allSettled([stageVerifiedOutputPage(s.storage, page(1, "second", true)), stageVerifiedOutputPage(s.storage, page(1, "other", true))]);
		expect(concurrent.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(concurrent.filter((r) => r.status === "rejected")).toHaveLength(1);
	});
});
