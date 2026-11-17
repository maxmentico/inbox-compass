// Fakes shared by the pipeline tests: a model that answers by subject, and Gmail for linked mailboxes.

import { vi } from "vitest";
import { batchResponse, type fullMessage, idsInBatch } from "./helpers";

export const chat = (content: string) => ({ choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }] });

/** A fake model: "invoice" emails require a payment, with high stakes; everything else is marketing. */
export function fakeAi() {
	return vi.fn(async (_model: string, inputs: any) => {
		const content: string = inputs.messages[1].content;
		const emails = JSON.parse(content.slice(content.indexOf("[")));
		return chat(
			JSON.stringify({
				items: emails.map((e: any) => ({
					ref: e.ref,
					sender_type: /invoice/i.test(e.subject) ? "automated" : "marketing",
					request: /invoice/i.test(e.subject) ? "required" : "none",
					stakes: /invoice/i.test(e.subject) ? "high" : "none",
					action: /invoice/i.test(e.subject) ? `Pay ${e.subject}` : "",
					category: /invoice/i.test(e.subject) ? "payment" : "newsletter",
					due: null,
					summary: `About ${e.subject}`,
					// A thank-you after the owner's reply asks nothing.
					...(/thank/i.test(e.subject) && e.thread.some((m: any) => m.by === "owner")
						? { sender_type: "person", request: "none", stakes: "none", category: "fyi", action: "", summary: "Thanks" }
						: {}),
				})),
			}),
		);
	});
}

export type ThreadMessage = {
	id?: string;
	internalDate: string;
	labelIds: string[];
	snippet?: string;
	payload?: { headers: { name: string; value: string }[] };
};
const threadIdsInBatch = (body: string) => [...body.matchAll(/threads\/([^?]+)\?/g)].map((m) => decodeURIComponent(m[1]!));

/** A message lookup's answer: its thread and labels, or an HTTP status for that message. */
export type Lookup = { threadId: string; labelIds: string[] } | number;

/**
 * Fake Gmail for two mailboxes; "broken" has a revoked refresh token. Thread lookups answer from
 * `threads`; any other thread holds just the incoming message (not replied). Send-as addresses
 * answer from `sendAs`, else just the primary address. Messages in `failFull` answer 500 when
 * fetched in full; thread-and-labels lookups (format=minimal) answer from `lookups`, else from the
 * inbox, else 404. No expect() in here: the code under test catches errors, so a failed assertion
 * would pass as a Gmail failure. Requests are recorded in `calls` for tests to check.
 */
export function fakeGmail(
	inbox: Record<string, ReturnType<typeof fullMessage>[]>,
	threads: Record<string, ThreadMessage[]> = {},
	sendAs: Record<string, string[]> = {},
	opts: { failFull?: Set<string>; lookups?: Record<string, Lookup> } = {},
) {
	const calls = {
		list: 0,
		queries: [] as string[],
		batch: [] as string[][],
		threads: [] as string[][],
		minimal: [] as string[][],
		/** Each batch request's body, to check the format asked for. */
		bodies: [] as string[],
		sendAs: 0,
	};
	const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		if (url === "https://oauth2.googleapis.com/token") {
			const rt = new URLSearchParams(String(init?.body)).get("refresh_token")!;
			if (rt === "rt-broken") return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
			return Response.json({ access_token: `at:${rt.slice(3)}`, expires_in: 3599 });
		}
		const alias = String((init?.headers as Record<string, string>).Authorization).split(":")[1]!;
		if (url.startsWith("https://gmail.googleapis.com/gmail/v1/users/me/messages?")) {
			calls.list++;
			const params = new URL(url).searchParams;
			calls.queries.push(params.get("q")!);
			// Like Gmail: newest first, honouring after:<seconds>, paged by maxResults.
			const after = /after:(\d+)/.exec(params.get("q")!)?.[1];
			const all = (inbox[alias] ?? [])
				.filter((m) => !after || Number(m.internalDate) / 1000 > Number(after))
				.sort((a, b) => Number(b.internalDate) - Number(a.internalDate));
			const start = Number(params.get("pageToken") ?? 0);
			const end = start + Number(params.get("maxResults"));
			return Response.json({
				messages: all.slice(start, end).map((m) => ({ id: m.id })),
				...(end < all.length ? { nextPageToken: String(end) } : {}),
			});
		}
		if (url === "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs") {
			calls.sendAs++;
			return Response.json({ sendAs: (sendAs[alias] ?? [`${alias}@example.com`]).map((sendAsEmail) => ({ sendAsEmail })) });
		}
		if (url === "https://gmail.googleapis.com/batch/gmail/v1" && String(init?.body).includes("/threads/")) {
			const ids = threadIdsInBatch(String(init?.body));
			calls.threads.push(ids);
			calls.bodies.push(String(init?.body));
			return batchResponse(
				ids.map((id, i) => ({
					id: String(i),
					status: 200,
					// Any other thread: just the incoming message, still in the inbox.
					body: { id, messages: threads[id] ?? [{ id: id.replace(/^t-/, ""), internalDate: "1", labelIds: ["INBOX", "UNREAD"] }] },
				})),
			);
		}
		if (url === "https://gmail.googleapis.com/batch/gmail/v1") {
			const body = String(init?.body);
			const ids = idsInBatch(body);
			calls.bodies.push(body);
			const find = (id: string) => (inbox[alias] ?? []).find((x) => x.id === id);
			if (body.includes("format=minimal")) {
				calls.minimal.push(ids);
				return batchResponse(
					ids.map((id, i) => {
						const m = find(id);
						const answer = opts.lookups?.[id] ?? (m ? { threadId: m.threadId, labelIds: m.labelIds } : 404);
						return typeof answer === "number" ? { id: String(i), status: answer, body: {} } : { id: String(i), status: 200, body: { id, ...answer } };
					}),
				);
			}
			calls.batch.push(ids);
			return batchResponse(
				ids.map((id, i) => {
					const m = find(id);
					if (m && opts.failFull?.has(id)) return { id: String(i), status: 500, body: {} };
					return m ? { id: String(i), status: 200, body: m } : { id: String(i), status: 404, body: {} };
				}),
			);
		}
		throw new Error(`unexpected ${url}`);
	};
	return { impl, calls };
}

