import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
	createJiti: vi.fn((_id: unknown, _options: unknown) => ({
		import: vi.fn(async () => () => {}),
	})),
}));

vi.mock("jiti/static", () => ({ createJiti: state.createJiti }));

import { getAliases, loadExtensions } from "../src/core/extensions/loader.ts";

// Extensions installed from npm import the legacy @earendil-works/pi-* scope
// (the scope docs/extensions.md documents). Both jiti option tables must
// resolve them against the host, or built cli.js runs fail with
// `Cannot find module '@earendil-works/pi-coding-agent'`.
const LEGACY_SPECIFIERS = [
	"@earendil-works/pi-coding-agent",
	"@earendil-works/pi-agent-core",
	"@earendil-works/pi-tui",
	"@earendil-works/pi-ai",
	"@earendil-works/pi-ai/compat",
	"@earendil-works/pi-ai/oauth",
	"@earendil-works/pi-ai/providers/all",
];

interface JitiOptionsProbe {
	alias?: unknown;
	virtualModules?: Record<string, unknown>;
}

describe("legacy @earendil-works scope aliases", () => {
	it("resolves legacy specifiers via virtualModules (source/binary hosts)", async () => {
		const result = await loadExtensions(["/extension.ts"], "/");

		expect(result.errors).toEqual([]);
		expect(state.createJiti).toHaveBeenCalledOnce();

		const options = state.createJiti.mock.calls[0][1] as JitiOptionsProbe;
		const virtualModules = options.virtualModules ?? {};
		for (const specifier of LEGACY_SPECIFIERS) {
			expect(virtualModules[specifier], specifier).toBeDefined();
		}
	});

	it("resolves legacy specifiers via alias (built cli.js hosts)", () => {
		const aliases = getAliases();
		for (const specifier of LEGACY_SPECIFIERS) {
			expect(aliases[specifier], specifier).toBeDefined();
			expect(aliases[specifier], specifier).toBe(aliases[specifier.replace("@earendil-works/pi-", "@bramburn/qi-")]);
		}
	});
});
