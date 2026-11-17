// SYNTHETIC / UNWIRED. Transaction-bound legacy previous-run selection. No caller-supplied digest.
// Segmented heads and ambiguous/missing historical indexes fail closed. Genesis is accepted only
// when an authoritative bounded index is empty or an indexed query proves no unexpired digest keys.
const REAL=/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}Z)?$/;
type KeyRow={generation:string;preparation:string;kind:string;expires_at:number|null;chunks:number};
export function readSyntheticPreviousDigestInTransaction(sql:SqlStorage):string|null|undefined{
 try{
  const names=sql.exec<{name:string}>("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('gen_head','gen_key_heads','gen_chunks','sgen_committed')").toArray().map(x=>x.name);
  if(!['gen_head','gen_key_heads','gen_chunks'].every(n=>names.includes(n)))return undefined;
  const head=sql.exec<{generation:string}>('SELECT generation FROM gen_head WHERE singleton=1').toArray()[0];
  if(head&&names.includes('sgen_committed')&&sql.exec('SELECT scope FROM sgen_committed WHERE scope=?',head.generation).toArray().length)return undefined;
  const now=Date.now();
  const row=(key:string)=>sql.exec<KeyRow>('SELECT generation,preparation,kind,expires_at,chunks FROM gen_key_heads WHERE key=?',key).toArray()[0];
  const live=(r:KeyRow|undefined)=>!!r&&r.kind==='put'&&(r.expires_at===null||r.expires_at>now);
  const read=(key:string,maxBytes:number):string|undefined=>{
   const r=row(key);if(!live(r)||!r||!head||!Number.isSafeInteger(r.chunks)||r.chunks<1||r.chunks>4)return undefined;
   const parts=sql.exec<{idx:number;bytes:number;data:string}>('SELECT idx,bytes,data FROM gen_chunks WHERE generation=? AND preparation=? AND key=? ORDER BY idx',r.generation,r.preparation,key).toArray();
   if(parts.length!==r.chunks)return undefined;let out='';
   for(let i=0;i<parts.length;i++){const p=parts[i]!;if(p.idx!==i||!Number.isSafeInteger(p.bytes)||p.bytes<1||p.bytes>65536||out.length+p.bytes>maxBytes||typeof p.data!=='string')return undefined;const v=atob(p.data);if(v.length!==p.bytes)return undefined;out+=v;}
   return out;
  };
  const exists=(id:string):boolean=>{
   const r=row(`digest:${id}`);if(!live(r)||!r||!head||!Number.isSafeInteger(r.chunks)||r.chunks<1||r.chunks>160)return false;
   const s=sql.exec<{n:number;min:number;max:number}>('SELECT COUNT(*) AS n,MIN(idx) AS min,MAX(idx) AS max FROM gen_chunks WHERE generation=? AND preparation=? AND key=?',r.generation,r.preparation,`digest:${id}`).toArray()[0];
   return !!s&&s.n===r.chunks&&s.min===0&&s.max===r.chunks-1;
  };
  const pointer=read('last-run',32);
  if(pointer!==undefined&&REAL.test(pointer)&&exists(pointer))return pointer;
  const indexRow=row('runs-index');
  if(!live(indexRow)){
   // A missing index normally triggers a digest-key listing. Only the provably empty case is safe.
   return sql.exec("SELECT key FROM gen_key_heads WHERE key>=? AND key<? AND kind='put' AND (expires_at IS NULL OR expires_at>?) LIMIT 1",'digest:','digest;',now).toArray().length?undefined:null;
  }
  const encoded=read('runs-index',65536);if(encoded===undefined)return undefined;
  const list:unknown=JSON.parse(encoded);if(!Array.isArray(list)||list.length>1030||list.some(v=>typeof v!=='string'||v.length>128))return undefined;
  const first=list.find((v:string)=>!v.endsWith('-test')) as string|undefined;
  if(first===undefined)return null;
  // Production takes the first non-test index entry even if its digest is gone. Failing closed in
  // that case prevents silently selecting a different previous run until fallback parity is agreed.
  return REAL.test(first)&&exists(first)?first:undefined;
 }catch{return undefined;}
}
