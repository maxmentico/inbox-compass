// Human dates and sender names for the pages. Plain text only: callers escape what these return.
// Dates are in the owner's time zone, relative to `now`, which callers pass in so tests can pin it.

import type { Digest } from "./digest";
import { senderAddress } from "./rules";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const DAY_MS = 86_400_000;

interface Parts {
	y: number;
	m: number;
	d: number;
	hh: string;
	mm: string;
}

// One formatter per time zone: building an Intl formatter is far slower than using one.
const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(date: Date, timeZone: string): Parts {
	let f = formatters.get(timeZone);
	if (!f) {
		f = new Intl.DateTimeFormat("en-US", {
			timeZone,
			year: "numeric",
			month: "numeric",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		});
		formatters.set(timeZone, f);
	}
	const p: Record<string, string> = {};
	for (const { type, value } of f.formatToParts(date)) p[type] = value;
	return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: p.hour ?? "00", mm: p.minute ?? "00" };
}

/** Days since 1970-01-01 of a calendar date, for whole-day differences. */
const dayNumber = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / DAY_MS;
const weekday = (y: number, m: number, d: number) => WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!;
/** "21 Oct", with the year only when it isn't this year. */
const dayMonth = (y: number, m: number, d: number, thisYear: number) => `${d} ${MONTHS[m - 1]}${y === thisYear ? "" : ` ${y}`}`;

function parse(iso: string | null | undefined): Date | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	return Number.isNaN(t) ? null : new Date(t);
}

/** When an email arrived: "06:58" today, "Fri 20:56" within 6 days, "21 Oct" before that. */
export function itemTime(iso: string | null, timeZone: string, now: Date): string {
	const date = parse(iso);
	if (!date) return "";
	const t = partsIn(date, timeZone);
	const today = partsIn(now, timeZone);
	const ago = dayNumber(today.y, today.m, today.d) - dayNumber(t.y, t.m, t.d);
	if (ago === 0) return `${t.hh}:${t.mm}`;
	if (ago > 0 && ago <= 6) return `${weekday(t.y, t.m, t.d)} ${t.hh}:${t.mm}`;
	return dayMonth(t.y, t.m, t.d, today.y);
}

/** A due date (YYYY-MM-DD): "Due today", "Due tomorrow", "Due Wed 28 Oct", or overdue. */
export function dueLabel(due: string, timeZone: string, now: Date): { text: string; late: boolean } {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
	if (!m) return { text: `Due ${due}`, late: false };
	const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
	const today = partsIn(now, timeZone);
	const ahead = dayNumber(y, mo, d) - dayNumber(today.y, today.m, today.d);
	if (ahead < 0) return { text: `Overdue since ${dayMonth(y, mo, d, today.y)}`, late: true };
	if (ahead === 0) return { text: "Due today", late: false };
	if (ahead === 1) return { text: "Due tomorrow", late: false };
	return { text: `Due ${weekday(y, mo, d)} ${dayMonth(y, mo, d, today.y)}`, late: false };
}

/** A run or window start: "Sat 24 Oct, 07:30". */
export function runTime(iso: string, timeZone: string, now: Date): string {
	const date = parse(iso);
	if (!date) return iso;
	const t = partsIn(date, timeZone);
	return `${weekday(t.y, t.m, t.d)} ${dayMonth(t.y, t.m, t.d, partsIn(now, timeZone).y)}, ${t.hh}:${t.mm}`;
}

/** The same without the weekday, for the small print: "24 Oct, 07:30". */
export function shortTime(iso: string, timeZone: string, now: Date): string {
	const date = parse(iso);
	if (!date) return iso;
	const t = partsIn(date, timeZone);
	return `${dayMonth(t.y, t.m, t.d, partsIn(now, timeZone).y)}, ${t.hh}:${t.mm}`;
}

/** A calendar day: "2 Oct". */
export function dayLabel(iso: string, timeZone: string, now: Date): string {
	const date = parse(iso);
	if (!date) return iso;
	const t = partsIn(date, timeZone);
	return dayMonth(t.y, t.m, t.d, partsIn(now, timeZone).y);
}

/**
 * The name to show for a From header: its display name, else its address, else the header as it is.
 * A header that is only a (comment), such as the "(couldn't load)" placeholder, has no name.
 */
export function senderName(from: string): string {
	const lt = from.lastIndexOf("<");
	if (lt > 0) {
		let name = from.slice(0, lt).trim().replace(/\s+/g, " ");
		if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1).replace(/\\(.)/g, "$1").trim();
		if (name) return name;
	}
	const address = senderAddress(from);
	if (address) return address;
	const raw = from.trim();
	return /^\(.*\)$/.test(raw) ? "" : raw;
}

/**
 * Whether a display name could pass for an address or a domain ("billing@yourbank.com",
 * "paypal.com Security"), so the real address must be shown beside it.
 */
export function nameLooksLikeAddress(name: string): boolean {
	return name.includes("@") || /[a-z0-9-]\.[a-z]{2,}/i.test(name);
}

/**
 * The notice when the model was unavailable, emails were estimated, or estimates are waiting: "The AI
 * model's daily allowance ran out at 10:28. 9 emails were estimated from your history; they'll be
 * re-checked when it's back. 9 estimates are waiting to be re-checked; the oldest is from 24 Oct."
 */
export function aiNotice(ai: NonNullable<Digest["ai"]>, timeZone: string, now: Date): string {
	const parts: string[] = [];
	const at = ai.unavailable ? itemTime(ai.unavailable.at, timeZone, now) : "";
	if (ai.unavailable?.reason === "quota") parts.push(`The AI model's daily allowance ran out at ${at}.`);
	else if (ai.unavailable) parts.push(`The AI model wasn't available at ${at}.`);
	else if (ai.estimated) parts.push("The AI model couldn't classify some emails.");
	const n = ai.estimated;
	if (n) {
		const how = ai.fromHistory === n ? "from your history" : ai.fromHistory === 0 ? "with simple rules" : "from your history and simple rules";
		const when = ai.unavailable ? "when it's back" : "on the next run";
		parts.push(`${n} email${n === 1 ? " was" : "s were"} estimated ${how}; ${n === 1 ? "it'll" : "they'll"} be re-checked ${when}.`);
	}
	const w = ai.waiting ?? 0;
	if (w) {
		const oldest = ai.oldestWaiting ? `; the oldest is from ${dayLabel(ai.oldestWaiting, timeZone, now)}` : "";
		parts.push(`${w} estimate${w === 1 ? " is" : "s are"} waiting to be re-checked${oldest}.`);
	}
	const x = ai.expired ?? 0;
	if (x) parts.push(`${x} estimate${x === 1 ? "" : "s"} couldn't be re-checked in time; ${x === 1 ? "it's" : "they're"} in To action to check.`);
	return parts.join(" ");
}

/**
 * How long ago, in words: "just now" (under 5 s, or in the future: clock skew), "N sec ago", "N min ago",
 * "N h ago", "N days ago", "N weeks ago" (7 to 29 days), "N months ago" (30-day months, at most 11), then
 * "N years ago". Singular where it's 1 ("1 day ago").
 */
export function timeAgo(at: number, now: Date): string {
	const s = Math.floor((now.getTime() - at) / 1000);
	if (s < 5) return "just now";
	if (s < 60) return `${s} sec ago`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m} min ago`;
	const h = Math.floor(m / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.floor(h / 24);
	const n = (k: number, unit: string) => `${k} ${unit}${k === 1 ? "" : "s"} ago`;
	if (d < 7) return n(d, "day");
	if (d < 30) return n(Math.floor(d / 7), "week");
	if (d < 365) return n(Math.min(11, Math.floor(d / 30)), "month");
	return n(Math.floor(d / 365), "year");
}

/**
 * The digest's headline after a since-last-check run, from how many To action items are still open
 * (`total`: how many it had, done or not; `leftover`: items still open from earlier runs). Friendly, and
 * four or five words.
 */
export function toActionHeadline(open: number, total: number, leftover = 0): string {
	if (open <= 0 && total > 0) return leftover > 0 ? "New ones done. Nice work!" : "All done. Nice work!";
	if (open <= 0) return leftover > 0 ? "Nothing new. Just leftovers." : "All clear. Enjoy your day!";
	if (open === 1) return "Just one thing for you";
	if (open === 2) return "Just two things for you";
	if (open <= 4) return `${open} things, nice and easy`;
	if (open <= 7) return `${open} things. You've got this`;
	return `${open} things. Coffee first?`;
}
