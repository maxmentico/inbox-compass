// Gmail REST client for one linked mailbox, plus the cross-mailbox search fan-out.

import { AccountError, type AccountRecord, getAccessToken } from "./accounts";
import { type BatchItem, type BatchPartResponse, buildBatchBody, GMAIL_BATCH_URL, MAX_BATCH_SIZE, parseBatchResponse } from "./batch";
import { randomToken } from "./crypto";
import { type AttachmentInfo, EXCERPT_SOURCE_CHARS, type Excerpt, extractBody, type GmailPart, header, readableExcerpt, truncate } from "./mime";
import { currentStats, netFetch } from "./telemetry";

const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const METADATA_HEADERS = ["From", "To", "Cc", "Subject", "Date"];

/**
 * Gmail can rate-limit or temporarily fail individual parts of a busy batch. Those are fetched again,
 * waiting delayMs, then twice that. Waiting costs no Worker CPU time. Tests set delayMs to 0.
 */
export const RATE_LIMIT_RETRY = { attempts: 2, delayMs: 1_000 };

export interface GmailMessage {
	id: string;
	threadId: string;
	labelIds?: string[];
	snippet?: string;
	internalDate?: string;
	payload?: GmailPart;
}

export class GmailApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "GmailApiError";
	}
}

export async function getProfile(accessToken: string): Promise<{ emailAddress: string }> {
	const resp = await netFetch(`${API}/profile`, { headers: { Authorization: `Bearer ${accessToken}` } });
	if (!resp.ok) throw new GmailApiError(`Gmail profile: HTTP ${resp.status}`, resp.status);
	const body = (await resp.json()) as { emailAddress?: string };
	if (!body.emailAddress) throw new GmailApiError("Gmail profile had no emailAddress", 500);
	return { emailAddress: body.emailAddress };
}

type ClientEnv = Pick<Env, "TOKEN_ENCRYPTION_KEY" | "GOOGLE_CLIENT_ID" | "GOOGLE_CLIENT_SECRET">;

export class GmailClient {
	constructor(
		private readonly env: ClientEnv,
		readonly account: AccountRecord,
	) {}

	/** Gmail API requests this client has made (telemetry); token refreshes aren't included. */
	calls = 0;

	/** Runs `fn` with an access token; on a 401 refreshes once and retries. */
	private async withToken(fn: (token: string) => Promise<Response>): Promise<Response> {
		let token = await getAccessToken(this.env, this.account);
		this.calls++;
		let resp = await fn(token);
		if (resp.status === 401) {
			token = await getAccessToken(this.env, this.account, { forceRefresh: true });
			this.calls++;
			resp = await fn(token);
		}
		if (resp.status === 401) {
			throw new AccountError(`Gmail rejected access for "${this.account.alias}". Re-link it.`, this.account.alias, true);
		}
		return resp;
	}

	private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
		const resp = await this.withToken((token) =>
			netFetch(`${API}${path}`, {
				...init,
				headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
			}),
		);
		if (!resp.ok) {
			const detail = await resp.text().catch(() => "");
			throw new GmailApiError(
				`Gmail ${init.method ?? "GET"} ${path.split("?")[0]} -> HTTP ${resp.status}${explain(resp.status, detail)}`,
				resp.status,
			);
		}
		if (resp.status === 204) return undefined as T;
		const text = await resp.text();
		return (text ? JSON.parse(text) : undefined) as T;
	}

	async listMessageIds(opts: {
		query: string;
		maxResults: number;
		pageToken?: string;
		includeSpamTrash?: boolean;
	}): Promise<{ ids: string[]; nextPageToken?: string; resultSizeEstimate?: number }> {
		const params = new URLSearchParams({ q: opts.query, maxResults: String(opts.maxResults) });
		if (opts.pageToken) params.set("pageToken", opts.pageToken);
		if (opts.includeSpamTrash) params.set("includeSpamTrash", "true");
		const body = await this.json<{ messages?: { id: string }[]; nextPageToken?: string; resultSizeEstimate?: number }>(
			`/messages?${params}`,
		);
		return {
			ids: (body.messages ?? []).map((m) => m.id),
			nextPageToken: body.nextPageToken,
			resultSizeEstimate: body.resultSizeEstimate,
		};
	}

	/** Metadata for up to MAX_BATCH_SIZE messages in one HTTP call. */
	batchGetMetadata(ids: string[]) {
		const headerParams = METADATA_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`).join("&");
		return this.batchGet(ids, `format=metadata&${headerParams}`);
	}

	/** Full messages (headers + bodies) for up to MAX_BATCH_SIZE ids in one HTTP call. */
	batchGetFull(ids: string[]) {
		return this.batchGet(ids, "format=full");
	}

	/**
	 * For each thread: its conversation (who wrote what, when, with Gmail's short preview) and which of
	 * its messages are still in the inbox. Threads Gmail fails to return are absent; callers fail open.
	 */
	async threadStates(threadIds: string[]): Promise<Map<string, ThreadState>> {
		const out = new Map<string, ThreadState>();
		const unique = [...new Set(threadIds)];
		for (let i = 0; i < unique.length; i += MAX_BATCH_SIZE) {
			const ids = unique.slice(i, i + MAX_BATCH_SIZE);
			const results = await this.batchFetch("threads", ids, "format=metadata&metadataHeaders=From");
			for (const id of ids) {
				const part = results.get(id);
				if (part?.status === 200 && part.body && typeof part.body === "object") {
					const messages = (part.body as GmailThread).messages ?? [];
					out.set(id, {
						messages: conversationOf(messages),
						inInbox: new Set(messages.filter((m) => m.labelIds?.includes("INBOX")).map((m) => m.id)),
					});
				}
			}
		}
		return out;
	}

	/** Full messages for any number of ids, MAX_BATCH_SIZE per HTTP call. */
	getFullMany(ids: string[]): Promise<{ messages: GmailMessage[]; failed: { id: string; status: number }[] }> {
		return this.batchGetMany(ids, "format=full");
	}

	/** Thread id and labels only, for any number of ids, MAX_BATCH_SIZE per HTTP call. */
	getMinimalMany(ids: string[]): Promise<{ messages: GmailMessage[]; failed: { id: string; status: number }[] }> {
		return this.batchGetMany(ids, "format=minimal");
	}

	private async batchGetMany(ids: string[], query: string): Promise<{ messages: GmailMessage[]; failed: { id: string; status: number }[] }> {
		const out = { messages: [] as GmailMessage[], failed: [] as { id: string; status: number }[] };
		for (let i = 0; i < ids.length; i += MAX_BATCH_SIZE) {
			const r = await this.batchGet(ids.slice(i, i + MAX_BATCH_SIZE), query);
			out.messages.push(...r.messages);
			out.failed.push(...r.failed);
		}
		return out;
	}

	/** Per-message failures are returned, not thrown. Rate-limited (429) parts are retried first. */
	private async batchGet(
		ids: string[],
		query: string,
	): Promise<{ messages: GmailMessage[]; failed: { id: string; status: number }[] }> {
		if (ids.length === 0) return { messages: [], failed: [] };
		const results = await this.batchFetch("messages", ids, query);

		const messages: GmailMessage[] = [];
		const failed: { id: string; status: number }[] = [];
		for (const id of ids) {
			const part = results.get(id);
			if (part && part.status === 200 && typeof part.body === "object" && part.body) {
				messages.push(part.body as GmailMessage);
			} else {
				failed.push({ id, status: part?.status ?? 0 });
			}
		}
		return { messages, failed };
	}

	/** GETs up to MAX_BATCH_SIZE messages or threads by id, retrying transient failures. */
	private async batchFetch(
		resource: "messages" | "threads",
		ids: string[],
		query: string,
	): Promise<Map<string, BatchPartResponse | undefined>> {
		if (ids.length > MAX_BATCH_SIZE) throw new Error(`At most ${MAX_BATCH_SIZE} ids per batch`);
		const results = new Map<string, BatchPartResponse | undefined>();
		let pending = ids;
		for (let attempt = 0; pending.length > 0; attempt++) {
			let parts: Map<string, BatchPartResponse>;
			try {
				parts = await this.batchOnce(resource, pending, query);
			} catch (error) {
				if (!(error instanceof GmailApiError) || !transientStatus(error.status) || attempt >= RATE_LIMIT_RETRY.attempts) throw error;
				await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY.delayMs * 2 ** attempt));
				continue;
			}
			pending.forEach((id, i) => results.set(id, parts.get(String(i))));
			const rateLimited = pending.filter((id) => results.get(id)?.status === 429).length;
			pending = pending.filter((id) => {
				const part = results.get(id);
				return part !== undefined && (transientStatus(part.status) || isRateLimit403(part));
			});
			const stats = currentStats();
			if (stats) stats.rateLimitedParts += rateLimited;
			if (pending.length === 0 || attempt >= RATE_LIMIT_RETRY.attempts) break;
			await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY.delayMs * 2 ** attempt));
		}
		return results;
	}

	/** One batch HTTP call; parts are keyed by each id's index in `ids`. */
	private async batchOnce(resource: "messages" | "threads", ids: string[], query: string): Promise<Map<string, BatchPartResponse>> {
		const items: BatchItem[] = ids.map((id, i) => ({
			id: String(i),
			method: "GET",
			path: `/gmail/v1/users/me/${resource}/${encodeURIComponent(id)}?${query}`,
		}));
		const boundary = `batch_${randomToken(12)}`;
		const send = () =>
			this.withToken((token) =>
				netFetch(GMAIL_BATCH_URL, {
					method: "POST",
					headers: { Authorization: `Bearer ${token}`, "Content-Type": `multipart/mixed; boundary=${boundary}` },
					body: buildBatchBody(items, boundary),
				}),
			);
		const read = async (resp: Response) => {
			if (!resp.ok) throw new GmailApiError(`Gmail batch -> HTTP ${resp.status}`, resp.status);
			return parseBatchResponse(resp.headers.get("Content-Type"), await resp.text());
		};

		const parts = await read(await send());
		// The outer request can succeed while every inner request is 401 (token revoked mid-life).
		const all401 = parts.size > 0 && [...parts.values()].every((p) => p.status === 401);
		if (!all401) return parts;
		await getAccessToken(this.env, this.account, { forceRefresh: true });
		return read(await send());
	}

	/** The mailbox's send-as addresses (its primary address and any aliases). Works with gmail.readonly. */
	async sendAsAddresses(): Promise<string[]> {
		const body = await this.json<{ sendAs?: { sendAsEmail?: string }[] }>("/settings/sendAs");
		return (body?.sendAs ?? []).map((s) => s.sendAsEmail).filter((e): e is string => typeof e === "string" && e.length > 0);
	}

	getMessage(id: string): Promise<GmailMessage> {
		return this.json<GmailMessage>(`/messages/${encodeURIComponent(id)}?format=full`);
	}

	getThread(id: string): Promise<{ id: string; messages?: GmailMessage[] }> {
		return this.json<{ id: string; messages?: GmailMessage[] }>(`/threads/${encodeURIComponent(id)}?format=full`);
	}

	/** Removes the UNREAD label. One call for up to 1000 ids. Requires gmail.modify. */
	async markRead(ids: string[]): Promise<void> {
		for (let i = 0; i < ids.length; i += 1000) {
			await this.json<void>(`/messages/batchModify`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ids: ids.slice(i, i + 1000), removeLabelIds: ["UNREAD"] }),
			});
		}
	}

	/** Adds the UNREAD label back, undoing markRead. One call for up to 1000 ids. Requires gmail.modify. */
	async markUnread(ids: string[]): Promise<void> {
		for (let i = 0; i < ids.length; i += 1000) {
			await this.json<void>(`/messages/batchModify`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ids: ids.slice(i, i + 1000), addLabelIds: ["UNREAD"] }),
			});
		}
	}
}

function transientStatus(status: number): boolean {
	return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function isRateLimit403(part: BatchPartResponse): boolean {
	if (part.status !== 403 || !part.body || typeof part.body !== "object") return false;
	const error = (part.body as { error?: { errors?: { reason?: string }[] } }).error;
	return Array.isArray(error?.errors) && error.errors.some((entry) => entry?.reason === "rateLimitExceeded" || entry?.reason === "userRateLimitExceeded");
}

function explain(status: number, detail: string): string {
	if (status === 403 && /insufficient/i.test(detail)) return " (token lacks the needed Gmail scope; re-link the account)";
	if (status === 403 && /accessNotConfigured|has not been used|is disabled/i.test(detail)) {
		return " (enable the Gmail API in your Google Cloud project)";
	}
	if (status === 403 && /admin|policy|domain/i.test(detail)) return " (blocked by the Workspace admin's API access policy)";
	if (status === 404) return " (not found; check the id and the account)";
	if (status === 429) return " (rate limited by Gmail; retry shortly with fewer results)";
	return "";
}

/** One message of a conversation: drafts, trash and spam are left out. */
export interface ConversationMessage {
	id: string;
	/** Arrival time, ms. */
	at: number;
	/** Sent from this mailbox (Gmail's SENT label). */
	byOwner: boolean;
	from: string;
	/** Gmail's short preview of the text. */
	preview: string;
}

export interface ThreadState {
	/** Oldest first. */
	messages: ConversationMessage[];
	/** Ids of the thread's messages that still have the INBOX label. */
	inInbox: Set<string>;
}

interface GmailThread {
	id: string;
	messages?: { id: string; internalDate?: string; labelIds?: string[]; snippet?: string; payload?: GmailPart }[];
}

const NOT_A_REPLY = new Set(["DRAFT", "TRASH", "SPAM"]);

export function conversationOf(messages: NonNullable<GmailThread["messages"]>): ConversationMessage[] {
	return messages
		.filter((m) => !(m.labelIds ?? []).some((l) => NOT_A_REPLY.has(l)))
		.map((m) => ({
			id: m.id,
			at: Number(m.internalDate ?? 0),
			byOwner: (m.labelIds ?? []).includes("SENT"),
			from: header(m.payload?.headers, "From") ?? "",
			preview: withoutQuote(decodeSnippet(m.snippet ?? "")),
		}))
		.sort((a, b) => a.at - b.at);
}

// Where quoted earlier text starts in a reply ("On Thu, Ann wrote:", "-----Original Message", Outlook's
// "From:", Russian "пишет:"). Each pattern is bounded, and previews are short.
const QUOTE_START = [
	/\bOn\s[^\n]{1,120}?\swrote:/i,
	/-{2,}\s*Original Message/i,
	/\bFrom:\s/,
	/(?:^|\s)От:\s/,
	/[^\s]{1,40}\s+пишет:/i,
	/\bSent from my\s/i,
];

/** A reply's own words: Gmail's preview runs on into the quoted message, which isn't the sender's. */
export function withoutQuote(preview: string): string {
	const cut = Math.min(...QUOTE_START.map((r) => r.exec(preview)?.index ?? preview.length), preview.length);
	return preview.slice(0, cut).trim();
}

/**
 * The owner wrote in the conversation after this message, so it has been answered. `at` is used when
 * the message itself isn't in the thread as fetched.
 */
export function repliedAfter(state: ThreadState, messageId: string, at?: number): boolean {
	const when = state.messages.find((m) => m.id === messageId)?.at ?? at;
	if (when === undefined || Number.isNaN(when)) return false;
	return state.messages.some((m) => m.byOwner && m.id !== messageId && m.at > when);
}

/** Up to `n` messages before this one in the conversation, oldest first. */
export function earlierInThread(state: ThreadState, messageId: string, n: number): ConversationMessage[] {
	const i = state.messages.findIndex((m) => m.id === messageId);
	return (i < 0 ? [] : state.messages.slice(0, i)).slice(-n);
}

// --- Normalised message shapes -----------------------------------------------------------------

export interface MessageSummary {
	account: string;
	id: string;
	threadId: string;
	date: string | null;
	from: string | null;
	to: string | null;
	subject: string | null;
	snippet: string;
	unread: boolean;
	labels: string[];
}

const SYSTEM_LABELS_SHOWN = new Set(["INBOX", "IMPORTANT", "STARRED", "SENT", "DRAFT", "SPAM", "TRASH"]);

function isoDate(internalDate: string | undefined): string | null {
	if (!internalDate) return null;
	const n = Number(internalDate);
	return Number.isFinite(n) ? new Date(n).toISOString() : null;
}

export function summarize(account: string, m: GmailMessage): MessageSummary {
	const hs = m.payload?.headers;
	const labelIds = m.labelIds ?? [];
	return {
		account,
		id: m.id,
		threadId: m.threadId,
		date: isoDate(m.internalDate),
		from: header(hs, "From") ?? null,
		to: header(hs, "To") ?? null,
		subject: header(hs, "Subject") ?? null,
		snippet: decodeSnippet(m.snippet ?? ""),
		unread: labelIds.includes("UNREAD"),
		labels: labelIds.filter((l) => SYSTEM_LABELS_SHOWN.has(l) || l.startsWith("CATEGORY_")),
	};
}

/** Gmail snippets are HTML-escaped. */
function decodeSnippet(s: string): string {
	return s
		.replace(/&#39;/g, "'")
		.replace(/&quot;/g, '"')
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export interface FullMessage extends MessageSummary {
	cc: string | null;
	replyTo: string | null;
	body: string;
	bodySource: "text/plain" | "text/html" | "none";
	bodyTruncated: boolean;
	/** What the sender wrote, cleaned for reading (mime.ts readableExcerpt): kept on the digest item. */
	excerpt: Excerpt;
	attachments: AttachmentInfo[];
}

/** HTML is typically several times longer than its text; this bounds conversion CPU per message. */
const HTML_INPUT_PER_TEXT_CHAR = 8;

export function toFullMessage(account: string, m: GmailMessage, maxBodyChars: number): FullMessage {
	const base = summarize(account, m);
	// The excerpt reads further than the model does, so the HTML cap allows for it.
	const extracted = extractBody(m.payload, { maxHtmlInputChars: Math.max(maxBodyChars, EXCERPT_SOURCE_CHARS) * HTML_INPUT_PER_TEXT_CHAR });
	const { text, truncated } = truncate(extracted.text, maxBodyChars);
	return {
		...base,
		cc: header(m.payload?.headers, "Cc") ?? null,
		replyTo: header(m.payload?.headers, "Reply-To") ?? null,
		body: text,
		bodySource: extracted.source,
		bodyTruncated: truncated,
		excerpt: readableExcerpt(extracted.text),
		attachments: extracted.attachments,
	};
}
