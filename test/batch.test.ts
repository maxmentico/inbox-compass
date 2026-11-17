import { describe, expect, it } from "vitest";
import { boundaryFromContentType, buildBatchBody, parseBatchResponse } from "../src/batch";

describe("buildBatchBody", () => {
	it("produces one application/http part per item with CRLF framing and a closing delimiter", () => {
		const body = buildBatchBody(
			[
				{ id: "0", method: "GET", path: "/gmail/v1/users/me/messages/a?format=metadata" },
				{ id: "1", method: "GET", path: "/gmail/v1/users/me/messages/b?format=metadata" },
			],
			"B",
		);
		expect(body).toBe(
			"--B\r\nContent-Type: application/http\r\nContent-ID: <item-0>\r\n\r\nGET /gmail/v1/users/me/messages/a?format=metadata\r\n\r\n" +
				"--B\r\nContent-Type: application/http\r\nContent-ID: <item-1>\r\n\r\nGET /gmail/v1/users/me/messages/b?format=metadata\r\n\r\n" +
				"--B--\r\n",
		);
	});

	it("rejects batches over 50", () => {
		const items = Array.from({ length: 51 }, (_, i) => ({ id: String(i), method: "GET" as const, path: "/x" }));
		expect(() => buildBatchBody(items, "B")).toThrow(/too large/);
	});
});

describe("parseBatchResponse", () => {
	const part = (id: string, status: string, json: string, eol = "\r\n") =>
		`--batch_abc${eol}Content-Type: application/http${eol}Content-ID: <response-item-${id}>${eol}${eol}` +
		`HTTP/1.1 ${status}${eol}Content-Type: application/json; charset=UTF-8${eol}Vary: Origin${eol}${eol}${json}${eol}`;

	it("maps out-of-order parts by Content-ID and keeps per-part status", () => {
		const body =
			"preamble ignored\r\n" +
			part("2", "429 Too Many Requests", '{"error":{"code":429}}') +
			part("0", "200 OK", '{"id":"m0","threadId":"t0"}') +
			part("1", "404 Not Found", '{"error":{"code":404}}') +
			"--batch_abc--\r\n";
		const parsed = parseBatchResponse("multipart/mixed; boundary=batch_abc", body);
		expect(parsed.size).toBe(3);
		expect(parsed.get("0")).toEqual({ status: 200, body: { id: "m0", threadId: "t0" } });
		expect(parsed.get("1")?.status).toBe(404);
		expect(parsed.get("2")?.status).toBe(429);
	});

	it("tolerates LF-only line endings and a quoted boundary", () => {
		const body = part("0", "200 OK", '{"id":"x"}', "\n") + "--batch_abc--\n";
		const parsed = parseBatchResponse('multipart/mixed; boundary="batch_abc"', body);
		expect(parsed.get("0")).toEqual({ status: 200, body: { id: "x" } });
	});

	it("does not split on a boundary-like string inside JSON when it lacks the -- prefix at line start", () => {
		const body = part("0", "200 OK", '{"snippet":"--batch_abc is a word"}') + "--batch_abc--";
		expect(parseBatchResponse("multipart/mixed; boundary=batch_abc", body).get("0")?.body).toEqual({
			snippet: "--batch_abc is a word",
		});
	});

	it("treats regex metacharacters in a quoted boundary literally", () => {
		const body = '--batch.a+\r\nContent-ID: <response-item-0>\r\n\r\nHTTP/1.1 200 OK\r\n\r\n{"id":"x"}\r\n--batch.a+--\r\n';
		expect(parseBatchResponse('multipart/mixed; boundary="batch.a+"', body).get("0")?.body).toEqual({ id: "x" });
	});

	it("throws without a boundary", () => {
		expect(() => boundaryFromContentType("application/json")).toThrow(/boundary/);
	});
});
