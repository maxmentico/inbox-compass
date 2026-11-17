// AES-256-GCM for refresh tokens at rest, plus small helpers for random tokens and hashing.
// KV is already encrypted at rest by Cloudflare; this layer means a leaked Cloudflare API token
// or KV export alone does not hand over working Google refresh tokens.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function base64UrlEncode(bytes: Uint8Array): string {
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(input: string): Uint8Array {
	const b64 = input.replace(/-/g, "+").replace(/_/g, "/");
	const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
	const bin = atob(padded);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function randomToken(bytes = 32): string {
	return base64UrlEncode(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison for equal-length secrets; unequal lengths return false. */
export function timingSafeEqual(a: string, b: string): boolean {
	const ab = enc.encode(a);
	const bb = enc.encode(b);
	if (ab.length !== bb.length) return false;
	let diff = 0;
	for (let i = 0; i < ab.length; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
	return diff === 0;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function importKey(rawKeyB64: string): Promise<CryptoKey> {
	let p = keyCache.get(rawKeyB64);
	if (!p) {
		p = (async () => {
			let raw: Uint8Array;
			try {
				raw = base64UrlDecode(rawKeyB64.trim());
			} catch {
				throw new Error("TOKEN_ENCRYPTION_KEY is not valid base64");
			}
			if (raw.length !== 32) {
				throw new Error(`TOKEN_ENCRYPTION_KEY must decode to 32 bytes (got ${raw.length})`);
			}
			return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
		})();
		// Don't cache failures.
		p.catch(() => keyCache.delete(rawKeyB64));
		keyCache.set(rawKeyB64, p);
	}
	return p;
}

/**
 * Encrypts `plaintext`, binding it to `context` (used as GCM additional data) so a ciphertext
 * copied to another account record fails to decrypt.
 */
export async function encryptString(plaintext: string, keyB64: string, context: string): Promise<string> {
	const key = await importKey(keyB64);
	const iv = crypto.getRandomValues(new Uint8Array(12));
	const ct = await crypto.subtle.encrypt(
		{ name: "AES-GCM", iv, additionalData: enc.encode(context) },
		key,
		enc.encode(plaintext),
	);
	return `v1.${base64UrlEncode(iv)}.${base64UrlEncode(new Uint8Array(ct))}`;
}

export async function decryptString(sealed: string, keyB64: string, context: string): Promise<string> {
	const [version, ivPart, ctPart, ...rest] = sealed.split(".");
	if (version !== "v1" || !ivPart || !ctPart || rest.length > 0) {
		throw new Error("Unrecognised ciphertext format");
	}
	const key = await importKey(keyB64);
	const pt = await crypto.subtle.decrypt(
		{ name: "AES-GCM", iv: base64UrlDecode(ivPart), additionalData: enc.encode(context) },
		key,
		base64UrlDecode(ctPart),
	);
	return dec.decode(pt);
}
