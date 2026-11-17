// EXPERIMENTAL: transaction contract only, not a production binding or a domain verifier.
// The trusted caller must first verify the immutable source page and inventory. A staged page is
// provisional; never expose it until a separate complete-generation/domain publication succeeds.

const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const HASH = /^[a-f0-9]{64}$/;
export const STAGE_PAGE_LIMITS = { bytes: 64 * 1024, pages: 160, records: 20_000, recordsPerPage: 16 } as const;

export interface StageCursor {
	scope: string;
	sourceId: string;
	generation: number;
	attempt: string;
	/** Coordinator-clock deadline; an expired attempt cannot stage or replay. */
	expiresAt: number;
	nextPage: number;
	nextSequence: number;
	totalRecords: number;
	complete: boolean;
}
export interface StagedPage { digest: string; bytes: Uint8Array }
export interface StageTransaction {
	readCursor(scope: string): StageCursor | null;
	readPage(scope: string, page: number): StagedPage | null;
	writePage(scope: string, page: number, value: StagedPage): void;
	writeCursor(scope: string, value: StageCursor): void;
}
/** Must provide a real all-or-nothing synchronous transaction with isolated writes and rollback. */
export interface AtomicStageStorage {
	transactionSync<T>(work: (tx: StageTransaction) => T): T;
}
export interface VerifiedOutputPage {
	scope: string;
	sourceId: string;
	generation: number;
	attempt: string;
	page: number;
	startSequence: number;
	endSequence: number;
	final: boolean;
	bytes: Uint8Array;
}

async function hash(bytes: Uint8Array): Promise<string> {
	const data = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
	return [...new Uint8Array(data)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

/**
 * Stage one already-verified page and advance its cursor in one transaction. The caller cannot use
 * this as source proof: producer authentication and domain validation are separate requirements.
 * Identical retries are idempotent; different retries and stale generations/attempts are rejected.
 */
export async function stageVerifiedOutputPage(storage: AtomicStageStorage, input: VerifiedOutputPage): Promise<"staged" | "already-staged"> {
	if (!storage || typeof storage.transactionSync !== "function" || !input || !TOKEN.test(input.scope) || !HASH.test(input.sourceId) || !TOKEN.test(input.attempt) || !Number.isSafeInteger(input.generation) || input.generation < 1 || !Number.isSafeInteger(input.page) || input.page < 0 || input.page >= STAGE_PAGE_LIMITS.pages || !Number.isSafeInteger(input.startSequence) || !Number.isSafeInteger(input.endSequence) || input.startSequence < 0 || input.endSequence < input.startSequence || input.endSequence > STAGE_PAGE_LIMITS.records || input.endSequence - input.startSequence > STAGE_PAGE_LIMITS.recordsPerPage || typeof input.final !== "boolean" || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength > STAGE_PAGE_LIMITS.bytes) throw new Error("Invalid staged output page");
	// Pin mutable input before awaiting the hash.
	const page = { ...input, bytes: new Uint8Array(input.bytes) };
	const payloadHash = await hash(page.bytes);
	const digest = await hash(new TextEncoder().encode(JSON.stringify([page.scope, page.sourceId, page.generation, page.attempt, page.page, page.startSequence, page.endSequence, page.final, payloadHash])));
	return storage.transactionSync((tx) => {
		const current = tx.readCursor(page.scope);
		if (!current || current.scope !== page.scope || current.sourceId !== page.sourceId || current.generation !== page.generation || current.attempt !== page.attempt || !Number.isSafeInteger(current.expiresAt) || current.expiresAt <= Date.now() || !Number.isSafeInteger(current.totalRecords) || current.totalRecords < 0 || current.totalRecords > STAGE_PAGE_LIMITS.records) throw new Error("Stale staged output generation");
		const existing = tx.readPage(page.scope, page.page);
		if (existing) {
			if (existing.digest !== digest) throw new Error("Conflicting staged output replay");
			return "already-staged";
		}
		if (current.complete || current.nextPage !== page.page || current.nextSequence !== page.startSequence || page.endSequence > current.totalRecords || page.final !== (page.endSequence === current.totalRecords) || (!page.final && page.endSequence === page.startSequence)) throw new Error("Out-of-order staged output page");
		tx.writePage(page.scope, page.page, { digest, bytes: page.bytes });
		tx.writeCursor(page.scope, { ...current, nextPage: page.page + 1, nextSequence: page.endSequence, complete: page.final });
		return "staged";
	});
}
