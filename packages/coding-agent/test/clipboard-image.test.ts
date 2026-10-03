import type { SpawnSyncReturns } from "child_process";
import { writeFileSync } from "fs";
import { beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => {
	return {
		spawnSync: vi.fn<(command: string, args: string[], options: unknown) => SpawnSyncReturns<Buffer>>(),
		clipboard: {
			hasImage: vi.fn<() => Promise<boolean>>(),
			getImageBinary: vi.fn<() => Promise<Uint8Array | null>>(),
		},
	};
});

vi.mock("child_process", () => {
	return {
		spawnSync: mocks.spawnSync,
	};
});

vi.mock("../src/utils/clipboard-native.js", () => {
	return {
		clipboard: mocks.clipboard,
	};
});

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

function spawnError(error: Error): SpawnSyncReturns<Buffer> {
	return {
		pid: 123,
		output: [Buffer.alloc(0), Buffer.alloc(0), Buffer.alloc(0)],
		stdout: Buffer.alloc(0),
		stderr: Buffer.alloc(0),
		status: null,
		signal: null,
		error,
	};
}

describe("readClipboardImage", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockReset();
		mocks.clipboard.hasImage.mockReset();
		mocks.clipboard.getImageBinary.mockReset();
	});

	test("Wayland: uses wl-paste and never calls clipboard", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\nimage/png\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return spawnOk(Buffer.from([1, 2, 3]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3]);
	});

	test("Wayland: falls back to xclip when wl-paste is missing", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called on Wayland");
		});

		const enoent = new Error("spawn ENOENT");
		(enoent as { code?: string }).code = "ENOENT";

		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste") {
				return spawnError(enoent);
			}

			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}

			if (command === "xclip" && args.includes("image/png")) {
				return spawnOk(Buffer.from([9, 8]));
			}

			return spawnOk(Buffer.alloc(0));
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { XDG_SESSION_TYPE: "wayland" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([9, 8]);
	});

	test("WSL: passes PowerShell path directly instead of through a custom env var", async () => {
		mocks.clipboard.hasImage.mockImplementation(() => {
			throw new Error("clipboard.hasImage should not be called before PowerShell on WSL");
		});

		let tmpFile: string | undefined;
		mocks.spawnSync.mockImplementation((command, args, options) => {
			if (command === "wl-paste" || command === "xclip") {
				return spawnOk(Buffer.alloc(0));
			}

			if (command === "wslpath") {
				tmpFile = args[1];
				return spawnOk(Buffer.from("C:\\Users\\O'Hare\\clip.png\n", "utf-8"));
			}

			if (command === "powershell.exe") {
				const spawnOptions = options as { env?: NodeJS.ProcessEnv };
				expect(spawnOptions.env?.PI_WSL_CLIPBOARD_IMAGE_PATH).toBeUndefined();
				expect(args[2]).toContain("$path = 'C:\\Users\\O''Hare\\clip.png'");
				if (!tmpFile) {
					throw new Error("wslpath should be called before powershell.exe");
				}
				writeFileSync(tmpFile, Buffer.from([4, 5, 6]));
				return spawnOk(Buffer.from("ok\n", "utf-8"));
			}

			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: { WSL_DISTRO_NAME: "Ubuntu" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([4, 5, 6]);
	});

	test("Non-Wayland: uses clipboard", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error(
				"spawnSync should not be called for non-Wayland sessions when native clipboard returns an image",
			);
		});

		mocks.clipboard.hasImage.mockResolvedValue(true);
		mocks.clipboard.getImageBinary.mockResolvedValue(new Uint8Array([7]));

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([7]);
	});

	test("Non-Wayland: falls back to xclip when clipboard has no image", async () => {
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("image/png\n", "utf-8"));
			}
			if (command === "xclip" && args.includes("image/png")) {
				return spawnOk(Buffer.from([8, 9]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		mocks.clipboard.hasImage.mockResolvedValue(false);

		const { readClipboardImage } = await import("../src/utils/clipboard-image.ts");
		const result = await readClipboardImage({ platform: "linux", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("image/png");
		expect(Array.from(result?.bytes ?? [])).toEqual([8, 9]);
	});
});

describe("readClipboardVideo", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockReset();
	});

	test("Wayland: reads a video payload via wl-paste", async () => {
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\nvideo/mp4\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				expect(args).toContain("video/mp4");
				return spawnOk(Buffer.from([1, 2, 3, 4]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardVideo } = await import("../src/utils/clipboard-image.ts");
		const result = readClipboardVideo({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("video/mp4");
		expect(Array.from(result?.bytes ?? [])).toEqual([1, 2, 3, 4]);
	});

	test("Wayland: returns null when the clipboard holds only images and text", async () => {
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\nimage/png\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return spawnOk(Buffer.alloc(0));
			}
			if (command === "xclip") {
				// xclip fallback finds no video targets either.
				return spawnOk(Buffer.alloc(0));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardVideo } = await import("../src/utils/clipboard-image.ts");
		const result = readClipboardVideo({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).toBeNull();
	});

	test("X11: falls back to xclip for video payloads", async () => {
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "xclip" && args.includes("TARGETS")) {
				return spawnOk(Buffer.from("video/webm\n", "utf-8"));
			}
			if (command === "xclip" && args.includes("video/webm")) {
				return spawnOk(Buffer.from([5, 6]));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardVideo } = await import("../src/utils/clipboard-image.ts");
		const result = readClipboardVideo({ platform: "linux", env: {} });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("video/webm");
		expect(Array.from(result?.bytes ?? [])).toEqual([5, 6]);
	});

	test("non-Linux platforms return null without spawning", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync should not be called on non-Linux platforms");
		});

		const { readClipboardVideo } = await import("../src/utils/clipboard-image.ts");
		expect(readClipboardVideo({ platform: "darwin", env: {} })).toBeNull();
		expect(readClipboardVideo({ platform: "win32", env: {} })).toBeNull();
	});
});

describe("readClipboardPdf", () => {
	beforeEach(() => {
		vi.resetModules();
		mocks.spawnSync.mockReset();
	});

	test("Wayland: reads a PDF payload via wl-paste", async () => {
		const pdfBytes = Buffer.from("%PDF-1.7", "utf-8");
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\napplication/pdf\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				expect(args).toContain("application/pdf");
				return spawnOk(pdfBytes);
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardPdf } = await import("../src/utils/clipboard-image.ts");
		const result = readClipboardPdf({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } });
		expect(result).not.toBeNull();
		expect(result?.mimeType).toBe("application/pdf");
		expect(Array.from(result?.bytes ?? [])).toEqual(Array.from(pdfBytes));
	});

	test("returns null when the clipboard holds no PDF", async () => {
		mocks.spawnSync.mockImplementation((command, args, _options) => {
			if (command === "wl-paste" && args[0] === "--list-types") {
				return spawnOk(Buffer.from("text/plain\nimage/png\n", "utf-8"));
			}
			if (command === "wl-paste" && args[0] === "--type") {
				return spawnOk(Buffer.alloc(0));
			}
			if (command === "xclip") {
				return spawnOk(Buffer.alloc(0));
			}
			throw new Error(`Unexpected spawnSync call: ${command} ${args.join(" ")}`);
		});

		const { readClipboardPdf } = await import("../src/utils/clipboard-image.ts");
		expect(readClipboardPdf({ platform: "linux", env: { WAYLAND_DISPLAY: "1" } })).toBeNull();
	});

	test("non-Linux platforms return null without spawning", async () => {
		mocks.spawnSync.mockImplementation(() => {
			throw new Error("spawnSync should not be called on non-Linux platforms");
		});

		const { readClipboardPdf } = await import("../src/utils/clipboard-image.ts");
		expect(readClipboardPdf({ platform: "darwin", env: {} })).toBeNull();
		expect(readClipboardPdf({ platform: "win32", env: {} })).toBeNull();
	});
});
