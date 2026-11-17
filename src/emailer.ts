// Optional: email the digest to yourself through Cloudflare Email Routing (send_email binding).
// The message goes Cloudflare -> your own verified inbox; no other provider is involved.

import { digestConfig } from "./config";
import { type Digest, type DigestItem, digestSections } from "./digest";
import { randomToken } from "./crypto";
import { aiNotice } from "./format";
import { stripLinks } from "./llm";

function b64(s: string): string {
	const bytes = new TextEncoder().encode(s);
	let bin = "";
	for (const b of bytes) bin += String.fromCharCode(b);
	return btoa(bin);
}

/** RFC 2047 encoded-word, only when the header has non-ASCII characters. */
export function encodeHeader(value: string): string {
	const clean = value.replace(/[\r\n]+/g, " ");
	return /^[\x20-\x7e]*$/.test(clean) ? clean : `=?UTF-8?B?${b64(clean)}?=`;
}

function wrap76(s: string): string {
	return s.replace(/.{1,76}/g, "$&\r\n").trimEnd();
}

// Mail clients auto-link URLs and bare domains in plain text, so email-derived text is defanged
// the same way as the model's.
function line(it: DigestItem): string {
	const due = it.due ? ` (due ${it.due})` : "";
	const covers = it.covers ? ` (+${it.covers} earlier in this conversation)` : "";
	const how = it.rechecked ? " (re-checked: needs you)" : it.estimated ? " (estimated)" : "";
	return `[${it.urgency.toUpperCase()}] ${it.account}: ${stripLinks(it.action || it.summary)}${due}${covers}${how}\n    ${stripLinks(it.from)} — ${stripLinks(it.subject)}`;
}

/** Counts the same sections as the page; expects a digest that applySettings has decided. */
export function digestText(d: Digest, appUrl?: string, timeZone = "UTC"): { subject: string; body: string } {
	const { open, suspicious, fyi, stillOpen } = digestSections(d);
	const broken = d.accounts.filter((a) => !a.ok);
	const parts: string[] = [];
	if (d.ai) parts.push(`${aiNotice(d.ai, timeZone, new Date(d.generatedAt))}\n`);
	parts.push(open.length ? `${open.length} new to action:\n` : "Nothing new needs action.\n");
	for (const it of open) parts.push(line(it));
	if (stillOpen.length) {
		parts.push(`\n${stillOpen.length} still open from earlier:\n`);
		for (const it of stillOpen) parts.push(line(it));
	}
	if (suspicious.length) parts.push(`\n${suspicious.length} flagged as possible phishing (see the page; don't click links in them).`);
	if (fyi.length) parts.push(`\n${fyi.length} for information only (see the page).`);
	if (broken.length) {
		parts.push("\nMailboxes that failed:");
		for (const a of broken) parts.push(`  ${a.alias}: ${a.needsRelink ? "needs re-linking" : a.error ?? "error"}`);
	}
	if (appUrl) parts.push(`\nOpen: ${appUrl.replace(/\/$/, "")}/app?run=${encodeURIComponent(d.id)}`);
	return {
		subject: `Inbox Compass ${d.date}: ${open.length} new to action${stillOpen.length ? `, ${stillOpen.length} still open` : ""}`,
		body: parts.join("\n"),
	};
}

export function buildMime(opts: { from: string; to: string; subject: string; body: string; now?: Date }): string {
	const domain = opts.from.split("@")[1] ?? "localhost";
	const headers = [
		`From: Inbox Compass <${opts.from}>`,
		`To: <${opts.to}>`,
		`Subject: ${encodeHeader(opts.subject)}`,
		`Date: ${(opts.now ?? new Date()).toUTCString()}`,
		`Message-ID: <${randomToken(16)}@${domain}>`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
	];
	return `${headers.join("\r\n")}\r\n\r\n${wrap76(b64(opts.body.replace(/\r?\n/g, "\r\n")))}\r\n`;
}

type MakeMessage = (from: string, to: string, raw: string) => Promise<unknown>;

const defaultMakeMessage: MakeMessage = async (from, to, raw) => {
	const { EmailMessage } = await import("cloudflare:email");
	return new EmailMessage(from, to, raw);
};

/** Sends when DIGEST_EMAIL, DIGEST_EMAIL_FROM and DIGEST_EMAIL_TO are all configured. */
export async function sendDigestEmail(
	env: Pick<Env, "DIGEST_EMAIL" | "DIGEST_EMAIL_FROM" | "DIGEST_EMAIL_TO" | "APP_URL" | "DIGEST_TIMEZONE">,
	digest: Digest,
	makeMessage: MakeMessage = defaultMakeMessage,
): Promise<"sent" | "not-configured"> {
	const from = env.DIGEST_EMAIL_FROM?.trim();
	const to = env.DIGEST_EMAIL_TO?.trim();
	if (!env.DIGEST_EMAIL || !from || !to) return "not-configured";
	const { subject, body } = digestText(digest, env.APP_URL, digestConfig(env).timeZone);
	const raw = buildMime({ from, to, subject, body });
	await env.DIGEST_EMAIL.send((await makeMessage(from, to, raw)) as EmailMessage);
	return "sent";
}
