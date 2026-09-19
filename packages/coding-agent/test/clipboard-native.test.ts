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

	test("returns null when no require root can load clipboard", () => {
		const missing = vi.fn<ClipboardRequire>(() => {
			throw new Error("missing");
		});

		expect(loadClipboardNative([missing])).toBeNull();
		expect(missing).toHaveBeenCalledWith("@bramburn/clipboard-rs");
		expect(missing).toHaveBeenCalledTimes(1);
	});
});