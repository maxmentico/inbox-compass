// Gmail HTTP batch requests (multipart/mixed).
//
// Why: Workers on the free plan allow 50 outbound subrequests per invocation. Fetching metadata for
// 20 messages in 3 mailboxes one-by-one is ~60+ calls; batching makes it one call per mailbox.
// Google recommends at most 50 inner requests per batch for Gmail.
// https://developers.google.com/workspace/gmail/api/guides/batch

export const GMAIL_BATCH_URL = "https://gmail.googleapis.com/batch/gmail/v1";
export const MAX_BATCH_SIZE = 50;

export interface BatchItem {
	/** Correlation id; must be unique within the batch. */
	id: string;
	method: "GET" | "POST";
	/** Path relative to the API root, e.g. /gmail/v1/users/me/messages/abc?format=metadata */
	path: string;
}

export interface BatchPartResponse {
	status: number;
	body: unknown;
}

export function buildBatchBody(items: BatchItem[], boundary: string): string {
	if (items.length > MAX_BATCH_SIZE) throw new Error(`Batch too large (${items.length} > ${MAX_BATCH_SIZE})`);
	const parts = items.map(
		(item) =>
			`--${boundary}\r\n` +
			`Content-Type: application/http\r\n` +
			`Content-ID: <item-${item.id}>\r\n` +
			`\r\n` +
			`${item.method} ${item.path}\r\n` +
			`\r\n`,
	);
	return parts.join("") + `--${boundary}--\r\n`;
}

export function boundaryFromContentType(contentType: string | null): string {
	const m = contentType?.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i);
	const b = m?.[1] ?? m?.[2];
	if (!b) throw new Error(`Batch response has no multipart boundary (content-type: ${contentType ?? "none"})`);
	return b;
}

/** Splits "headers<blank line>rest", tolerating CRLF or LF line endings. */
function splitHead(s: string): [string, string] {
	const m = /\r?\n\r?\n/.exec(s);
	if (!m) return [s, ""];
	return [s.slice(0, m.index), s.slice(m.index + m[0].length)];
}

/**
 * Parses a Gmail batch response into a map of correlation id -> inner HTTP response.
 * Parts may arrive in any order; correlation is by Content-ID ("<response-item-ID>").
 */
export function parseBatchResponse(contentType: string | null, body: string): Map<string, BatchPartResponse> {
	const boundary = boundaryFromContentType(contentType);
	const out = new Map<string, BatchPartResponse>();
	// A delimiter is only meaningful as a complete MIME boundary line. A message body
	// may contain the same characters, including the leading hyphens.
	const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const chunks = body.split(new RegExp(`(?:^|\\r?\\n)--${escaped}(?=--(?:\\r?\\n|$)|\\r?\\n|$)`, "g"));
	// chunks[0] is the preamble; a chunk starting with "--" is the closing delimiter's epilogue.
	for (const raw of chunks.slice(1)) {
		if (raw.startsWith("--")) break;
		const chunk = raw.replace(/^\r?\n/, "");
		const [outerHeaders, httpMessage] = splitHead(chunk);
		const idMatch = /^content-id:\s*<?response-item-([^>\s]+)>?\s*$/im.exec(outerHeaders);
		if (!idMatch?.[1]) continue;
		const [statusAndHeaders, bodyText] = splitHead(httpMessage);
		const statusMatch = /^HTTP\/[\d.]+\s+(\d{3})/m.exec(statusAndHeaders);
		const status = statusMatch?.[1] ? Number(statusMatch[1]) : 0;
		const trimmed = bodyText.trim();
		let parsed: unknown = trimmed;
		if (trimmed) {
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				// leave as text
			}
		}
		out.set(idMatch[1], { status, body: parsed });
	}
	return out;
}
