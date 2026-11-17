import { afterEach, describe, expect, it, vi } from "vitest";
import { _clearAccessTokenCache, getAccount } from "../src/accounts";
import { GmailClient, RATE_LIMIT_RETRY } from "../src/gmail";
import { batchResponse, idsInBatch, linkAccount, makeEnv } from "./helpers";

describe("Gmail batch transient failures", () => {
	const originalDelay = RATE_LIMIT_RETRY.delayMs;
	afterEach(() => {
		RATE_LIMIT_RETRY.delayMs = originalDelay;
		_clearAccessTokenCache();
		vi.unstubAllGlobals();
	});

	it("retries outer failures and only transient parts, preserving permanent failures", async () => {
		RATE_LIMIT_RETRY.delayMs = 0;
		const env = makeEnv();
		await linkAccount(env, "mail");
		const client = new GmailClient(env, (await getAccount(env.MAILBOX_KV, "mail"))!);
		const requests: string[][] = [];
		let call = 0;
		vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			if (String(input).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "token", expires_in: 3599 });
			const ids = idsInBatch(String(init?.body));
			requests.push(ids);
			call++;
			if (call === 1) return new Response("unavailable", { status: 503 });
			return batchResponse(ids.map((id, i) => ({
				id: String(i),
				status: id === "permanent" ? 403 : call === 2 && id === "retry" ? 503 : call === 2 && id === "quota" ? 403 : 200,
				body: id === "quota" && call === 2 ? { error: { errors: [{ reason: "userRateLimitExceeded" }] } } : { id, threadId: id },
			})));
		}));
		const result = await client.batchGetFull(["ok", "retry", "quota", "permanent"]);
		expect(requests).toEqual([["ok", "retry", "quota", "permanent"], ["ok", "retry", "quota", "permanent"], ["retry", "quota"]]);
		expect(result.messages.map((message) => message.id)).toEqual(["ok", "retry", "quota"]);
		expect(result.failed).toEqual([{ id: "permanent", status: 403 }]);
	});
});
