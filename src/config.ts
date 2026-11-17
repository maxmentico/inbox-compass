export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const GMAIL_MODIFY_SCOPE = "https://www.googleapis.com/auth/gmail.modify";
/** Full mailbox scope. Never requested here, but it also satisfies our checks if present. */
export const GMAIL_FULL_SCOPE = "https://mail.google.com/";

/** Lifetime of pending OAuth round trips. */
export const FLOW_TTL_SECONDS = 600;
/** Web session lifetime. */
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export const ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** Which mail counts. Each run adds its own time window (since the last check, or a test window). */
export const DEFAULT_DIGEST_QUERY = "in:inbox";
/** Most new emails taken per mailbox per run, newest first. */
export const DEFAULT_MAX_PER_ACCOUNT = 300;
export const MAX_PER_ACCOUNT_LIMIT = 300;
export const DEFAULT_MODEL = "@cf/openai/gpt-oss-120b";
export const DEFAULT_FALLBACK_MODEL = "@cf/google/gemma-4-26b-a4b-it";
export const DEFAULT_TIMEZONE = "Europe/London";

export function markReadEnabled(env: Pick<Env, "ENABLE_MARK_READ">): boolean {
	return (env.ENABLE_MARK_READ ?? "").trim().toLowerCase() === "true";
}

/** The Gmail scope requested when linking a mailbox. */
export function mailboxScope(env: Pick<Env, "ENABLE_MARK_READ">): string {
	return markReadEnabled(env) ? GMAIL_MODIFY_SCOPE : GMAIL_READONLY_SCOPE;
}

export function canRead(scopes: readonly string[]): boolean {
	return scopes.some((s) => s === GMAIL_READONLY_SCOPE || s === GMAIL_MODIFY_SCOPE || s === GMAIL_FULL_SCOPE);
}

export function canModify(scopes: readonly string[]): boolean {
	return scopes.some((s) => s === GMAIL_MODIFY_SCOPE || s === GMAIL_FULL_SCOPE);
}

export function isOwner(
	identity: { email?: unknown; email_verified?: unknown },
	env: Pick<Env, "OWNER_EMAIL">,
): boolean {
	const owner = (env.OWNER_EMAIL ?? "").trim().toLowerCase();
	if (!owner) return false;
	if (identity.email_verified !== true) return false;
	return typeof identity.email === "string" && identity.email.trim().toLowerCase() === owner;
}

export interface DigestConfig {
	query: string;
	maxPerAccount: number;
	model: string;
	fallbackModel: string | null;
	timeZone: string;
}

/**
 * Only Cloudflare-hosted Workers AI ids ("@cf/vendor/model") are accepted, so a config typo or a
 * provider-prefixed id (e.g. "anthropic/...", "openai/...", "dynamic/...") can never route mail to a
 * third-party AI provider. Anything else falls back to the default.
 */
export function isCloudflareModelId(id: string): boolean {
	return /^@cf\/[a-z0-9._-]+\/[a-z0-9._-]+$/i.test(id);
}

export function digestConfig(env: Partial<Env>): DigestConfig {
	const n = Number.parseInt(env.DIGEST_MAX_PER_ACCOUNT ?? "", 10);
	const tz = (env.DIGEST_TIMEZONE ?? "").trim() || DEFAULT_TIMEZONE;
	return {
		query: (env.DIGEST_QUERY ?? "").trim() || DEFAULT_DIGEST_QUERY,
		maxPerAccount: Number.isFinite(n) ? Math.min(MAX_PER_ACCOUNT_LIMIT, Math.max(1, n)) : DEFAULT_MAX_PER_ACCOUNT,
		model: pickModel(env.DIGEST_MODEL, DEFAULT_MODEL),
		fallbackModel:
			(env.DIGEST_FALLBACK_MODEL ?? "").trim().toLowerCase() === "none"
				? null
				: pickModel(env.DIGEST_FALLBACK_MODEL, DEFAULT_FALLBACK_MODEL),
		timeZone: isValidTimeZone(tz) ? tz : DEFAULT_TIMEZONE,
	};
}

function pickModel(value: string | undefined, fallback: string): string {
	const v = (value ?? "").trim();
	return v && isCloudflareModelId(v) ? v : fallback;
}

function isValidTimeZone(tz: string): boolean {
	try {
		new Intl.DateTimeFormat("en-GB", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** YYYY-MM-DD in the given zone. */
export function localDate(at: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
