// SYNTHETIC/UNWIRED. Compares a sealed candidate with an INDEPENDENT coordinator-owned expected
// stream. The injected source must be derived from trusted captured inputs, never from candidate
// index or output; a stub cannot authorize production. No production retention or bindings exist.
import type { SegmentedSemanticProof } from "./segmented-generation";
const ID=/^[A-Za-z0-9_-]{22,128}$/,HASH=/^[a-f0-9]{64}$/;
const PAGE=4096, CHUNK=64*1024, MAX_OPS=1000, MAX_BYTES=32*1024*1024;
type Version={key:string;version:number};
export interface ReferenceHeader { referenceId:string; job:string; generation:string; sourceId:string; digest:string; previous:string|null; versions:Version[]; totalOps:number; totalBytes:number }
export interface ReferenceOp { key:string; kind:"put"|"delete"; bytes:number; expiresAt:number|null; metadata:{arrived:number}|null }
/** Must be a trusted independent projection of the captured source, not a wrapper around sgen_index. */
export interface IndependentReferenceSource {
	current(sql:SqlStorage,scope:string,attempt:string,referenceId:string):boolean;
	header(sql:SqlStorage,scope:string,attempt:string,referenceId:string):ReferenceHeader|null;
	op(sql:SqlStorage,scope:string,attempt:string,referenceId:string,ordinal:number):ReferenceOp|null;
	/** Exactly `length` independently projected value bytes for this operation and offset. */
	bytes(sql:SqlStorage,scope:string,attempt:string,referenceId:string,ordinal:number,offset:number,length:number):Uint8Array|null;
}
type Build={scope:string;job:string;generation:string;attempt:string;source_id:string;previous:string|null;digest:string;versions:string;total_ops:number;total_bytes:number;complete:number};
type Cursor={scope:string;job:string;generation:string;attempt:string;source_id:string;reference_id:string;header:string;ordinal:number;offset:number;complete:number};
type IndexRow={key:string;kind:"put"|"delete";start:number;bytes:number;expires_at:number|null;metadata:string|null};
type Segment={data:ArrayBuffer;hash:string;bytes:number};
const normalizeVersions=(v:Version[])=>JSON.stringify([...v].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0));
const normalizeHeader=(h:ReferenceHeader)=>JSON.stringify({...h,versions:[...h.versions].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)});
async function digest(bytes:Uint8Array):Promise<string>{const d=await crypto.subtle.digest("SHA-256",new Uint8Array(bytes).buffer);return [...new Uint8Array(d)].map(x=>x.toString(16).padStart(2,"0")).join("");}

/** Independent, bounded verification. A complete transport/index is not itself a certificate. */
export class SyntheticSegmentCertificate {
	private readonly sql:SqlStorage;
	constructor(private readonly storage:DurableObjectStorage,private readonly reference?:IndependentReferenceSource){this.sql=storage.sql;this.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_segment_certificate (scope TEXT PRIMARY KEY,job TEXT NOT NULL,generation TEXT NOT NULL,attempt TEXT NOT NULL,source_id TEXT NOT NULL,reference_id TEXT NOT NULL,header TEXT NOT NULL,ordinal INTEGER NOT NULL,offset INTEGER NOT NULL,complete INTEGER NOT NULL)");}
	private row(scope:string):Cursor|undefined{return this.sql.exec<Cursor>("SELECT * FROM synthetic_segment_certificate WHERE scope=?",scope).toArray()[0];}
	private build(scope:string):Build|undefined{return this.sql.exec<Build>("SELECT scope,job,generation,attempt,source_id,previous,digest,versions,total_ops,total_bytes,complete FROM sgen_build WHERE scope=?",scope).toArray()[0];}
	private valid(c:Cursor):boolean{
		if(!this.reference||this.reference.current(this.sql,c.scope,c.attempt,c.reference_id)!==true)return false;
		const b=this.build(c.scope),transport=this.sql.exec<{state:string;bytes:number}>("SELECT state,bytes FROM seg_outputs WHERE scope=?",c.scope).toArray()[0];
		const h=this.reference.header(this.sql,c.scope,c.attempt,c.reference_id);
		return !!b&&b.complete===1&&b.job===c.job&&b.generation===c.generation&&b.attempt===c.attempt&&b.source_id===c.source_id&&!!transport&&transport.state==="sealed"&&transport.bytes===b.total_bytes&&!!h&&normalizeHeader(h)===c.header&&h.referenceId===c.reference_id&&h.job===c.job&&h.generation===c.generation&&h.sourceId===c.source_id&&h.digest===b.digest&&h.previous===b.previous&&normalizeVersions(h.versions)===b.versions&&h.totalOps===b.total_ops&&h.totalBytes===b.total_bytes;
	}
	begin(input:{scope:string;job:string;generation:string;attempt:string;sourceId:string;referenceId:string}):boolean{
		if(!input||![input.scope,input.job,input.generation,input.attempt,input.referenceId].every(v=>typeof v==="string"&&ID.test(v))||!HASH.test(input.sourceId)||!this.reference)return false;
		return this.storage.transactionSync(()=>{
			if(this.row(input.scope)||this.reference!.current(this.sql,input.scope,input.attempt,input.referenceId)!==true)return false;
			const h=this.reference!.header(this.sql,input.scope,input.attempt,input.referenceId);
			if(!h||h.referenceId!==input.referenceId||h.job!==input.job||h.generation!==input.generation||h.sourceId!==input.sourceId||!Array.isArray(h.versions)||h.versions.length>52||!Number.isSafeInteger(h.totalOps)||h.totalOps<1||h.totalOps>MAX_OPS||!Number.isSafeInteger(h.totalBytes)||h.totalBytes<1||h.totalBytes>MAX_BYTES)return false;
			const cursor:Cursor={scope:input.scope,job:input.job,generation:input.generation,attempt:input.attempt,source_id:input.sourceId,reference_id:input.referenceId,header:normalizeHeader(h),ordinal:0,offset:0,complete:0};
			if(!this.valid(cursor))return false;
			this.sql.exec("INSERT INTO synthetic_segment_certificate VALUES (?,?,?,?,?,?,?,0,0,0)",cursor.scope,cursor.job,cursor.generation,cursor.attempt,cursor.source_id,cursor.reference_id,cursor.header);return true;
		});
	}
	/** Compare ≤4 KiB of one value per step and atomically advance only after a second fence check. */
	async verifyNext(scope:string,attempt:string,expectedOrdinal:number,expectedOffset:number):Promise<{ordinal:number;offset:number;complete:boolean}|null>{
		if(!ID.test(scope)||!ID.test(attempt)||!Number.isSafeInteger(expectedOrdinal)||expectedOrdinal<0||!Number.isSafeInteger(expectedOffset)||expectedOffset<0||!this.reference)return null;
		const selected=this.storage.transactionSync(()=>{
			const c=this.row(scope);if(!c||c.attempt!==attempt||c.complete||c.ordinal!==expectedOrdinal||c.offset!==expectedOffset||!this.valid(c))return null;
			const h=this.reference!.header(this.sql,scope,attempt,c.reference_id)!,expected=this.reference!.op(this.sql,scope,attempt,c.reference_id,c.ordinal);
			const actual=this.sql.exec<IndexRow>("SELECT key,kind,start,bytes,expires_at,metadata FROM sgen_index WHERE scope=? AND ordinal=?",scope,c.ordinal).toArray()[0];
			if(!expected||!actual||expected.key!==actual.key||expected.kind!==actual.kind||expected.bytes!==actual.bytes||expected.expiresAt!==actual.expires_at||JSON.stringify(expected.metadata)!==(actual.metadata??"null")||c.offset>actual.bytes)return null;
			if(actual.kind==="delete"&&actual.bytes!==0)return null;
			const length=Math.min(PAGE,actual.bytes-c.offset,CHUNK-((actual.start+c.offset)%CHUNK));
			let candidate:Segment|null=null,referenceBytes=new Uint8Array();
			if(length){candidate=this.sql.exec<Segment>("SELECT data,hash,bytes FROM seg_parts WHERE scope=? AND idx=?",scope,Math.floor((actual.start+c.offset)/CHUNK)).toArray()[0]??null;const bytes=this.reference!.bytes(this.sql,scope,attempt,c.reference_id,c.ordinal,c.offset,length);if(!candidate||!(bytes instanceof Uint8Array)||bytes.byteLength!==length)return null;referenceBytes=new Uint8Array(bytes);}
			return {c,h,expected,actual,length,candidate,referenceBytes};
		});
		if(!selected)return null;
		if(selected.candidate){const raw=new Uint8Array(selected.candidate.data);if(raw.byteLength!==selected.candidate.bytes||await digest(raw)!==selected.candidate.hash)return null;const inner=(selected.actual.start+selected.c.offset)%CHUNK;if(inner+selected.length>raw.length)return null;const slice=raw.subarray(inner,inner+selected.length);if(slice.some((b,i)=>b!==selected.referenceBytes[i]))return null;}
		return this.storage.transactionSync(()=>{
			const c=this.row(scope);if(!c||c.attempt!==attempt||c.complete||c.ordinal!==expectedOrdinal||c.offset!==expectedOffset||c.header!==selected.c.header||!this.valid(c))return null;
			const expected=this.reference!.op(this.sql,scope,attempt,c.reference_id,c.ordinal),actual=this.sql.exec<IndexRow>("SELECT key,kind,start,bytes,expires_at,metadata FROM sgen_index WHERE scope=? AND ordinal=?",scope,c.ordinal).toArray()[0];
			if(JSON.stringify(expected)!==JSON.stringify(selected.expected)||JSON.stringify(actual)!==JSON.stringify(selected.actual))return null;
			if(selected.length){const bytes=this.reference!.bytes(this.sql,scope,attempt,c.reference_id,c.ordinal,c.offset,selected.length);const part=this.sql.exec<{hash:string;bytes:number}>("SELECT hash,bytes FROM seg_parts WHERE scope=? AND idx=?",scope,Math.floor((actual!.start+c.offset)/CHUNK)).toArray()[0];if(!(bytes instanceof Uint8Array)||bytes.byteLength!==selected.length||bytes.some((b,i)=>b!==selected.referenceBytes[i])||!part||part.hash!==selected.candidate!.hash||part.bytes!==selected.candidate!.bytes)return null;}
			const end=c.offset+selected.length,ordinal=end===actual!.bytes?c.ordinal+1:c.ordinal,offset=end===actual!.bytes?0:end,complete=ordinal===selected.h.totalOps;
			if(complete&&this.reference!.op(this.sql,scope,attempt,c.reference_id,ordinal)!==null)return null;
			this.sql.exec("UPDATE synthetic_segment_certificate SET ordinal=?,offset=?,complete=? WHERE scope=? AND ordinal=? AND offset=? AND complete=0",ordinal,offset,complete?1:0,scope,c.ordinal,c.offset);
			return {ordinal,offset,complete};
		});
	}
	/** O(1) certificate lookup; candidate/source data must remain immutable after verification. */
	proof():SegmentedSemanticProof{return(sql,scope,job,generation,sourceId)=>{if(sql!==this.sql)return false;const c=this.row(scope);return !!c&&c.complete===1&&c.job===job&&c.generation===generation&&c.source_id===sourceId&&this.valid(c);};}
}
