// Local workerd SQLite. Restart the runtime between pages to verify durable checkpoints and pins.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";

const directory = await mkdtemp(join(tmpdir(), "openinbox-compaction-"));
try {
  const entry = fileURLToPath(new URL("./compaction-fixture.ts", import.meta.url));
  const bundle = await build({ entryPoints:[entry], write:false, bundle:true, format:"esm", target:"es2022" });
  const options = convertV4MiniflareOptions({
    modules:true, script:bundle.outputFiles[0].text, compatibilityDate:"2026-10-01",
    durableObjects:{FIXTURE:{className:"CompactionFixture",useSQLite:true}},
  });
  for (const phase of ["seed", "resume", "expiry", "gc"]) {
    const runtime = new Miniflare({ ...options, resourcePersistencePath: directory });
    try {
      const response = await runtime.dispatchFetch("https://synthetic.invalid/" + phase);
      const content = await response.text();
      assert.equal(response.status,200,content.slice(0,800));
      const data = JSON.parse(content);
      if (phase==="seed") assert.equal(data.seed,true);
      else if (phase==="resume") assert.equal(data.resume,true);
      else if (phase==="expiry") assert.equal(data.expiry,true);
      else {assert.equal(data.ok,true);console.log(JSON.stringify(data));}
    } finally {await runtime.dispose();}
  }
} finally {await rm(directory,{recursive:true,force:true});}
