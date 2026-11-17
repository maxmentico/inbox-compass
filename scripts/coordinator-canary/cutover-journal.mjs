// Synthetic local workerd. No remote resource, mailbox, secret, KV binding or external proof.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const directory = await mkdtemp(join(tmpdir(), "openinbox-cutover-"));
const root = fileURLToPath(new URL("../../", import.meta.url));
const worker = `
  import {CutoverJournal} from "./src/cutover-journal.ts";
  export class Fixture {
    constructor(state) {this.store=state.storage;this.journal=new CutoverJournal(this.store);}
    async fetch(request) {
      const cmd=new URL(request.url).pathname.slice(1);
      const args=await request.json();
      if(cmd==="drained")return Response.json(this.store.transactionSync(()=>this.journal.drainedInTransaction(this.store.sql,...args)));
      if(cmd==="break"){
        this.store.sql.exec("CREATE TRIGGER interrupt_freeze BEFORE UPDATE OF freeze_id ON cutover_control WHEN NEW.freeze_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'test rollback'); END");
        return Response.json(true);
      }
      if(cmd==="restore"){this.store.sql.exec("DROP TRIGGER interrupt_freeze");return Response.json(true);}
      if(!["status","admit","start","cancel","applied","uncertain","freeze","page","reopenLegacy"].includes(cmd))return new Response(null,{status:404});
      try{return Response.json(this.journal[cmd](...args));}catch(error){return Response.json({error:error.message},{status:409});}
    }
  }
  export default {fetch(req,env){return env.FIXTURE.get(env.FIXTURE.idFromName("private-fixture")).fetch(req);}};
`;
let runtime;
const cmd = async (op, ...args) => {
  const result=await runtime.dispatchFetch("https://invented.invalid/"+op,{method:"POST",body:JSON.stringify(args)});
  const content=await result.json();
  if (!result.ok) throw Error(content.error);
  return content;
};
const hash1="a".repeat(64),hash2="b".repeat(64);
try {
  const bundle=await build({stdin:{contents:worker,resolveDir:resolve(root)},bundle:true,write:false,format:"esm",target:"es2022"});
  const options={...convertV4MiniflareOptions({modules:true,script:bundle.outputFiles[0].text,compatibilityDate:"2026-10-01",durableObjects:{FIXTURE:{className:"Fixture",useSQLite:true}}}),resourcePersistencePath:directory};
  runtime=new Miniflare(options);
  const op=randomUUID(), duplicateOwners=[randomUUID(),randomUUID()], freezeId=randomUUID();
  const receipts=await Promise.all(duplicateOwners.map(owner=>cmd("admit",1,op,owner,"settings",hash1)));
  const accepted=receipts.findIndex(r=>r.kind==="admitted");
  assert.equal(receipts.filter(r=>r.kind==="admitted").length,1);
  const owner=duplicateOwners[accepted], loser=duplicateOwners[1-accepted];
  assert.equal(await cmd("start",op,loser),false);
  assert.equal(await cmd("start",op,owner),true);
  assert.equal(await cmd("start",op,owner),false);
  assert.deepEqual(await cmd("admit",1,op,owner,"done",hash1),{kind:"conflict"});
  const cancelled=randomUUID(),cancelOwner=randomUUID();
  assert.equal((await cmd("admit",1,cancelled,cancelOwner,"job",hash2)).seq,2);
  assert.equal(await cmd("cancel",cancelled,cancelOwner),true);
  assert.equal(await cmd("start",cancelled,cancelOwner),false);
  await cmd("break");
  await assert.rejects(cmd("freeze",1,freezeId),/test rollback/);
  assert.equal((await cmd("status")).frozen,false);
  await cmd("restore");
  const late=randomUUID(),lateOwner=randomUUID();
  const [f,race]=await Promise.all([cmd("freeze",1,freezeId),cmd("admit",1,late,lateOwner,"index",hash1)]);
  assert.deepEqual(f,{epoch:1,id:freezeId,highWater:race.kind==="admitted"?3:2});
  if(race.kind==="admitted") assert.equal(await cmd("cancel",late,lateOwner),true);
  else assert.equal(race.kind,"closed");
  assert.deepEqual(await cmd("freeze",1,freezeId),f);
  assert.equal(await cmd("freeze",1,randomUUID()),null);
  assert.equal(await cmd("cancel",op,owner),false);
  assert.equal(await cmd("uncertain",op,owner),true);
  assert.equal(await cmd("drained",f),false);
  assert.equal(await cmd("page",f,0,2),null);
  assert.equal(await cmd("reopenLegacy",f),null);
  await runtime.dispose();runtime=new Miniflare(options);
  assert.deepEqual(await cmd("status"),{epoch:1,frozen:true,highWater:f.highWater,outstanding:true});
  assert.equal((await cmd("admit",1,op,loser,"settings",hash1)).phase,"uncertain");
  assert.equal(await cmd("applied",op,loser,hash2),false);
  assert.equal(await cmd("applied",op,owner,hash2),true);
  assert.equal(await cmd("applied",op,owner,hash2),true);
  assert.equal(await cmd("applied",op,owner,hash1),false);
  assert.equal(await cmd("drained",{...f,highWater:f.highWater-1}),false);
  assert.equal(await cmd("drained",f),true);
  let after=0;const entries=[];
  do { const page=await cmd("page",f,after,1);entries.push(...page.entries);after=page.next; } while(after!==null);
  assert.equal(entries.length,f.highWater);
  assert.deepEqual(entries.map(r=>r.seq),Array.from({length:f.highWater},(_,i)=>i+1));
  assert.equal(entries[0].result,hash2);
  assert.equal(Object.hasOwn(entries[0],"owner"),false);
  assert.equal(await cmd("reopenLegacy",f),2);
  assert.equal(await cmd("drained",f),false);
  assert.equal(await cmd("page",f,0,1),null);
  assert.equal((await cmd("admit",1,randomUUID(),randomUUID(),"account",hash1)).kind,"closed");
  assert.equal((await cmd("admit",2,randomUUID(),randomUUID(),"account",hash1)).seq,f.highWater+1);
  console.log("Cutover journal passed in local workerd: concurrent admission, frozen high-water mark, restart, replay, rollback and unresolved-write fences.");
} finally { if(runtime)await runtime.dispose();await rm(directory,{recursive:true,force:true}); }
