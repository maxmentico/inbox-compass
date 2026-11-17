import { describe, expect, it } from "vitest";
import { decodeEntities, htmlToText } from "../src/html";
import { EXCERPT_CHARS, extractBody, type GmailPart, readableExcerpt, truncate } from "../src/mime";
import { toFullMessage } from "../src/gmail";
import { b64url, bestOf3 } from "./helpers";

const ct = (value: string) => [{ name: "Content-Type", value }];

describe("extractBody", () => {
	it("prefers text/plain inside multipart/alternative and lists attachments", () => {
		const payload: GmailPart = {
			mimeType: "multipart/mixed",
			parts: [
				{
					mimeType: "multipart/alternative",
					parts: [
						{ mimeType: "text/plain", headers: ct("text/plain; charset=UTF-8"), body: { data: b64url("Hello plain") } },
						{ mimeType: "text/html", headers: ct("text/html; charset=UTF-8"), body: { data: b64url("<p>Hello html</p>") } },
					],
				},
				{
					mimeType: "application/pdf",
					filename: "invoice.pdf",
					body: { size: 12345, attachmentId: "att1" },
				},
			],
		};
		const out = extractBody(payload);
		expect(out.source).toBe("text/plain");
		expect(out.text).toBe("Hello plain");
		expect(out.attachments).toEqual([{ filename: "invoice.pdf", mimeType: "application/pdf", sizeBytes: 12345 }]);
	});

	it("falls back to HTML converted to text", () => {
		const out = extractBody({
			mimeType: "text/html",
			headers: ct("text/html; charset=utf-8"),
			body: { data: b64url("<html><head><style>p{}</style></head><body><p>Hi&nbsp;Max</p><p>Line 2</p></body></html>") },
		});
		expect(out.source).toBe("text/html");
		expect(out.text).toBe("Hi Max\n\nLine 2");
	});

	it("decodes UTF-8 Cyrillic", () => {
		const out = extractBody({ mimeType: "text/plain", headers: ct("text/plain; charset=utf-8"), body: { data: b64url("Привет, мир") } });
		expect(out.text).toBe("Привет, мир");
	});

	it("applies a legacy charset when the runtime supports it", () => {
		// "Привет" in windows-1251
		const bytes = new Uint8Array([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]);
		const out = extractBody({ mimeType: "text/plain", headers: ct('text/plain; charset="windows-1251"'), body: { data: b64url(bytes) } });
		expect(out.text).toBe("Привет");
	});

	it("does not throw on an unknown charset", () => {
		const out = extractBody({ mimeType: "text/plain", headers: ct("text/plain; charset=x-made-up"), body: { data: b64url("ok") } });
		expect(out.text).toBe("ok");
	});

	it("treats inline parts with Content-Disposition: attachment as attachments, not body", () => {
		const out = extractBody({
			mimeType: "multipart/mixed",
			parts: [
				{ mimeType: "text/plain", body: { data: b64url("body") } },
				{
					mimeType: "text/plain",
					headers: [{ name: "Content-Disposition", value: "attachment" }],
					body: { data: b64url("not body"), size: 8 },
				},
			],
		});
		expect(out.text).toBe("body");
		expect(out.attachments).toHaveLength(1);
	});

	it("handles a missing payload", () => {
		expect(extractBody(undefined)).toEqual({ text: "", source: "none", attachments: [] });
	});
});

describe("htmlToText", () => {
	it("drops scripts, comments and styles; keeps short links; drops long tracking links", () => {
		const long = `https://track.example.com/${"x".repeat(300)}`;
		const html = `<!-- c --><script>alert(1)</script><p>See <a href="https://example.com/a">the doc</a> or <a href="${long}">this</a>.</p>`;
		expect(htmlToText(html)).toBe("See the doc (https://example.com/a) or this.");
	});

	it("renders lists and table cells readably", () => {
		expect(htmlToText("<ul><li>One</li><li>Two</li></ul><table><tr><td>A</td><td>B</td></tr></table>")).toBe(
			"- One\n- Two\n\nA B",
		);
	});

	it("keeps an unclosed link's text and the rest of the email; a closed one gets its URL", () => {
		expect(htmlToText('<p><a href="https://a.example/x">Open</p><p>Next</p>')).toBe("Open\n\nNext");
		expect(htmlToText('<a href="https://a.example/x"><b>Open</b></a> <abbr>x</abbr></a>')).toBe("Open (https://a.example/x) x");
		expect(htmlToText("a <!-- never closed <p>b</p>")).toBe("a");
		expect(htmlToText("x < y and <p>z")).toBe("x < y and\nz");
	});

	// Linear in the input: one hostile email can't pin a run's CPU (each pattern took seconds with the old regexes).
	const PATHOLOGICAL: [string, string][] = [
		["unclosed links", '<a href="x">'],
		["unclosed comments", "<!--"],
		["unclosed links with tag-like closes", '<a href="x"></abbr>'],
		["unclosed styles", "<style>"],
		["unclosed list items", "<li "],
		["bare angle brackets", "<"],
		["unterminated hrefs", '<a href="'],
		["entities without semicolons", "&#x1&amp"],
		["closing tags only", "</a"],
	];
	for (const [what, unit] of PATHOLOGICAL) {
		it(`stays fast on 40 KB of ${what}`, () => {
			const html = unit.repeat(Math.ceil(40_000 / unit.length));
			expect(bestOf3(() => htmlToText(html))).toBeLessThan(50);
		});
	}
	it("stays fast on one 40 KB tag full of hrefs, and on many HTML parts (the cap is for all parts together)", () => {
		const part = { mimeType: "text/html", body: { data: b64url('<a href="x">'.repeat(3_400)) } };
		const many = { mimeType: "multipart/alternative", parts: Array.from({ length: 20 }, () => part) };
		expect(bestOf3(() => htmlToText(`<a ${'href="x '.repeat(5_000)}>`))).toBeLessThan(50);
		expect(bestOf3(() => extractBody(many, { maxHtmlInputChars: 40_000 }))).toBeLessThan(50);
		const body = extractBody(many, { maxHtmlInputChars: 40_000 });
		expect(body.text.length).toBeLessThan(20);
	});

	it("decodes numeric and named entities, and leaves invalid ones alone", () => {
		expect(decodeEntities("&#1055;&#x440;&amp;&laquo;x&raquo;&#xD800;&bogus;")).toBe("Пр&«x»&#xD800;&bogus;");
	});
});

describe("truncate", () => {
	it("flags truncation", () => {
		expect(truncate("abcdef", 3)).toEqual({ text: "abc", truncated: true });
		expect(truncate("abc", 3)).toEqual({ text: "abc", truncated: false });
	});
});

describe("readableExcerpt (what the sender wrote, kept on the digest item)", () => {
	const text = (body: string, max?: number) => readableExcerpt(body, max).text;

	it("reads an HTML email as text: paragraphs, lists and short links kept as plain text; padding and tracking URLs dropped", () => {
		const html =
			'<html><head><style>p{color:red}</style></head><body><div style="display:none">Preview͏‌­ ͏‌</div>' +
			"<p>Hi Max,</p><p>Your plan ends on <b>25 October</b>.</p><ul><li>Basic</li><li>£4.99 a month</li></ul>" +
			'<p><a href="https://hostline.example/renew">Renew</a> · <a href="https://t.example/' + "q".repeat(300) + '">Track</a></p>' +
			"<p>&nbsp;</p><p>&nbsp;</p><p>&nbsp;</p><p>Hostline</p></body></html>";
		const body = extractBody({ mimeType: "text/html", body: { data: b64url(html) } }).text;
		expect(readableExcerpt(body)).toEqual({ text: "Preview\n\nHi Max,\n\nYour plan ends on 25 October.\n\n- Basic\n- £4.99 a month\n\nRenew (https://hostline.example/renew) · Track\n\nHostline" });
		// In plain text, a tracking URL becomes "[link]"; a short one stays.
		expect(text(`See https://a.example/x and <https://click.example/${"z".repeat(200)}>`)).toBe("See https://a.example/x and [link]");
	});

	it("drops quoted earlier messages: '>' lines and everything from 'On … wrote:' (one or two lines), Outlook's header, Russian; says so", () => {
		expect(readableExcerpt("Sounds good.\n> earlier\n>> older\nSee you then.")).toEqual({ text: "Sounds good.\nSee you then.", cut: "quote" });
		expect(readableExcerpt("Yes, Friday works.\n\nOn Mon, 20 Oct 2026 at 10:00, Tom Berger <tom@x.example> wrote:\n> Does Friday work?\nmore quoted")).toEqual({ text: "Yes, Friday works.…", cut: "quote" });
		expect(text("Yes.\nOn Mon, 20 Oct 2026 at 10:00, Tom Berger <\ntom@x.example> wrote:\nquoted")).toBe("Yes.…");
		expect(text("Approved.\n\n________________________________\nFrom: Priya <p@x.example>\nSent: Monday\nquoted")).toBe("Approved.\n\n________________________________…");
		expect(text("Да, подходит.\n\nпн, 20 окт. 2026 г. в 10:00, Том <tom@x.example>:\n> Подходит?")).toBe("Да, подходит.…");
		expect(text("Ok\n-----Original Message-----\nquoted")).toBe("Ok…");
		expect(readableExcerpt("On Monday we meet.\nBring the slides.")).toEqual({ text: "On Monday we meet.\nBring the slides." });
	});

	it("keeps a forwarded email whole: Gmail's and Apple's forward headers aren't quotes", () => {
		const gmail = "FYI, see below.\n\n---------- Forwarded message ---------\nFrom: Anna <anna@client.example>\nDate: Mon, 20 Oct 2026 at 10:00\nSubject: Contract\nTo: Max <me@example.com>\n\nHi Max, the contract is attached.";
		expect(readableExcerpt(gmail)).toEqual({ text: gmail });
		const apple = "See below\n\nBegin forwarded message:\n\nFrom: Anna <anna@client.example>\nDate: 20 October 2026 at 10:00:00 BST\nSubject: Contract\n\nHi Max, the contract is attached.";
		expect(readableExcerpt(apple)).toEqual({ text: apple });
		// A reply quoted inside the forwarded email is still cut.
		expect(text(`${gmail}\n\nOn Sun, 19 Oct 2026 at 09:00, Max <me@example.com> wrote:\n> old`)).toBe(`${gmail}…`);
	});

	it("an address and a time in a sentence ending in a colon isn't a quote header", () => {
		const body = "Our meeting is at 10:00 with Anna <anna@client.example>:\n- agenda\n- budget";
		expect(readableExcerpt(body)).toEqual({ text: body });
		expect(text("Hi\n20.10.2026, 10:00, Tom <tom@x.example>:\nquoted")).toBe("Hi…");
	});

	it("turns every line separator into \\n (U+2028, U+2029, NEL, CR), so text can't hide a line break", () => {
		expect(text("a b c\u0085d\re\r\nf\u000bg")).toBe("a\nb\nc\nd\ne\nf\ng");
	});

	it("collapses spaces and blank-line runs, and caps at EXCERPT_CHARS with an ellipsis at a word break", () => {
		expect(text("  a \t  b  \r\n\r\n\r\n\r\n c  d  ")).toBe("a b\n\nc d");
		const long = readableExcerpt("word ".repeat(1_000));
		expect(long.text.length).toBeLessThanOrEqual(EXCERPT_CHARS + 1);
		expect(long.text.endsWith("word…")).toBe(true);
		expect(long.cut).toBe("length");
		expect(text("x".repeat(5_000), 100)).toBe(`${"x".repeat(100)}…`);
		expect(readableExcerpt("")).toEqual({ text: "" });
	});

	it("stays fast on hostile input", () => {
		expect(
			bestOf3(() => {
				readableExcerpt(`${"On ".repeat(3_000)}\n${"a".repeat(4_000)}:\n${"> ".repeat(2_000)}`);
				readableExcerpt(`${"x <a@b> ".repeat(800)}:`);
				readableExcerpt(`${"2026 10:00 ".repeat(36)}<a@b.c>:\n`.repeat(12));
			}),
		).toBeLessThan(50);
	});

	it("reads further than the model does: the item's excerpt isn't cut at the model's 2,500 characters", () => {
		const body = `${"Line of the email. ".repeat(150)}End.`;
		const full = toFullMessage("me", { id: "m1", threadId: "t1", payload: { mimeType: "text/plain", headers: [{ name: "Cc", value: "Bo <bo@x.example>" }], body: { data: b64url(body) } } }, 2_500);
		expect(full.body).toHaveLength(2_500);
		expect(full.bodyTruncated).toBe(true);
		expect(full.excerpt).toEqual({ text: body.trim() });
		expect(full.cc).toBe("Bo <bo@x.example>");
	});
});
