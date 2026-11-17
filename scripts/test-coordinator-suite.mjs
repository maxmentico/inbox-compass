// Run only local, synthetic Workers/SQLite integration tests. Each script creates its own
// temporary Worker and state. This suite does not deploy or read production bindings.
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const tests = (await readdir(directory)).filter((name) => /^test-.*-runtime\.mjs$/.test(name)).sort();
if (!tests.length) throw new Error('No synthetic runtime tests found');

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
	console.log(`\nSynthetic runtime suite passed: ${tests.length} scripts.`);
}
