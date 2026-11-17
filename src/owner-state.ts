// Isolated coordinator component. Not bound to production or an authentication boundary.
// The injected verifier must prove each item belongs to the current digest in the same transaction.
import { MAX_DEADLINE_DAYS, MAX_SENDER_RULES, normaliseRule, type Settings } from "./rules";

const DONE_TTL_MS = 61 * 24 * 60 * 60 * 1000;
const MAX_DONE_KEYS = 100;
const MAX_CLEANUP = 100;
const SETTINGS_CHUNK_BYTES = 64 * 1024;
const KEY = /^[a-z0-9][a-z0-9-]{0,31}:[A-Za-z0-9_-]{1,256}$/;
type DoneAuthorization = { head: string; accounts: Readonly<Record<string, number>> };
/** Return the mailbox epoch captured for this digest item, or null if absent. */
export type DoneMembership = (sql: SqlStorage, head: string, key: string) => number | null;

/** Settings and done marks share the same SQLite database as the generation revision vector. */
export class OwnerState {
	private readonly sql: SqlStorage;
	constructor(private readonly storage: DurableObjectStorage, private readonly containsDoneItem?: DoneMembership) {
		this.sql = storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS owner_settings (singleton INTEGER PRIMARY KEY CHECK (singleton=1), value TEXT NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS owner_settings_hash (singleton INTEGER PRIMARY KEY CHECK (singleton=1), hash TEXT NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS owner_settings_chunks (idx INTEGER PRIMARY KEY, bytes INTEGER NOT NULL, hash TEXT NOT NULL, data BLOB NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS owner_done (item TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)");
		this.sql.exec("CREATE INDEX IF NOT EXISTS owner_done_expiry ON owner_done(expires_at)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS owner_done_scoped (namespace TEXT NOT NULL,message_id TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(namespace,message_id))");
		this.sql.exec("CREATE INDEX IF NOT EXISTS owner_done_scoped_expiry ON owner_done_scoped(expires_at)");
		// gen_versions is also used by the domain commit fence. Initialize only if absent.
		this.sql.exec("CREATE TABLE IF NOT EXISTS gen_versions (key TEXT PRIMARY KEY, version INTEGER NOT NULL)");
		this.sql.exec("INSERT OR IGNORE INTO gen_versions (key,version) VALUES ('settings',0),('done',0)");
	}

	private revision(kind: "settings" | "done"): number {
		const row = this.sql.exec<{ version: number }>("SELECT version FROM gen_versions WHERE key=?", kind).toArray()[0];
		if (!row || !Number.isSafeInteger(row.version) || row.version < 0) throw new Error("Owner revision unavailable");
		return row.version;
	}

	private bump(kind: "settings" | "done"): number {
		const next = this.revision(kind) + 1;
		if (!Number.isSafeInteger(next)) throw new Error("Owner revision exhausted");
		this.sql.exec("UPDATE gen_versions SET version=? WHERE key=?", next, kind);
		return next;
	}

	/** Reject malformed settings rather than silently publishing a different value. */
	async setSettings(settings: Settings, expectedRevision: number): Promise<{ revision: number; changed: boolean }> {
		if (!settings || !Number.isInteger(settings.deadlineDays) || settings.deadlineDays < 0 || settings.deadlineDays > MAX_DEADLINE_DAYS) throw new Error("Invalid settings");
		if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("Invalid settings revision");
		const lists = [settings.important, settings.muted];
		if (lists.some((list) => !Array.isArray(list) || list.length > MAX_SENDER_RULES || list.some((rule) => typeof rule !== "string" || normaliseRule(rule) !== rule) || new Set(list).size !== list.length)) throw new Error("Invalid settings");
		if (settings.muted.some((rule) => settings.important.includes(rule))) throw new Error("Invalid settings");
		const value = JSON.stringify({ deadlineDays: settings.deadlineDays, important: settings.important, muted: settings.muted });
		const encoded = new TextEncoder().encode(value);
		const digest = await crypto.subtle.digest("SHA-256", encoded);
		const hash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
		const chunks: { data: Uint8Array; hash: string }[] = [];
		for (let offset = 0; offset < encoded.length; offset += SETTINGS_CHUNK_BYTES) {
			const data = encoded.slice(offset, offset + SETTINGS_CHUNK_BYTES);
			const part = await crypto.subtle.digest("SHA-256", data);
			chunks.push({ data, hash: [...new Uint8Array(part)].map((byte) => byte.toString(16).padStart(2, "0")).join("") });
		}
		return this.storage.transactionSync(() => {
			const revision = this.revision("settings");
			const prior = this.sql.exec<{ value: string }>("SELECT value FROM owner_settings WHERE singleton=1").toArray()[0];
			const priorHash = this.sql.exec<{ hash: string }>("SELECT hash FROM owner_settings_hash WHERE singleton=1").toArray()[0];
			const priorChunks = this.sql.exec<{ idx: number; bytes: number; hash: string }>("SELECT idx,bytes,hash FROM owner_settings_chunks ORDER BY idx").toArray();
			const same = prior?.value === value && priorHash?.hash === hash && priorChunks.length === chunks.length && priorChunks.every((part, i) => part.idx === i && part.bytes === chunks[i]!.data.length && part.hash === chunks[i]!.hash);
			if (revision !== expectedRevision) {
				// An exact replay after a lost response may observe the immediately next revision.
				if (same && revision === expectedRevision + 1) return { revision, changed: false };
				throw new Error("Settings changed; retry with the current revision");
			}
			if (same) return { revision, changed: false };
			this.sql.exec("INSERT OR REPLACE INTO owner_settings (singleton,value) VALUES (1,?)", value);
			this.sql.exec("INSERT OR REPLACE INTO owner_settings_hash (singleton,hash) VALUES (1,?)", hash);
			this.sql.exec("DELETE FROM owner_settings_chunks");
			chunks.forEach((part, idx) => this.sql.exec("INSERT INTO owner_settings_chunks (idx,bytes,hash,data) VALUES (?,?,?,?)", idx, part.data.length, part.hash, part.data));
			return { revision: this.bump("settings"), changed: true };
		});
	}

	/** A fixed revision and value are read in the same transaction. */
	getSettings(): { settings: Settings | null; revision: number } {
		return this.storage.transactionSync(() => {
			const row = this.sql.exec<{ value: string }>("SELECT value FROM owner_settings WHERE singleton=1").toArray()[0];
			return { settings: row ? JSON.parse(row.value) as Settings : null, revision: this.revision("settings") };
		});
	}

	/** A stored hash must exist with the exact value; pre-hash records require explicit migration. */
	getSettingsHash(): { hash: string | null; revision: number } {
		return this.storage.transactionSync(() => {
			const value = this.sql.exec<{ value: string }>("SELECT value FROM owner_settings WHERE singleton=1").toArray()[0];
			const hash = this.sql.exec<{ hash: string }>("SELECT hash FROM owner_settings_hash WHERE singleton=1").toArray()[0];
			if (!!value !== !!hash) throw new Error("Owner settings hash requires migration");
			return { hash: hash?.hash ?? null, revision: this.revision("settings") };
		});
	}

	/** Bounded, authorized item updates. Replays do not advance the revision. */
	setDone(keys: readonly string[], done: boolean, expectedRevision: number, authorization: DoneAuthorization): { revision: number; changed: string[] } {
		if (!Array.isArray(keys) || keys.length > MAX_DONE_KEYS || typeof done !== "boolean" || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || keys.some((key) => typeof key !== "string" || !KEY.test(key))) throw new Error("Invalid done marks");
		if (!authorization || typeof authorization.head !== "string" || !authorization.head.length || authorization.head.length > 128 || !authorization.accounts || typeof authorization.accounts !== "object" || !this.containsDoneItem) throw new Error("Done authorization unavailable");
		const unique = [...new Set(keys)];
		return this.storage.transactionSync(() => {
			const now = Date.now();
			if (this.revision("done") !== expectedRevision) throw new Error("Done marks changed; retry with the current revision");
			const head = this.sql.exec<{ generation: string }>("SELECT generation FROM gen_head WHERE singleton=1").toArray()[0]?.generation;
			if (head !== authorization.head) throw new Error("Digest changed; reload before updating");
			for (const key of unique) {
				const alias = key.slice(0, key.indexOf(":"));
				const epoch = authorization.accounts[alias];
				const account = this.sql.exec<{ identity: string | null; version: number }>("SELECT a.identity,i.version FROM domain_accounts a JOIN coordinated_incarnations i ON i.alias=a.alias WHERE a.alias=?", alias).toArray()[0];
				const itemEpoch = this.containsDoneItem!(this.sql, authorization.head, key);
				if (!Number.isSafeInteger(epoch) || !account?.identity || account.version !== epoch || itemEpoch !== epoch) throw new Error("Item or mailbox changed; reload before updating");
			}
			// Expiry changes the logical snapshot. Drain it first so a commit cannot accept a stale revision.
			if (this.sql.exec("SELECT item FROM owner_done WHERE expires_at<=? LIMIT 1", now).toArray().length || this.sql.exec("SELECT namespace FROM owner_done_scoped WHERE expires_at<=? LIMIT 1",now).toArray().length) throw new Error("Expired done marks require cleanup");
			const changed: string[] = [];
			for (const key of unique) {
				const exists = this.sql.exec("SELECT item FROM owner_done WHERE item=?", key).toArray().length > 0;
				if (exists === done) continue;
				if (done) this.sql.exec("INSERT INTO owner_done (item,expires_at) VALUES (?,?)", key, now + DONE_TTL_MS);
				else this.sql.exec("DELETE FROM owner_done WHERE item=?", key);
				changed.push(key);
			}
			return { revision: changed.length ? this.bump("done") : this.revision("done"), changed };
		});
	}

	/** No snapshot is returned while expired marks remain to be reflected in the revision. */
	getDone(keys: readonly string[]): { revision: number; done: string[] } {
		if (!Array.isArray(keys) || keys.length > MAX_DONE_KEYS || keys.some((key) => typeof key !== "string" || !KEY.test(key))) throw new Error("Invalid done marks");
		return this.storage.transactionSync(() => {
			if (this.sql.exec("SELECT item FROM owner_done WHERE expires_at<=? LIMIT 1", Date.now()).toArray().length || this.sql.exec("SELECT namespace FROM owner_done_scoped WHERE expires_at<=? LIMIT 1",Date.now()).toArray().length) throw new Error("Expired done marks require cleanup");
			const done = [...new Set(keys)].filter((key) => this.sql.exec("SELECT item FROM owner_done WHERE item=?", key).toArray().length > 0);
			return { revision: this.revision("done"), done };
		});
	}

	/** Expire at most 100 marks per transaction; every change invalidates prior snapshots. */
	cleanupDone(limit = MAX_CLEANUP): { removed: number; remaining: boolean; revision: number } {
		if (!Number.isInteger(limit) || limit < 1 || limit > MAX_CLEANUP) throw new Error("Invalid cleanup limit");
		return this.storage.transactionSync(() => {
			const now = Date.now();
			const expired = this.sql.exec<{ item: string }>("SELECT item FROM owner_done WHERE expires_at<=? ORDER BY expires_at,item LIMIT ?", now, limit).toArray();
			for (const row of expired) this.sql.exec("DELETE FROM owner_done WHERE item=?", row.item);
			const revision = expired.length ? this.bump("done") : this.revision("done");
			const remaining = this.sql.exec("SELECT item FROM owner_done WHERE expires_at<=? LIMIT 1", now).toArray().length > 0 || this.sql.exec("SELECT namespace FROM owner_done_scoped WHERE expires_at<=? LIMIT 1",now).toArray().length > 0;
			return { removed: expired.length, remaining, revision };
		});
	}
}

/** Synthetic scoped done marks. Routers must fence off legacy setDone/getDone before enabling. */
export type DoneNamespace=(sql:SqlStorage,alias:string,incarnation:number)=>string|null;
export class ScopedDoneState {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly membership?:DoneMembership,private readonly namespace?:DoneNamespace){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS owner_done (item TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS gen_versions (key TEXT PRIMARY KEY, version INTEGER NOT NULL)');
  this.sql.exec("INSERT OR IGNORE INTO gen_versions (key,version) VALUES ('done',0)");
  this.sql.exec('CREATE TABLE IF NOT EXISTS owner_done_scoped (namespace TEXT NOT NULL,message_id TEXT NOT NULL,expires_at INTEGER NOT NULL,PRIMARY KEY(namespace,message_id))');
  this.sql.exec('CREATE INDEX IF NOT EXISTS owner_done_scoped_expiry ON owner_done_scoped(expires_at)');
 }
 private revision():number{const r=this.sql.exec<{version:number}>("SELECT version FROM gen_versions WHERE key='done'").toArray()[0];if(!r||!Number.isSafeInteger(r.version)||r.version<0)throw new Error('Done revision unavailable');return r.version;}
 private clean():boolean{return !this.sql.exec('SELECT item FROM owner_done WHERE expires_at<=? LIMIT 1',Date.now()).toArray().length&&!this.sql.exec('SELECT namespace FROM owner_done_scoped WHERE expires_at<=? LIMIT 1',Date.now()).toArray().length;}
 setDone(keys:readonly string[],done:boolean,expectedRevision:number,authorization:DoneAuthorization):{revision:number;changed:string[]}{
  if(!Array.isArray(keys)||keys.length>MAX_DONE_KEYS||typeof done!=='boolean'||!Number.isSafeInteger(expectedRevision)||expectedRevision<0||keys.some(k=>typeof k!=='string'||!KEY.test(k))||!authorization||typeof authorization.head!=='string'||!authorization.accounts||!this.membership||!this.namespace)throw new Error('Scoped done authorization unavailable');
  return this.storage.transactionSync(()=>{
   if(this.revision()!==expectedRevision||this.sql.exec<{generation:string}>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0]?.generation!==authorization.head||!this.clean())throw new Error('Done snapshot changed; retry');
   const addresses:{key:string;namespace:string;message:string}[]=[];
   for(const key of new Set(keys)){
    const at=key.indexOf(':'),alias=key.slice(0,at),message=key.slice(at+1),inc=authorization.accounts[alias];
    if(!Number.isSafeInteger(inc)||this.membership!(this.sql,authorization.head,key)!==inc)throw new Error('Item or mailbox changed; reload before updating');
    const namespace=this.namespace!(this.sql,alias,inc!);if(!namespace)throw new Error('Mailbox namespace unavailable');
    addresses.push({key,namespace,message});
   }
   const changed:string[]=[];
   for(const item of addresses){const exists=this.sql.exec('SELECT message_id FROM owner_done_scoped WHERE namespace=? AND message_id=?',item.namespace,item.message).toArray().length>0;if(exists===done)continue;if(done)this.sql.exec('INSERT INTO owner_done_scoped VALUES (?,?,?)',item.namespace,item.message,Date.now()+DONE_TTL_MS);else this.sql.exec('DELETE FROM owner_done_scoped WHERE namespace=? AND message_id=?',item.namespace,item.message);changed.push(item.key);}
   const revision=changed.length?this.revision()+1:this.revision();if(!Number.isSafeInteger(revision))throw new Error('Done revision exhausted');if(changed.length)this.sql.exec("UPDATE gen_versions SET version=? WHERE key='done'",revision);
   return {revision,changed};
  });
 }
 getDone(keys:readonly string[],incarnations:Readonly<Record<string,number>>):{revision:number;done:string[]}{
  if(!Array.isArray(keys)||keys.length>MAX_DONE_KEYS||keys.some(k=>typeof k!=='string'||!KEY.test(k))||!incarnations||!this.namespace)throw new Error('Scoped done authorization unavailable');
  return this.storage.transactionSync(()=>{if(!this.clean())throw new Error('Expired done marks require cleanup');const done:string[]=[];for(const key of new Set(keys)){const at=key.indexOf(':'),alias=key.slice(0,at),message=key.slice(at+1),inc=incarnations[alias];if(!Number.isSafeInteger(inc))throw new Error('Mailbox incarnation unavailable');const ns=this.namespace!(this.sql,alias,inc!);if(!ns)throw new Error('Mailbox namespace unavailable');if(this.sql.exec('SELECT message_id FROM owner_done_scoped WHERE namespace=? AND message_id=?',ns,message).toArray().length)done.push(key);}return {revision:this.revision(),done};});
 }
 cleanup(limit=MAX_CLEANUP):{removed:number;remaining:boolean;revision:number}{
  if(!Number.isSafeInteger(limit)||limit<1||limit>MAX_CLEANUP)throw new Error('Invalid cleanup limit');
  return this.storage.transactionSync(()=>{const rows=this.sql.exec<{namespace:string;message_id:string}>('SELECT namespace,message_id FROM owner_done_scoped WHERE expires_at<=? ORDER BY expires_at,namespace,message_id LIMIT ?',Date.now(),limit).toArray();for(const r of rows)this.sql.exec('DELETE FROM owner_done_scoped WHERE namespace=? AND message_id=?',r.namespace,r.message_id);const revision=rows.length?this.revision()+1:this.revision();if(!Number.isSafeInteger(revision))throw new Error('Done revision exhausted');if(rows.length)this.sql.exec("UPDATE gen_versions SET version=? WHERE key='done'",revision);return {removed:rows.length,remaining:!!(this.sql.exec('SELECT namespace FROM owner_done_scoped WHERE expires_at<=? LIMIT 1',Date.now()).toArray().length||this.sql.exec('SELECT item FROM owner_done WHERE expires_at<=? LIMIT 1',Date.now()).toArray().length),revision};});
 }
}
