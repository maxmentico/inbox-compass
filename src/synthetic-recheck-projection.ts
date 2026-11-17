// SYNTHETIC/UNWIRED. Bounded reference-compatible recheck value projection, not a commit protocol.
// Source methods must read one immutable coordinator-owned snapshot inside the caller's transaction;
// caller-supplied lists or a self-declared version are not authoritative. Output is provisional.

const TOKEN=/^[A-Za-z0-9_-]{22,128}$/,HASH=/^[a-f0-9]{64}$/,ID=/^[A-Za-z0-9_-]{1,256}$/;
export const RECHECK_PROJECTION_LIMITS={entriesPerPage:16,bytesPerPage:8192,entries:20_000} as const;
export const RECHECK_PROJECTION_TTL=21*24*60*60;
export interface RecheckProjectionSource {
	/** Must fail if generation, account identity, owner revisions or source state changed. */
	current(scope:string,sourceId:string):boolean;
	/** Counts and existence are from the captured coordinator snapshot, not producer input. */
	info(scope:string,sourceId:string,account:string):{present:boolean;before:number;estimated:number;now:number}|null;
	beforeAt(scope:string,sourceId:string,account:string,index:number):{id:string;added:number}|null;
	estimatedAt(scope:string,sourceId:string,account:string,index:number):string|null;
	isSettled(scope:string,sourceId:string,account:string,id:string):boolean;
	inBefore(scope:string,sourceId:string,account:string,id:string):boolean;
}
export interface RecheckProjectionCheckpoint {
	scope:string;sourceId:string;account:string;present:boolean;before:number;estimated:number;now:number;
	phase:"before"|"estimated"|"done";index:number;processed:number;emitted:number;changed:boolean;started:boolean;
}
export type RecheckProjectionFinal={kind:"put";expirationTtl:number}|{kind:"delete"}|{kind:"noop"};

export function beginRecheckProjection(source:RecheckProjectionSource,scope:string,sourceId:string,account:string):RecheckProjectionCheckpoint {
	if(!TOKEN.test(scope)||!HASH.test(sourceId)||!/^[a-z0-9][a-z0-9-]{0,31}$/.test(account)||source.current(scope,sourceId)!==true)throw new Error("Invalid recheck source");
	const info=source.info(scope,sourceId,account);
	if(!info||typeof info.present!=="boolean"||!Number.isSafeInteger(info.before)||!Number.isSafeInteger(info.estimated)||info.before<0||info.estimated<0||info.before+info.estimated>RECHECK_PROJECTION_LIMITS.entries||!Number.isSafeInteger(info.now)||(!info.present&&(info.before!==0||info.estimated!==0)))throw new Error("Invalid recheck inventory");
	return {scope,sourceId,account,...info,phase:"before",index:0,processed:0,emitted:0,changed:false,started:false};
}

/** Returns at most 16 records/8 KiB. Persist checkpoint and chunk together with a fenced CAS. */
export function nextRecheckProjectionPage(source:RecheckProjectionSource,checkpoint:RecheckProjectionCheckpoint,expected:{scope:string;sourceId:string;phase:RecheckProjectionCheckpoint["phase"];index:number}):{checkpoint:RecheckProjectionCheckpoint;chunk:string;final:RecheckProjectionFinal|null} {
	if(!checkpoint||checkpoint.scope!==expected.scope||checkpoint.sourceId!==expected.sourceId||checkpoint.phase!==expected.phase||checkpoint.index!==expected.index||checkpoint.phase==="done"||!Number.isSafeInteger(checkpoint.index)||!Number.isSafeInteger(checkpoint.processed)||!Number.isSafeInteger(checkpoint.emitted)||checkpoint.index<0||checkpoint.emitted<0||checkpoint.emitted>checkpoint.processed||(checkpoint.phase==="before"&&(checkpoint.index>checkpoint.before||checkpoint.processed!==checkpoint.index))||(checkpoint.phase==="estimated"&&(checkpoint.index>checkpoint.estimated||checkpoint.processed!==checkpoint.before+checkpoint.index))||typeof checkpoint.changed!=="boolean"||typeof checkpoint.started!=="boolean"||source.current(checkpoint.scope,checkpoint.sourceId)!==true)throw new Error("Stale recheck checkpoint");
	const info=source.info(checkpoint.scope,checkpoint.sourceId,checkpoint.account);
	if(!info||info.present!==checkpoint.present||info.before!==checkpoint.before||info.estimated!==checkpoint.estimated||info.now!==checkpoint.now)throw new Error("Changed recheck inventory");
	const s={...checkpoint};let chunk=s.started?"":"[";s.started=true;let processed=0;
	while(processed<RECHECK_PROJECTION_LIMITS.entriesPerPage&&s.phase!=="done"){
		if(s.phase==="before"&&s.index===s.before){s.phase="estimated";s.index=0;continue;}
		if(s.phase==="estimated"&&s.index===s.estimated){s.phase="done";break;}
		let value:{id:string;added:number}|null=null;
		if(s.phase==="before"){
			const entry=source.beforeAt(s.scope,s.sourceId,s.account,s.index);
			if(!entry||!ID.test(entry.id)||!Number.isSafeInteger(entry.added))throw new Error("Missing or invalid recheck record");
			const settled=source.isSettled(s.scope,s.sourceId,s.account,entry.id);if(typeof settled!=="boolean")throw new Error("Missing settled membership");
			if(settled)s.changed=true;else value={id:entry.id,added:entry.added};
		}else{
			const id=source.estimatedAt(s.scope,s.sourceId,s.account,s.index);
			if(!id||!ID.test(id))throw new Error("Missing or invalid estimated record");
			const known=source.inBefore(s.scope,s.sourceId,s.account,id);if(typeof known!=="boolean")throw new Error("Missing before membership");
			if(!known){value={id,added:s.now};s.changed=true;}
		}
		if(value){chunk+=(s.emitted?",":"")+JSON.stringify(value);s.emitted++;}
		s.index++;s.processed++;processed++;
	}
	if(s.phase==="done")chunk+="]";
	if(new TextEncoder().encode(chunk).byteLength>RECHECK_PROJECTION_LIMITS.bytesPerPage||source.current(s.scope,s.sourceId)!==true)throw new Error("Recheck projection exceeded limit or became stale");
	const final:RecheckProjectionFinal|null=s.phase!=="done"?null:!s.present||(!s.changed&&!s.emitted)?{kind:"noop"}:s.emitted?{kind:"put",expirationTtl:RECHECK_PROJECTION_TTL}:{kind:"delete"};
	return {checkpoint:s,chunk,final};
}
