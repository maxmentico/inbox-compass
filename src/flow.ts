// Short-lived state for browser OAuth round trips to Google, bound to the browser that started them.
//
// The `state` sent to Google is random; the matching record lives in MAILBOX_KV for FLOW_TTL_SECONDS
// and is deleted on first use. A __Host- cookie holding the same value proves the callback is
// arriving in the browser that started the flow (login-CSRF / state-injection protection).

import { FLOW_TTL_SECONDS } from "./config";
import { randomToken, timingSafeEqual } from "./crypto";

export type FlowRecord = { kind: "login" } | { kind: "link"; alias: string; replace: boolean };

const FLOW_PREFIX = "flow:";
export const FLOW_COOKIE = "__Host-idg-flow";

export function cookie(name: string, value: string, maxAge: number): string {
	return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookie(name: string): string {
	return `${name}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function readCookie(request: Request, name: string): string | undefined {
	const header = request.headers.get("Cookie");
	if (!header) return undefined;
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx < 0) continue;
		if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
	}
	return undefined;
}

export async function startFlow(kv: KVNamespace, record: FlowRecord): Promise<{ state: string; setCookie: string }> {
	const state = randomToken(32);
	await kv.put(FLOW_PREFIX + state, JSON.stringify(record), { expirationTtl: FLOW_TTL_SECONDS });
	return { state, setCookie: cookie(FLOW_COOKIE, state, FLOW_TTL_SECONDS) };
}

export class FlowError extends Error {}

/** Validates state against the cookie and KV, then deletes it (single use). */
export async function consumeFlow(kv: KVNamespace, request: Request, state: string | undefined): Promise<FlowRecord> {
	if (!state) throw new FlowError("Missing state parameter.");
	const bound = readCookie(request, FLOW_COOKIE);
	if (!bound || !timingSafeEqual(bound, state)) {
		throw new FlowError("This sign-in wasn't started in this browser, or it expired. Start again.");
	}
	const key = FLOW_PREFIX + state;
	const record = await kv.get<FlowRecord>(key, "json");
	if (!record) throw new FlowError("This sign-in has expired or was already used. Start again.");
	await kv.delete(key);
	return record;
}
