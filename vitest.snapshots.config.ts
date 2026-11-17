// `npm run ui:snapshots`: renders the UI to docs/design-handover/current/ (see scripts/ui-snapshots.ts).
// Kept out of `npm test`, which only picks up *.test.ts.
import { defineConfig } from "vitest/config";

export default defineConfig({ test: { include: ["scripts/ui-snapshots.ts"] } });
