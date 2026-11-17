import { describe, expect, it, vi } from "vitest";
import { pinAtomicState, withAtomicState } from "../src/atomic-kv";

const json = (value: unknown) => Promise.resolve(Response.json(value));

describe("atomic KV bulk reads", () => {
	it("uses one authority request for a 100-key bulk read", async () => {
		const requests: string[] = [];
		const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = input instanceof Request ? input : new Request(input, init);
			const operation = new URL(request.url).pathname.split("/").pop()!;
			requests.push(operation);
			const body = await request.json() as { keys?: string[]; seq?: number; pin?: string };
			if (operation === "head") return Response.json({ head: { generation: "generation", seq: 1 } });
			if (operation === "pin") return Response.json({ pin: body.pin, head: { generation: "generation", seq: 1 }, expiresAt: Date.now() + 60_000 });
			if (operation === "read-many") return Response.json({ items: body.keys!.map((key) => ({ key, kind: "value", data: btoa("1"), metadata: null })) });
			return new Response(null, { status: 404 });
		});
		const namespace = { idFromName: () => ({}), get: () => ({ fetch: fetcher }) } as unknown as DurableObjectNamespace;
		const legacy = { get: vi.fn(() => json(new Map())) } as unknown as KVNamespace;
		const env = withAtomicState({ MAILBOX_KV: legacy, JOB_AUTHORITY: namespace, ATOMIC_STATE_MODE: "active" } as Env);
		const keys = Array.from({ length: 100 }, (_, index) => `done:mail:message-${index}`);

		const values = await env.MAILBOX_KV.get(keys, "text");

		expect([...values.values()]).toEqual(Array(100).fill("1"));
		expect(requests).toEqual(["head", "pin", "read-many"]);
		expect(legacy.get).not.toHaveBeenCalled();

		await expect(pinAtomicState(env.MAILBOX_KV, 1)).resolves.toBeUndefined();
		expect(requests).toEqual(["head", "pin", "read-many"]);
		await expect(pinAtomicState(env.MAILBOX_KV, 2)).rejects.toThrow("different generation");
	});
});
