// Run only local, synthetic Workers/SQLite integration tests. Each script creates its own
// temporary Worker and state. This suite does not deploy or read production bindings.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const allTests = (await readdir(directory)).filter((name) => /^test-.*-runtime\.mjs$/.test(name)).sort();
if (!allTests.length) throw new Error('No synthetic runtime tests found');
// CI splits the slow Workers/SQLite suite across independent jobs; locally the default runs all.
const shardIndex = Number(process.env.SHARD_INDEX ?? 0);
const shardCount = Number(process.env.SHARD_COUNT ?? 1);
if (!Number.isSafeInteger(shardIndex) || !Number.isSafeInteger(shardCount) || shardCount < 1 || shardIndex < 0 || shardIndex >= shardCount)
	throw new Error('SHARD_INDEX must be in [0, SHARD_COUNT), and SHARD_COUNT >= 1');
const tests = allTests.filter((_, index) => index % shardCount === shardIndex);
console.log(`Runtime test shard ${shardIndex + 1}/${shardCount}: ${tests.length} of ${allTests.length} scripts`);

const failures = [];
for (const name of tests) {
	console.log(`\nRunning ${name}`);
	const child = spawn(process.execPath, [join(directory, name)], { cwd: resolve(directory, '..'), stdio: 'inherit' });
	const timer = setTimeout(() => child.kill('SIGTERM'), 120_000);
	const result = await new Promise((resolveResult) => {
		child.once('error', (error) => resolveResult({ error }));
		child.once('exit', (code, signal) => resolveResult({ code, signal }));
	});
	clearTimeout(timer);
	if (result.error || result.code !== 0) failures.push(name);
}
if (failures.length) {
	console.error(`Synthetic runtime suite failed: ${failures.join(', ')}`);
	process.exitCode = 1;
} else {
	console.log(`\nSynthetic runtime suite passed: ${tests.length} scripts (shard ${shardIndex + 1}/${shardCount}).`);
}
