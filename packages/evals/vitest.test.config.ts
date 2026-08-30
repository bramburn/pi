import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
// `@vitest-evals/core@0.15.0` declares a `source` condition in its `exports` that
// resolves to `./src/index.ts` (a file that is NOT shipped in the published tarball).
// Vite's resolver picks the `source` condition when running vitest, which then
// throws "Cannot find module .../src/index.ts" while the runtime import works
// fine under plain Node. Force vitest to use the dist entry points that are
// actually on disk by aliasing the package to its installed dist.
const vitestEvalsCoreIndex = fileURLToPath(new URL("./node_modules/@vitest-evals/core/dist/index.mjs", import.meta.url));
const vitestEvalsIndex = fileURLToPath(new URL("./node_modules/vitest-evals/dist/index.mjs", import.meta.url));

export default mergeConfig(
	baseConfig,
	defineConfig({
		test: {
			include: ["test/**/*.test.ts"],
		},
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
				// Bypass the published `source` export condition by aliasing to the dist file.
				{ find: /^@vitest-evals\/core$/, replacement: vitestEvalsCoreIndex },
				{ find: /^vitest-evals$/, replacement: vitestEvalsIndex },
			],
		},
		server: {
			fs: { allow: [repoRoot] },
		},
	}),
);
