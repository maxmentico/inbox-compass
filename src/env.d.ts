// Bindings and variables for this Worker. Keep in sync with wrangler.jsonc.

interface Env {
	/** Linked mailboxes (encrypted refresh tokens), digests, classification cache, OAuth flow state. */
	MAILBOX_KV: KVNamespace;
	/** Cloudflare-native approximate rate limit for unauthenticated OAuth starts. */
	LOGIN_RATE_LIMITER: RateLimit;
	/** Workers AI. Inference runs on Cloudflare; no other AI provider is called. */
	AI: Ai;
	/** Private SQLite singleton for job leases, mailbox claims and accepted result references. */
	JOB_AUTHORITY?: DurableObjectNamespace;
	/** Atomic generation rollout: omitted/off, bridge, or active after a verified import. */
	ATOMIC_STATE_MODE?: string;
	/** Optional: Cloudflare Email Routing binding used to email the digest to yourself. */
	DIGEST_EMAIL?: SendEmail;

	/** Google OAuth client (Web application): owner sign-in and mailbox linking. */
	GOOGLE_CLIENT_ID: string;
	GOOGLE_CLIENT_SECRET: string;
	/** 32 random bytes, base64. Encrypts refresh tokens and the session cookie. */
	TOKEN_ENCRYPTION_KEY: string;

	/** The only Google identity allowed to sign in to the web UI. */
	OWNER_EMAIL: string;
	/** "true" requests gmail.modify so "done" marks mail as read; otherwise gmail.readonly. */
	ENABLE_MARK_READ?: string;

	/** Gmail search used to collect candidate emails each run. */
	DIGEST_QUERY?: string;
	/** Max emails per mailbox per run (1-50). */
	DIGEST_MAX_PER_ACCOUNT?: string;
	/** Workers AI model id. Must be a Cloudflare-hosted "@cf/..." id. */
	DIGEST_MODEL?: string;
	/** Model to retry with when the primary fails or returns invalid JSON. "none" disables. */
	DIGEST_FALLBACK_MODEL?: string;
	/** IANA time zone used for digest dates and display. */
	DIGEST_TIMEZONE?: string;
	/** Public URL of this Worker, used for links in the digest email, e.g. https://inbox-digest.you.workers.dev */
	APP_URL?: string;
	/** Optional email delivery: both must be set, and To must be a verified Email Routing destination. */
	DIGEST_EMAIL_FROM?: string;
	DIGEST_EMAIL_TO?: string;
	/** This Worker itself (a service binding): the morning run steps its job through it, one invocation per mailbox. */
	SELF?: Fetcher;
}

// nodejs_compat provides this; only what telemetry.ts uses is declared.
declare module "node:async_hooks" {
	export class AsyncLocalStorage<T> {
		run<R>(store: T, fn: () => R): R;
		getStore(): T | undefined;
	}
}
