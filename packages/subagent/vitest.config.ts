import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			globals: true,
			environment: "node",
			testTimeout: 30_000,
			env: { PI_OFFLINE: "1" },
			unstubEnvs: true,
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
			silent: "passed-only",
			coverage: {
				provider: "v8",
				reporter: ["text", "lcov", "html"],
				include: ["src/**/*.ts"],
				exclude: ["src/**/*.d.ts", "src/test-utils/**", "src/index.ts"],
				thresholds: {
					lines: 100,
					functions: 100,
					branches: 100,
					statements: 100,
				},
			},
		},
		resolve: {
			alias: [
				{
					find: /^@earendil-works\/pi-coding-agent$/,
					replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)),
				},
				{ find: /^@earendil-works\/pi-agent-core$/, replacement: workspaceSourcePaths.agentIndex },
				{ find: /^@earendil-works\/pi-ai$/, replacement: workspaceSourcePaths.aiIndex },
				{ find: /^@earendil-works\/pi-ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
				{ find: /^@earendil-works\/pi-tui$/, replacement: workspaceSourcePaths.tuiIndex },
			],
		},
	}),
);