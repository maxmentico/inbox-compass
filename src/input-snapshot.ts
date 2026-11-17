// Isolated content-addressed snapshot primitives. No storage implementation or production wiring.
// The id commits to the ordered fragment hashes and lengths, not to a caller-supplied version label.

export const INPUT_SNAPSHOT_LIMITS = {
	fragmentBytes: 64 * 1024,
	fragments: 160,
	totalBytes: 10 * 1024 * 1024,
	pageBytes: 256 * 1024,
	pageFragments: 16,
} as const;

export interface InputSnapshotManifest {
	version: 1;
	id: string;
	totalBytes: number;
	fragments: { sha256: string; bytes: number }[];
}

export interface InputSnapshotSource {
	/** Return the fragment for this content id and index, or null if absent. */
	read(id: string, index: number): Promise<Uint8Array | null>;
}

/** Coordinator-owned storage: keys combine job-generation scope and content id; transitions are atomic and cannot reset. */
export interface SnapshotCheckpointStore {
	create(id: string): Promise<boolean>;
	read(id: string): Promise<{ next: number; complete: boolean } | null>;
	compareAndAdvance(id: string, expectedNext: number, next: number, complete: boolean): Promise<boolean>;
}

const HASH = /^[a-f0-9]{64}$/;
const SCOPE = /^[A-Za-z0-9_-]{22,128}$/;
function checkpointKey(scope: string, id: string): string {
	if (!SCOPE.test(scope)) throw new Error("Invalid snapshot checkpoint scope");
	return `${scope}:${id}`;
}
const encoder = new TextEncoder();
async function sha256(bytes: Uint8Array): Promise<string> {
	const hash = await crypto.subtle.digest("SHA-256", new Uint8Array(bytes).buffer);
	return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// A fixed-position array gives the descriptor a canonical representation independent of object key order.
function descriptor(totalBytes: number, fragments: InputSnapshotManifest["fragments"]): Uint8Array {
	return encoder.encode(JSON.stringify([1, totalBytes, fragments.map((f) => [f.sha256, f.bytes])]));
}

function pinManifest(manifest: InputSnapshotManifest): InputSnapshotManifest {
	if (!manifest || !Array.isArray(manifest.fragments) || manifest.fragments.length > INPUT_SNAPSHOT_LIMITS.fragments) throw new Error("Invalid snapshot descriptor");
	return { ...manifest, fragments: manifest.fragments.map((f) => ({ ...f })) };
}

/** Pins bounded bytes and creates their content id; storage must recheck hashes when staging. */
export async function prepareInputSnapshot(fragments: readonly Uint8Array[]): Promise<{ manifest: InputSnapshotManifest; fragments: Uint8Array[] }> {
	// Snapshot both membership and bytes synchronously before the first digest yields. Otherwise the
	// caller can append or mutate fragments while hashing and change the version being constructed.
	const original = [...fragments];
	if (original.length > INPUT_SNAPSHOT_LIMITS.fragments) throw new Error("Snapshot exceeds fragment limit");
	let totalBytes = 0;
	for (const fragment of original) {
		if (!(fragment instanceof Uint8Array) || fragment.byteLength === 0 || fragment.byteLength > INPUT_SNAPSHOT_LIMITS.fragmentBytes) throw new Error("Invalid snapshot fragment size");
		totalBytes += fragment.byteLength;
		if (totalBytes > INPUT_SNAPSHOT_LIMITS.totalBytes) throw new Error("Snapshot exceeds byte limit");
	}
	const pinned = original.map((fragment) => new Uint8Array(fragment));
	const entries: InputSnapshotManifest["fragments"] = [];
	for (const fragment of pinned) {
		entries.push({ sha256: await sha256(fragment), bytes: fragment.byteLength });
	}
	return { manifest: { version: 1, id: await sha256(descriptor(totalBytes, entries)), totalBytes, fragments: entries }, fragments: pinned };
}

/** Computes a descriptor only. Persisting caller-owned buffers requires revalidating their hashes. */
export async function createInputSnapshot(fragments: readonly Uint8Array[]): Promise<InputSnapshotManifest> {
	return (await prepareInputSnapshot(fragments)).manifest;
}

/** Checks the pinned version and the entire descriptor before any data is returned. */
export async function validateInputSnapshot(manifest: InputSnapshotManifest, expectedId: string): Promise<void> {
	if (!manifest || manifest.version !== 1 || !HASH.test(expectedId) || manifest.id !== expectedId || !Array.isArray(manifest.fragments) || manifest.fragments.length > INPUT_SNAPSHOT_LIMITS.fragments) throw new Error("Invalid snapshot version or descriptor");
	let total = 0;
	for (const f of manifest.fragments) {
		if (!f || typeof f.sha256 !== "string" || !HASH.test(f.sha256) || !Number.isSafeInteger(f.bytes) || f.bytes <= 0 || f.bytes > INPUT_SNAPSHOT_LIMITS.fragmentBytes) throw new Error("Invalid snapshot fragment descriptor");
		total += f.bytes;
		if (total > INPUT_SNAPSHOT_LIMITS.totalBytes) throw new Error("Snapshot exceeds byte limit");
	}
	if (!Number.isSafeInteger(manifest.totalBytes) || total !== manifest.totalBytes || await sha256(descriptor(total, manifest.fragments)) !== expectedId) throw new Error("Snapshot descriptor integrity failure");
}

/**
 * Verifies and returns one bounded page. A page proves only those fragments; the caller must complete
 * verification of all pages before publishing or treating the snapshot as complete.
 */
export async function readInputSnapshotPage(
	source: InputSnapshotSource,
	manifest: InputSnapshotManifest,
	expectedId: string,
	start: number,
	options: { maxBytes: number; maxFragments: number },
): Promise<{ fragments: Uint8Array[]; next: number | null }> {
	const pinned = pinManifest(manifest);
	await validateInputSnapshot(pinned, expectedId);
	if (!Number.isSafeInteger(start) || start < 0 || start > pinned.fragments.length || !Number.isSafeInteger(options.maxBytes) || options.maxBytes <= 0 || options.maxBytes > INPUT_SNAPSHOT_LIMITS.pageBytes || !Number.isSafeInteger(options.maxFragments) || options.maxFragments <= 0 || options.maxFragments > INPUT_SNAPSHOT_LIMITS.pageFragments) throw new Error("Invalid snapshot page bounds");
	const out: Uint8Array[] = [];
	let bytes = 0;
	let index = start;
	while (index < pinned.fragments.length && out.length < options.maxFragments) {
		const entry = pinned.fragments[index]!;
		if (bytes + entry.bytes > options.maxBytes) {
			if (!out.length) throw new Error("Snapshot fragment exceeds page budget");
			break;
		}
		const fragment = await source.read(expectedId, index);
		if (!(fragment instanceof Uint8Array) || fragment.byteLength !== entry.bytes) throw new Error("Missing or corrupt snapshot fragment");
		// Hash the same private copy that we return, even if the source reuses its buffer.
		const copy = new Uint8Array(fragment);
		if (await sha256(copy) !== entry.sha256) throw new Error("Missing or corrupt snapshot fragment");
		out.push(copy);
		bytes += entry.bytes;
		index++;
	}
	return { fragments: out, next: index < pinned.fragments.length ? index : null };
}

/** Verifies completeness with bounded reads. This does not promise that an external source is immutable. */
export async function verifyInputSnapshot(source: InputSnapshotSource, manifest: InputSnapshotManifest, expectedId: string): Promise<void> {
	const pinned = pinManifest(manifest);
	let next: number | null = 0;
	do {
		const page: { next: number | null } = await readInputSnapshotPage(source, pinned, expectedId, next, { maxBytes: INPUT_SNAPSHOT_LIMITS.pageBytes, maxFragments: INPUT_SNAPSHOT_LIMITS.pageFragments });
		next = page.next;
	} while (next !== null);
}

/** Initializes a version-bound checkpoint once; a duplicate start never resets progress. */
export async function startSnapshotVerification(store: SnapshotCheckpointStore, manifest: InputSnapshotManifest, expectedId: string, scope: string): Promise<void> {
	await validateInputSnapshot(pinManifest(manifest), expectedId);
	if (!(await store.create(checkpointKey(scope, expectedId)))) throw new Error("Snapshot verification already started");
}

/**
 * Verifies one page and atomically advances its coordinator-owned checkpoint. The caller's expected
 * index prevents replay or out-of-order requests. Completeness assumes the source remains immutable;
 * its storage must enforce that separately. A CAS failure makes concurrent retries fail closed.
 */
export async function verifyNextSnapshotPage(
	store: SnapshotCheckpointStore,
	source: InputSnapshotSource,
	manifest: InputSnapshotManifest,
	expectedId: string,
	scope: string,
	expectedNext: number,
	options: { maxBytes: number; maxFragments: number },
): Promise<{ next: number; complete: boolean }> {
	const pinned = pinManifest(manifest);
	await validateInputSnapshot(pinned, expectedId);
	const key = checkpointKey(scope, expectedId);
	const checkpoint = await store.read(key);
	if (!checkpoint || checkpoint.complete || checkpoint.next !== expectedNext) throw new Error("Snapshot checkpoint missing, complete or out of order");
	const page = await readInputSnapshotPage(source, pinned, expectedId, expectedNext, options);
	const complete = page.next === null;
	const next = page.next ?? pinned.fragments.length;
	if (!(await store.compareAndAdvance(key, expectedNext, next, complete))) throw new Error("Snapshot checkpoint changed");
	return { next, complete };
}

/** Reconstructs only small snapshots; large ones must be consumed page by page after completeness checks. */
export async function reconstructSmallInputSnapshot(source: InputSnapshotSource, manifest: InputSnapshotManifest, expectedId: string): Promise<Uint8Array> {
	const pinned = pinManifest(manifest);
	await validateInputSnapshot(pinned, expectedId);
	if (pinned.totalBytes > INPUT_SNAPSHOT_LIMITS.pageBytes) throw new Error("Snapshot exceeds reconstruction budget");
	const result = new Uint8Array(pinned.totalBytes);
	let offset = 0;
	let next: number | null = 0;
	do {
		const page = await readInputSnapshotPage(source, pinned, expectedId, next, { maxBytes: INPUT_SNAPSHOT_LIMITS.pageBytes, maxFragments: INPUT_SNAPSHOT_LIMITS.pageFragments });
		for (const fragment of page.fragments) { result.set(fragment, offset); offset += fragment.byteLength; }
		next = page.next;
	} while (next !== null);
	return result;
}
