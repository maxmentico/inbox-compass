import { describe, expect, it } from "vitest";
import { stepProgressTick, streamPage } from "../src/pages";

describe("streamPage", () => {
	it("rest() finishes and sends the closing chunk when the client stops reading mid-step", async () => {
		let work!: Promise<unknown>;
		let restDone = false;
		const res = streamPage(
			"T",
			"<p>start</p>",
			async (write) => {
				for (let i = 1; i <= 8; i++) await write(stepProgressTick(i, 8));
				restDone = true;
				return "<p id=tail>done</p>";
			},
			{ waitUntil: (p) => {
				work = p;
			} },
		);
		const reader = res.body!.getReader();
		await reader.read();
		const [, chunks] = await Promise.all([
			work,
			(async () => {
				const parts: string[] = [];
				for (;;) {
					const { done, value } = await reader.read();
					if (done) break;
					parts.push(new TextDecoder().decode(value));
				}
				return parts.join("");
			})(),
		]);
		expect(restDone).toBe(true);
		expect(chunks).toContain('id=tail');
		expect(chunks).toContain("8 of 8");
	}, 15_000);
});
