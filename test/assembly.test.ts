import { afterEach, expect, it, vi } from "vitest";
import { _clearAccessTokenCache } from "../src/accounts";
import { assemble, collect, getDigest, prepareAssembly, runContext } from "../src/digest";
import { fakeAi, fakeGmail } from "./fakes";
import { fullMessage, linkAccount, makeEnv, MESSAGE_TIME } from "./helpers";

afterEach(() => {
	_clearAccessTokenCache();
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

it("prepares a digest without writing state, then assembly persists the same digest", async () => {
	const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
	await linkAccount(env, "mail");
	vi.stubGlobal("fetch", vi.fn(fakeGmail({ mail: [fullMessage("m1", { subject: "Invoice", ms: MESSAGE_TIME })] }).impl));
	vi.spyOn(console, "log").mockImplementation(() => {});
	const context = await runContext(env, {}, new Date("2026-10-24T06:30:00Z"), false);
	const partials = await collect(env, context, context.accounts);
	const put = vi.spyOn(env.MAILBOX_KV, "put");
	const del = vi.spyOn(env.MAILBOX_KV, "delete");
	const prepared = await prepareAssembly(env, context, partials);
	expect(put).not.toHaveBeenCalled();
	expect(del).not.toHaveBeenCalled();
	expect(prepared.digest.items.map((item) => item.messageId)).toEqual(["m1"]);
	const digest = await assemble(env, context, partials);
	expect(digest).toEqual(prepared.digest);
	expect(await getDigest(env.MAILBOX_KV, digest.id)).toEqual(prepared.digest);
});

it("uses a supplied complete done snapshot without reading KV or mutating partials", async () => {
	const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
	await linkAccount(env, "mail");
	vi.stubGlobal("fetch", vi.fn(fakeGmail({ mail: [fullMessage("m1", { subject: "Invoice", ms: MESSAGE_TIME })] }).impl));
	const context = await runContext(env, {}, new Date("2026-10-24T06:30:00Z"), false);
	const partials = await collect(env, context, context.accounts);
	const original = structuredClone(partials);
	const get = vi.spyOn(env.MAILBOX_KV, "get");
	const prepared = await prepareAssembly(env, context, partials, { doneKeys: new Set(["mail:m1"]) });
	expect(get).not.toHaveBeenCalled();
	expect(prepared.digest.items[0]).toMatchObject({ messageId: "m1", done: true, needsAction: false });
	expect(partials).toEqual(original);
});

it("uses the snapshot for previously ticked items that may need carrying", async () => {
	const env = makeEnv({ AI: { run: fakeAi() } as unknown as Ai });
	await linkAccount(env, "mail");
	vi.stubGlobal("fetch", vi.fn(fakeGmail({ mail: [fullMessage("m1", { subject: "Invoice", ms: MESSAGE_TIME })] }).impl));
	const context = await runContext(env, {}, new Date("2026-10-24T06:30:00Z"), false);
	const partials = await collect(env, context, context.accounts);
	const item = partials[0]!.items[0]!;
	const ctx = { ...context, openIfUnticked: [item], ticked: new Set([item.key]) };
	const emptyPartials = partials.map((p) => ({ ...p, items: [] }));
	const stillDone = await prepareAssembly(env, ctx, emptyPartials, { doneKeys: new Set([item.key]) });
	const unticked = await prepareAssembly(env, ctx, emptyPartials, { doneKeys: new Set() });
	expect(stillDone.digest.items).toHaveLength(0);
	expect(unticked.digest.items).toHaveLength(1);
	expect(unticked.digest.items[0]).toMatchObject({ key: item.key, carried: true, done: false });
});
