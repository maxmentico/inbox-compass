// Turning Gmail API message payloads (format=full) into readable text.

import { base64UrlDecode } from "./crypto";
import { htmlToText } from "./html";

export interface GmailHeader {
	name: string;
	value: string;
}

export interface GmailPart {
	partId?: string;
	mimeType?: string;
	filename?: string;
	headers?: GmailHeader[];
	body?: { size?: number; data?: string; attachmentId?: string };
	parts?: GmailPart[];
}

export interface AttachmentInfo {
	filename: string;
	mimeType: string;
	sizeBytes: number;
}

export interface ExtractedBody {
	text: string;
	/** Which representation the text came from. */
	source: "text/plain" | "text/html" | "none";
	attachments: AttachmentInfo[];
}

export function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
	const lower = name.toLowerCase();
	return headers?.find((h) => h.name.toLowerCase() === lower)?.value;
}

function charsetOf(part: GmailPart): string {
	const ct = header(part.headers, "Content-Type") ?? "";
	const m = /charset\s*=\s*"?([^";\s]+)"?/i.exec(ct);
	return (m?.[1] ?? "utf-8").toLowerCase();
}

/** Gmail returns transfer-decoded bytes as base64url; the charset still has to be applied. */
export function decodePartData(part: GmailPart): string {
	const data = part.body?.data;
	if (!data) return "";
	const bytes = base64UrlDecode(data);
	const charset = charsetOf(part);
	try {
		return new TextDecoder(charset).decode(bytes);
	} catch {
		// Runtime doesn't know this charset (e.g. some legacy Cyrillic encodings): fall back to UTF-8.
		return new TextDecoder("utf-8").decode(bytes);
	}
}

function isAttachment(part: GmailPart): boolean {
	if (part.filename) return true;
	const disposition = header(part.headers, "Content-Disposition") ?? "";
	return /^\s*attachment/i.test(disposition);
}

function walk(part: GmailPart, visit: (p: GmailPart) => void): void {
	visit(part);
	for (const child of part.parts ?? []) walk(child, visit);
}

/**
 * @param opts.maxHtmlInputChars caps the HTML fed to the converter, across all HTML parts. HTML-to-text is the main CPU
 *   cost (~3.5 ms per 200 KB measured), and the Workers Free plan allows 10 ms CPU per request.
 */
export function extractBody(payload: GmailPart | undefined, opts: { maxHtmlInputChars?: number } = {}): ExtractedBody {
	const attachments: AttachmentInfo[] = [];
	const plain: string[] = [];
	const html: string[] = [];
	if (!payload) return { text: "", source: "none", attachments };

	walk(payload, (p) => {
		const mime = (p.mimeType ?? "").toLowerCase();
		if (isAttachment(p)) {
			attachments.push({
				filename: p.filename || "(unnamed)",
				mimeType: p.mimeType ?? "application/octet-stream",
				sizeBytes: p.body?.size ?? 0,
			});
			return;
		}
		if (mime === "text/plain") plain.push(decodePartData(p));
		else if (mime === "text/html") html.push(decodePartData(p));
	});

	const plainText = plain.join("\n\n").trim();
	if (plainText) return { text: plainText, source: "text/plain", attachments };
	// The cap is for all HTML parts together: an email with many parts costs no more than one with one.
	let budget = opts.maxHtmlInputChars ?? Number.POSITIVE_INFINITY;
	const htmlText = html
		.map((h) => {
			const part = h.length > budget ? h.slice(0, budget) : h;
			budget -= part.length;
			return part ? htmlToText(part) : "";
		})
		.filter(Boolean)
		.join("\n\n")
		.trim();
	if (htmlText) return { text: htmlText, source: "text/html", attachments };
	return { text: "", source: "none", attachments };
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
	if (text.length <= max) return { text, truncated: false };
	return { text: text.slice(0, max), truncated: true };
}

/** How much of what the sender wrote a digest keeps per email (shown when the email is expanded). */
export const EXCERPT_CHARS = 3_000;
/** At most this much body text is looked at for the excerpt, which bounds the work per email. */
export const EXCERPT_SOURCE_CHARS = 5_000;

// Invisible characters newsletters pad their preview text with (soft hyphen, zero-width and
// bidi controls, Hangul fillers, combining grapheme joiner, BOM).
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFEFF\uFFA0]/g;
/** Every way text can break a line: CR, CRLF, and the Unicode separators (U+2028, U+2029, NEL, VT, FF, FS-RS). */
export const LINE_BREAKS = /\r\n?|[\u000B\u000C\u001C-\u001E\u0085\u2028\u2029]/g;
/** URLs this long are tracking redirects, not something to read. */
const LONG_URL = /<?https?:\/\/[^\s<>]{150,}>?/gi;
/** "---------- Forwarded message ---------" (Gmail), "Begin forwarded message:" (Apple), and translations. */
const FORWARD = /^(?:-{2,}\s*(?:Forwarded message|Пересылаемое сообщение|Weitergeleitete Nachricht|Message transféré|Mensaje reenviado)\s*-{2,}|(?:Begin forwarded message|Начало переадресованного сообщения)\s*:)$/i;

/**
 * The line that starts a quoted earlier message: "On … wrote:" and its translations, Gmail's localised
 * "<date>, Name <address>:", "Original Message", Outlook's "From:" + "Sent:" block. `forwarded`: the line
 * follows a forward marker, so a "From:" block is the forwarded email's header, not a quote.
 */
function startsQuote(line: string, next: string, forwarded: boolean): boolean {
	const l = line.trim();
	if (!l || l.length > 400) return false;
	if (/^On\b.{0,300}\bwrote:$/i.test(l)) return true;
	// Gmail wraps a long "On …, Name <address>" line before "wrote:".
	if (/^On\b.{0,300}$/i.test(l) && /^\S.{0,200}\bwrote:$/i.test(next.trim())) return true;
	if (/\d/.test(l) && /^.{0,300}(?:написал\(а\)|написала?|пишет|schrieb|a écrit|escribió|ha scritto|schreef)\s*:$/i.test(l)) return true;
	// "пн, 19 окт. 2026 г. в 10:00, Tom <tom@x.example>:": starts with a date (a year early on, then a
	// time), ends with an address and a colon. "Our meeting is at 10:00 with Anna <a@x>:" isn't one.
	if (/>\s*:$/.test(l) && /^.{0,40}?\b(?:19|20)\d{2}\b.{0,120}?\b\d{1,2}[:.]\d{2}\b.{0,200}<[^<>\s@]+@[^<>\s]+>\s*:$/.test(l)) return true;
	if (/^-{2,}\s*(?:Original Message|Исходное сообщение)\s*-{2,}$/i.test(l)) return true;
	// Outlook: "From: …" followed by "Sent: …" or "Date: …".
	if (!forwarded && /^(?:From|От):\s.+/i.test(l) && /^(?:Sent|Date|Отправлено|Дата):\s/i.test(next.trim())) return true;
	return false;
}

/** What a digest item keeps of an email's text, and whether (and why) it was cut short. */
export interface Excerpt {
	text: string;
	/** "quote": quoted earlier text was left out; "length": it was longer than the cap. */
	cut?: "quote" | "length";
}

/**
 * What the sender wrote, as plain text for reading: invisible padding and long tracking URLs dropped,
 * quoted earlier replies cut off ("On … wrote:" and what follows, "> " lines; a forwarded email is kept),
 * line breaks normalised to "\n", whitespace and runs of blank lines collapsed, capped at `max`
 * characters. Text cut off at the end ends in "…". Never rendered as HTML: always escaped.
 */
export function readableExcerpt(body: string, max = EXCERPT_CHARS): Excerpt {
	const lines = body.slice(0, EXCERPT_SOURCE_CHARS).replace(LINE_BREAKS, "\n").replace(INVISIBLE, "").replace(LONG_URL, "[link]").split("\n");
	const kept: string[] = [];
	let quote = false;
	let ended = false;
	let previous = "";
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i]!;
		if (startsQuote(line, lines[i + 1] ?? "", FORWARD.test(previous))) {
			quote = ended = true;
			break;
		}
		if (/^\s*>/.test(line)) {
			quote = true;
			continue;
		}
		const tidy = line.replace(/[ \t\u00A0\u2007\u202F]+/g, " ").trim();
		kept.push(tidy);
		if (tidy) previous = tidy;
	}
	const text = kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
	if (text.length > max) return { text: capText(text, max), cut: quote ? "quote" : "length" };
	if (!text) return { text };
	return quote ? { text: ended ? `${text}…` : text, cut: "quote" } : { text };
}

/** `text` cut to at most `max` characters plus "…", at a word break when there's one near the end. */
export function capText(text: string, max: number): string {
	if (text.length <= max) return text;
	const cut = text.slice(0, max);
	const space = cut.search(/\s\S*$/);
	return `${(space > 0 && space > max - 200 ? cut.slice(0, space) : cut).trimEnd()}…`;
}
