import { app, scheduledRun } from "./web";
import { withAtomicState } from "./atomic-kv";
import { ensureAtomicBaseline, resolveAtomicMode } from "./atomic-migration";
import { AtomicGenerationClient } from "./atomic-generation-authority";
import { randomToken } from "./crypto";

export { InboxJobAuthority } from "./job-authority";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const requestAt = Date.now();
		try {
			await ensureAtomicBaseline(env);
			const resolved = await resolveAtomicMode(env);
			if (resolved.ATOMIC_STATE_MODE !== "bridge" || !resolved.JOB_AUTHORITY) return app.fetch(request, withAtomicState(resolved), ctx);
			const url = new URL(request.url);
			const drivesMutation = request.method !== "GET" || url.pathname !== "/";
			if (!drivesMutation) return app.fetch(request, resolved, ctx);
			const operation = randomToken(16), journal = new AtomicGenerationClient(resolved.JOB_AUTHORITY);
			if (!(await journal.bridgeBegin(operation, url.pathname.startsWith("/internal/") ? "job" : "web"))?.ok) return new Response("Temporarily unavailable", { status: 503 });
			try { return await app.fetch(request, resolved, ctx); }
			finally { if (!(await journal.bridgeEnd(operation))?.ok) console.error("bridge operation outcome could not be recorded"); }
		} finally {
			if (request.method === "POST" && new URL(request.url).pathname === "/app/run") {
				console.log(JSON.stringify({ evt: "run-submit-total", elapsedMs: Date.now() - requestAt }));
			}
		}
	},
	async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
		await ensureAtomicBaseline(env);
		const resolved = await resolveAtomicMode(env);
		if (resolved.ATOMIC_STATE_MODE !== "bridge" || !resolved.JOB_AUTHORITY) { await scheduledRun(withAtomicState(resolved), ctx); return; }
		const operation = randomToken(16), journal = new AtomicGenerationClient(resolved.JOB_AUTHORITY);
		if (!(await journal.bridgeBegin(operation, "scheduled"))?.ok) throw new Error("Bridge journal is unavailable");
		try { await scheduledRun(resolved, ctx); }
		finally { if (!(await journal.bridgeEnd(operation))?.ok) throw new Error("Scheduled bridge outcome could not be recorded"); }
	},
} satisfies ExportedHandler<Env>;
