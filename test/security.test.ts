import { describe, expect, it } from "vitest";
import { getAccount, saveAccount, validateAlias } from "../src/accounts";
import { canModify, canRead, digestConfig, GMAIL_MODIFY_SCOPE, GMAIL_READONLY_SCOPE, isOwner, localDate, mailboxScope } from "../src/config";
import { base64UrlDecode, base64UrlEncode, decryptString, encryptString, timingSafeEqual } from "../src/crypto";
import { consumeFlow, FLOW_COOKIE, FlowError, startFlow } from "../src/flow";
import { checkCsrf, createSessionCookie, readSession, SESSION_COOKIE } from "../src/session";
import { memoryKV, TEST_KEY } from "./helpers";

describe("token encryption", () => {
	it("round-trips and binds ciphertext to its context", async () => {
		const sealed = await encryptString("refresh-token-123", TEST_KEY, "account:mentico");
		expect(sealed).not.toContain("refresh-token-123");
		await expect(decryptString(sealed, TEST_KEY, "account:mentico")).resolves.toBe("refresh-token-123");
		await expect(decryptString(sealed, TEST_KEY, "account:personal")).rejects.toThrow();
	});
	it("detects tampering and rejects short keys", async () => {
		const sealed = await encryptString("secret", TEST_KEY, "ctx");
		const [v, iv, ct] = sealed.split(".");
		// Flip one bit of a real ciphertext byte (not base64 padding bits), first and last.
		for (const at of [0, -1]) {
			const bytes = base64UrlDecode(ct!);
			const i = at < 0 ? bytes.length + at : at;
			bytes[i] = bytes[i]! ^ 1;
			await expect(decryptString(`${v}.${iv}.${base64UrlEncode(bytes)}`, TEST_KEY, "ctx")).rejects.toThrow();
		}
		await expect(encryptString("x", Buffer.alloc(16).toString("base64"), "c")).rejects.toThrow(/32 bytes/);
	});
	it("timingSafeEqual", () => {
		expect(timingSafeEqual("abc", "abc")).toBe(true);
		expect(timingSafeEqual("abc", "abd")).toBe(false);
		expect(timingSafeEqual("abc", "abcd")).toBe(false);
	});
});

describe("owner check", () => {
	const env = { OWNER_EMAIL: " Max@Example.com " };
	it("requires a verified, case-insensitively matching email and fails closed", () => {
		expect(isOwner({ email: "max@example.com", email_verified: true }, env)).toBe(true);
		expect(isOwner({ email: "max@example.com", email_verified: false }, env)).toBe(false);
		expect(isOwner({ email: "max@example.com.evil.io", email_verified: true }, env)).toBe(false);
		expect(isOwner({ email: "", email_verified: true }, { OWNER_EMAIL: "" })).toBe(false);
	});
});

describe("web session", () => {
	const env = { TOKEN_ENCRYPTION_KEY: TEST_KEY, OWNER_EMAIL: "owner@example.com" };
	const req = (cookieHeader?: string, init: RequestInit = {}) =>
		new Request("https://app.test/app", { ...init, headers: { ...(cookieHeader ? { Cookie: cookieHeader } : {}), ...(init.headers ?? {}) } });
	const value = (setCookie: string) => setCookie.split(";")[0]!;

	it("is a hardened cookie that round-trips", async () => {
		const set = await createSessionCookie(env, { sub: "123", email: "owner@example.com" });
		expect(set).toMatch(new RegExp(`^${SESSION_COOKIE}=v1\\.`));
		for (const attr of ["Secure", "HttpOnly", "SameSite=Lax", "Path=/"]) expect(set).toContain(attr);
		const s = await readSession(req(value(set)), env);
		expect(s).toMatchObject({ sub: "123", email: "owner@example.com" });
		expect(s!.csrf.length).toBeGreaterThanOrEqual(16);
	});

	it("rejects expired, tampered, foreign-key, and no-longer-owner sessions", async () => {
		const set = await createSessionCookie(env, { sub: "1", email: "owner@example.com" }, 0);
		expect(await readSession(req(value(set)), env)).toBeNull(); // expired (minted at epoch)
		const fresh = value(await createSessionCookie(env, { sub: "1", email: "owner@example.com" }));
		expect(await readSession(req(`${fresh}x`), env)).toBeNull();
		expect(await readSession(req(fresh), { ...env, TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64") })).toBeNull();
		expect(await readSession(req(fresh), { ...env, OWNER_EMAIL: "someone-else@example.com" })).toBeNull();
		expect(await readSession(req(), env)).toBeNull();
	});

	it("CSRF requires the session token and a same-site Origin when present", async () => {
		const s = (await readSession(req(value(await createSessionCookie(env, { sub: "1", email: "owner@example.com" }))), env))!;
		expect(checkCsrf(req(undefined, { method: "POST" }), s, s.csrf)).toBe(true);
		expect(checkCsrf(req(undefined, { method: "POST", headers: { Origin: "https://app.test" } }), s, s.csrf)).toBe(true);
		expect(checkCsrf(req(undefined, { method: "POST", headers: { Origin: "https://evil.test" } }), s, s.csrf)).toBe(false);
		expect(checkCsrf(req(undefined, { method: "POST" }), s, "wrong-token-xxxxxxxxxxxx")).toBe(false);
		expect(checkCsrf(req(undefined, { method: "POST" }), s, null)).toBe(false);
	});
});

describe("OAuth flow state", () => {
	const reqWithCookie = (v?: string) => new Request("https://x.test/callback", { headers: v ? { Cookie: `other=1; ${FLOW_COOKIE}=${v}` } : {} });
	it("is single-use and bound to the starting browser", async () => {
		const kv = memoryKV();
		const { state } = await startFlow(kv, { kind: "link", alias: "a", replace: false });
		await expect(consumeFlow(kv, reqWithCookie(), state)).rejects.toBeInstanceOf(FlowError);
		await expect(consumeFlow(kv, reqWithCookie("someone-elses"), state)).rejects.toBeInstanceOf(FlowError);
		await expect(consumeFlow(kv, reqWithCookie(state), state)).resolves.toMatchObject({ kind: "link", alias: "a" });
		await expect(consumeFlow(kv, reqWithCookie(state), state)).rejects.toBeInstanceOf(FlowError);
	});
});

describe("config", () => {
	it("scopes", () => {
		expect(mailboxScope({ ENABLE_MARK_READ: "true" })).toBe(GMAIL_MODIFY_SCOPE);
		expect(mailboxScope({})).toBe(GMAIL_READONLY_SCOPE);
		expect(canRead([GMAIL_READONLY_SCOPE])).toBe(true);
		expect(canModify([GMAIL_READONLY_SCOPE])).toBe(false);
	});
	it("digest settings fall back safely", () => {
		expect(digestConfig({})).toMatchObject({ query: "in:inbox", maxPerAccount: 300, model: "@cf/openai/gpt-oss-120b", timeZone: "Europe/London" });
		expect(digestConfig({ DIGEST_MAX_PER_ACCOUNT: "500", DIGEST_TIMEZONE: "Mars/Olympus" })).toMatchObject({ maxPerAccount: 300, timeZone: "Europe/London" });
		expect(digestConfig({ DIGEST_MAX_PER_ACCOUNT: "0" }).maxPerAccount).toBe(1);
	});
	it("only ever uses Cloudflare-hosted @cf/ model ids", () => {
		expect(digestConfig({}).fallbackModel).toBe("@cf/google/gemma-4-26b-a4b-it");
		expect(digestConfig({ DIGEST_MODEL: "@cf/deepseek-ai/deepseek-v4.1-flash-1017" }).model).toBe("@cf/deepseek-ai/deepseek-v4.1-flash-1017");
		for (const bad of ["anthropic/claude-opus-5.5", "openai/gpt-5.5", "dynamic/fast", "workers-ai/@cf/openai/gpt-oss-120b", "@cf/openai", " "]) {
			expect(digestConfig({ DIGEST_MODEL: bad }).model).toBe("@cf/openai/gpt-oss-120b");
			expect(digestConfig({ DIGEST_FALLBACK_MODEL: bad }).fallbackModel).toBe("@cf/google/gemma-4-26b-a4b-it");
		}
		expect(digestConfig({ DIGEST_FALLBACK_MODEL: "none" }).fallbackModel).toBeNull();
	});
	it("local dates follow UK clock changes", () => {
		expect(localDate(new Date("2026-10-24T23:30:00Z"), "Europe/London")).toBe("2026-10-25"); // BST
		expect(localDate(new Date("2026-10-25T23:30:00Z"), "Europe/London")).toBe("2026-10-25"); // GMT
	});
	it("aliases", () => {
		expect(validateAlias(" Mentico ")).toBe("mentico");
		for (const bad of ["", "-x", "a b", "a/b", "x".repeat(33), "account:x"]) expect(() => validateAlias(bad)).toThrow();
	});
});

describe("account storage", () => {
	it("never stores the refresh token in plaintext", async () => {
		const kv = memoryKV();
		await saveAccount({ MAILBOX_KV: kv, TOKEN_ENCRYPTION_KEY: TEST_KEY }, { alias: "m", email: "a@b.c", scopes: [GMAIL_MODIFY_SCOPE], refreshToken: "1//super-secret" });
		expect([...kv.store.values()].join("")).not.toContain("super-secret");
		expect((await getAccount(kv, "m"))?.email).toBe("a@b.c");
	});
});
