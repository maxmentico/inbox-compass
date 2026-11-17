// SYNTHETIC, UNWIRED coordinator-owned reference stream. The projector must be statically trusted
// independent code that reads verified captured input, never the producer's candidate output. No
// complete projector, account/retention integration, authentication boundary or production wiring
// exists. A caller can ask for the next page but cannot submit the page's bytes.
const TOKEN=/^[A-Za-z0-9_-]{22,128}$/,HASH=/^[a-f0-9]{64}$/;
const PAGE_BYTES=64*1024, MAX_PAGES=512, MAX_TOTAL=32*1024*1024;
export type ReferenceContext={id:string;job:string;generation:string;attempt:string;sourceId:string;sourceScope:string;previousHead:string|null;versions:{key:string;version:number}[]};
/** Same-transaction validation of the pinned source proof, finalizer, head and revision vector. */
export type ReferenceAuthorization=(sql:SqlStorage,context:Readonly<ReferenceContext>)=>boolean;
export interface IndependentPageProjector {
 /** Must deterministically derive its next bounded page from the captured source, never candidate bytes. */
 next(context:Readonly<ReferenceContext>,cursor:string|null):Promise<{bytes:Uint8Array;nextCursor:string|null;complete:boolean}>;
}
type Row={context:string;cursor:string|null;next_page:number;bytes:number;complete:number};
export class TrustedReferenceStore {
 private readonly sql:SqlStorage;
 constructor(private readonly storage:DurableObjectStorage,private readonly authorize?:ReferenceAuthorization,private readonly projector?:IndependentPageProjector){
  this.sql=storage.sql;
  this.sql.exec('CREATE TABLE IF NOT EXISTS trusted_reference (id TEXT PRIMARY KEY,context TEXT NOT NULL,cursor TEXT,next_page INTEGER NOT NULL,bytes INTEGER NOT NULL,complete INTEGER NOT NULL)');
  this.sql.exec('CREATE TABLE IF NOT EXISTS trusted_reference_pages (id TEXT NOT NULL,page INTEGER NOT NULL,hash TEXT NOT NULL,bytes INTEGER NOT NULL,data BLOB NOT NULL,PRIMARY KEY(id,page))');
 }
 private row(id:string):Row|undefined{return this.sql.exec<Row>('SELECT context,cursor,next_page,bytes,complete FROM trusted_reference WHERE id=?',id).toArray()[0];}
 private permitted(context:ReferenceContext):boolean{return !!this.authorize&&this.authorize(this.sql,context)===true;}
 begin(input:ReferenceContext):boolean{
  if(!input||![input.id,input.job,input.generation,input.attempt,input.sourceScope].every(v=>typeof v==='string'&&TOKEN.test(v))||!HASH.test(input.sourceId)||(input.previousHead!==null&&!TOKEN.test(input.previousHead))||!Array.isArray(input.versions)||input.versions.length>52)return false;
  const seen=new Set<string>();for(const v of input.versions){if(!v||typeof v.key!=='string'||!v.key.length||v.key.length>256||seen.has(v.key)||!Number.isSafeInteger(v.version)||v.version<0)return false;seen.add(v.key);}
  const context:ReferenceContext={id:input.id,job:input.job,generation:input.generation,attempt:input.attempt,sourceId:input.sourceId,sourceScope:input.sourceScope,previousHead:input.previousHead,versions:input.versions.map(v=>({key:v.key,version:v.version})).sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0)};
  const encoded=JSON.stringify(context);
  return this.storage.transactionSync(()=>{
   if(!this.projector||!this.permitted(context))return false;
   const prior=this.row(context.id);if(prior)return prior.context===encoded;
   this.sql.exec('INSERT INTO trusted_reference VALUES (?,?,NULL,0,0,0)',context.id,encoded);return true;
  });
 }
 /** No caller bytes accepted. False/null means a stale checkpoint, invalid source, or limit. */
 async advance(id:string,expectedPage:number):Promise<{next:number;complete:boolean}|null>{
  if(!TOKEN.test(id)||!Number.isSafeInteger(expectedPage)||expectedPage<0||expectedPage>=MAX_PAGES||!this.projector)return null;
  const before=this.storage.transactionSync(()=>{
   const row=this.row(id);if(!row||row.complete||row.next_page!==expectedPage)return null;
   const context=JSON.parse(row.context) as ReferenceContext;if(!this.permitted(context))return null;return {row,context};
  });
  if(!before)return null;
  const result=await this.projector.next(structuredClone(before.context),before.row.cursor);
  if(!result||!(result.bytes instanceof Uint8Array)||result.bytes.length<1||result.bytes.length>PAGE_BYTES||typeof result.complete!=='boolean'||(result.nextCursor!==null&&(typeof result.nextCursor!=='string'||result.nextCursor.length>1024))||result.complete!==(result.nextCursor===null)||(!result.complete&&result.nextCursor===before.row.cursor))return null;
  const data=new Uint8Array(result.bytes);
  const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',data.buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
  return this.storage.transactionSync(()=>{
   const current=this.row(id);if(!current||current.complete||current.next_page!==expectedPage||current.cursor!==before.row.cursor||current.context!==before.row.context||!this.permitted(before.context)||current.bytes+data.length>MAX_TOTAL)return null;
   this.sql.exec('INSERT INTO trusted_reference_pages (id,page,hash,bytes,data) VALUES (?,?,?,?,?)',id,expectedPage,digest,data.length,data.buffer);
   this.sql.exec('UPDATE trusted_reference SET cursor=?,next_page=next_page+1,bytes=bytes+?,complete=? WHERE id=?',result.nextCursor,data.length,result.complete?1:0,id);
   return {next:expectedPage+1,complete:result.complete};
  });
 }
 /** Same-transaction metadata accessor for the independent comparator; never trust producer progress. */
 statusInTransaction(sql:SqlStorage,id:string):{context:ReferenceContext;pages:number;bytes:number;complete:boolean}|null{
  if(sql!==this.sql)return null;const row=this.row(id);if(!row)return null;const context=JSON.parse(row.context) as ReferenceContext;
  return this.permitted(context)?{context,pages:row.next_page,bytes:row.bytes,complete:row.complete===1}:null;
 }
 async read(id:string,page:number):Promise<Uint8Array|null>{
  if(!TOKEN.test(id)||!Number.isSafeInteger(page)||page<0||page>=MAX_PAGES)return null;
  const selected=this.storage.transactionSync(()=>{
   const status=this.statusInTransaction(this.sql,id);if(!status||!status.complete||page>=status.pages)return null;
   const part=this.sql.exec<{hash:string;bytes:number;data:ArrayBuffer}>('SELECT hash,bytes,data FROM trusted_reference_pages WHERE id=? AND page=?',id,page).toArray()[0];
   if(!part)throw new Error('missing trusted reference page');return {context:JSON.stringify(status.context),part};
  });
  if(!selected)return null;
  const data=new Uint8Array(selected.part.data),digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(data).buffer))].map(b=>b.toString(16).padStart(2,'0')).join('');
  if(data.length!==selected.part.bytes||digest!==selected.part.hash)throw new Error('corrupt trusted reference page');
  const still=this.storage.transactionSync(()=>{const status=this.statusInTransaction(this.sql,id);return !!status&&status.complete&&JSON.stringify(status.context)===selected.context;});
  return still?data:null;
 }
}
