import { describe, expect, it } from "vitest";
import { finishSyntheticJsonStream, pushSyntheticJsonFragment, startSyntheticJsonStream, STREAM_JSON_LIMITS, type JsonEvent } from "../src/synthetic-stream-json";

const sourceId = "a".repeat(64), scope = "b".repeat(22), encoder = new TextEncoder();
function parse(text: string, chunk: number): JsonEvent[] {
	const data = encoder.encode(text), events: JsonEvent[] = [];
	let state = startSyntheticJsonStream(sourceId, scope);
	for (let i = 0; i < data.length; i += chunk) {
		const part = data.slice(i, i + chunk); let offset = 0;
		while (offset < part.length) {
			const next = pushSyntheticJsonFragment(state, sourceId, scope, part, offset);
			expect(next.nextOffset - offset).toBeLessThanOrEqual(STREAM_JSON_LIMITS.bytesPerCall);
			expect(next.events.length).toBeLessThanOrEqual(STREAM_JSON_LIMITS.eventsPerCall);
			if (next.nextOffset === offset && !next.events.length) throw new Error("no progress");
			state = next.checkpoint; offset = next.nextOffset; events.push(...next.events);
		}
	}
	events.push(...finishSyntheticJsonStream(state, sourceId, scope).events);
	return events;
}
describe("bounded synthetic JSON tokenizer", () => {
	it("preserves events when escapes and multibyte UTF-8 span fragments", () => {
		const input = JSON.stringify({ greeting: 'Привет ✓ 😄 "quoted"', items: [null, true, -12.5e-7, { x: "line\nend" }], empty: {} });
		expect(parse(input, 1)).toEqual(parse(input, 4096));
		expect(parse(input, 1)).toContainEqual({ type: "value", value: 'Привет ✓ 😄 "quoted"' });
	});

	it.each(['{"x":1,"x":2}', '{"x":1,}', '[1,]', '{"x" 1}', '[true false]', '{"x":"cut', '{"x":', '01', '1e400'])('rejects invalid, ambiguous or incomplete JSON %s', (input) => {
		expect(() => parse(input, 3)).toThrow();
	});

	it("bounds token length and rejects identity mismatch", () => {
		expect(() => parse(JSON.stringify("x".repeat(STREAM_JSON_LIMITS.tokenBytes)), 2048)).toThrow(/token exceeds/);
		const state = startSyntheticJsonStream(sourceId, scope);
		expect(() => pushSyntheticJsonFragment(state, "c".repeat(64), scope, encoder.encode("[]"), 0)).toThrow(/identity|checkpoint/);
		expect(state.totalBytes).toBe(0);
	});
});
