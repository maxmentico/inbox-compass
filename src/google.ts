// Google OAuth 2.0 endpoints used for (a) owner sign-in and (b) linking mailboxes.

import { netFetch } from "./telemetry";

export const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
export const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

export interface GoogleTokenResponse {
	access_token: string;
	expires_in: number;
	refresh_token?: string;
	scope?: string;
	token_type?: string;
	id_token?: string;
}

export class GoogleAuthError extends Error {
	constructor(
		message: string,
		/** Google's OAuth error code, e.g. "invalid_grant" when a refresh token is revoked or expired. */
		readonly code?: string,
	) {
		super(message);
		this.name = "GoogleAuthError";
	}
}

export function buildAuthorizeUrl(opts: {
	clientId: string;
	redirectUri: string;
	scope: string;
	state: string;
	offline?: boolean;
	prompt?: string;
	loginHint?: string;
}): string {
	const u = new URL(GOOGLE_AUTH_URL);
	u.searchParams.set("client_id", opts.clientId);
	u.searchParams.set("redirect_uri", opts.redirectUri);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("scope", opts.scope);
	u.searchParams.set("state", opts.state);
	if (opts.offline) u.searchParams.set("access_type", "offline");
	if (opts.prompt) u.searchParams.set("prompt", opts.prompt);
	if (opts.loginHint) u.searchParams.set("login_hint", opts.loginHint);
	return u.href;
}

async function postToken(params: Record<string, string>): Promise<GoogleTokenResponse> {
	const resp = await netFetch(GOOGLE_TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
	});
	const text = await resp.text();
	let body: Record<string, unknown> = {};
	try {
		body = JSON.parse(text) as Record<string, unknown>;
	} catch {
		// fall through with empty body
	}
	if (!resp.ok || typeof body.access_token !== "string") {
		const code = typeof body.error === "string" ? body.error : undefined;
		const desc = typeof body.error_description === "string" ? body.error_description : `HTTP ${resp.status}`;
		throw new GoogleAuthError(`Google token endpoint: ${code ?? "error"} (${desc})`, code);
	}
	return body as unknown as GoogleTokenResponse;
}

export function exchangeCode(opts: {
	clientId: string;
	clientSecret: string;
	code: string;
	redirectUri: string;
}): Promise<GoogleTokenResponse> {
	return postToken({
		client_id: opts.clientId,
		client_secret: opts.clientSecret,
		code: opts.code,
		grant_type: "authorization_code",
		redirect_uri: opts.redirectUri,
	});
}

export function refreshAccessToken(opts: {
	clientId: string;
	clientSecret: string;
	refreshToken: string;
}): Promise<GoogleTokenResponse> {
	return postToken({
		client_id: opts.clientId,
		client_secret: opts.clientSecret,
		refresh_token: opts.refreshToken,
		grant_type: "refresh_token",
	});
}

export async function fetchUserInfo(accessToken: string): Promise<{
	sub?: string;
	email?: string;
	email_verified?: boolean;
	name?: string;
}> {
	const resp = await netFetch(GOOGLE_USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!resp.ok) throw new GoogleAuthError(`Google userinfo failed: HTTP ${resp.status}`);
	return (await resp.json()) as { sub?: string; email?: string; email_verified?: boolean; name?: string };
}

/** Best effort: a failure here should not block the caller. */
export async function revokeToken(token: string): Promise<boolean> {
	try {
		const resp = await netFetch(GOOGLE_REVOKE_URL, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ token }).toString(),
		});
		return resp.ok;
	} catch {
		return false;
	}
}
