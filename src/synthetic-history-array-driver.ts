// SYNTHETIC / UNWIRED. Authenticated history JSON array -> provisional record pages. These records
// are not yet domain validated, redacted, merged or suitable for publication. No real mail.
import { type JsonEvent,type JsonStreamCheckpoint,startSyntheticJsonStream,pushSyntheticJsonFragment,finishSyntheticJsonStream } from './synthetic-stream-json';
import { type ArrayExtractState,startArrayExtraction,extractArrayEvents,finishArrayExtraction } from './synthetic-array-extractor';
import { SyntheticTrustedInputStream } from './synthetic-trusted-input-stream';
const ID=/^[A-Za-z0-9_-]{22,128}$/,HASH=/^[a-f0-9]{64}$/,KEY=/^history:[a-z0-9][a-z0-9-]{0,31}$/;
type State={scope:string;attempt:string;sourceId:string;key:string;seq:number;chunkIndex:number;offset:number;byteBudget:number;recordBudget:number;parser:JsonStreamCheckpoint;extractor:ArrayExtractState;pending:JsonEvent[];inputEnded:boolean;done:boolean;records:number};
type Row={id:string;revision:number;state:string};
export class SyntheticHistoryArrayDriver{
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly stream:SyntheticTrustedInputStream){this.sql=storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_history_driver (id TEXT PRIMARY KEY,revision INTEGER NOT NULL,state TEXT NOT NULL)');this.sql.exec('CREATE TABLE IF NOT EXISTS synthetic_history_driver_page (id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(id,revision))');}
 private row(id:string):Row|undefined{return this.sql.exec<Row>('SELECT * FROM synthetic_history_driver WHERE id=?',id).toArray()[0];}
 start(id:string,scope:string,attempt:string,sourceId:string,key:string,seq:number,byteBudget=16384,recordBudget=16):boolean{
  if(!ID.test(id)||!ID.test(scope)||!ID.test(attempt)||!HASH.test(sourceId)||!KEY.test(key)||!Number.isSafeInteger(seq)||seq<0||![16384,32768,65536].includes(byteBudget)||![16,32].includes(recordBudget))return false;
  return this.storage.transactionSync(()=>{
   if(this.row(id)||!this.stream.infoInTransaction(this.sql,scope,attempt,sourceId))return false;
   const first=this.stream.readInTransaction(this.sql,scope,attempt,seq);if(!first||first.descriptor.kind!=='state'||first.descriptor.key!==key||first.descriptor.index!==0)return false;
   const s:State={scope,attempt,sourceId,key,seq,chunkIndex:0,offset:0,byteBudget,recordBudget,parser:startSyntheticJsonStream(sourceId,scope),extractor:startArrayExtraction(sourceId,scope),pending:[],inputEnded:false,done:false,records:0};
   this.sql.exec('INSERT INTO synthetic_history_driver VALUES (?,0,?)',id,JSON.stringify(s));return true;
  });
 }
 /** Each step consumes at most its explicit 16–64 KiB budget or 512 events and stages at most 32 records. */
 step(id:string,revision:number):{revision:number;done:boolean;records:number}|null{
  if(!ID.test(id)||!Number.isSafeInteger(revision)||revision<0)return null;
  return this.storage.transactionSync(()=>{
   const row=this.row(id);if(!row||row.revision!==revision)return null;let s:State;
   try{s=JSON.parse(row.state) as State;}catch{return null;}
   const info=this.stream.infoInTransaction(this.sql,s.scope,s.attempt,s.sourceId);if(!info||s.done)return null;
   if(!s.pending.length&&!s.inputEnded){
    const chunk=s.seq<info.count?this.stream.readInTransaction(this.sql,s.scope,s.attempt,s.seq):null;
    if(s.seq<info.count&&!chunk)return null;
    if(!chunk||chunk.descriptor.kind!=='state'||chunk.descriptor.key!==s.key){
     const result=finishSyntheticJsonStream(s.parser,s.sourceId,s.scope);s.parser=result.checkpoint;s.pending=result.events;s.inputEnded=true;
    }else{
     if(chunk.descriptor.index!==s.chunkIndex)return null;
     if(![16384,32768,65536].includes(s.byteBudget))return null;
     const result=pushSyntheticJsonFragment(s.parser,s.sourceId,s.scope,chunk.bytes,s.offset,{bytesPerCall:s.byteBudget,eventsPerCall:512});s.parser=result.checkpoint;s.pending=result.events;s.offset=result.nextOffset;
     if(s.offset===chunk.bytes.length){s.seq++;s.chunkIndex++;s.offset=0;}
    }
   }
   let records:unknown[]=[];
   if(s.pending.length){if(![16,32].includes(s.recordBudget))return null;const page=extractArrayEvents(s.extractor,s.sourceId,s.scope,s.extractor.nextEvent,s.pending,s.recordBudget);s.extractor=page.state;s.pending=s.pending.slice(page.consumed);records=page.records;s.records+=records.length;if(s.records>20000)throw Error('History record cap exceeded');}
   if(s.inputEnded&&!s.pending.length){finishArrayExtraction(s.extractor,s.sourceId,s.scope);s.done=true;}
   const state=JSON.stringify(s),payload=JSON.stringify(records),enc=new TextEncoder();if(enc.encode(state).length>512*1024||enc.encode(payload).length>512*1024)throw Error('History page cap exceeded');
   if(!this.stream.infoInTransaction(this.sql,s.scope,s.attempt,s.sourceId))return null;
   this.sql.exec('INSERT INTO synthetic_history_driver_page VALUES (?,?,?)',id,revision,payload);this.sql.exec('UPDATE synthetic_history_driver SET revision=?,state=? WHERE id=? AND revision=?',revision+1,state,id,revision);
   return {revision:revision+1,done:s.done,records:s.records};
  });
 }
 readPage(id:string,revision:number):unknown[]|null{return this.storage.transactionSync(()=>{const row=this.row(id);if(!row)return null;const s=JSON.parse(row.state) as State;if(!s.done||!this.stream.infoInTransaction(this.sql,s.scope,s.attempt,s.sourceId))return null;const page=this.sql.exec<{payload:string}>('SELECT payload FROM synthetic_history_driver_page WHERE id=? AND revision=?',id,revision).toArray()[0];if(!page)return null;try{return JSON.parse(page.payload) as unknown[];}catch{return null;}});}
}
