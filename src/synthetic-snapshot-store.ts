// Experimental, synthetic-only storage for the unbound input snapshot prototype. A snapshot
// remains immutable and readable only while its owning run lease is active. It is not a production
// retention policy and is not connected to publication or the live Worker.
import { INPUT_SNAPSHOT_LIMITS as LIMIT, type InputSnapshotManifest, type InputSnapshotSource, type SnapshotCheckpointStore, validateInputSnapshot } from './input-snapshot';

const ID = /^[a-f0-9]{64}$/;
const OWNER = /^[A-Za-z0-9_-]{22,128}$/;
type SnapshotRow = { owner: string; manifest: string; sealed: number };

export class SyntheticSnapshotStore {
  private readonly sql: SqlStorage;
  constructor(private readonly storage: DurableObjectStorage, private readonly ensureAlarm: (at: number) => Promise<void>) {
    this.sql = storage.sql;
    this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_snapshots (id TEXT PRIMARY KEY, owner TEXT NOT NULL, manifest TEXT NOT NULL, sealed INTEGER NOT NULL DEFAULT 0)');
    this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_fragments (id TEXT NOT NULL, idx INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (id, idx))');
    this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_checkpoints (id TEXT PRIMARY KEY, next INTEGER NOT NULL, complete INTEGER NOT NULL)');
  }
  private active(owner: string): boolean {
    const row = this.sql.exec<{ owner: string; expires_at: number }>('SELECT owner, expires_at FROM lease WHERE id = 1').toArray()[0];
    return !!row && row.owner === owner && row.expires_at > Date.now();
  }
  private snapshot(id: string, owner: string): SnapshotRow | undefined {
    const row = this.sql.exec<SnapshotRow>('SELECT owner, manifest, sealed FROM synthetic_snapshots WHERE id = ?', id).toArray()[0];
    return row?.owner === owner ? row : undefined;
  }
  async create(owner: string, manifest: InputSnapshotManifest): Promise<boolean> {
    if (!OWNER.test(owner)) return false;
    // Pin the descriptor before the first await; a caller cannot mutate the verified value.
    let pinned: string;
    let copy: InputSnapshotManifest;
    try {
      if (!manifest || !Array.isArray(manifest.fragments) || manifest.fragments.length > LIMIT.fragments) return false;
      copy = { version: manifest.version, id: manifest.id, totalBytes: manifest.totalBytes, fragments: manifest.fragments.map((f) => ({ sha256: f.sha256, bytes: f.bytes })) };
      pinned = JSON.stringify(copy);
      await validateInputSnapshot(copy, copy.id);
    } catch { return false; }
    await this.ensureAlarm(Date.now() + 6 * 60_000);
    return this.storage.transactionSync(() => {
      if (!this.active(owner)) return false;
      const prior = this.snapshot(copy.id, owner);
      if (prior) return prior.manifest === pinned;
      if (this.sql.exec('SELECT id FROM synthetic_snapshots LIMIT 1').toArray().length) return false;
      this.sql.exec('INSERT INTO synthetic_snapshots (id, owner, manifest) VALUES (?, ?, ?)', copy.id, owner, pinned);
      return true;
    });
  }
  async put(owner: string, id: string, index: number, value: Uint8Array): Promise<boolean> {
    if (!OWNER.test(owner) || !ID.test(id) || !Number.isSafeInteger(index) || index < 0 || !(value instanceof Uint8Array) || !value.byteLength || value.byteLength > LIMIT.fragmentBytes) return false;
    const copy = new Uint8Array(value);
    const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', copy.buffer))].map((b) => b.toString(16).padStart(2, '0')).join('');
    const data = btoa(String.fromCharCode(...copy));
    await this.ensureAlarm(Date.now() + 6 * 60_000);
    return this.storage.transactionSync(() => {
      if (!this.active(owner)) return false;
      const row = this.snapshot(id, owner);
      if (!row || row.sealed) return false;
      const manifest = JSON.parse(row.manifest) as InputSnapshotManifest;
      const entry = manifest.fragments[index];
      if (!entry || entry.bytes !== copy.byteLength || entry.sha256 !== digest) return false;
      const prior = this.sql.exec<{ data: string }>('SELECT data FROM synthetic_fragments WHERE id = ? AND idx = ?', id, index).toArray()[0];
      if (prior) return prior.data === data;
      this.sql.exec('INSERT INTO synthetic_fragments (id, idx, data) VALUES (?, ?, ?)', id, index, data);
      return true;
    });
  }
  seal(owner: string, id: string): boolean {
    return this.storage.transactionSync(() => {
      if (!this.active(owner)) return false;
      const row = this.snapshot(id, owner);
      if (!row) return false;
      if (row.sealed) return true;
      const count = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM synthetic_fragments WHERE id = ?', id).toArray()[0]?.n ?? 0;
      if (count !== (JSON.parse(row.manifest) as InputSnapshotManifest).fragments.length) return false;
      this.sql.exec('UPDATE synthetic_snapshots SET sealed = 1 WHERE id = ?', id);
      return true;
    });
  }
  source(owner: string): InputSnapshotSource {
    return { read: async (id, index) => this.storage.transactionSync(() => {
      if (!this.active(owner) || !this.snapshot(id, owner)?.sealed) return null;
      const row = this.sql.exec<{ data: string }>('SELECT data FROM synthetic_fragments WHERE id = ? AND idx = ?', id, index).toArray()[0];
      return row ? Uint8Array.from(atob(row.data), (c) => c.charCodeAt(0)) : null;
    }) };
  }
  checkpoints(owner: string): SnapshotCheckpointStore {
    // The lease owner is the per-generation scope; a checkpoint key from any other scope
    // must not access or reset this owner's progress, even if the content ID is identical.
    const scopedId = (key: string): string | null => {
      const prefix = `${owner}:`;
      const id = key.startsWith(prefix) ? key.slice(prefix.length) : '';
      return OWNER.test(owner) && ID.test(id) ? id : null;
    };
    return {
      create: async (id) => this.storage.transactionSync(() => {
        id = scopedId(id) ?? '';
        if (!id) return false;
        if (!this.active(owner) || !this.snapshot(id, owner)?.sealed) return false;
        if (this.sql.exec('SELECT id FROM synthetic_checkpoints WHERE id = ?', id).toArray().length) return false;
        this.sql.exec('INSERT INTO synthetic_checkpoints (id, next, complete) VALUES (?, 0, 0)', id);
        return true;
      }),
      read: async (id) => this.storage.transactionSync(() => {
        id = scopedId(id) ?? '';
        if (!id) return null;
        if (!this.active(owner) || !this.snapshot(id, owner)?.sealed) return null;
        const row = this.sql.exec<{ next: number; complete: number }>('SELECT next, complete FROM synthetic_checkpoints WHERE id = ?', id).toArray()[0];
        return row ? { next: row.next, complete: row.complete === 1 } : null;
      }),
      compareAndAdvance: async (id, expected, next, complete) => this.storage.transactionSync(() => {
        id = scopedId(id) ?? '';
        if (!id) return false;
        if (!this.active(owner)) return false;
        const row = this.snapshot(id, owner);
        if (!row?.sealed) return false;
        const manifest = JSON.parse(row.manifest) as InputSnapshotManifest;
        if (!Number.isSafeInteger(expected) || !Number.isSafeInteger(next) || expected < 0 || next < expected || next > manifest.fragments.length || next - expected > LIMIT.pageFragments || complete !== (next === manifest.fragments.length) || (next === expected && !complete)) return false;
        if (manifest.fragments.slice(expected, next).reduce((n, f) => n + f.bytes, 0) > LIMIT.pageBytes) return false;
        const result = this.sql.exec('UPDATE synthetic_checkpoints SET next = ?, complete = ? WHERE id = ? AND next = ? AND complete = 0', next, complete ? 1 : 0, id, expected);
        return result.rowsWritten === 1;
      }),
    };
  }
}
