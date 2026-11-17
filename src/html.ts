// Small, dependency-free HTML -> readable text conversion for email bodies.
// Not a sanitizer: output is plain text handed to Claude, never rendered as HTML.

const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
	ndash: "–",
	mdash: "—",
	hellip: "…",
	laquo: "«",
	raquo: "»",
	lsquo: "‘",
	rsquo: "’",
	ldquo: "“",
	rdquo: "”",
	bull: "•",
	middot: "·",
	copy: "©",
	reg: "®",
	trade: "™",
	euro: "€",
	pound: "£",
	zwnj: "",
	zwj: "",
};

export function decodeEntities(s: string): string {
	return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, ent: string) => {
		if (ent[0] === "#") {
			const cp = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
			if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return whole;
			return String.fromCodePoint(cp);
		}
		const named = NAMED_ENTITIES[ent.toLowerCase()];
		return named ?? whole;
	});
}

const MAX_LINK_LENGTH = 200;
/** A tag longer than this isn't read for its href (bounds the attribute search). */
const MAX_TAG_LENGTH = 2_000;
/** Blocks dropped whole, with their content. */
const DROPPED = new Set(["script", "style", "head", "title", "template", "svg"]);
const BLOCK_CLOSE = new Set(["p", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "table", "blockquote", "section", "article", "header", "footer"]);
const BLOCK_OPEN = new Set(["p", "div", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "blockquote"]);

/** The text an anchor becomes: its text, plus the URL when it's informative and short (tracking redirects are long). */
function anchorText(inner: string, href: string | null): string {
	const text = inner.trim();
	if (href === null) return text;
	const url = decodeEntities(href.trim());
	if (!/^https?:\/\//i.test(url) || url.length > MAX_LINK_LENGTH) return text;
	if (!text || decodeEntities(text) === url) return url;
	return `${text} (${url})`;
}

/**
 * One left-to-right pass, so the work is linear in the input whatever it holds: every search (indexOf)
 * starts where the last one ended, and an unclosed comment, tag or dropped block ends the text there.
 * (Regexes like `<a[^>]*?href=(.*?)…<\/a>` are quadratic or worse on unclosed tags.)
 */
export function htmlToText(html: string): string {
	const lower = html.toLowerCase();
	const out: string[] = [];
	/** Where the open anchor's text starts in `out`, and its href (null: none worth keeping). */
	let anchor: { at: number; href: string | null } | null = null;
	const closeAnchor = () => {
		if (!anchor) return;
		const inner = out.splice(anchor.at).join("");
		out.push(anchorText(inner, anchor.href));
		anchor = null;
	};
	/** The next "</a>" at or after the current position; -1 once there's none left. Only moves forward. */
	let nextClose = -2;
	const closedLater = (from: number) => {
		while (nextClose !== -1 && nextClose < from) {
			nextClose = lower.indexOf("</a", Math.max(from, nextClose + 1));
			// "</abbr>", "</aside>": not an anchor's end; look on.
			while (nextClose >= 0 && /[a-z0-9]/.test(lower[nextClose + 3] ?? "")) nextClose = lower.indexOf("</a", nextClose + 3);
		}
		return nextClose !== -1;
	};
	let i = 0;
	while (i < html.length) {
		const lt = html.indexOf("<", i);
		if (lt < 0) {
			out.push(html.slice(i));
			break;
		}
		if (lt > i) out.push(html.slice(i, lt));
		if (lower.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			if (end < 0) break;
			i = end + 3;
			continue;
		}
		// "<" not followed by a tag name, "/", "!" or "?" is text, as in a browser ("x < y").
		if (!/[a-z/!?]/.test(lower[lt + 1] ?? "")) {
			out.push("<");
			i = lt + 1;
			continue;
		}
		const gt = html.indexOf(">", lt + 1);
		// No ">" anywhere after it: not a tag, and none can follow. The rest is text.
		if (gt < 0) {
			out.push(html.slice(lt));
			break;
		}
		const tag = lower.slice(lt + 1, gt);
		const closing = tag.startsWith("/");
		const name = /^\/?\s*([a-z][a-z0-9]*)/.exec(tag)?.[1] ?? "";
		i = gt + 1;
		if (!closing && DROPPED.has(name)) {
			const end = lower.indexOf(`</${name}`, i);
			if (end < 0) break;
			const after = html.indexOf(">", end);
			if (after < 0) break;
			i = after + 1;
			continue;
		}
		if (name === "a") {
			if (closing) closeAnchor();
			else {
				closeAnchor();
				// Never closed: the tag just goes, as any other.
				if (!closedLater(gt + 1)) continue;
				const attrs = gt - lt <= MAX_TAG_LENGTH ? html.slice(lt + 1, gt) : "";
				const m = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
				anchor = { at: out.length, href: m ? (m[1] ?? m[2] ?? "") : null };
			}
			continue;
		}
		if (anchor) continue; // inside a link, tags just go
		if (name === "br") out.push("\n");
		else if (name === "li" && !closing) out.push("\n- ");
		else if (closing && BLOCK_CLOSE.has(name)) out.push("\n");
		else if (!closing && BLOCK_OPEN.has(name)) out.push("\n");
		else if (closing && (name === "td" || name === "th")) out.push("\t");
	}
	closeAnchor();
	let s = decodeEntities(out.join(""));
	// Whitespace cleanup.
	s = s.replace(/\r\n?/g, "\n");
	s = s.replace(/[ \t\u00a0]+/g, " ");
	s = s.replace(/ ?\n ?/g, "\n");
	s = s.replace(/\n{3,}/g, "\n\n");
	return s.trim();
}
