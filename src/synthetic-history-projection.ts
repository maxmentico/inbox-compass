// SYNTHETIC/UNWIRED. History merge only, not a full manifest or publication. All source lookups
// must use one immutable, coordinator-authenticated snapshot inside the caller's fenced transaction.
import type { HistoryEntry } from "./estimate";
import { isSecurityEmail, redactSecrets } from "./secrets";
import { REQUESTS,SENDER_TYPES,STAKES } from "./rules";
import { CATEGORIES } from "./llm";

const TOKEN=/^[A-Za-z0-9_-]{22,128}$/,HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9_-]{1,256}$/;
export const HISTORY_PROJECTION_LIMITS={recordsPerPage:16,bytesPerPage:8192,sourceRecords:20_000,resultRecords:500} as const;
export const HISTORY_PROJECTION_TTL=60*24*60*60;
export interface HistoryProjectionSource {
	current(scope:string,sourceId:string):boolean;
	info(scope:string,sourceId:string,account:string):{present:boolean;before:number;added:number}|null;
	/** Added entries sorted by date descending, with original ordinal for stable equal-date order. */
	addedSortedAt(scope:string,sourceId:string,account:string,index:number):{entry:HistoryEntry;ordinal:number}|null;
	beforeAt(scope:string,sourceId:string,account:string,index:number):HistoryEntry|null;
	/** Membership in the complete original added set, including entries beyond the result cap. */
	inAdded(scope:string,sourceId:string,account:string,id:string):boolean;
}
export interface HistoryProjectionCheckpoint {
	scope:string;sourceId:string;account:string;present:boolean;before:number;added:number;
	phase:"added"|"before"|"done";index:number;processed:number;emitted:number;started:boolean;
	previousAdded:{date:string;ordinal:number}|null;
}
export type HistoryProjectionFinal={kind:"put";expirationTtl:number}|{kind:"noop"};

export function beginHistoryProjection(source:HistoryProjectionSource,scope:string,sourceId:string,account:string):HistoryProjectionCheckpoint {
	if(!TOKEN.test(scope)||!HASH.test(sourceId)||!/^[a-z0-9][a-z0-9-]{0,31}$/.test(account)||source.current(scope,sourceId)!==true)throw new Error("Invalid history source");
	const info=source.info(scope,sourceId,account);
	if(!info||typeof info.present!=="boolean"||!Number.isSafeInteger(info.before)||!Number.isSafeInteger(info.added)||info.before<0||info.added<0||info.before+info.added>HISTORY_PROJECTION_LIMITS.sourceRecords||(!info.present&&info.added!==0))throw new Error("Invalid history inventory");
	return {scope,sourceId,account,...info,phase:"added",index:0,processed:0,emitted:0,started:false,previousAdded:null};
}
function validateEntry(entry:HistoryEntry):string {
	const keys=["id","address","domain","name","subject","shape","addressing","tab","important","starred","conversation","attachment","flags","answers","date"];
	const oneOf=(values:readonly string[],value:unknown)=>typeof value==="string"&&values.includes(value);
	if(!entry||typeof entry!=="object"||Array.isArray(entry)||Object.keys(entry).length!==keys.length||Object.keys(entry).some(k=>!keys.includes(k))||!ID.test(entry.id)||typeof entry.address!=="string"||entry.address.length>320||typeof entry.domain!=="string"||entry.domain.length>255||typeof entry.name!=="string"||entry.name.length>500||typeof entry.subject!=="string"||entry.subject.length>500||!(entry.date===null||typeof entry.date==="string"&&entry.date.length<=40)||!Array.isArray(entry.shape)||entry.shape.length>100||entry.shape.some(v=>typeof v!=="string"||v.length>120)||!oneOf(["only_you","to_you","cc_you","not_named","bulk"],entry.addressing)||!oneOf(["primary","social","promotions","updates","forums",""],entry.tab)||![entry.important,entry.starred,entry.conversation,entry.attachment].every(v=>typeof v==="boolean")||!Array.isArray(entry.flags)||entry.flags.length>4||entry.flags.some(v=>!oneOf(["money","deadline","request","security"],v))||!entry.answers||typeof entry.answers!=="object"||Array.isArray(entry.answers)||Object.keys(entry.answers).length!==4||Object.keys(entry.answers).some(k=>!["sender","request","stakes","category"].includes(k))||!oneOf(SENDER_TYPES,entry.answers.sender)||!oneOf(REQUESTS,entry.answers.request)||!oneOf(STAKES,entry.answers.stakes)||!oneOf(CATEGORIES,entry.answers.category)||redactSecrets(entry.subject,isSecurityEmail(entry.subject,"",""))!==entry.subject)throw new Error("Invalid or unredacted history entry");
	const value=JSON.stringify(entry);
	if(typeof value!=="string"||new TextEncoder().encode(value).byteLength>HISTORY_PROJECTION_LIMITS.bytesPerPage-2)throw new Error("History entry exceeds limit");
	return value;
}

/** Processes ≤16 source records/8 KiB; caller atomically stages the provisional chunk and cursor. */
export function nextHistoryProjectionPage(source:HistoryProjectionSource,checkpoint:HistoryProjectionCheckpoint,expected:{scope:string;sourceId:string;phase:HistoryProjectionCheckpoint["phase"];index:number}):{checkpoint:HistoryProjectionCheckpoint;chunk:string;final:HistoryProjectionFinal|null}{
	if(!checkpoint||checkpoint.scope!==expected.scope||checkpoint.sourceId!==expected.sourceId||checkpoint.phase!==expected.phase||checkpoint.index!==expected.index||checkpoint.phase==="done"||!Number.isSafeInteger(checkpoint.index)||!Number.isSafeInteger(checkpoint.processed)||!Number.isSafeInteger(checkpoint.emitted)||checkpoint.index<0||checkpoint.emitted<0||checkpoint.emitted>HISTORY_PROJECTION_LIMITS.resultRecords||checkpoint.emitted>checkpoint.processed||(checkpoint.phase==="added"&&(checkpoint.index>checkpoint.added||checkpoint.processed!==checkpoint.index))||(checkpoint.phase==="before"&&(checkpoint.index>checkpoint.before||checkpoint.processed!==checkpoint.added+checkpoint.index))||source.current(checkpoint.scope,checkpoint.sourceId)!==true)throw new Error("Stale history checkpoint");
	const info=source.info(checkpoint.scope,checkpoint.sourceId,checkpoint.account);
	if(!info||info.present!==checkpoint.present||info.before!==checkpoint.before||info.added!==checkpoint.added)throw new Error("Changed history inventory");
	const s={...checkpoint};let chunk=s.started?"":"[";s.started=true;let processed=0;
	while(processed<HISTORY_PROJECTION_LIMITS.recordsPerPage&&s.phase!=="done"){
		if(!s.present||s.emitted===HISTORY_PROJECTION_LIMITS.resultRecords){s.phase="done";break;}
		if(s.phase==="added"&&s.index===s.added){s.phase="before";s.index=0;continue;}
		if(s.phase==="before"&&s.index===s.before){s.phase="done";break;}
		let entry:HistoryEntry, ordinal:number|undefined;
		if(s.phase==="added"){
			const item=source.addedSortedAt(s.scope,s.sourceId,s.account,s.index);if(!item||!Number.isSafeInteger(item.ordinal)||item.ordinal<0||item.ordinal>=s.added)throw new Error("Missing or invalid learned history");
			entry=item.entry;ordinal=item.ordinal;
			const date=entry?.date??"",previous=s.previousAdded;
			if(previous){const order=previous.date.localeCompare(date);if(order<0||order===0&&previous.ordinal>=ordinal)throw new Error("Unstable history ordering");}
		}else{
			const item=source.beforeAt(s.scope,s.sourceId,s.account,s.index);if(!item)throw new Error("Missing history entry");entry=item;
		}
		const value=validateEntry(entry);
		const included=s.phase==="added"?true:(()=>{const match=source.inAdded(s.scope,s.sourceId,s.account,entry.id);if(typeof match!=="boolean")throw new Error("Missing learned history membership");return !match;})();
		const piece=included?(s.emitted?",":"")+value:"";
		if(new TextEncoder().encode(chunk+piece).byteLength>HISTORY_PROJECTION_LIMITS.bytesPerPage-1){if(processed===0)throw new Error("History page exceeds limit");break;}
		if(included){chunk+=piece;s.emitted++;}
		if(s.phase==="added")s.previousAdded={date:entry.date??"",ordinal:ordinal!};
		s.index++;s.processed++;processed++;
	}
	if(s.phase==="done")chunk+="]";
	if(new TextEncoder().encode(chunk).byteLength>HISTORY_PROJECTION_LIMITS.bytesPerPage||source.current(s.scope,s.sourceId)!==true)throw new Error("History projection exceeded limit or became stale");
	return {checkpoint:s,chunk,final:s.phase!=="done"?null:s.present?{kind:"put",expirationTtl:HISTORY_PROJECTION_TTL}:{kind:"noop"}};
}
