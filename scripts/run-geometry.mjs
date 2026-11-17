// Checks that the run progress page never moves its rows: every mailbox row has the same top and
// height in every state (to do, in progress, completed, failed, finished, paused), at 375 px and
// 1280 px. Renders the snapshots from `npm run ui:snapshots` in headless Chrome (DevTools protocol;
// no extra packages) and prints each row's top and height.
//
//   npm run ui:snapshots && npm run ui:geometry        (CHROME=/path/to/chrome to choose the browser)

import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PAGES = ["06a-run-start", "06f-run-counting", "06-run-progress", "06e-run-last-step", "06b-run-ready", "06d-run-paused"];
const WIDTHS = [375, 1280];
const dir = join(process.cwd(), "docs/design-handover/current");
const port = 9334;

const chrome = spawn(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${port}`, `--user-data-dir=${mkdtempSync(join(tmpdir(), "geo-"))}`, "about:blank"], { stdio: "ignore" });
let ws;
try {
	let info;
	for (let i = 0; i < 50 && !info; i++) {
		info = await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json()).catch(() => null);
		if (!info) await new Promise((r) => setTimeout(r, 200));
	}
	ws = new WebSocket(info.webSocketDebuggerUrl);
	await new Promise((r) => ws.addEventListener("open", r, { once: true }));
	let n = 0;
	const waiting = new Map();
	ws.addEventListener("message", (e) => {
		const m = JSON.parse(e.data);
		if (m.id && waiting.has(m.id)) {
			waiting.get(m.id)(m);
			waiting.delete(m.id);
		}
	});
	const send = (method, params = {}, sessionId) =>
		new Promise((resolve, reject) => {
			const id = ++n;
			waiting.set(id, (m) => (m.error ? reject(new Error(m.error.message)) : resolve(m.result)));
			ws.send(JSON.stringify({ id, method, params, sessionId }));
		});
	const { targetId } = await send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await send("Target.attachToTarget", { targetId, flatten: true });

	let ok = true;
	for (const width of WIDTHS) {
		await send("Emulation.setDeviceMetricsOverride", { width, height: 1200, deviceScaleFactor: 1, mobile: width < 640 }, sessionId);
		const rows = {};
		for (const p of PAGES) {
			await send("Page.navigate", { url: `file://${dir}/${p}.html` }, sessionId);
			await new Promise((r) => setTimeout(r, 300));
			const { result } = await send(
				"Runtime.evaluate",
				{
					expression: `JSON.stringify([...document.querySelectorAll(".jrow")].filter((e) => e.offsetParent).map((e) => { const r = e.getBoundingClientRect(); return [e.querySelector(".alias").textContent, e.className.replace("jrow is-", ""), Math.round((r.top + scrollY) * 100) / 100, Math.round(r.height * 100) / 100]; }))`,
					returnByValue: true,
				},
				sessionId,
			);
			rows[p] = JSON.parse(result.value);
		}
		console.log(`\n${width} px: top / height of each row, by page (state)`);
		const aliases = rows[PAGES[0]].map((r) => r[0]);
		for (const [i, alias] of aliases.entries()) {
			const cells = PAGES.map((p) => rows[p][i]);
			const same = cells.every((c) => c && c[2] === cells[0][2] && c[3] === cells[0][3]);
			if (!same) ok = false;
			console.log(`${same ? "ok  " : "MOVED"} ${alias.padEnd(9)} ${cells.map((c) => (c ? `${c[1].padEnd(7)} ${c[2]}/${c[3]}` : "missing")).join("  |  ")}`);
		}
	}
	console.log(ok ? "\nEvery row keeps its top and height in every state." : "\nRows move between states.");
	process.exitCode = ok ? 0 : 1;
} finally {
	ws?.close();
	chrome.kill();
}
