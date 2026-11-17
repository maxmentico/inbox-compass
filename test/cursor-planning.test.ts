import { describe, expect, it } from "vitest";
import { calculateCursor, calculateHeldFailures, type DigestItem, type MailboxRun } from "../src/digest";

const NOW = new Date("2026-10-24T12:00:00.000Z");
const now = NOW.getTime();
const run: MailboxRun = { before: null, seenTimes: [], backlog: false };
const item = (messageId: string, at: number | null, classified: boolean): DigestItem => ({
	messageId,
	date: at === null ? null : new Date(at).toISOString(),
	classified,
} as DigestItem);

describe("cursor state calculations", () => {
	it("holds the cursor just before a newly failed message and returns the failure write", () => {
		const failed = item("failed", now - 20_000, false);
		const good = item("good", now - 10_000, true);
		const before = { old: now - 99_000 };
		const holds = calculateHeldFailures([failed], before, NOW);
		expect(holds).toEqual({ held: [failed], next: { failed: now } });
		expect(before).toEqual({ old: now - 99_000 });
		expect(calculateCursor(run, [failed, good], holds.held, NOW, null)).toEqual({ after: now - 20_001, checked: now });
	});

	it("keeps the cursor on an undated failure, but lets an expired hold go", () => {
		const missingDate = item("missing", null, false);
		const good = item("good", now - 10_000, true);
		const latest = { after: now - 50_000, share: 5 };
		const held = calculateHeldFailures([missingDate], {}, NOW);
		expect(calculateCursor(run, [missingDate, good], held.held, NOW, latest)).toEqual({ ...latest, checked: now });
		const expired = calculateHeldFailures([missingDate], { missing: now - 2 * 86_400_000 }, NOW);
		expect(expired.held).toEqual([]);
		expect(calculateCursor(run, [missingDate, good], expired.held, NOW, latest)).toEqual({ after: now - 10_000, checked: now });
		expect(calculateHeldFailures([], { missing: now }, NOW)).toEqual({ held: [], next: null });
	});

	it("preserves a newer supplied cursor and a backlog does not advance from seen times", () => {
		const earlier = item("old", now - 40_000, true);
		const latest = { after: now - 5_000, share: 15 };
		expect(calculateCursor(run, [earlier], [], NOW, latest)).toEqual({ ...latest, checked: now });
		const backlog = { ...run, backlog: true, seenTimes: [now - 1_000] };
		expect(calculateCursor(backlog, [], [], NOW, { after: now - 50_000 })).toEqual({ after: now - 50_000, checked: now });
	});
});
