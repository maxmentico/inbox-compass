// Local-only fixed scenarios. Synthetic authorizers accept the invented publications in this test.
import { SegmentedGeneration } from "../../src/segmented-generation";
import { SegmentedOutputStore } from "../../src/segmented-output-store";
import { SyntheticSegmentInventory } from "../../src/synthetic-segment-inventory";
import { JobStateCore } from "../../src/job-state-core";
const token = () => crypto.randomUUID();
const encoder = new TextEncoder(), decoder = new TextDecoder();
function check(ok: unknown, label: string): asserts ok { if (!ok) throw new Error(label); }
type Operation = { key: string; value?: string; expiresAt?: number; metadata?: { arrived: number } };
export class CompactionFixture {
  constructor(private state: DurableObjectState) {}
  async fetch(request: Request) {
    const storage = this.state.storage, sql = storage.sql;
    const store = new SegmentedOutputStore(storage, () => true);
    const gen = new SegmentedGeneration(storage, () => true, () => true);
    const core = new JobStateCore(storage, gen.atomicCommit());
    const compact = gen.compaction;
    let authorized = true;
    const sourceId="f".repeat(64);
    const inventory=new SyntheticSegmentInventory(storage,(_sql,_head,source)=>authorized && source===sourceId);
    async function enumerate(head:string,capturedAt=Date.now()) {
      const pin=compact.pin(head), scope=token();
      check(pin && inventory.begin(scope,head,sourceId,pin,capturedAt),"authenticated inventory begin");
      let revision=0;
      while(true){
        const page=await inventory.next(scope,revision);
        check(page,"authenticated inventory chunk");
        revision=page.revision;
        if(page.complete)break;
      }
      const entries:NonNullable<ReturnType<typeof inventory.page>>["entries"]=[];
      let next:number|null=0;
      while(next!==null){
        const page=inventory.page(scope,next,8);
        check(page,"authenticated inventory page");
        entries.push(...page.entries);
        next=page.next;
      }
      return {entries,scope,pin,capturedAt};
    }
    async function stage(ops: Operation[]) {
      const job = token(), generation = token(), attempt = token(), scope = token(), sourceId = "a".repeat(64);
      const previous = gen.head(), digest = "test-" + job;
      const bytes = encoder.encode(ops.map(op => op.value ?? "").join(""));
      check(core.create({ job, generation, driver: "web", mailboxes: [] }).ok, "create");
      check(core.claimFinal(job, generation, attempt), "claim");
      check(store.begin(scope, job, generation, attempt, sourceId), "transport begin");
      for (let i = 0; i * 65536 < bytes.length; i++) {
        check(await store.append(scope, attempt, i, bytes.slice(i * 65536, (i + 1) * 65536)) === "staged", "append");
      }
      check(store.seal(scope, attempt, Math.ceil(bytes.length / 65536), bytes.length), "seal bytes");
      check(gen.begin({ job, generation, scope, attempt, sourceId, previous, digest, versions: [], totalOps: ops.length, totalBytes: bytes.length }), "index begin");
      for (let i = 0; i * 16 < ops.length; i++) {
        const page = ops.slice(i * 16, (i + 1) * 16).map(op => ({
          key: op.key, kind: op.value === undefined ? "delete" as const : "put" as const,
          bytes: encoder.encode(op.value ?? "").length, expiresAt: op.expiresAt, metadata: op.metadata,
        }));
        check(await gen.indexPage(scope, attempt, i, page), "index page");
      }
      check(gen.sealIndex(scope, attempt), "seal index");
      return { scope, job, generation, attempt, digest };
    }
    const finish = (x: Awaited<ReturnType<typeof stage>>) => core.finalize(x.job, x.generation, x.attempt, x.digest, x.scope);
    const text = async (head: string, key: string, pin?: string) => {
      let offset = 0, out = "";
      for (;;) {
        const r = await gen.read(head, key, offset, pin);
        if (r.kind !== "value") return r.kind;
        out += decoder.decode(r.bytes);
        if (r.next === null) return out;
        offset = r.next;
      }
    };
    const compactAll = (head: string, start = 0) => {
      let cursor = start;
      for (;;) {
        const p = compact.step(head, cursor);
        check(p, "compaction checkpoint");
        if (p.complete) return;
        check(p.revision > cursor, "compaction progress");
        cursor = p.revision;
      }
    };
    async function mustRejectBeforeExpiryTombstone(scope:string) {
      let revision=0;
      for(let i=0;i<64;i++){
        const p=await inventory.next(scope,revision);
        if(!p){
          const before=sql.exec<{key:string}>("SELECT key FROM sinv_entries WHERE scope=? ORDER BY ordinal DESC LIMIT 1",scope).toArray()[0];
          check(before && before.key==="replace","inventory stopped at the first unvisited key that expired after capture");
          check(!sql.exec("SELECT ordinal FROM sinv_entries WHERE scope=? AND key='timed'",scope).toArray().length,"expired live key was never certified as a tombstone");
          check(inventory.page(scope,0,1)===null,"incomplete inventory is unreadable");
          return;
        }
        check(!p.complete,"inventory wrongly completed after a live-at-capture expiry");
        revision=p.revision;
      }
      throw new Error("inventory did not encounter test expiry");
    }
    const table = "CREATE TABLE IF NOT EXISTS fixture_state (id INTEGER PRIMARY KEY, value TEXT NOT NULL)";
    sql.exec(table);
    if (new URL(request.url).pathname === "/seed") {
      const nearExpiry=Date.now()+120000;
      const initial = await stage([{key:"keep",value:"stored",metadata:{arrived:17}}, {key:"toDelete",value:"old"}, {key:"expired",value:"old"}, {key:"empty",value:""}, {key:"timed",value:"alive",expiresAt:nearExpiry}, {key:"keepBig",value:"x".repeat(65540)}]);
      check(finish(initial), "seed");
      const obsolete = await stage([{key:"replace",value:"z".repeat(17*65536+4)}]);
      check(finish(obsolete), "obsolete");
      const pin = compact.pin(obsolete.scope);
      check(pin, "pin obsolete");
      let current = "";
      for (let i=0;i<14;i++) {
        const ops: Operation[] = [{key:"replace",value:"new-"+i}];
        if (i===13) {
          ops.push({key:"toDelete"}, {key:"expired",value:"lapsed",expiresAt:1});
          for(let j=0;j<24;j++) ops.push({key:"filler-"+j,value:"tag-"+j});
        }
        const next = await stage(ops);
        check(finish(next), "publish overlay");
        current = next.scope;
      }
      const pending = await stage([{key:"more",value:"seventeenth"}]);
      let blocked = false;
      try { finish(pending); } catch (error) { blocked = String(error).includes("compaction required"); }
      check(blocked && gen.head()===current, "depth boundary before compaction");
      const p = compact.step(current, 0);
      check(p && !p.complete, "paging");
      check(compact.step(current, 0)?.revision === p.revision, "duplicate checkpoint");
      sql.exec("INSERT INTO fixture_state VALUES (1,?)", JSON.stringify({initial:initial.scope, obsolete:obsolete.scope, job:obsolete.job, current, pending, pin, nearExpiry, revision:p.revision}));
      return Response.json({seed:true});
    }
    const encoded=sql.exec<{value:string}>("SELECT value FROM fixture_state WHERE id=1").toArray()[0]?.value;
    check(encoded, "fixture state after restart");
    const data = JSON.parse(encoded);
    if(new URL(request.url).pathname === "/expiry"){
      const saved=JSON.parse(sql.exec<{value:string}>("SELECT value FROM fixture_state WHERE id=2").toArray()[0]!.value);
      const head=data.pending.scope,realNow=Date.now;
      try{
        Date.now=()=>data.nearExpiry;
        check(!inventory.begin(saved.pendingFlat,head,sourceId,saved.pin,data.nearExpiry),"cannot move capture timestamp on replay");
        await mustRejectBeforeExpiryTombstone(saved.pendingOverlay);
        compactAll(head);
        const provenance=sql.exec<{source:string|null;tombstone_expiry:number|null}>("SELECT source,tombstone_expiry FROM seg_flat_keys WHERE head=? AND key='timed'",head).toArray()[0];
        check(provenance?.source===null && provenance.tombstone_expiry===data.nearExpiry,"covering marker retains expiry provenance");
        await mustRejectBeforeExpiryTombstone(saved.pendingFlat);
        const granted=new SyntheticSegmentInventory(storage,(_sql,_head,source,at)=>source===sourceId && at===saved.capturedAt);
        check(!granted.begin(token(),head,sourceId,saved.pin,data.nearExpiry),"cannot substitute unapproved capture time");
        const fresh=await enumerate(head);
        check(fresh.entries.find(e=>e.key==="timed")?.kind==="tombstone","new capture at exact expiry sees tombstone");
        compact.release(fresh.pin);
      }finally{Date.now=realNow;}
      compact.release(saved.pin);
      check(compact.collect(head,data.obsolete,()=>true)==="progress","first cleanup batch");
      return Response.json({expiry:true});
    }
    if (new URL(request.url).pathname === "/gc") {
      const head=data.pending.scope;
      check(gen.head()===head && compact.complete(head),"current head survives GC restart");
      check(sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM seg_parts WHERE scope=?",data.obsolete).toArray()[0]?.n===2,"first batch removed exactly 16 chunks");
      const before=sql.exec<{bytes:number}>("SELECT bytes FROM seg_budget WHERE job=?",data.job).toArray()[0]!.bytes;
      sql.exec("CREATE TRIGGER injected_failure BEFORE DELETE ON seg_parts WHEN OLD.idx=17 BEGIN SELECT RAISE(ABORT,'injected retention failure'); END");
      let failed=false;
      try {compact.collect(head,data.obsolete,()=>true);} catch {failed=true;}
      check(failed && sql.exec<{n:number}>("SELECT COUNT(*) AS n FROM seg_parts WHERE scope=?",data.obsolete).toArray()[0]?.n===2,"partial batch rolled back");
      check(sql.exec<{bytes:number}>("SELECT bytes FROM seg_budget WHERE job=?",data.job).toArray()[0]?.bytes===before,"budget rollback");
      sql.exec("DROP TRIGGER injected_failure");
      let batches=1;
      while(compact.collect(head,data.obsolete,()=>true)==="progress") check(++batches<8,"bounded GC");
      check(compact.collect(head,data.obsolete,()=>true)==="done","GC replay");
      check(sql.exec<{bytes:number}>("SELECT bytes FROM seg_budget WHERE job=?",data.job).toArray()[0]?.bytes===0,"released segment budget");
      check(compact.discardIndex(head,data.current) === "blocked","external index-retention proof required");
      while(compact.discardIndex(head,data.current,()=>true)==="progress") {}
      check(!compact.complete(data.current),"superseded index removed");
      check(await text(head,"replace")==="new-13" && await text(head,"keep")==="stored","read after GC");
      return Response.json({ok:true,generations:17,reclaimBatches:batches});
    }
    const before=await enumerate(data.current);
    const interruptedPin=compact.pin(data.current),interruptedScope=token();
    check(interruptedPin&&inventory.begin(interruptedScope,data.current,sourceId,interruptedPin,Date.now()),"inventory before same-head compaction");
    check(await inventory.next(interruptedScope,0),"first inventory checkpoint");
    compactAll(data.current, data.revision);
    const after=await enumerate(data.current);
    check(JSON.stringify(before.entries)===JSON.stringify(after.entries),"byte-exact source inventory across compaction");
    check(after.entries.filter(e=>e.kind==="tombstone").map(e=>e.key).join(",")==="expired,toDelete","expired and deleted key inventory");
    let partialRevision=1;
    while(true){const p=await inventory.next(interruptedScope,partialRevision);check(p,"resume across compaction");partialRevision=p.revision;if(p.complete)break;}
    check(JSON.stringify(inventory.page(interruptedScope,0,32)?.entries)===JSON.stringify(before.entries),"no omissions across in-place compaction");
    compact.release(interruptedPin);
    compact.release(before.pin);compact.release(after.pin);
    check(await text(data.current,"replace")==="new-13", "most recent overlay wins");
    check(await text(data.current,"toDelete")==="missing" && await text(data.current,"expired")==="missing", "no resurrection");
    check(await text(data.current,"empty")==="", "empty value");
    check(sql.exec("SELECT key FROM seg_flat_keys WHERE head=? AND source IS NULL",data.current).toArray().length===2,"deletion and expiry markers survive compaction without retaining value blobs");
    const meta=await gen.read(data.current, "keep", 0);
    check(meta.kind==="value" && (meta.metadata as {arrived:number}).arrived===17, "metadata survives");
    check(finish(data.pending), "generation 17");
    const head=gen.head()!;
    check(compact.step(data.current,0)===null, "stale compaction");
    check(await text(head,"keep")==="stored" && await text(head,"more")==="seventeenth", "older state and new generation coexist");
    check(await text(data.obsolete,"replace")==="changed", "ordinary reader reloads");
    check(await text(data.obsolete,"replace",data.pin)==="z".repeat(17*65536+4), "historical pin survives restart and publication");
    const seventeenth=await enumerate(head);
    const listed=seventeenth.entries;
    const adapters = storage.transactionSync(()=>{
      check(inventory.validInTransaction(sql,seventeenth.scope,head,sourceId,seventeenth.capturedAt),"adapter validity");
      check(!inventory.validInTransaction(sql,seventeenth.scope,head,"b".repeat(64),seventeenth.capturedAt),"unproven context");
      const result:typeof listed=[];
      let cursor:{key:string;index:number}|null=null;
      do{
        const part=inventory.entriesInTransaction(sql,seventeenth.scope,cursor,1);
        check(part,"keyset adapter");
        result.push(...part.entries);
        cursor=part.next;
      }while(cursor);
      return result;
    });
    check(JSON.stringify(adapters)===JSON.stringify(listed),"keyset cursor covers every chunk exactly");
    for(const entry of listed){
      const chunk=storage.transactionSync(()=>inventory.readInTransaction(sql,seventeenth.scope,entry.key,entry.index));
      check(chunk && JSON.stringify(chunk.entry)===JSON.stringify(entry),"point descriptor");
      if(chunk.bytes===null)check(entry.kind==="tombstone","tombstone point read");
      else {
        const digest=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new Uint8Array(chunk.bytes).buffer)),x=>x.toString(16).padStart(2,"0")).join("");
        check(digest===entry.hash,"point byte hash");
      }
    }
    check(listed.length===before.entries.length+1 && listed.some(e=>e.key==="more"),"inventory across seventeenth publication");
    check(JSON.stringify(listed.filter(e=>e.key!=="more"))===JSON.stringify(before.entries),"bounded ancestor enumeration has no omissions");
    authorized=false;
    check(inventory.page(seventeenth.scope,0,1)===null,"revoked inventory source authority");
    authorized=true;
    // Advance only this isolated fixture's clock. The pin still has several minutes left.
    const realNow=Date.now;
    try{
      Date.now=()=>data.nearExpiry;
      check(inventory.page(seventeenth.scope,0,1)===null,"completed inventory invalidated at TTL");
      const fresh=await enumerate(head);
      check(fresh.entries.find(e=>e.key==="timed")?.kind==="tombstone","expired covered value masks older content");
      compact.release(fresh.pin);
    }finally{Date.now=realNow;}
    compact.release(seventeenth.pin);
    const delayedPin=compact.pin(head),capturedAt=Date.now(),pendingOverlay=token(),pendingFlat=token();
    check(delayedPin && inventory.begin(pendingOverlay,head,sourceId,delayedPin,capturedAt) && inventory.begin(pendingFlat,head,sourceId,delayedPin,capturedAt),"capture before expiry for post-restart verification");
    sql.exec("INSERT INTO fixture_state VALUES (2,?)",JSON.stringify({pendingOverlay,pendingFlat,pin:delayedPin,capturedAt}));
    check(compact.collect(head,data.obsolete,()=>true)==="blocked", "live reader prevents GC");
    compact.release(data.pin);
    check(await text(data.obsolete,"replace",data.pin)==="changed", "released pin rejected");
    check(compact.collect(head,data.initial,()=>true)==="blocked", "referenced value protected");
    check(compact.collect(head,head,()=>true)==="blocked", "current head protected");
    check(compact.collect(head,data.obsolete)==="blocked" && compact.collect(head,data.obsolete,()=>false)==="blocked", "external retention proof required");
    const expiring=compact.pin(head);
    check(expiring,"expiry pin");
    sql.exec("UPDATE seg_reader_pins SET expires_at=0 WHERE id=?",expiring);
    check(await text(head,"keep",expiring)==="changed","expired pin cannot resume");
    return Response.json({resume:true});
  }
}
export default { fetch(req:Request, env:{FIXTURE:DurableObjectNamespace}) {
  return env.FIXTURE.get(env.FIXTURE.idFromName("only")).fetch(req);
} };
