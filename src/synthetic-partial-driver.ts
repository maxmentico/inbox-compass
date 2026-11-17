// SYNTHETIC/UNWIRED. Bounded extraction driver for selected accepted-partial elements only. It is
// not a complete partial/manifest projector. Never use it for live mail or expose internal endpoints.
import { type JsonEvent, type JsonStreamCheckpoint, startSyntheticJsonStream, pushSyntheticJsonFragment, finishSyntheticJsonStream } from "./synthetic-stream-json";
import { type PartialExtractCheckpoint, extractPartialEvents, finishPartialExtraction, startPartialExtraction } from "./synthetic-partial-extractor";
import { type PartialDtoCheckpoint, finishPartialDtoMapping, mapPartialDtoBatch, startPartialDtoMapping } from "./synthetic-partial-dto";
import type { TrustedAssemblySource } from "./trusted-assembly-source";
import type { SyntheticPackedSourceProof } from "./synthetic-packed-source-proof";

const TOKEN=/^[A-Za-z0-9_-]{22,128}$/, HASH=/^[a-f0-9]{64}$/, ALIAS=/^[a-z0-9][a-z0-9-]{0,31}$/;
const CHECKPOINT_LIMIT=512*1024, PAGE_LIMIT=64*1024;
type DtoStored=Omit<PartialDtoCheckpoint,"seenKeys">&{seenKeys:string[]};
type State={scope:string;attempt:string;sourceId:string;alias:string;identity:string;email:string;fragment:number;offset:number;parser:JsonStreamCheckpoint;extractor:PartialExtractCheckpoint;dto:DtoStored;pending:JsonEvent[];inputEnded:boolean;elementsDone:boolean};
type Row={id:string;scope:string;attempt:string;source_id:string;alias:string;identity:string;email:string;revision:number;state:string};
type Auth={job:string;generation:string;identity:string;email:string;chunks:number;token:string;versions:string};

/** Checkpoints and provisional DTO pages share the same SQLite transaction. */
export class SyntheticPartialDriver {
	private readonly sql:SqlStorage;
	constructor(private readonly storage:DurableObjectStorage,private readonly source:TrustedAssemblySource,private readonly proof:SyntheticPackedSourceProof){
		this.sql=storage.sql;
		this.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_partial_driver (id TEXT PRIMARY KEY, scope TEXT NOT NULL, attempt TEXT NOT NULL, source_id TEXT NOT NULL, alias TEXT NOT NULL, identity TEXT NOT NULL, email TEXT NOT NULL, revision INTEGER NOT NULL, state TEXT NOT NULL)");
		this.sql.exec("CREATE TABLE IF NOT EXISTS synthetic_partial_pages (id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(id,revision))");
	}
	private row(id:string):Row|undefined{return this.sql.exec<Row>("SELECT * FROM synthetic_partial_driver WHERE id=?",id).toArray()[0];}
	/** Must execute inside this object's existing transaction. */
	private auth(scope:string,attempt:string,sourceId:string,alias:string):Auth|null{
		if(!this.source.validateInTransaction(this.sql,scope,attempt))return null;
		const source=this.sql.exec<{job:string;generation:string;token:string;payload:string}>("SELECT job,generation,token,payload FROM trusted_source WHERE scope=?",scope).toArray()[0];
		const proof=this.sql.exec<{complete:number;source_id:string;attempt:string}>("SELECT complete,source_id,attempt FROM synthetic_packed_proof WHERE scope=?",scope).toArray()[0];
		if(!source||source.token!==attempt||!proof||proof.complete!==1||proof.source_id!==sourceId||proof.attempt!==attempt)return null;
		let versions:string;
		try{versions=JSON.stringify((JSON.parse(source.payload).versions as {key:string;version:number}[]).map(v=>({key:v.key,value:v.version})));}catch{return null;}
		if(this.proof.authority()(this.sql,source.job,source.generation,sourceId,versions)!==true)return null;
		const step=this.sql.exec<{identity:string;token:string;partial_count:number}>("SELECT identity,token,partial_count FROM core_steps WHERE job=? AND alias=? AND state='done'",source.job,alias).toArray()[0];
		const email=this.source.accountEmailInTransaction(this.sql,scope,attempt,alias);
		if(!step||!HASH.test(step.identity)||!TOKEN.test(step.token)||!Number.isSafeInteger(step.partial_count)||step.partial_count<1||step.partial_count>160||!email)return null;
		return {job:source.job,generation:source.generation,identity:step.identity,email:email.toLowerCase(),chunks:step.partial_count,token:step.token,versions};
	}
	private decode(row:Row):State|null{
		try{const state=JSON.parse(row.state) as State;if(state.scope!==row.scope||state.attempt!==row.attempt||state.sourceId!==row.source_id||state.alias!==row.alias||state.identity!==row.identity||state.email!==row.email||!Array.isArray(state.dto.seenKeys)||!Array.isArray(state.pending))return null;return state;}catch{return null;}
	}
	/** Coordinator-only reads of a completely extracted, still-authorized partial. */
	completedInTransaction(sql:SqlStorage,id:string):{scope:string;attempt:string;sourceId:string;alias:string;pages:number}|null{
		if(sql!==this.sql)return null;const row=this.row(id);if(!row)return null;const state=this.decode(row),auth=this.auth(row.scope,row.attempt,row.source_id,row.alias);
		return state?.elementsDone&&auth&&auth.identity===row.identity&&auth.email===row.email?{scope:row.scope,attempt:row.attempt,sourceId:row.source_id,alias:row.alias,pages:row.revision}:null;
	}
	pageInTransaction(sql:SqlStorage,id:string,revision:number):unknown[]|null{
		const info=this.completedInTransaction(sql,id);if(!info||!Number.isSafeInteger(revision)||revision<0||revision>=info.pages)return null;
		const row=sql.exec<{payload:string}>('SELECT payload FROM synthetic_partial_pages WHERE id=? AND revision=?',id,revision).toArray()[0];if(!row)return null;
		try{const value:unknown=JSON.parse(row.payload);return Array.isArray(value)&&value.length<=32?value:null;}catch{return null;}
	}
	start(id:string,scope:string,attempt:string,sourceId:string,alias:string):boolean{
		if(!TOKEN.test(id)||!TOKEN.test(scope)||!TOKEN.test(attempt)||!HASH.test(sourceId)||!ALIAS.test(alias))return false;
		return this.storage.transactionSync(()=>{
			if(this.row(id))return false;
			const auth=this.auth(scope,attempt,sourceId,alias);if(!auth)return false;
			const dto=startPartialDtoMapping(sourceId,scope,alias,auth.email,auth.identity);
			const state:State={scope,attempt,sourceId,alias,identity:auth.identity,email:auth.email,fragment:0,offset:0,parser:startSyntheticJsonStream(sourceId,scope),extractor:startPartialExtraction(sourceId,scope),dto:{...dto,seenKeys:[]},pending:[],inputEnded:false,elementsDone:false};
			this.sql.exec("INSERT INTO synthetic_partial_driver VALUES (?,?,?,?,?,?,?,0,?)",id,scope,attempt,sourceId,alias,auth.identity,auth.email,JSON.stringify(state));return true;
		});
	}
	/** One bounded CPU step. The page is provisional and is not a validated full assembly result. */
	async step(id:string,expectedRevision:number):Promise<{revision:number;elementsDone:boolean}|null>{
		if(!TOKEN.test(id)||!Number.isSafeInteger(expectedRevision)||expectedRevision<0)return null;
		const before=this.storage.transactionSync(()=>{const row=this.row(id);if(!row||row.revision!==expectedRevision)return null;const auth=this.auth(row.scope,row.attempt,row.source_id,row.alias),state=this.decode(row);return auth&&state&&!state.elementsDone&&auth.identity===row.identity&&auth.email===row.email?{row,auth,state}:null;});
		if(!before)return null;
		const s=before.state;
		const readIndex=s.fragment;
		let expectedChunk:{hash:string;bytes:number}|null=null;
		if(!s.pending.length&&!s.inputEnded){
			if(s.fragment>=before.auth.chunks){
				const finished=finishSyntheticJsonStream(s.parser,s.sourceId,s.scope);s.parser=finished.checkpoint;s.pending=finished.events;s.inputEnded=true;
			}else{
				expectedChunk=this.storage.transactionSync(()=>this.sql.exec<{hash:string;bytes:number}>("SELECT hash,bytes FROM core_chunks WHERE job=? AND alias=? AND token=? AND idx=?",before.auth.job,s.alias,before.auth.token,s.fragment).toArray()[0]??(s.fragment===0?this.sql.exec<{hash:string;bytes:number}>("SELECT hash,bytes FROM core_stages WHERE job=? AND alias=? AND token=?",before.auth.job,s.alias,before.auth.token).toArray()[0]:undefined)??null);
				const fragment=this.source.readPartial(s.scope,s.attempt,s.alias,s.fragment);
				if(!expectedChunk||!fragment||fragment.byteLength!==expectedChunk.bytes)return null;
				const digest=[...new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(fragment).buffer))].map(x=>x.toString(16).padStart(2,"0")).join("");
				if(digest!==expectedChunk.hash)return null;
				const result=pushSyntheticJsonFragment(s.parser,s.sourceId,s.scope,fragment,s.offset);s.parser=result.checkpoint;s.offset=result.nextOffset;s.pending=result.events;
				if(s.offset===fragment.byteLength){s.fragment++;s.offset=0;}
			}
		}
		let records:unknown[]=[];
		if(s.pending.length){
			const reduced=extractPartialEvents(s.extractor,s.sourceId,s.scope,s.extractor.nextEvent,s.pending);s.extractor=reduced.checkpoint;s.pending=s.pending.slice(reduced.consumed);
			const dto:PartialDtoCheckpoint={...s.dto,seenKeys:new Set(s.dto.seenKeys)};
			const mapped=mapPartialDtoBatch(dto,{sourceId:s.sourceId,scope:s.scope,account:s.alias,identity:s.identity,nextSequence:dto.nextSequence},reduced.records);
			s.dto={...mapped.checkpoint,seenKeys:[...mapped.checkpoint.seenKeys]};records=mapped.records;
		}
		if(s.inputEnded&&!s.pending.length&&records.length===0){
			finishPartialExtraction(s.extractor,s.sourceId,s.scope);
			const dto:PartialDtoCheckpoint={...s.dto,seenKeys:new Set(s.dto.seenKeys)};
			const final=finishPartialDtoMapping(dto);s.dto={...final.checkpoint,seenKeys:[...final.checkpoint.seenKeys]};records=final.records;s.elementsDone=true;
		}
		const serialized=JSON.stringify(s),payload=JSON.stringify(records),enc=new TextEncoder();
		if(enc.encode(serialized).byteLength>CHECKPOINT_LIMIT||enc.encode(payload).byteLength>PAGE_LIMIT)throw new Error("Synthetic partial capacity exceeded");
		return this.storage.transactionSync(()=>{
			const current=this.row(id),auth=current&&this.auth(current.scope,current.attempt,current.source_id,current.alias);
			if(!current||current.revision!==expectedRevision||current.state!==before.row.state||!auth||auth.identity!==current.identity||auth.email!==current.email||auth.token!==before.auth.token||auth.chunks!==before.auth.chunks)return null;
			if(expectedChunk){const chunk=this.sql.exec<{hash:string;bytes:number}>("SELECT hash,bytes FROM core_chunks WHERE job=? AND alias=? AND token=? AND idx=?",auth.job,current.alias,auth.token,readIndex).toArray()[0]??(readIndex===0?this.sql.exec<{hash:string;bytes:number}>("SELECT hash,bytes FROM core_stages WHERE job=? AND alias=? AND token=?",auth.job,current.alias,auth.token).toArray()[0]:undefined);if(!chunk||chunk.hash!==expectedChunk.hash||chunk.bytes!==expectedChunk.bytes)return null;}
			this.sql.exec("INSERT INTO synthetic_partial_pages VALUES (?,?,?)",id,expectedRevision,payload);
			this.sql.exec("UPDATE synthetic_partial_driver SET revision=?,state=? WHERE id=? AND revision=?",expectedRevision+1,serialized,id,expectedRevision);
			return {revision:expectedRevision+1,elementsDone:s.elementsDone};
		});
	}
}
