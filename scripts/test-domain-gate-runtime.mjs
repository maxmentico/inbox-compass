// Synthetic-only local runtime test. The authority here is a fixed stub, not the real projector.
import {strict as assert} from 'node:assert';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const dir=await mkdtemp(join(tmpdir(),'domain-gate-')),port=20000+process.pid%20000,base=`http://127.0.0.1:${port}`,id=()=>randomBytes(16).toString('base64url'),hash=s=>createHash('sha256').update(s).digest('hex');
await writeFile(join(dir,'entry.ts'), `import {JobStateCore} from ${JSON.stringify(resolve('src/job-state-core.ts'))}; import {GenerationStore} from ${JSON.stringify(resolve('src/generation-store.ts'))}; import {DomainGenerationGate} from ${JSON.stringify(resolve('src/domain-generation-gate.ts'))}; import {TrustedAssemblySource} from ${JSON.stringify(resolve('src/trusted-assembly-source.ts'))}; import {OwnerState} from ${JSON.stringify(resolve('src/owner-state.ts'))};
export class DomainTest { constructor(state) { this.sql=state.storage.sql; this.storage=state.storage; new GenerationStore(state.storage); this.gate=new DomainGenerationGate(state.storage,(_sql,m)=>m.changes.some(c=>c.key==='cursor:a' && c.chunks?.[0]?.hash === '${hash('expected-cursor')}')); this.store=new GenerationStore(state.storage,this.gate.verifier()); this.core=new JobStateCore(state.storage,this.store.atomicCommit(),this.gate.jobBinding()); this.noAuthority=new DomainGenerationGate(state.storage); this.source=new TrustedAssemblySource(state.storage,this.gate,{kind:'legacy',authorize:()=>true,previous:()=>null}); this.owner=new OwnerState(state.storage); }
async fetch(req){const op=new URL(req.url).pathname.slice(1),d=await req.json(); let r;
if(op==='expireDone'){this.sql.exec('INSERT INTO owner_done (item,expires_at) VALUES (?,?)','a:synthetic',Date.now());r=true;}
else if(op==='expireJob'){this.sql.exec('UPDATE core_jobs SET expires=? WHERE job=?',Date.now(),d.job);r=true;}
else if(op==='seedState'){for(let i=0;i<500;i++)this.sql.exec("INSERT INTO gen_key_heads (key,generation,preparation,kind,expires_at,metadata,chunks) VALUES (?,?,?,'put',?,?,0)",'cls:box0:m'+String(i).padStart(4,'0'),d.generation,d.preparation,d.expires,JSON.stringify({arrived:i}));this.sql.exec("INSERT INTO gen_key_heads (key,generation,preparation,kind,chunks) VALUES (?,?,?,'put',0)",'digest:2026-01-01T06:30:00Z-test',d.generation,d.preparation);r=true;}
else if(op==='dropRuns'){this.sql.exec("DELETE FROM gen_key_heads WHERE key='runs-index'");r=true;}
else if(op==='digestExpiry'){this.sql.exec("UPDATE gen_key_heads SET expires_at=? WHERE key>=? AND key<?",d.expires,'digest:','digest;');r=true;}
else if(op==='restoreRuns'){this.sql.exec("INSERT INTO gen_key_heads (key,generation,preparation,kind,chunks) VALUES ('runs-index',?,?,'put',1)",d.generation,d.preparation);r=true;}
else if(op==='cleanupDone')r=this.owner.cleanupDone();
// Synthetic seed only: real done mutations require an authenticated current digest.
else if(op==='setDone'){this.storage.transactionSync(()=>{this.sql.exec('INSERT INTO owner_done (item,expires_at) VALUES (?,?)',d.item,Date.now()+86400000);this.sql.exec("UPDATE gen_versions SET version=version+1 WHERE key='done'");});r=true;}
else if(op==='setSettings')r=await this.owner.setSettings(d.value,d.revision);
else if(op==='seedAccount'){this.sql.exec('CREATE TABLE IF NOT EXISTS coordinated_accounts (alias TEXT PRIMARY KEY,value TEXT,purge_pending INTEGER NOT NULL)');this.sql.exec('CREATE TABLE IF NOT EXISTS coordinated_identities (identity TEXT PRIMARY KEY,alias TEXT UNIQUE NOT NULL)');this.sql.exec('INSERT INTO coordinated_accounts VALUES (?,?,0)',d.alias,JSON.stringify({alias:d.alias,email:d.email,sealedRefreshToken:'synthetic-secret-never-return'}));this.sql.exec('INSERT INTO coordinated_identities VALUES (?,?)',d.identity,d.alias);r=true;}
else if(op==='corruptSettings'){this.sql.exec('DELETE FROM owner_settings_hash');r=true;}
else if(op==='account')r=this.gate.changeAccount(d.alias,d.identity);
else if(op==='bump')r=this.gate.bump(d.kind);
else if(op==='create')r=this.core.create(d);
else if(op==='claim')r=this.core.claim(d.job,d.generation,d.token);
else if(op==='fail')r=this.core.fail(d.job,d.generation,d.alias,d.token);
else if(op==='stagePartial')r=await this.core.stage(d.job,d.generation,d.alias,d.token,new TextEncoder().encode(d.data));
else if(op==='accept')r=this.core.accept(d.job,d.generation,d.alias,d.token,d.hash);
else if(op==='captureSource')r=this.source.capture(d.scope,d.job,d.generation,d.token);
else if(op==='describeSource')r=this.source.describe(d.scope,d.token);
else if(op==='inventory')r=this.storage.transactionSync(()=>this.source.inventoryPageInTransaction(this.sql,d.scope,d.token,d.after,d.limit));
else if(op==='sourceEmail')r=this.storage.transactionSync(()=>this.source.accountEmailInTransaction(this.sql,d.scope,d.token,d.alias));
else if(op==='sourcePartial'){const v=this.source.readPartial(d.scope,d.token,d.alias,d.index);r=v?new TextDecoder().decode(v):null;}
else if(op==='sourceState')r=this.source.readState(d.scope,d.token,d.key,d.index);
else if(op==='final')r=this.core.claimFinal(d.job,d.generation,d.token);
else if(op==='capture')r=this.gate.capture(d.job,d.generation);
else if(op==='prepare')r=this.store.prepare(d);
else if(op==='seal')r=this.gate.seal(d.job,d.generation,d.preparation);
else if(op==='noAuthority')r=this.noAuthority.seal(d.job,d.generation,d.preparation);
else if(op==='stage')r=await this.store.stage(d.job,d.generation,d.token,d.preparation,d.key,d.index,new TextEncoder().encode(d.data));
else if(op==='commit')r=this.core.finalize(d.job,d.generation,d.token,d.digest,d.preparation);
else if(op==='head')r=this.store.head();
else return new Response(null,{status:404});return Response.json({r});} }
export default {fetch(req,env){return env.TEST.get(env.TEST.idFromName('singleton')).fetch(req);}};
`);
await writeFile(join(dir,'wrangler.json'),JSON.stringify({name:'synthetic-domain',main:'entry.ts',compatibility_date:'2026-10-01',durable_objects:{bindings:[{name:'TEST',class_name:'DomainTest'}]},migrations:[{tag:'v1',new_sqlite_classes:['DomainTest']}]}));
let child;
async function call(op,body){const r=await fetch(`${base}/${op}`,{method:'POST',body:JSON.stringify(body)});if(!r.ok)throw new Error(`HTTP ${r.status} ${op}`);return (await r.json()).r;}
async function start(){child=spawn(resolve('node_modules/.bin/wrangler'),['dev','--local','--config',join(dir,'wrangler.json'),'--persist-to',join(dir,'state'),'--port',String(port),'--ip','127.0.0.1','--inspector-port','0'],{env:{...process.env,XDG_CONFIG_HOME:dir,WRANGLER_SEND_METRICS:'false'},stdio:['ignore','pipe','pipe']});let out='';child.stdout.on('data',v=>out+=v);child.stderr.on('data',v=>out+=v);for(let i=0;i<150;i++){if(child.exitCode!==null)throw new Error(out);try{await call('head',{});return;}catch{await delay(100);}}throw new Error(out);}
async function stop(){if(!child||child.exitCode!==null)return;const done=new Promise(r=>child.once('exit',r));child.kill('SIGINT');await done;child=undefined;}
try {
 await start(); const identity='a'.repeat(64);assert.equal(await call('account',{alias:'a',identity}),1);
 const job=id(),generation=id(),token=id(),driver='web';
 assert.equal((await call('create',{job,generation,driver,mailboxes:[{alias:'a',identity}]})).ok,true);
 const attempt=id();assert.equal((await call('claim',{job,generation,token:attempt})).kind,'claim');const partial=await call('stagePartial',{job,generation,alias:'a',token:attempt,data:'synthetic accepted partial'});assert.equal(await call('accept',{job,generation,alias:'a',token:attempt,hash:partial}),true);assert.equal(await call('final',{job,generation,token}),true);
 await call('setDone',{item:'a:message',revision:0});
 const scope=id(), captured=await call('captureSource',{scope,job,generation,token});assert.equal(captured.rows[0].partial,partial);assert.equal(await call('sourcePartial',{scope,token,alias:'a',index:0}),'synthetic accepted partial');assert.equal((await call('sourceState',{scope,token,key:'account:a',index:0})).kind,'missing');
 assert.equal(await call('sourceEmail',{scope,token,alias:'a'}),null);await call('seedAccount',{alias:'a',identity,email:'a@example.invalid'});assert.equal(await call('sourceEmail',{scope,token,alias:'a'}),'a@example.invalid');assert.equal(await call('sourceEmail',{scope,token,alias:'other'}),null);
 const done=await call('sourceState',{scope,token,key:'done:a:message',index:0});assert.equal(done.kind,'value');assert.deepEqual(done.bytes,{'0':49});
 const inventory=[];let after=null;do{const page=await call('inventory',{scope,token,after,limit:2});assert(page);inventory.push(...page.entries);after=page.next;}while(after);assert.equal(inventory[0].kind,'partial');assert.equal(inventory[0].hash,hash('synthetic accepted partial'));assert(inventory.some(e=>e.key==='cursor:a'&&e.kind==='missing'));assert(inventory.some(e=>e.key==='recheck:a'&&e.kind==='missing'));assert(inventory.some(e=>e.key==='done:a:message'&&e.kind==='state'&&e.hash===hash('1')&&e.expiresAt>0));assert.equal(new Set(inventory.map(e=>e.cursor)).size,inventory.length);
 const digest='2026-10-24T06:30:00Z';
 const values=new Map([[`digest:${digest}`,'digest'],['runs-index','index'],['last-run',digest],[`job-result:${job}`,'result'],[`job-done:${job}`,digest],['cursor:a','expected-cursor']]);
 const changes=[...values].map(([key,v])=>({key,kind:'put',chunks:[{hash:hash(v),bytes:Buffer.byteLength(v)}]}));
 const versions=await call('capture',{job,generation});assert.equal(versions.length,3);
 let m={job,generation,token,preparation:id(),expectedPreparation:null,digest,previous:null,versions,changes:changes.filter(c=>c.key!=='cursor:a')};
 assert.equal(await call('prepare',m),true);assert.equal(await call('seal',m),false);assert.equal(await call('noAuthority',m),false);
 let n={...m,preparation:id(),expectedPreparation:m.preparation,changes};assert.equal(await call('prepare',n),true);assert.equal(await call('seal',n),true);
 for(const [key,data] of values)assert.equal(await call('stage',{...n,key,index:0,data}),true);
 await call('bump',{kind:'settings'});assert.equal(await call('describeSource',{scope,token}),null);assert.equal(await call('sourcePartial',{scope,token,alias:'a',index:0}),null);await assert.rejects(call('commit',n));assert.equal(await call('head',{}),null);
 let p={...n,preparation:id(),expectedPreparation:n.preparation,versions:await call('capture',{job,generation})};assert.equal(await call('prepare',p),true);assert.equal(await call('seal',p),true);
 for(const [key,data] of values)assert.equal(await call('stage',{...p,key,index:0,data}),true);
 await call('bump',{kind:'done'});await assert.rejects(call('commit',p));assert.equal(await call('head',{}),null);
 let q={...p,preparation:id(),expectedPreparation:p.preparation,versions:await call('capture',{job,generation})};assert.equal(await call('prepare',q),true);assert.equal(await call('seal',q),true);
 for(const [key,data] of values)assert.equal(await call('stage',{...q,key,index:0,data}),true);
 await call('expireDone',{});assert.equal(await call('capture',{job,generation}),null);await assert.rejects(call('commit',q));assert.equal((await call('cleanupDone',{})).removed,1);await assert.rejects(call('commit',q));
 const r={...q,preparation:id(),expectedPreparation:q.preparation,versions:await call('capture',{job,generation})};assert.equal(await call('prepare',r),true);assert.equal(await call('seal',r),true);for(const [key,data] of values)assert.equal(await call('stage',{...r,key,index:0,data}),true);
 await stop();await start();assert.equal(await call('commit',r),true);assert.equal(await call('head',{}),generation);
 const job2=id(),gen2=id();assert.equal((await call('create',{job:job2,generation:gen2,driver,mailboxes:[{alias:'a',identity}]})).ok,true);
 assert.equal(await call('account',{alias:'a',identity}),2);
 const attempt2=id();assert.equal((await call('claim',{job:job2,generation:gen2,token:attempt2})).kind,'claim');assert.equal(await call('fail',{job:job2,generation:gen2,alias:'a',token:attempt2}),true);
 assert.equal(await call('capture',{job:job2,generation:gen2}),null);
 await call('expireJob',{job:job2});
 const many=Array.from({length:50},(_,i)=>({alias:`box${i}`,identity:hash(`account-${i}`)}));
 for(const account of many)await call('account',account);
 const job3=id(),gen3=id();assert.equal((await call('create',{job:job3,generation:gen3,driver,mailboxes:many})).ok,true);
 for(let i=0;i<many.length;i++){const t=id(),row=await call('claim',{job:job3,generation:gen3,token:t});assert.equal(row.kind,'claim');assert.equal(await call('fail',{job:job3,generation:gen3,alias:row.alias,token:t}),true);}
 const final3=id(),scope3=id();assert.equal(await call('final',{job:job3,generation:gen3,token:final3}),true);
 const settings={deadlineDays:4,important:Array.from({length:500},(_,i)=>`${'a'.repeat(220)}${i}@example.com`),muted:[]};
 await call('setSettings',{value:settings,revision:1});
 const expires=Date.now()+60_000;await call('seedState',{generation,preparation:r.preparation,expires});
 await call('dropRuns',{});assert.equal(await call('captureSource',{scope:scope3,job:job3,generation:gen3,token:final3}),null);await call('digestExpiry',{expires:Date.now()-1});const expiredScope=id();assert(await call('captureSource',{scope:expiredScope,job:job3,generation:gen3,token:final3}));await call('digestExpiry',{expires:null});assert.equal(await call('describeSource',{scope:expiredScope,token:final3}),null);await call('restoreRuns',{generation,preparation:r.preparation});
 assert(await call('captureSource',{scope:scope3,job:job3,generation:gen3,token:final3}));
 assert.equal((await call('sourceState',{scope:scope3,token:final3,key:'digest:2026-01-01T06:30:00Z-test',index:0})).kind,'missing');
 let cursor=null, count=0, cached=0;const seen=new Set(),settingsParts=[];const inventoryStart=performance.now();do{const page=await call('inventory',{scope:scope3,token:final3,after:cursor,limit:64});assert(page);for(const entry of page.entries){assert(!seen.has(entry.cursor));seen.add(entry.cursor);if(entry.key.startsWith('cls:box0:')){cached++;assert.equal(entry.expiresAt,expires);assert.equal(typeof entry.metadata.arrived,'number');}if(entry.key==='settings')settingsParts.push(entry);}count+=page.entries.length;cursor=page.next;}while(cursor);assert.equal(count,704);assert.equal(cached,500);assert.equal(settingsParts.length,2);
 const decoded=[];for(const part of settingsParts){const r=await call('sourceState',{scope:scope3,token:final3,key:'settings',index:part.index});assert.equal(r.kind,'value');const bytes=Buffer.from(Object.values(r.bytes));assert.equal(hash(bytes),part.hash);decoded.push(bytes);}assert.deepEqual(JSON.parse(Buffer.concat(decoded).toString('utf8')),settings);
 console.log(`Synthetic 50-mailbox/${count}-entry inventory: ${(performance.now()-inventoryStart).toFixed(1)} ms total local wall time, not deployed CPU.`);
 await call('corruptSettings',{});assert.equal((await call('sourceState',{scope:scope3,token:final3,key:'settings',index:0})).kind,'corrupt');
 cursor=null;let rejected=false;do{const page=await call('inventory',{scope:scope3,token:final3,after:cursor,limit:64});if(!page){rejected=true;break;}cursor=page.next;}while(cursor);assert.equal(rejected,true);
 console.log('Synthetic domain gate: independent plan stub, settings/done fences, restart and same-address relink passed.');
} finally {await stop();await rm(dir,{recursive:true,force:true});}
