// Rough CPU check against the Workers Free plan's 10 ms/request budget.
// Not a precise benchmark: V8 here ≈ V8 in workerd, but machines differ. Treat as an order-of-magnitude guard.

import { describe, expect, it } from "vitest";
import { parseBatchResponse } from "../src/batch";
import { extractBody } from "../src/mime";
import { b64url } from "./helpers";

function newsletter(bytes: number): string {
	const block =
		'<table class="x"><tr><td style="padding:8px;font-family:Arial"><a href="https://t.example.com/' +
		"q".repeat(250) +
		'">Read more</a> &nbsp; Lorem ipsum dolor sit amet, <b>consectetur</b> adipiscing elit &amp; more.</td></tr></table>\n';
	let html = "<html><head><style>.x{color:red}</style></head><body>";
	while (html.length < bytes) html += block;
	return html + "</body></html>";
}

function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.floor(s.length / 2)]!;
}

describe("CPU budget (Workers Free: 10 ms/request)", () => {
	it("a 200 KB HTML email converts in well under the budget", () => {
		const payload = { mimeType: "text/html", headers: [], body: { data: b64url(newsletter(200_000)) } };
		for (let i = 0; i < 5; i++) extractBody(payload); // warm up the JIT
		const times: number[] = [];
		for (let i = 0; i < 15; i++) {
			const t = performance.now();
			extractBody(payload);
			times.push(performance.now() - t);
		}
		// The fastest run, not the median: other test files run in parallel and slow some runs down;
		// the conversion's own cost is what the fastest run shows.
		const ms = Math.min(...times);
		console.log(`200 KB HTML -> text: fastest ${ms.toFixed(2)} ms, median ${median(times).toFixed(2)} ms`);
		expect(ms).toBeLessThan(6);
	});

	it("parsing a 50-message metadata batch is cheap", () => {
		const b = "batch_x";
		const item = (i: number) =>
			`--${b}\r\nContent-Type: application/http\r\nContent-ID: <response-item-${i}>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n` +
			JSON.stringify({
				id: `m${i}`,
				threadId: `t${i}`,
				snippet: "x".repeat(200),
				labelIds: ["INBOX", "UNREAD"],
				internalDate: "1761000000000",
				payload: { headers: [{ name: "From", value: "A <a@b.c>" }, { name: "Subject", value: "S".repeat(80) }] },
			}) +
			"\r\n";
		const body = Array.from({ length: 50 }, (_, i) => item(i)).join("") + `--${b}--`;
		for (let i = 0; i < 5; i++) parseBatchResponse(`multipart/mixed; boundary=${b}`, body);
		const times: number[] = [];
		for (let i = 0; i < 15; i++) {
			const t = performance.now();
			parseBatchResponse(`multipart/mixed; boundary=${b}`, body);
			times.push(performance.now() - t);
		}
		const ms = median(times);
		console.log(`50-part batch parse: median ${ms.toFixed(2)} ms`);
		expect(ms).toBeLessThan(2);
	});
});
