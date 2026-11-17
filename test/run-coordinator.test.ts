import { afterEach, describe, expect, it, vi } from "vitest";
import { RunCoordinator } from "../src/run-coordinator";

// The same transitions are also exercised against the local Workers SQLite runtime. This
// in-memory SQL stand-in lets expiry be tested without waiting six minutes in the test suite.
function coordinator(failOn?: string) {
	let row: { owner: string; holder: string; expires_at: number } | undefined;
	const owners = new Map<string, number>();
	const sql = { exec(query: string, ...args: (string | number)[]) {
		if (query === failOn) throw new Error("injected storage failure");
		if (query === "SELECT owner FROM owners WHERE owner = ?") return { toArray: () => owners.has(args[0] as string) ? [{ owner: args[0] }] : [] };
		if (query === "SELECT released FROM owners WHERE owner = ?") return { toArray: () => owners.has(args[0] as string) ? [{ released: owners.get(args[0] as string) }] : [] };
		if (query === "INSERT INTO owners (owner) VALUES (?)") owners.set(args[0] as string, 0);
		if (query === "UPDATE owners SET released = 1 WHERE owner = ?") owners.set(args[0] as string, 1);
		if (query.startsWith("SELECT")) return { toArray: () => row ? [{ ...row }] : [] };
		if (query.startsWith("INSERT")) row = { owner: args[0] as string, holder: args[1] as string, expires_at: args[2] as number };
		if (query.startsWith("UPDATE") && row) row.expires_at = args[0] as number;
		if (query === "DELETE FROM lease WHERE id = 1") row = undefined;
		return { toArray: () => [] };
	} };
	const transactionSync = <T>(fn: () => T): T => {
		const savedRow = row ? { ...row } : undefined;
		const savedOwners = new Map(owners);
		try { return fn(); } catch (e) {
			row = savedRow;
			owners.clear();
			for (const [key, value] of savedOwners) owners.set(key, value);
			throw e;
		}
	};
	return new RunCoordinator({ storage: { sql, transactionSync, getAlarm: async () => null, setAlarm: async () => {} } } as unknown as DurableObjectState);
}

const owner = "a".repeat(22);
const other = "b".repeat(22);
const holder = { at: "2026-10-24T06:30:00Z", job: owner, driver: "web" };
async function call(c: RunCoordinator, op: string, body: unknown) {
	const r = await c.fetch(new Request(`https://coordinator/${op}`, { method: "POST", body: JSON.stringify(body) }));
	return { status: r.status, body: r.ok ? await r.json() as { ok: boolean; lease: { owner: string; expiresAt: number } | null } : null };
}

describe("run coordinator", () => {
	afterEach(() => vi.useRealTimers());
	it("expires a lease by server time, rejects its owner, and admits a new owner", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-10-24T06:30:00Z"));
		const c = coordinator();
		const first = await call(c, "acquire", { owner, holder });
		expect(first.body?.ok).toBe(true);
		vi.advanceTimersByTime(6 * 60_000);
		expect((await call(c, "inspect", {})).body?.lease).toBeNull();
		expect((await call(c, "renew", { owner })).body?.ok).toBe(false);
		expect((await call(c, "acquire", { owner: other, holder })).body?.ok).toBe(true);
		expect((await call(c, "release", { owner })).body?.ok).toBe(false);
		expect((await call(c, "inspect", {})).body?.lease?.owner).toBe(other);
	});
	it("renewal extends expiry from server time, and only the owner can release", async () => {
		vi.useFakeTimers();
		const c = coordinator();
		const first = await call(c, "acquire", { owner, holder });
		vi.advanceTimersByTime(5 * 60_000);
		expect((await call(c, "renew", { owner })).body?.lease?.expiresAt).toBe(first.body!.lease!.expiresAt + 5 * 60_000);
		vi.advanceTimersByTime(60_000);
		expect((await call(c, "inspect", {})).body?.lease?.owner).toBe(owner);
		expect((await call(c, "release", { owner: other })).body?.ok).toBe(false);
		expect((await call(c, "release", { owner })).body?.ok).toBe(true);
		expect((await call(c, "release", { owner })).body?.ok).toBe(true);
		expect((await call(c, "acquire", { owner, holder })).body?.ok).toBe(false);
	});
	it("returns the same lease for an ambiguous acquire retry without extending it", async () => {
		vi.useFakeTimers();
		const c = coordinator();
		const first = await call(c, "acquire", { owner, holder });
		vi.advanceTimersByTime(60_000);
		const retry = await call(c, "acquire", { owner, holder });
		expect(retry.body).toEqual(first.body);
		expect((await call(c, "acquire", { owner: other, holder })).body?.ok).toBe(false);
	});
	it("rejects malformed input without changing the lease", async () => {
		const c = coordinator();
		expect((await call(c, "acquire", { owner: "short", holder })).status).toBe(400);
		expect((await call(c, "acquire", { owner, holder: { ...holder, extra: true } })).status).toBe(400);
		expect((await call(c, "inspect", { owner })).status).toBe(400);
		expect((await call(c, "inspect", {})).body?.lease).toBeNull();
	});
	it("rolls back the owner tombstone when acquisition fails partway through", async () => {
		const c = coordinator("INSERT OR REPLACE INTO lease (id, owner, holder, expires_at) VALUES (1, ?, ?, ?)");
		await expect(call(c, "acquire", { owner, holder })).rejects.toThrow("injected storage failure");
		// If the owner insertion had survived, the same token would now be rejected before
		// reaching the injected failure. Reaching it again confirms the transaction rolled back.
		await expect(call(c, "acquire", { owner, holder })).rejects.toThrow("injected storage failure");
		expect((await call(c, "inspect", {})).body?.lease).toBeNull();
	});
	it("keeps active staged data until lease expiry and schedules bounded cleanup", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		const expiresAt = Date.now() + 60_000;
		const queries: string[] = [];
		const setAlarm = vi.fn(async (_at: number) => {});
		const sql = { exec(query: string) {
			queries.push(query);
			if (query.startsWith("SELECT expires_at FROM lease")) return { toArray: () => Date.now() < expiresAt ? [{ expires_at: expiresAt }] : [] };
			if (query.startsWith("SELECT COUNT(*) AS count FROM steps")) return { toArray: () => [{ count: 1 }] };
			if (query.startsWith("SELECT COUNT(*) AS count FROM publications")) return { toArray: () => [{ count: 0 }] };
			if (query.startsWith("SELECT MIN(expires_at)")) return { toArray: () => [{ earliest: null }] };
			return { toArray: () => [] };
		} };
		const storage = { sql, transactionSync: <T>(fn: () => T) => fn(), getAlarm: async () => null, setAlarm };
		const c = new RunCoordinator({ storage } as unknown as DurableObjectState);
		await c.alarm();
		expect(queries.some((q) => q.startsWith("DELETE FROM steps"))).toBe(false);
		expect(setAlarm).toHaveBeenLastCalledWith(expiresAt);
		vi.advanceTimersByTime(60_000);
		await c.alarm();
		expect(queries.some((q) => q.startsWith("DELETE FROM steps"))).toBe(true);
		expect(setAlarm).toHaveBeenLastCalledWith(expiresAt + 1000);
	});
});
