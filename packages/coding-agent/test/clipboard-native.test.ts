import { describe, expect, test, vi } from "vitest";
import { type ClipboardModule, loadClipboardNative } from "../src/utils/clipboard-native.ts";

type ClipboardRequire = (id: string) => unknown;

const fakeClipboard: ClipboardModule = {
	getText: async () => "",
	setText: async () => {},
	hasImage: async () => true,
	getImageBinary: async () => [1, 2, 3],
};

describe("loadClipboardNative", () => {
	test("loads @bramburn/clipboard-rs from the first require root", () => {
		const primary = vi.fn<ClipboardRequire>(() => fakeClipboard);
		const fallback = vi.fn<ClipboardRequire>(() => fakeClipboard);

		expect(loadClipboardNative([primary, fallback])).toBe(fakeClipboard);
		expect(primary).toHaveBeenCalledWith("@bramburn/clipboard-rs");
		expect(primary).toHaveBeenCalledTimes(1);
		expect(fallback).not.toHaveBeenCalled();
	});

	test("falls back to the next require root", () => {
		const enoent = new Error("missing from bundled root");
		(enoent as { code?: string }).code = "MODULE_NOT_FOUND";
		const primary = vi.fn<ClipboardRequire>(() => {
			throw enoent;
		});
		const fallback = vi.fn<ClipboardRequire>(() => fakeClipboard);

		expect(loadClipboardNative([primary, fallback])).toBe(fakeClipboard);
		expect(primary).toHaveBeenCalledWith("@bramburn/clipboard-rs");
		expect(fallback).toHaveBeenCalledWith("@bramburn/clipboard-rs");
	});

	test("falls back to upstream when the fork loads but its prebuild is missing", () => {
		// packages/clipboard-rs/index.js loads the .node lazily, so require()
		// succeeds even with a missing prebuild; usability is only visible
		// through the addonMarker() sentinel.
		const brokenFork: ClipboardModule = {
			...fakeClipboard,
			addonMarker: () => "@bramburn/clipboard-rs: no prebuild for win32-x64",
		};
		const upstream: ClipboardModule = {
			getText: async () => "upstream",
			setText: async () => {},
			hasImage: async () => false,
			getImageBinary: async () => [7, 8, 9],
		};
		const primary = vi.fn<ClipboardRequire>((id) => (id === "@bramburn/clipboard-rs" ? brokenFork : upstream));
		const fallback = vi.fn<ClipboardRequire>(() => {
			throw new Error("not installed");
		});

		const loaded = loadClipboardNative([primary, fallback]);
		expect(loaded).toBe(upstream);
		expect(primary).toHaveBeenNthCalledWith(1, "@bramburn/clipboard-rs");
		expect(primary).toHaveBeenNthCalledWith(2, "@mariozechner/clipboard");
		expect(fallback).not.toHaveBeenCalled();
	});

	test("skips a probe whose addonMarker throws", () => {
		const throwingFork: ClipboardModule = {
			...fakeClipboard,
			addonMarker: () => {
				throw new Error("ELF load error");
			},
		};
		const primary = vi.fn<ClipboardRequire>(() => throwingFork);
		const fallback = vi.fn<ClipboardRequire>(() => fakeClipboard);

		expect(loadClipboardNative([primary, fallback])).toBe(fakeClipboard);
	});

	test("accepts a healthy fork marker without probing upstream", () => {
		const healthyFork: ClipboardModule = {
			...fakeClipboard,
			addonMarker: () => "pi-clipboard-rs v0.0.1",
		};
		const primary = vi.fn<ClipboardRequire>(() => healthyFork);
		const fallback = vi.fn<ClipboardRequire>(() => fakeClipboard);

		expect(loadClipboardNative([primary, fallback])).toBe(healthyFork);
		expect(fallback).not.toHaveBeenCalled();
	});

	test("returns null when no require root can load clipboard", () => {
		const missing = vi.fn<ClipboardRequire>(() => {
			throw new Error("missing");
		});

		expect(loadClipboardNative([missing])).toBeNull();
		expect(missing).toHaveBeenCalledWith("@bramburn/clipboard-rs");
		expect(missing).toHaveBeenCalledWith("@mariozechner/clipboard");
		expect(missing).toHaveBeenCalledTimes(2);
	});
});
