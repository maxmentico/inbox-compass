// `npm test`: the *.test.ts files under test/. docs/ holds copies of the code handed to designers
// (docs/design-handover/), which aren't part of the suite.
import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		exclude: [...configDefaults.exclude, "docs/**", ".private/**"],
		// The run's telemetry lines (src/telemetry.ts) would flood the output; tests that need them spy on console.log.
		onConsoleLog: (line) => (line.startsWith('{"evt":') ? false : undefined),
	},
});
