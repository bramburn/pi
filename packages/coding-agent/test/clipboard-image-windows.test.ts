/**
 * Tests for the native-Windows PowerShell base64 fallback in
 * `packages/coding-agent/src/utils/clipboard-image.ts`.
 *
 * The native addon (`packages/clipboard-rs`) reports `hasImage() ===
 * false` whenever it cannot open it (clipboard held by another app,
 * arboard backend failure, etc). We still want image-paste to work
 * for users running pi on Windows, so `readClipboardImage` falls
 * through to PowerShell, which can read the clipboard via
 * `System.Windows.Forms.Clipboard` regardless of arboard's state.
 *
 * These tests force the fallback by mocking `hasImage() === false`
 * and `spawnSync("powershell.exe", ...)` to return a base64-encoded
 * 1x1 PNG fixture.
 */
import { Buffer } from "node:buffer";
import type { SpawnSyncReturns } from "node:child_process";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	spawnSync: vi.fn<(command: string, args: string[], options?: unknown) => SpawnSyncReturns<Buffer>>(),
	clipboard: {
		hasImage: vi.fn<() => Promise<boolean>>(),
		getImageBinary: vi.fn<() => Promise<Array<number> | null>>(),
	},
}));

vi.mock("node:child_process", () => ({ spawnSync: mocks.spawnSync }));
vi.mock("../src/utils/clipboard-native.ts", () => ({ clipboard: mocks.clipboard }));

// Tiny 1x1 transparent PNG, base64-encoded so PowerShell can emit it
// as a plain ASCII string (no stdout encoding bugs). Same fixture the
// `clipboard-rs` integration test uses, just base64-encoded.
const PNG_BASE64 =
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==";
const PNG_BYTES = new Uint8Array(Buffer.from(PNG_BASE64, "base64"));

function spawnOk(stdout: Buffer): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), stdout, Buffer.alloc(0)],
		stdout,
		stderr: Buffer.alloc(0),
		status: 0,
		signal: null,
	};
}

describe("readClipboardImage Windows PowerShell fallback", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockReset();
		mocks.clipboard.hasImage.mockReset();
		mocks.clipboard.getImageBinary.mockReset();

		// Force the native path to "no image" so the PowerShell fallback
		// has to pick up the slack.
		mocks.clipboard.hasImage.mockResolvedValue(false);
		mocks.clipboard.getImageBinary.mockResolvedValue(null);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	test("decodes base64 PowerShell output to PNG bytes", async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });

		mocks.spawnSync.mockImplementation((command, args) => {
			if (command !== "powershell.exe") {
				throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
			}
			// Sanity-check the script: it should ask PowerShell to
			// emit a base64 PNG, not save to a tmp file.
			expect(args[2]).toContain("[Convert]::ToBase64String");
			expect(args[2]).toContain("[System.Drawing.Imaging.ImageFormat]::Png");
			return spawnOk(Buffer.from(PNG_BASE64, "utf8"));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "win32", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual(Array.from(PNG_BYTES));
	});

	test("returns null when PowerShell produces no base64 output", async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });

		mocks.spawnSync.mockImplementation((command) => {
			if (command === "powershell.exe") return spawnOk(Buffer.alloc(0));
			throw new Error(`Unexpected spawnSync call: ${command}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "win32", env: {} })).toBeNull();
	});

	test("returns null when PowerShell fails to spawn", async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });

		const error = new Error("spawn ENOENT") as Error & { code?: string };
		error.code = "ENOENT";
		mocks.spawnSync.mockImplementation(() => ({
			pid: 0,
			output: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)],
			stdout: Buffer.alloc(0),
			stderr: Buffer.alloc(0),
			status: null,
			signal: null,
			error,
		}));

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "win32", env: {} })).toBeNull();
	});

	test("does not call PowerShell on non-Windows platforms", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync must not be called for macOS/Linux");
		});
		mocks.clipboard.hasImage.mockResolvedValue(false);

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		expect(await readClipboardImage({ platform: "darwin", env: {} })).toBeNull();
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	test("native addon path wins when hasImage returns true", async () => {
		vi.stubGlobal("process", { ...process, platform: "win32" });

		const nativeBytes = [10, 20, 30];
		mocks.clipboard.hasImage.mockResolvedValue(true);
		mocks.clipboard.getImageBinary.mockResolvedValue(nativeBytes);

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "win32", env: {} });
		expect(result?.bytes).toEqual(new Uint8Array(nativeBytes));
		expect(mocks.spawnSync).not.toHaveBeenCalled();
	});

	test("PowerShell fallback runs when native addon rejects (ClipboardOccupied)", async () => {
		// arboard on Windows raises ClipboardOccupied when another app
		// briefly holds the clipboard. The previous behavior was for
		// this rejection to escape readClipboardImage and abort paste;
		// the new behavior is to fall through to PowerShell, which reads
		// the clipboard via System.Windows.Forms.Clipboard independently
		// of arboard.
		vi.stubGlobal("process", { ...process, platform: "win32" });

		mocks.clipboard.hasImage.mockRejectedValue(new Error("ClipboardOccupied"));

		mocks.spawnSync.mockImplementation((command) => {
			if (command === "powershell.exe") {
				return spawnOk(Buffer.from(PNG_BASE64, "utf8"));
			}
			throw new Error(`Unexpected spawnSync call: ${command}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "win32", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual(Array.from(PNG_BYTES));
	});

	test("PowerShell fallback runs when hasImage is true but getImageBinary throws", async () => {
		// TOCTOU window: hasImage reads "true" but the clipboard is
		// released/changed before getImageBinary runs. We must not
		// surface the rejection to the caller — fall through to
		// PowerShell instead.
		vi.stubGlobal("process", { ...process, platform: "win32" });

		mocks.clipboard.hasImage.mockResolvedValue(true);
		mocks.clipboard.getImageBinary.mockRejectedValue(new Error("ClipboardOccupied"));

		mocks.spawnSync.mockImplementation((command) => {
			if (command === "powershell.exe") {
				return spawnOk(Buffer.from(PNG_BASE64, "utf8"));
			}
			throw new Error(`Unexpected spawnSync call: ${command}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "win32", env: {} });
		expect(result).not.toBeNull();
		expect(Array.from(result?.bytes ?? [])).toEqual(Array.from(PNG_BYTES));
	});
});