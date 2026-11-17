// SYNTHETIC / UNWIRED: incremental proof of coordinator-owned source descriptors and bytes.
// It supports >160 chunks without materializing a snapshot. The returned hash-chain root is not
// a sealed input snapshot or an output semantic certificate; no production caller is bound here.
import type { TrustedAssemblySource, TrustedInventoryEntry } from './trusted-assembly-source';
import type { SyntheticSourceAuthority } from './synthetic-job-bound-stage';
const ID=/^[A-Za-z0-9_-]{22,128}$/,HASH=/^[a-f0-9]{64}$/;
type Row={job:string;generation:string;token:string;cursor:string|null;revision:number;root:string;complete:number};
async function hash(bytes:Uint8Array):Promise<string>{return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new Uint8Array(bytes).buffer))].map(n=>n.toString(16).padStart(2,'0')).join('');}
export class SyntheticLargeSourceProof {
 private sql:SqlStorage;
 constructor(private storage:DurableObjectStorage,private source:TrustedAssemblySource){this.sql=storage.sql;this.sql.exec('CREATE TABLE IF NOT EXISTS large_source_proof (scope TEXT PRIMARY KEY,job TEXT NOT NULL,generation TEXT NOT NULL,token TEXT NOT NULL,cursor TEXT,revision INTEGER NOT NULL,root TEXT NOT NULL,complete INTEGER NOT NULL)');this.sql.exec('CREATE INDEX IF NOT EXISTS large_source_root ON large_source_proof (job,generation,root)');}
 private row(scope:string):Row|undefined{return this.sql.exec<Row>('SELECT job,generation,token,cursor,revision,root,complete FROM large_source_proof WHERE scope=?',scope).toArray()[0];}
 private valid(scope:string,r:Row):boolean{const capture=this.sql.exec<{job:string;generation:string;token:string}>('SELECT job,generation,token FROM trusted_source WHERE scope=?',scope).toArray()[0];return !!capture&&capture.job===r.job&&capture.generation===r.generation&&capture.token===r.token&&this.source.validateInTransaction(this.sql,scope,r.token);}
 begin(scope:string,job:string,generation:string,token:string):boolean{
  if(![scope,job,generation,token].every(v=>typeof v==='string'&&ID.test(v)))return false;
  return this.storage.transactionSync(()=>{const old=this.row(scope);if(old)return old.job===job&&old.generation===generation&&old.token===token&&this.valid(scope,old);const row:Row={job,generation,token,cursor:null,revision:0,root:'0'.repeat(64),complete:0};if(!this.valid(scope,row))return false;this.sql.exec('INSERT INTO large_source_proof VALUES (?,?,?,?,NULL,0,?,0)',scope,job,generation,token,row.root);return true;});
 }
 /** Verify one descriptor and at most 64 KiB of source per checkpoint. */
 async next(scope:string,token:string,revision:number):Promise<{revision:number;complete:boolean;root:string}|null>{
  if(!ID.test(scope)||!ID.test(token)||!Number.isSafeInteger(revision)||revision<0)return null;
  const work=this.storage.transactionSync(()=>{const r=this.row(scope);if(!r||r.token!==token||r.revision!==revision||r.complete||!this.valid(scope,r))return null;const page=this.source.inventoryPageInTransaction(this.sql,scope,token,r.cursor,1);return page?{r,page}:null;});if(!work)return null;
  if(work.page.entries.length>1)return null;const e:TrustedInventoryEntry|undefined=work.page.entries[0];
  if(e){
   if(!Number.isSafeInteger(e.bytes)||e.bytes<0||e.bytes>65536)return null;
   if(e.kind==='partial'){const bytes=this.source.readPartial(scope,token,e.key,e.index);if(!bytes||bytes.length!==e.bytes||!e.hash||await hash(bytes)!==e.hash)return null;}
   else{const actual=this.source.readState(scope,token,e.key,e.index);if(e.kind==='missing'||e.kind==='tombstone'){if(actual.kind!==e.kind||e.bytes!==0||e.hash!==null)return null;}else if(actual.kind!=='value'||JSON.stringify(actual.metadata)!==JSON.stringify(e.metadata)||actual.expiresAt!==e.expiresAt)return null;else if(e.bytes===0){if(actual.bytes!==null||e.hash!==null)return null;}else if(!actual.bytes||actual.bytes.length!==e.bytes||!e.hash||!HASH.test(e.hash)||await hash(actual.bytes)!==e.hash)return null;}
  }
  const root=await hash(new TextEncoder().encode(JSON.stringify([work.r.root,e??null])));
  return this.storage.transactionSync(()=>{const r=this.row(scope);if(!r||JSON.stringify(r)!==JSON.stringify(work.r)||!this.valid(scope,r))return null;const again=this.source.inventoryPageInTransaction(this.sql,scope,token,r.cursor,1);if(JSON.stringify(again)!==JSON.stringify(work.page))return null;const complete=work.page.next===null,cursor=e?.cursor??r.cursor;this.sql.exec('UPDATE large_source_proof SET cursor=?,revision=revision+1,root=?,complete=? WHERE scope=?',cursor,root,complete?1:0,scope);return {revision:revision+1,complete,root};});
 }
 /** The root is internal and valid only while the source head, revisions, pin and TTL remain valid. */
 status(scope:string,token:string):{revision:number;complete:boolean;root:string}|null{return this.storage.transactionSync(()=>{const r=this.row(scope);return r&&r.token===token&&this.valid(scope,r)?{revision:r.revision,complete:!!r.complete,root:r.root}:null;});}
 root(scope:string,token:string):string|null{return this.storage.transactionSync(()=>{const r=this.row(scope);return r&&r.token===token&&r.complete&&this.valid(scope,r)?r.root:null;});}
 /** Direct coordinator-source stage authority; this does not certify output or a snapshot. */
 authority():SyntheticSourceAuthority{return(sql,job,generation,root,versions)=>{
  if(sql!==this.sql||!HASH.test(root))return false;
  const rows=sql.exec<{scope:string}>('SELECT scope FROM large_source_proof WHERE job=? AND generation=? AND root=? AND complete=1 LIMIT 2',job,generation,root).toArray();
  if(rows.length!==1)return false;const scope=rows[0]!.scope,r=this.row(scope);if(!r||!this.valid(scope,r))return false;
  const capture=sql.exec<{payload:string}>('SELECT payload FROM trusted_source WHERE scope=?',scope).toArray()[0];
  try{const have=JSON.parse(capture!.payload).versions as {key:string;version:number}[],want=(JSON.parse(versions) as {key:string;value:number}[]).map(v=>({key:v.key,version:v.value}));const sorted=(v:{key:string;version:number}[])=>[...v].sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);return JSON.stringify(sorted(have))===JSON.stringify(sorted(want));}catch{return false;}
 };}
}
