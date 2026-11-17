// SYNTHETIC ONLY: bounded extraction of top-level array elements from verified JSON events.
import type { JsonEvent } from './synthetic-stream-json';
type Frame={value:unknown[]|Record<string,unknown>;key:string|null};
export type ArrayExtractState={sourceId:string;scope:string;nextEvent:number;started:boolean;done:boolean;frames:Frame[];captureBytes:number};
const ID=/^[A-Za-z0-9_-]{22,128}$/, HASH=/^[a-f0-9]{64}$/;
const enc=new TextEncoder();
export function startArrayExtraction(sourceId:string,scope:string):ArrayExtractState{if(!HASH.test(sourceId)||!ID.test(scope))throw Error('Invalid source');return {sourceId,scope,nextEvent:0,started:false,done:false,frames:[],captureBytes:0};}
function attach(f:Frame,value:unknown){if(Array.isArray(f.value))f.value.push(value);else{if(f.key===null)throw Error('Missing object key');Object.defineProperty(f.value,f.key,{value,writable:true,enumerable:true,configurable:true});f.key=null;}}
/** Caller persists state, consumed events and resulting records atomically. */
export function extractArrayEvents(state:ArrayExtractState,sourceId:string,scope:string,expected:number,events:readonly JsonEvent[],maxRecords=16):{state:ArrayExtractState;consumed:number;records:unknown[]}{
 if(!state||state.sourceId!==sourceId||state.scope!==scope||state.nextEvent!==expected||!Array.isArray(events)||events.length>512)throw Error('Invalid array checkpoint');
 if(!Number.isSafeInteger(maxRecords)||maxRecords<1||maxRecords>32)throw Error('Invalid array record budget');
 const s=structuredClone(state),records:unknown[]=[];let consumed=0;
 for(const e of events){
  if(records.length===maxRecords)break;
  if(s.done)throw Error('Extra array input');
  if(!s.started){if(e.type!=='array-start')throw Error('Expected array');s.started=true;}
  else if(s.frames.length){
   s.captureBytes+=enc.encode(JSON.stringify(e)).length;if(s.captureBytes>16384)throw Error('Array record exceeds limit');
   const top=s.frames.at(-1)!;
   if(e.type==='key'){if(Array.isArray(top.value)||top.key!==null)throw Error('Invalid array object key');top.key=e.value;}
   else if(e.type==='object-start'||e.type==='array-start'){if(s.frames.length>=64)throw Error('Array depth exceeded');s.frames.push({value:e.type==='object-start'?{}:[],key:null});}
   else if(e.type==='object-end'||e.type==='array-end'){
    const frame=s.frames.pop()!;if(frame.key!==null||(e.type==='array-end')!==Array.isArray(frame.value))throw Error('Invalid array record');
    if(s.frames.length)attach(s.frames.at(-1)!,frame.value);else{records.push(frame.value);s.captureBytes=0;}
   }else if(e.type==='value')attach(top,e.value);else throw Error('Invalid array event');
  }else if(e.type==='array-end')s.done=true;
  else if(e.type==='object-start'||e.type==='array-start'){s.captureBytes=enc.encode(JSON.stringify(e)).length;s.frames.push({value:e.type==='object-start'?{}:[],key:null});}
  else if(e.type==='value'){if(enc.encode(JSON.stringify(e)).length>16384)throw Error('Array record exceeds limit');records.push(e.value);}
  else throw Error('Invalid array element');
  s.nextEvent++;consumed++;
 }
 return {state:s,consumed,records};
}
export function finishArrayExtraction(s:ArrayExtractState,sourceId:string,scope:string):void{if(s.sourceId!==sourceId||s.scope!==scope||!s.started||!s.done||s.frames.length)throw Error('Incomplete array');}
