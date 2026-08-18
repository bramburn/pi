import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			environment: "node",
			fileParallelism: false,
			include: ["src/**/*.eval.ts"],
			testTimeout: 120000,
			hookTimeout: 30000,
			// Vitest's default `pool: "threads"` is unreliable under Bun in
			// 2025 (`bun.sh/docs/runtime/nodejs-apis#bunnode-threads-pool`).
			// Force `forks` so the eval runner is cross-runtime safe. Node and
			// Bun both support forks; the trade-off is process startup cost,
			// which is acceptable for these model-backed evals (issue #193).
			pool: "forks",
			setupFiles: ["./src/vitest-evals/setup.ts"],
			reporters: ["vitest-evals/reporter", "./src/vitest-evals/reporter.ts"],
		},
		resolve: {
			alias: [{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex }],
		},
	}),
);
