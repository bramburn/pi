import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30000,
			// Tests run offline by default; opt in with allowNetwork() from test/test-network-env.ts.
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			// Exclude dist/ so vitest doesn't run copied .test.ts files that
			// ship in the build output (e.g. examples/extensions/background-tasks).
			// node_modules and .git are vitest defaults and don't need to be listed.
			exclude: ["**/dist/**"],
			server: {
				deps: {
					// photon-node is a native WASM binding (better-sqlite3-style); vite's SSR
					// transformer cannot bundle native modules, so we exclude it from transformation.
					// Add any other native binding here.
					external: [/@silvia-odwyer\/photon-node/],
				},
			},
		},
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-client$/,
					replacement: fileURLToPath(new URL("../client/src/index.ts", import.meta.url)),
				},
				{
					find: /^@earendil-works\/pi-protocol$/,
					replacement: fileURLToPath(new URL("../protocol/src/index.ts", import.meta.url)),
				},
				{ find: /^@mariozechner\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@mariozechner\/pi-ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
				{ find: /^@mariozechner\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@mariozechner\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);
