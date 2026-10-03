import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const telemetrySrcIndex = fileURLToPath(new URL("../telemetry/src/index.ts", import.meta.url));

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		testTimeout: 30000, // 30 seconds for API calls
		// Live-network blocks are gated behind PI_LIVE_TESTS=1; without it the
		// gate scrubs ambient provider credentials before test modules load.
		// See test/live-tests-gate.ts.
		setupFiles: ["./test/live-tests-gate.ts"],
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		silent: "passed-only",
	},
	resolve: {
		alias: [{ find: /^@earendil-works\/pi-telemetry$/, replacement: telemetrySrcIndex }],
	},
});