// Run from any directory. Remote mode creates a private disposable Worker and removes it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';

const args = process.argv.slice(2);
assert(args.length === 1 && ['--local', '--remote'].includes(args[0]), 'Use --local or --remote');
const remote = args[0] === '--remote';
const root = fileURLToPath(new URL('../../', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'openinbox-canary-'));
const name = 'openinbox-canary-' + randomBytes(16).toString('hex');
const config = join(dir, 'wrangler.json');
const cli = join(root, 'node_modules/.bin/wrangler');
const deploy = args => execFileSync(cli, [...args, '--config', config], {
  cwd: dir, stdio: 'inherit', env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
});
const base = { name, main: 'worker.mjs', compatibility_date: '2026-10-01', workers_dev: false, preview_urls: false, observability: { enabled: false } };
let runtime, proxy, deployed = false, verifiedRemoval = false;
try {
  const bundle = await build({ entryPoints: [join(root, 'scripts/coordinator-canary/worker.ts')], bundle: true, write: false, format: 'esm', target: 'es2022' });
  const source = bundle.outputFiles[0].text;
  let call;
  if (remote) {
    await writeFile(join(dir, 'worker.mjs'), source);
    await writeFile(config, JSON.stringify({ ...base, durable_objects: { bindings: [{ name: 'CANARY', class_name: 'Canary' }] }, migrations: [{ tag: 'v1', new_sqlite_classes: ['Canary'] }] }));
    console.error('Creating isolated private Worker', name);
    deploy(['deploy']);
    deployed = true;
    const caller = join(dir, 'caller.json');
    await writeFile(caller, JSON.stringify({ name: name + '-caller', compatibility_date: base.compatibility_date, services: [{ binding: 'TARGET', service: name, remote: true }] }));
    const { getPlatformProxy } = createRequire(import.meta.url)('wrangler');
    proxy = await getPlatformProxy({ configPath: caller, envFiles: [], persist: false }).catch(e => { throw Error(e.message); });
    call = (path, opts) => proxy.env.TARGET.fetch('https://fixture.invalid' + path, opts);
  } else {
    runtime = new Miniflare(convertV4MiniflareOptions({ modules: true, script: source, compatibilityDate: base.compatibility_date, durableObjects: { CANARY: { className: 'Canary', useSQLite: true } } }));
    call = (path, opts) => runtime.dispatchFetch('https://fixture.invalid' + path, opts);
  }
  assert.equal((await call('/unknown', { method: 'POST' })).status, 404);
  assert.equal((await call('/run', { method: 'POST', body: 'arbitrary input' })).status, 404);
  const started = performance.now();
  const response = await call('/run', { method: 'POST' });
  const text = await response.text();
  assert.equal(response.status, 200, text.slice(0, 250));
  const data = JSON.parse(text);
  assert.equal(data.ok, true);
  assert.equal(data.messages, 500);
  assert.equal(data.changes, 501);
  console.log(JSON.stringify({ mode: remote ? 'deployed' : 'local', ...(remote ? { worker: name } : {}), wallMs: Math.round(performance.now() - started), ...data }));
} finally {
  try {
    if (proxy) await proxy.dispose();
    if (runtime) await runtime.dispose();
  } finally {
    if (deployed) {
      // Remove the synthetic namespace with a class-deletion migration before deleting this
      // uniquely named Worker. Keep config on failure so cleanup can be retried exactly.
      await writeFile(join(dir, 'worker.mjs'), 'export default {fetch(){return new Response(null,{status:404})}};');
      await writeFile(config, JSON.stringify({ ...base, migrations: [{ tag: 'v1', new_sqlite_classes: ['Canary'] }, { tag: 'v2', deleted_classes: ['Canary'] }] }));
      try {
        deploy(['deploy']);
        deploy(['delete', name, '--force']);
        verifiedRemoval = true;
        console.error('Removed synthetic namespace and Worker', name);
      } finally {
        if (!verifiedRemoval) console.error('Cleanup incomplete; retain config and retry for', name, 'at', config);
      }
    }
    if (!deployed || verifiedRemoval) await rm(dir, { recursive: true, force: true });
  }
}
