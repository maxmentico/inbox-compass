import { AtomicGenerationClient } from "./atomic-generation-authority";
import { randomToken } from "./crypto";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();
const PIN_TO = Symbol("atomic-pin-to");

function encoded(bytes: Uint8Array): string {
	let raw = "";
	for (let index = 0; index < bytes.length; index += 0x8000) raw += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
	return btoa(raw);
}

/** Keys whose latest visible value must come from one committed generation. */
export function isAtomicStateKey(key: string): boolean {
	if (key.startsWith("digest:") && key.endsWith("-test")) return false;
	return key === "last-run" || key === "runs-index" || key === "settings" ||
		key === "atomic-mode" || ["digest:", "cursor:", "failures:", "cls:", "history:", "recheck:", "checked:", "done:", "job-result:", "job-done:", "account-state:"].some((prefix) => key.startsWith(prefix));
}

function decoded<T>(value: string, type?: string): T {
	if (type === "json") return JSON.parse(value) as T;
	if (type === "arrayBuffer") return textEncoder.encode(value).buffer as T;
	if (type === "stream") return new Blob([value]).stream() as T;
	return value as T;
}

/** Request-scoped KV facade. Its first authoritative read pins a generation for the request. */
class AtomicKVFacade {
	private readonly atomic: AtomicGenerationClient;
	private pinned: Promise<number | null> | null = null;
	constructor(private readonly legacy: KVNamespace, authority: DurableObjectNamespace) { this.atomic = new AtomicGenerationClient(authority); }
	async [PIN_TO](seq: number): Promise<void> {
		if (!this.pinned) this.pinned = (async () => (await this.atomic.pin(randomToken(16), seq))?.head.seq ?? null)();
		const current = await this.pinned;
		if (current !== seq) throw new Error("Atomic state is pinned to a different generation");
	}
	private seq(): Promise<number | null> {
		if (!this.pinned) this.pinned = (async () => {
			const head = (await this.atomic.head())?.head;
			if (!head) return null;
			const pin = await this.atomic.pin(randomToken(16), head.seq);
			return pin?.head.seq ?? null;
		})();
		return this.pinned;
	}
	private async one<T>(key: string, type?: string): Promise<T | null> {
		if (!isAtomicStateKey(key)) return this.legacy.get<T>(key, type as never);
		const seq = await this.seq();
		if (seq === null) return this.legacy.get<T>(key, type as never);
		const found = await this.atomic.read(seq, key);
		// Pre-cutover digests are immutable after the bridge drains and remain valid legacy objects.
		if (found.value === null && key.startsWith("digest:")) return this.legacy.get<T>(key, type as never);
		return found.value === null ? null : decoded<T>(found.value, type);
	}
	async get<T = string>(keyOrKeys: string | string[], typeOrOptions?: string | { type?: string }): Promise<T | null | Map<string, T | null>> {
		const type = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
		if (Array.isArray(keyOrKeys)) {
			const values = new Map<string, T | null>();
			const atomicKeys = [...new Set(keyOrKeys.filter(isAtomicStateKey))];
			const legacyKeys = [...new Set(keyOrKeys.filter((key) => !isAtomicStateKey(key)))];
			if (legacyKeys.length) {
				const legacy = await this.legacy.get<T>(legacyKeys, type as never);
				for (const key of legacyKeys) values.set(key, legacy.get(key) ?? null);
			}
			if (atomicKeys.length) {
				const seq = await this.seq();
				if (seq === null) {
					const legacy = await this.legacy.get<T>(atomicKeys, type as never);
					for (const key of atomicKeys) values.set(key, legacy.get(key) ?? null);
				} else {
					const found = await this.atomic.readMany(seq, atomicKeys);
					if (!found) throw new Error("Atomic state batch read failed");
					const legacyDigests = atomicKeys.filter((key) => key.startsWith("digest:") && found.get(key)?.value === null);
					const fallback = legacyDigests.length ? await this.legacy.get<T>(legacyDigests, type as never) : new Map<string, T | null>();
					for (const key of atomicKeys) {
						const item = found.get(key);
						values.set(key, item?.value === null ? (fallback.get(key) ?? null) : decoded<T>(item!.value!, type));
					}
				}
			}
			return new Map(keyOrKeys.map((key) => [key, values.get(key) ?? null]));
		}
		return this.one<T>(keyOrKeys, type);
	}
	async getWithMetadata<T = string, M = unknown>(key: string, typeOrOptions?: string | { type?: string }): Promise<{ value: T | null; metadata: M | null; cacheStatus: string | null }> {
		if (!isAtomicStateKey(key)) return this.legacy.getWithMetadata<T, M>(key, typeOrOptions as never);
		const seq = await this.seq();
		if (seq === null) return this.legacy.getWithMetadata<T, M>(key, typeOrOptions as never);
		const type = typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions?.type;
		const found = await this.atomic.read(seq, key);
		return { value: found.value === null ? null : decoded<T>(found.value, type), metadata: (found.metadata ?? null) as M | null, cacheStatus: null };
	}
	async put(key: string, value: string | ArrayBuffer | ArrayBufferView | ReadableStream, options: { expiration?: number; expirationTtl?: number; metadata?: unknown } = {}): Promise<void> {
		if (!isAtomicStateKey(key)) return this.legacy.put(key, value, options);
		let bytes: Uint8Array;
		if (typeof value === "string") bytes = textEncoder.encode(value);
		else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
		else if (ArrayBuffer.isView(value)) bytes = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
		else bytes = new Uint8Array(await new Response(value).arrayBuffer());
		const expiresAt = options.expiration !== undefined ? options.expiration * 1000 : options.expirationTtl !== undefined ? Date.now() + options.expirationTtl * 1000 : undefined;
		const operation = randomToken(16), generation = randomToken(16);
		const result = await this.atomic.mutate({ operation, generation, key, kind: "put", data: encoded(bytes), ...(expiresAt === undefined ? {} : { expiresAt }), ...(options.metadata && typeof options.metadata === "object" && Number.isSafeInteger((options.metadata as { arrived?: number }).arrived) ? { metadata: { arrived: (options.metadata as { arrived: number }).arrived } } : {}) });
		if (!result?.ok) throw new Error("Atomic state mutation failed");
	}
	async delete(key: string): Promise<void> {
		if (!isAtomicStateKey(key)) return this.legacy.delete(key);
		const result = await this.atomic.mutate({ operation: randomToken(16), generation: randomToken(16), key, kind: "delete" });
		if (!result?.ok) throw new Error("Atomic state deletion failed");
	}
	async list<M = unknown>(options: { prefix?: string; limit?: number; cursor?: string } = {}): Promise<KVNamespaceListResult<M, string>> {
		const prefix = options.prefix ?? "";
		if (!prefix || !isAtomicStateKey(prefix)) return this.legacy.list<M>(options);
		const seq = await this.seq();
		if (seq === null) return this.legacy.list<M>(options);
		if (prefix === "digest:") {
			type Cursor = { legacy?: string; atomic?: string; legacyDone?: boolean; atomicDone?: boolean };
			let cursor: Cursor = {};
			if (options.cursor) {
				try { const raw = options.cursor.replace(/-/g, "+").replace(/_/g, "/"); cursor = JSON.parse(textDecoder.decode(Uint8Array.from(atob(raw + "=".repeat((4 - raw.length % 4) % 4)), (char) => char.charCodeAt(0)))) as Cursor; }
				catch { throw new Error("Invalid atomic list cursor"); }
			}
			const pageSize = Math.min(500, Math.max(1, options.limit ?? 1_000));
			const [legacy, atomic] = await Promise.all([
				cursor.legacyDone ? null : this.legacy.list<M>({ prefix, limit: pageSize, ...(cursor.legacy ? { cursor: cursor.legacy } : {}) }),
				cursor.atomicDone ? null : this.atomic.list(seq, prefix, cursor.atomic ?? null, pageSize),
			]);
			if (!cursor.atomicDone && !atomic) throw new Error("Atomic digest listing failed");
			const merged = new Map<string, KVNamespaceListKey<M, string>>();
			for (const key of legacy?.keys ?? []) merged.set(key.name, key);
			for (const key of atomic?.keys ?? []) merged.set(key.name, key as KVNamespaceListKey<M, string>);
			const next: Cursor = {
				...(legacy && !legacy.list_complete ? { legacy: legacy.cursor } : { legacyDone: true }),
				...(atomic && !atomic.complete ? { atomic: atomic.cursor } : { atomicDone: true }),
			};
			const complete = next.legacyDone === true && next.atomicDone === true;
			const nextCursor = complete ? undefined : btoa(String.fromCharCode(...textEncoder.encode(JSON.stringify(next)))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
			return { keys: [...merged.values()].sort((a, b) => a.name.localeCompare(b.name)), list_complete: complete, cacheStatus: null, ...(nextCursor ? { cursor: nextCursor } : {}) } as KVNamespaceListResult<M, string>;
		}
		const result = await this.atomic.list(seq, prefix, options.cursor ?? null, options.limit ?? 1_000);
		if (!result) throw new Error("Atomic state listing failed");
		return { keys: result.keys as KVNamespaceListKey<M, string>[], list_complete: result.complete, cacheStatus: null, ...(result.cursor ? { cursor: result.cursor } : {}) } as KVNamespaceListResult<M, string>;
	}
}

export function withAtomicState(env: Env): Env {
	if (!["active", "migrate"].includes(env.ATOMIC_STATE_MODE ?? "") || !env.JOB_AUTHORITY) return env;
	return { ...env, MAILBOX_KV: new AtomicKVFacade(env.MAILBOX_KV, env.JOB_AUTHORITY) as unknown as KVNamespace };
}

export async function pinAtomicState(kv: KVNamespace, seq: number): Promise<void> {
	const facade = kv as KVNamespace & { [PIN_TO]?: (value: number) => Promise<void> };
	if (!facade[PIN_TO]) throw new Error("Atomic state facade is unavailable");
	await facade[PIN_TO](seq);
}
