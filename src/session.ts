// Owner web session: an AES-GCM sealed cookie (no server-side session store).
//
// The cookie carries the owner's Google subject/email, an expiry and a per-session CSRF token.
// Every read re-checks the email against OWNER_EMAIL, so changing it ends existing sessions;
// rotating TOKEN_ENCRYPTION_KEY ends all sessions (and invalidates stored mailbox tokens).

import { isOwner, SESSION_TTL_SECONDS } from "./config";
import { decryptString, encryptString, randomToken, timingSafeEqual } from "./crypto";
import { clearCookie, cookie, readCookie } from "./flow";

export const SESSION_COOKIE = "__Host-idg-session";
const SESSION_CONTEXT = "web-session";

export interface Session {
	sub: string;
	email: string;
	/** Expiry, ms since epoch. */
	exp: number;
	/** Per-session CSRF token, embedded in every form. */
	csrf: string;
}

export async function createSessionCookie(
	env: Pick<Env, "TOKEN_ENCRYPTION_KEY">,
	identity: { sub: string; email: string },
	now = Date.now(),
): Promise<string> {
	const session: Session = {
		sub: identity.sub,
		email: identity.email,
		exp: now + SESSION_TTL_SECONDS * 1000,
		csrf: randomToken(24),
	};
	const sealed = await encryptString(JSON.stringify(session), env.TOKEN_ENCRYPTION_KEY, SESSION_CONTEXT);
	return cookie(SESSION_COOKIE, sealed, SESSION_TTL_SECONDS);
}

export function clearSessionCookie(): string {
	return clearCookie(SESSION_COOKIE);
}

export async function readSession(
	request: Request,
	env: Pick<Env, "TOKEN_ENCRYPTION_KEY" | "OWNER_EMAIL">,
	now = Date.now(),
): Promise<Session | null> {
	const raw = readCookie(request, SESSION_COOKIE);
	if (!raw) return null;
	let session: Session;
	try {
		session = JSON.parse(await decryptString(raw, env.TOKEN_ENCRYPTION_KEY, SESSION_CONTEXT)) as Session;
	} catch {
		return null;
	}
	if (typeof session.exp !== "number" || session.exp < now) return null;
	// Sessions are only minted for a verified owner email; re-check against current config.
	if (!isOwner({ email: session.email, email_verified: true }, env)) return null;
	if (typeof session.csrf !== "string" || session.csrf.length < 16) return null;
	return session;
}

/**
 * Validates a state-changing POST: the form's CSRF token must match the session's, and when the
 * browser sends Origin it must be this site. (SameSite=Lax already blocks most cross-site POSTs.)
 */
export function checkCsrf(request: Request, session: Session, formToken: unknown): boolean {
	const origin = request.headers.get("Origin");
	if (origin && origin !== new URL(request.url).origin) return false;
	return typeof formToken === "string" && timingSafeEqual(formToken, session.csrf);
}
