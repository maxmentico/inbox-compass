import { describe, expect, it } from "vitest";
import { dayLabel, dueLabel, itemTime, nameLooksLikeAddress, runTime, senderName, shortTime, timeAgo, toActionHeadline } from "../src/format";

// Saturday 24 October 2026, 07:30 in London (still BST, UTC+1).
const NOW = new Date("2026-10-24T06:30:00Z");
const TZ = "Europe/London";

describe("human dates", () => {
	it("item times: the time today, weekday and time within 6 days, the date before that", () => {
		expect(itemTime("2026-10-24T05:58:00Z", TZ, NOW)).toBe("06:58");
		expect(itemTime("2026-10-23T23:30:00Z", TZ, NOW)).toBe("00:30"); // already the 24th in London
		expect(itemTime("2026-10-23T19:56:00Z", TZ, NOW)).toBe("Fri 20:56");
		expect(itemTime("2026-10-18T10:00:00Z", TZ, NOW)).toBe("Sun 11:00");
		expect(itemTime("2026-10-17T10:00:00Z", TZ, NOW)).toBe("17 Oct");
		expect(itemTime("2025-12-31T10:00:00Z", TZ, NOW)).toBe("31 Dec 2025");
		expect(itemTime(null, TZ, NOW)).toBe("");
		expect(itemTime("not a date", TZ, NOW)).toBe("");
	});

	it("item times follow the owner's time zone, not UTC", () => {
		// 02:30 on the 24th in New York; 23:00 on the 23rd there is yesterday.
		expect(itemTime("2026-10-24T03:00:00Z", "America/New_York", NOW)).toBe("Fri 23:00");
		expect(itemTime("2026-10-24T05:00:00Z", "America/New_York", NOW)).toBe("01:00");
	});

	it("due dates: today, tomorrow, a weekday and date, or overdue", () => {
		expect(dueLabel("2026-10-24", TZ, NOW)).toEqual({ text: "Due today", late: false });
		expect(dueLabel("2026-10-25", TZ, NOW)).toEqual({ text: "Due tomorrow", late: false });
		expect(dueLabel("2026-10-28", TZ, NOW)).toEqual({ text: "Due Wed 28 Oct", late: false });
		expect(dueLabel("2026-11-03", TZ, NOW)).toEqual({ text: "Due Tue 3 Nov", late: false });
		expect(dueLabel("2027-01-05", TZ, NOW)).toEqual({ text: "Due Tue 5 Jan 2027", late: false });
		expect(dueLabel("2026-10-16", TZ, NOW)).toEqual({ text: "Overdue since 16 Oct", late: true });
		expect(dueLabel("2026-10-23", TZ, NOW)).toEqual({ text: "Overdue since 23 Oct", late: true });
		expect(dueLabel("soon", TZ, NOW)).toEqual({ text: "Due soon", late: false });
	});

	it("run labels, the small print and linked dates", () => {
		expect(runTime("2026-10-24T06:30:00Z", TZ, NOW)).toBe("Sat 24 Oct, 07:30");
		expect(runTime("2026-10-23T19:40:00Z", TZ, NOW)).toBe("Fri 23 Oct, 20:40");
		expect(shortTime("2026-10-24T06:30:00Z", TZ, NOW)).toBe("24 Oct, 07:30");
		expect(dayLabel("2026-10-02T09:00:00.000Z", TZ, NOW)).toBe("2 Oct");
	});
});

describe("sender display names", () => {
	it("takes the display name, else the address, else the header as it is", () => {
		expect(senderName("Priya Natarajan <priya@northwind.example>")).toBe("Priya Natarajan");
		expect(senderName('"Natarajan, Priya" <priya@northwind.example>')).toBe("Natarajan, Priya");
		expect(senderName('"Tom \\"TB\\" Berger" <tom@x.example>')).toBe('Tom "TB" Berger');
		expect(senderName("info@schoolpost.example")).toBe("info@schoolpost.example");
		expect(senderName("<ap@supplier.example>")).toBe("ap@supplier.example");
		expect(senderName('"" <ap@supplier.example>')).toBe("ap@supplier.example");
		expect(senderName("News")).toBe("News");
		expect(senderName("(couldn't load)")).toBe("");
	});

	it("returns a hostile name as plain text, for the page to escape", () => {
		expect(senderName('<img src=x onerror=alert(1)> "Evil" <e@x.com>')).toBe('<img src=x onerror=alert(1)> "Evil"');
	});

	it("tells which display names could pass for an address or a domain", () => {
		expect(nameLooksLikeAddress("billing@yourbank.com")).toBe(true);
		expect(nameLooksLikeAddress("paypal.com Security")).toBe(true);
		expect(nameLooksLikeAddress("PayPal Security")).toBe(false);
		expect(nameLooksLikeAddress("Mr. Tom Berger")).toBe(false);
	});
});

describe("time ago", () => {
	const S = 1_000;
	const MIN = 60 * S;
	const H = 60 * MIN;
	const D = 24 * H;
	const ago = (ms: number) => timeAgo(NOW.getTime() - ms, NOW);

	it("seconds, minutes and hours, with the boundaries", () => {
		expect(ago(0)).toBe("just now");
		expect(ago(4 * S)).toBe("just now");
		expect(ago(5 * S)).toBe("5 sec ago");
		expect(ago(59 * S)).toBe("59 sec ago");
		expect(ago(60 * S)).toBe("1 min ago");
		expect(ago(59 * MIN + 59 * S)).toBe("59 min ago");
		expect(ago(60 * MIN)).toBe("1 h ago");
		expect(ago(23 * H + 59 * MIN)).toBe("23 h ago");
	});

	it("days, weeks, months and years, singular where it's one", () => {
		expect(ago(24 * H)).toBe("1 day ago");
		expect(ago(2 * D)).toBe("2 days ago");
		expect(ago(6 * D + 23 * H)).toBe("6 days ago");
		expect(ago(7 * D)).toBe("1 week ago");
		expect(ago(28 * D)).toBe("4 weeks ago");
		expect(ago(29 * D)).toBe("4 weeks ago");
		expect(ago(30 * D)).toBe("1 month ago");
		expect(ago(60 * D)).toBe("2 months ago");
		expect(ago(11 * 30 * D)).toBe("11 months ago");
		expect(ago(364 * D)).toBe("11 months ago");
		expect(ago(365 * D)).toBe("1 year ago");
		expect(ago(3 * 365 * D)).toBe("3 years ago");
	});

	it("a time in the future (clock skew) is just now", () => {
		expect(ago(-10 * MIN)).toBe("just now");
	});
});

describe("toActionHeadline", () => {
	it("says how much To action holds, in four or five friendly words", () => {
		const cases: [number, number, string][] = [
			[0, 0, "All clear. Enjoy your day!"],
			[0, 3, "All done. Nice work!"],
			[1, 1, "Just one thing for you"],
			[2, 5, "Just two things for you"],
			[3, 3, "3 things, nice and easy"],
			[4, 4, "4 things, nice and easy"],
			[5, 5, "5 things. You've got this"],
			[7, 7, "7 things. You've got this"],
			[8, 8, "8 things. Coffee first?"],
			[23, 23, "23 things. Coffee first?"],
		];
		for (const [open, total, text] of cases) {
			expect(toActionHeadline(open, total)).toBe(text);
			if (open) expect(toActionHeadline(open, total, 2)).toBe(text);
			expect(text.split(" ").length).toBeGreaterThanOrEqual(4);
			expect(text.split(" ").length).toBeLessThanOrEqual(5);
		}
	});

	it("with nothing new but items still open from earlier, says so", () => {
		expect(toActionHeadline(0, 0, 1)).toBe("Nothing new. Just leftovers.");
		expect(toActionHeadline(0, 2, 3)).toBe("New ones done. Nice work!");
	});
});
