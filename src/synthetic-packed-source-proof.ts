// SYNTHETIC ONLY. Bounded keyed source proof; no production binding or output semantic verifier.
// A sealed snapshot contains arrays of descriptors, not caller-supplied source bytes. Descriptors are
// checked against coordinator-owned inventory and the actual immutable source is independently hashed.
import { readInputSnapshotPage, validateInputSnapshot, type InputSnapshotManifest } from "./input-snapshot";
import type { SyntheticSnapshotStore } from "./synthetic-snapshot-store";
import type { SyntheticSourceAuthority } from "./synthetic-job-bound-stage";
import type { TrustedInventoryEntry, TrustedInventoryReader } from "./synthetic-source-proof";

export interface PackedTrustedSource extends TrustedInventoryReader {
	readPartial(scope: string, token: string, alias: string, index: number): Uint8Array | null;
	readState(scope: string, token: string, key: string, index: number): { kind: "stale" | "missing" | "tombstone" | "corrupt" } | { kind: "value"; bytes: Uint8Array | null; metadata: unknown; expiresAt: number | null };
}
export interface PackedDescriptor { kind: TrustedInventoryEntry["kind"]; key: string; index: number; bytes: number; hash: string | null; expiresAt?: number | null; metadata?: unknown }
const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ENTRIES = 16, MAX_SOURCE_BYTES = 64 * 1024;
type Proof = { scope:string; job:string; generation:string; attempt:string; source_id:string; manifest:string; next_idx:number; after_cursor:string|null; complete:number };
const canonical = (m: InputSnapshotManifest) => JSON.stringify({version:m.version,id:m.id,totalBytes:m.totalBytes,fragments:m.fragments.map(f=>({sha256:f.sha256,bytes:f.bytes}))});
async function hash(value: Uint8Array): Promise<string> { const h=await crypto.subtle.digest("SHA-256",new Uint8Array(value).buffer); return [...new Uint8Array(h)].map(n=>n.toString(16).padStart(2,"0")).join(""); }

/** Descriptor keys and state metadata are derived from the trusted source, never a caller's list. */
export function packedDescriptor(entry: TrustedInventoryEntry): PackedDescriptor {
	return { kind:entry.kind,key:entry.key,index:entry.index,bytes:entry.bytes,hash:entry.hash,...(entry.kind==="state"?{expiresAt:entry.expiresAt,metadata:entry.metadata}:{}) };
}
function validPacked(value: unknown): value is PackedDescriptor[] {
	if (!Array.isArray(value) || !value.length || value.length>MAX_ENTRIES) return false;
	return value.every((e) => {
		if (!e || typeof e!=="object" || Array.isArray(e) || !["partial","state","missing","tombstone"].includes(e.kind) || typeof e.key!=="string" || e.key.length>360 || !Number.isSafeInteger(e.index) || e.index<0 || !Number.isSafeInteger(e.bytes) || e.bytes<0 || e.bytes>MAX_SOURCE_BYTES || !(e.hash===null || typeof e.hash==="string" && HASH.test(e.hash))) return false;
		const allowed=e.kind==="state"?["kind","key","index","bytes","hash","expiresAt","metadata"]:["kind","key","index","bytes","hash"];
		return Object.keys(e).length===allowed.length && Object.keys(e).every(k=>allowed.includes(k));
	});
}

export class SyntheticPackedSourceProof {
	private readonly sql:SqlStorage;
	constructor(private readonly storage:DurableObjectStorage,private readonly trusted:PackedTrustedSource,private readonly snapshots:SyntheticSnapshotStore){this.sql=storage.sql;this.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_packed_proof (scope TEXT PRIMARY KEY, job TEXT NOT NULL, generation TEXT NOT NULL, attempt TEXT NOT NULL, source_id TEXT NOT NULL, manifest TEXT NOT NULL, next_idx INTEGER NOT NULL, after_cursor TEXT, complete INTEGER NOT NULL)");}
	private row(scope:string):Proof|undefined{return this.sql.exec<Proof>("SELECT * FROM synthetic_packed_proof WHERE scope=?",scope).toArray()[0];}
	private valid(p:Proof):boolean{
		const capture=this.sql.exec<{job:string;generation:string;token:string}>("SELECT job,generation,token FROM trusted_source WHERE scope=?",p.scope).toArray()[0];
		const snapshot=this.sql.exec<{owner:string;sealed:number;manifest:string}>("SELECT owner,sealed,manifest FROM synthetic_snapshots WHERE id=?",p.source_id).toArray()[0];
		const lease=this.sql.exec<{expires_at:number}>("SELECT expires_at FROM lease WHERE id=1 AND owner=?",p.generation).toArray()[0];
		return !!capture&&capture.job===p.job&&capture.generation===p.generation&&capture.token===p.attempt&&!!snapshot&&snapshot.owner===p.generation&&snapshot.sealed===1&&snapshot.manifest===p.manifest&&!!lease&&lease.expires_at>Date.now()&&this.trusted.validateInTransaction(this.sql,p.scope,p.attempt);
	}
	async begin(input:{scope:string;job:string;generation:string;attempt:string;manifest:InputSnapshotManifest}):Promise<boolean>{
		if(!input||![input.scope,input.job,input.generation,input.attempt].every(v=>typeof v==="string"&&TOKEN.test(v))||!input.manifest||!Array.isArray(input.manifest.fragments)||input.manifest.fragments.length>160)return false;
		const identity={scope:input.scope,job:input.job,generation:input.generation,attempt:input.attempt};
		const m={version:input.manifest.version,id:input.manifest.id,totalBytes:input.manifest.totalBytes,fragments:input.manifest.fragments.map(f=>({sha256:f.sha256,bytes:f.bytes}))};
		try{await validateInputSnapshot(m,m.id);}catch{return false;}
		const p:Proof={...identity,source_id:m.id,manifest:canonical(m),next_idx:0,after_cursor:null,complete:0};
		return this.storage.transactionSync(()=>{if(this.row(p.scope)||!this.valid(p))return false;const first=this.trusted.inventoryPageInTransaction(this.sql,p.scope,p.attempt,null,1);if(!first||(m.fragments.length===0)!==(first.entries.length===0&&first.next===null))return false;this.sql.exec("INSERT INTO synthetic_packed_proof VALUES (?,?,?,?,?,?,0,NULL,?)",p.scope,p.job,p.generation,p.attempt,p.source_id,p.manifest,m.fragments.length===0?1:0);return true;});
	}
	async verifyNext(scope:string,attempt:string,expectedIndex:number):Promise<{next:number;complete:boolean}|null>{
		if(!TOKEN.test(scope)||!TOKEN.test(attempt)||!Number.isSafeInteger(expectedIndex)||expectedIndex<0||expectedIndex>=160)return null;
		const before=this.storage.transactionSync(()=>{const p=this.row(scope);return p&&p.attempt===attempt&&!p.complete&&p.next_idx===expectedIndex&&this.valid(p)?p:null;});
		if(!before)return null;
		let manifest:InputSnapshotManifest,packed:unknown;
		try{manifest=JSON.parse(before.manifest) as InputSnapshotManifest;const page=await readInputSnapshotPage(this.snapshots.source(before.generation),manifest,before.source_id,expectedIndex,{maxBytes:64*1024,maxFragments:1});if(page.fragments.length!==1)return null;packed=JSON.parse(new TextDecoder("utf-8",{fatal:true,ignoreBOM:false}).decode(page.fragments[0]));}catch{return null;}
		if(!validPacked(packed))return null;
		const inventory=this.storage.transactionSync(()=>{const p=this.row(scope);if(!p||p.next_idx!==expectedIndex||p.after_cursor!==before.after_cursor||p.manifest!==before.manifest||!this.valid(p))return null;return this.trusted.inventoryPageInTransaction(this.sql,scope,attempt,p.after_cursor,packed.length);});
		if(!inventory||inventory.entries.length!==packed.length||inventory.entries.reduce((n,e)=>n+e.bytes,0)>MAX_SOURCE_BYTES)return null;
		for(let i=0;i<packed.length;i++){
			const e=inventory.entries[i]!, expected=packedDescriptor(e), supplied=packed[i]!;
			if(JSON.stringify(expected)!==JSON.stringify(supplied))return null;
			if(e.kind==="partial"){
				const raw=this.trusted.readPartial(scope,attempt,e.key,e.index);if(!raw||raw.byteLength!==e.bytes||await hash(raw)!==e.hash)return null;
			}else{
				const value=this.trusted.readState(scope,attempt,e.key,e.index);
				if(e.kind==="missing"||e.kind==="tombstone"){if(value.kind!==e.kind)return null;}
				else{if(value.kind!=="value"||JSON.stringify(value.metadata)!==JSON.stringify(e.metadata)||value.expiresAt!==e.expiresAt)return null;if(e.bytes===0){if(value.bytes!==null||e.hash!==null)return null;}else if(!value.bytes||value.bytes.byteLength!==e.bytes||await hash(value.bytes)!==e.hash)return null;}
			}
		}
		return this.storage.transactionSync(()=>{const p=this.row(scope);if(!p||p.next_idx!==expectedIndex||p.after_cursor!==before.after_cursor||p.manifest!==before.manifest||!this.valid(p))return null;const again=this.trusted.inventoryPageInTransaction(this.sql,scope,attempt,p.after_cursor,packed.length);if(!again||JSON.stringify(again)!==JSON.stringify(inventory))return null;const next=expectedIndex+1,complete=again.next===null;if(complete!==(next===manifest.fragments.length))return null;this.sql.exec("UPDATE synthetic_packed_proof SET next_idx=?,after_cursor=?,complete=? WHERE scope=? AND next_idx=? AND complete=0",next,complete?again.entries.at(-1)!.cursor:again.next,complete?1:0,scope,expectedIndex);return {next,complete};});
	}
	/** Only approves exact source content; separate independent output verification is mandatory. */
	authority():SyntheticSourceAuthority{return (sql,job,generation,sourceId,versions)=>{if(sql!==this.sql)return false;const proofs=sql.exec<Proof>("SELECT * FROM synthetic_packed_proof WHERE job=? AND generation=? AND source_id=? AND complete=1",job,generation,sourceId).toArray();return proofs.some(p=>{if(!this.valid(p))return false;const row=sql.exec<{payload:string}>("SELECT payload FROM trusted_source WHERE scope=?",p.scope).toArray()[0];try{const have=JSON.parse(row!.payload).versions as {key:string;version:number}[],want=(JSON.parse(versions) as {key:string;value:number}[]).map(v=>({key:v.key,version:v.value}));const sort=(v:{key:string;version:number}[])=>[...v].sort((a,b)=>a.key.localeCompare(b.key));return JSON.stringify(sort(have))===JSON.stringify(sort(want));}catch{return false;}});};}
}
