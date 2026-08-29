/**
 * Tests for terminal image detection and line handling
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Image } from "../src/components/image.ts";
import {
	cropKittyImageLine,
	deleteAllKittyImages,
	deleteAllKittyPlacements,
	deleteKittyImage,
	detectCapabilities,
	encodeITerm2,
	encodeKitty,
	getCapabilities,
	getKittyImageMetadata,
	getKittyImagePlacement,
	hyperlink,
	imageFallback,
	isImageLine,
	registerKittyImageMetadata,
	renderImage,
	resetCapabilitiesCache,
	setCapabilities,
	setCapabilityOverrides,
	setCellDimensions,
} from "../src/terminal-image.ts";
import { visibleWidth } from "../src/utils.ts";

const ENV_KEYS = [
	"TERM",
	"TERM_PROGRAM",
	"TERMINAL_EMULATOR",
	"COLORTERM",
	"TMUX",
	"KITTY_WINDOW_ID",
	"GHOSTTY_RESOURCES_DIR",
	"WEZTERM_PANE",
	"ITERM_SESSION_ID",
	"WT_SESSION",
	"CMUX_WORKSPACE_ID",
	"WARP_SESSION_ID",
	"WARP_TERMINAL_SESSION_UUID",
	"PI_HYPERLINKS",
	"PI_IMAGE_PROTOCOL",
	"PI_TRUE_COLOR",
] as const;

function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => T): T {
	const saved: Record<string, string | undefined> = {};
	for (const key of ENV_KEYS) {
		saved[key] = process.env[key];
		delete process.env[key];
	}
	try {
		for (const [k, v] of Object.entries(overrides)) {
			if (v === undefined) delete process.env[k];
			else process.env[k] = v;
		}
		return fn();
	} finally {
		for (const key of ENV_KEYS) {
			if (saved[key] === undefined) delete process.env[key];
			else process.env[key] = saved[key];
		}
	}
}

describe("isImageLine", () => {
	describe("iTerm2 image protocol", () => {
		it("should detect iTerm2 image escape sequence at start of line", () => {
			// iTerm2 image escape sequence: ESC ]1337;File=...
			const iterm2ImageLine = "\x1b]1337;File=size=100,100;inline=1:base64encodeddata==\x07";
			expect(isImageLine(iterm2ImageLine)).toBe(true);
		});

		it("should detect iTerm2 image escape sequence with text before it", () => {
			// Simulating a line that has text then image data (bug scenario)
			const lineWithTextAndImage = "Some text \x1b]1337;File=size=100,100;inline=1:base64data==\x07 more text";
			expect(isImageLine(lineWithTextAndImage)).toBe(true);
		});

		it("should detect iTerm2 image escape sequence in middle of long line", () => {
			// Simulate a very long line with image data in the middle
			const longLineWithImage =
				"Text before image..." + "\x1b]1337;File=inline=1:verylongbase64data==" + "...text after";
			expect(isImageLine(longLineWithImage)).toBe(true);
		});

		it("should detect iTerm2 image escape sequence at end of line", () => {
			const lineWithImageAtEnd = "Regular text ending with \x1b]1337;File=inline=1:base64data==\x07";
			expect(isImageLine(lineWithImageAtEnd)).toBe(true);
		});

		it("should detect minimal iTerm2 image escape sequence", () => {
			const minimalImageLine = "\x1b]1337;File=:\x07";
			expect(isImageLine(minimalImageLine)).toBe(true);
		});
	});

	describe("Kitty image protocol", () => {
		it("should detect Kitty image escape sequence at start of line", () => {
			// Kitty image escape sequence: ESC _G
			const kittyImageLine = "\x1b_Ga=T,f=100,t=f,d=base64data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			expect(isImageLine(kittyImageLine)).toBe(true);
		});

		it("should detect Kitty image escape sequence with text before it", () => {
			// Bug scenario: text + image data in same line
			const lineWithTextAndKittyImage = "Output: \x1b_Ga=T,f=100;data...\x1b\\\x1b_Gm=i=1;\x1b\\";
			expect(isImageLine(lineWithTextAndKittyImage)).toBe(true);
		});

		it("should detect Kitty image escape sequence with padding", () => {
			// Kitty protocol adds padding to escape sequences
			const kittyWithPadding = "  \x1b_Ga=T,f=100...\x1b\\\x1b_Gm=i=1;\x1b\\  ";
			expect(isImageLine(kittyWithPadding)).toBe(true);
		});
	});

	describe("Bug regression tests", () => {
		it("should detect image sequences in very long lines (304k+ chars)", () => {
			// This simulates the crash scenario: a line with 304,401 chars
			// containing image escape sequences somewhere
			const base64Char = "A".repeat(100); // 100 chars of base64-like data
			const imageSequence = "\x1b]1337;File=size=800,600;inline=1:";

			// Build a long line with image sequence
			const longLine =
				"Text prefix " +
				imageSequence +
				base64Char.repeat(3000) + // ~300,000 chars
				" suffix";

			expect(longLine.length > 300000).toBe(true);
			expect(isImageLine(longLine)).toBe(true);
		});

		it("should detect image sequences when terminal doesn't support images", () => {
			// The bug occurred when getImageEscapePrefix() returned null
			// isImageLine should still detect image sequences regardless
			const lineWithImage = "Read image file [image/jpeg]\x1b]1337;File=inline=1:base64data==\x07";
			expect(isImageLine(lineWithImage)).toBe(true);
		});

		it("should detect image sequences with ANSI codes before them", () => {
			// Text might have ANSI styling before image data
			const lineWithAnsiAndImage = "\x1b[31mError output \x1b]1337;File=inline=1:image==\x07";
			expect(isImageLine(lineWithAnsiAndImage)).toBe(true);
		});

		it("should detect image sequences with ANSI codes after them", () => {
			const lineWithImageAndAnsi = "\x1b_Ga=T,f=100:data...\x1b\\\x1b_Gm=i=1;\x1b\\\x1b[0m reset";
			expect(isImageLine(lineWithImageAndAnsi)).toBe(true);
		});
	});

	describe("Negative cases - lines without images", () => {
		it("should not detect images in plain text lines", () => {
			const plainText = "This is just a regular text line without any escape sequences";
			expect(isImageLine(plainText)).toBe(false);
		});

		it("should not detect images in lines with only ANSI codes", () => {
			const ansiText = "\x1b[31mRed text\x1b[0m and \x1b[32mgreen text\x1b[0m";
			expect(isImageLine(ansiText)).toBe(false);
		});

		it("should not detect images in lines with cursor movement codes", () => {
			const cursorCodes = "\x1b[1A\x1b[2KLine cleared and moved up";
			expect(isImageLine(cursorCodes)).toBe(false);
		});

		it("should not detect images in lines with partial iTerm2 sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with ]1337;File but missing ESC at start";
			expect(isImageLine(partialSequence)).toBe(false);
		});

		it("should not detect images in lines with partial Kitty sequences", () => {
			// Similar prefix but missing the complete sequence
			const partialSequence = "Some text with _G but missing ESC at start";
			expect(isImageLine(partialSequence)).toBe(false);
		});

		it("should not detect images in empty lines", () => {
			expect(isImageLine("")).toBe(false);
		});

		it("should not detect images in lines with newlines only", () => {
			expect(isImageLine("\n")).toBe(false);
			expect(isImageLine("\n\n")).toBe(false);
		});
	});

	describe("Mixed content scenarios", () => {
		it("should detect images when line has both Kitty and iTerm2 sequences", () => {
			const mixedLine = "Kitty: \x1b_Ga=T...\x1b\\\x1b_Gm=i=1;\x1b\\ iTerm2: \x1b]1337;File=inline=1:data==\x07";
			expect(isImageLine(mixedLine)).toBe(true);
		});

		it("should detect image in line with multiple text and image segments", () => {
			const complexLine = "Start \x1b]1337;File=img1==\x07 middle \x1b]1337;File=img2==\x07 end";
			expect(isImageLine(complexLine)).toBe(true);
		});

		it("should not falsely detect image in line with file path containing keywords", () => {
			// File path might contain "1337" or "File" but without escape sequences
			const filePathLine = "/path/to/File_1337_backup/image.jpg";
			expect(isImageLine(filePathLine)).toBe(false);
		});
	});
});

describe("detectCapabilities", () => {
	it("defaults to hyperlinks: false for unknown terminals", () => {
		withEnv({}, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("applies environment overrides", () => {
		expect(
			withEnv({ PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty", PI_TRUE_COLOR: "1" }, () => detectCapabilities()),
		).toStrictEqual({ images: "kitty", trueColor: true, hyperlinks: true });
		expect(
			withEnv({ TERM_PROGRAM: "iterm.app", PI_HYPERLINKS: "0", PI_IMAGE_PROTOCOL: "none", PI_TRUE_COLOR: "0" }, () =>
				detectCapabilities(),
			),
		).toStrictEqual({ images: null, trueColor: false, hyperlinks: false });
	});

	it("preserves auto-detection for auto environment overrides", () => {
		expect(
			withEnv(
				{
					TERM_PROGRAM: "ghostty",
					PI_HYPERLINKS: "auto",
					PI_IMAGE_PROTOCOL: "auto",
					PI_TRUE_COLOR: "auto",
				},
				() => detectCapabilities(),
			),
		).toStrictEqual({ images: "kitty", trueColor: true, hyperlinks: true });
	});

	it("applies and clears programmatic overrides", () => {
		withEnv({ PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty", PI_TRUE_COLOR: "1" }, () => {
			setCapabilityOverrides({ images: null, trueColor: false, hyperlinks: false });
			try {
				expect(getCapabilities()).toStrictEqual({ images: null, trueColor: false, hyperlinks: false });
				setCapabilityOverrides({});
				expect(getCapabilities()).toStrictEqual({ images: "kitty", trueColor: true, hyperlinks: true });
			} finally {
				setCapabilityOverrides({});
				resetCapabilitiesCache();
			}
		});
	});

	it("bypasses the tmux probe when hyperlinks are overridden", () => {
		let probed = false;
		const caps = withEnv(
			{ TMUX: "/tmp/tmux-1000/default,1234,0", PI_HYPERLINKS: "1", PI_IMAGE_PROTOCOL: "kitty" },
			() =>
				detectCapabilities(() => {
					probed = true;
					return false;
				}),
		);
		expect(probed).toBe(false);
		expect(caps.hyperlinks).toBe(true);
		expect(caps.images).toBe("kitty");
	});

	it("enables hyperlinks under tmux when the client forwards them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => true);
			expect(caps.hyperlinks).toBe(true);
			expect(caps.images).toBe(null);
		});
	});

	it("disables hyperlinks under tmux when the client does not forward them", () => {
		withEnv({ TMUX: "/tmp/tmux-1000/default,1234,0", TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities(() => false);
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("checks tmux capability when TERM starts with 'tmux'", () => {
		withEnv({ TERM: "tmux-256color", TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities(() => true);
			expect(caps.hyperlinks).toBe(true);
			expect(caps.images).toBe(null);

			const caps2 = detectCapabilities(() => false);
			expect(caps2.hyperlinks).toBe(false);
		});
	});

	it("forces hyperlinks: false when TERM starts with 'screen'", () => {
		withEnv({ TERM: "screen-256color" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("enables hyperlinks for Ghostty", () => {
		withEnv({ TERM_PROGRAM: "ghostty" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("does not disable Ghostty images solely because cmux is present", () => {
		withEnv({ TERM_PROGRAM: "ghostty", CMUX_WORKSPACE_ID: "workspace" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("kitty");
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables hyperlinks for Kitty", () => {
		withEnv({ KITTY_WINDOW_ID: "1" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables hyperlinks for WezTerm", () => {
		withEnv({ WEZTERM_PANE: "0" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables images and hyperlinks for Warp via TERM_PROGRAM", () => {
		withEnv({ TERM_PROGRAM: "WarpTerminal" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("kitty");
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables images and hyperlinks for Warp via WARP_SESSION_ID", () => {
		withEnv({ WARP_SESSION_ID: "some-session-id" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("kitty");
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables images and hyperlinks for Warp via WARP_TERMINAL_SESSION_UUID", () => {
		withEnv({ WARP_TERMINAL_SESSION_UUID: "d0e1a2e5-7ca7-44cd-9037-ac7222011161" }, () => {
			const caps = detectCapabilities();
			expect(caps.images).toBe("kitty");
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("disables images for Warp inside tmux", () => {
		withEnv(
			{
				TERM_PROGRAM: "WarpTerminal",
				TMUX: "/tmp/tmux-1000/default,1234,0",
				TERM: "tmux-256color",
			},
			() => {
				const caps = detectCapabilities(() => true);
				expect(caps.images).toBe(null);
				expect(caps.hyperlinks).toBe(true);
			},
		);
	});

	it("enables hyperlinks for iTerm2", () => {
		withEnv({ TERM_PROGRAM: "iterm.app" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables hyperlinks for VSCode", () => {
		withEnv({ TERM_PROGRAM: "vscode" }, () => {
			const caps = detectCapabilities();
			expect(caps.hyperlinks).toBe(true);
		});
	});

	it("enables truecolor and hyperlinks for Windows Terminal outside multiplexers", () => {
		withEnv({ WT_SESSION: "session", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(true);
			expect(caps.images).toBe(null);
		});
	});

	it("enables truecolor without hyperlinks for JetBrains terminal", () => {
		withEnv({ TERMINAL_EMULATOR: "JetBrains-JediTerm", TERM: "xterm-256color" }, () => {
			const caps = detectCapabilities();
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("does not inherit Windows Terminal truecolor through tmux", () => {
		withEnv({ WT_SESSION: "session", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false);
			expect(caps.trueColor).toBe(false);
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});

	it("trusts explicit truecolor hints through tmux", () => {
		withEnv({ COLORTERM: "truecolor", TMUX: "/tmp/tmux-1000/default,1234,0", TERM: "tmux-256color" }, () => {
			const caps = detectCapabilities(() => false);
			expect(caps.trueColor).toBe(true);
			expect(caps.hyperlinks).toBe(false);
			expect(caps.images).toBe(null);
		});
	});
});

describe("iTerm2 image encoding", () => {
	it("includes the decoded payload size in OSC 1337 metadata", () => {
		const sequence = encodeITerm2("AAAA", { width: 2, height: "auto" });
		expect(sequence).toBe("\x1b]1337;File=inline=1;size=3;width=2;height=auto:AAAA\x07");
	});
});

describe("Kitty image cursor movement", () => {
	it("can request no terminal-side cursor movement", () => {
		const sequence = encodeKitty("AAAA", { columns: 2, rows: 2, moveCursor: false });
		expect(sequence.startsWith("\x1b_Ga=T,f=100,q=2,C=1,c=2,r=2;")).toBeTruthy();
	});

	it("suppresses Kitty replies for delete commands", () => {
		expect(deleteKittyImage(42)).toBe("\x1b_Ga=d,d=I,i=42,q=2\x1b\\");
		expect(deleteAllKittyImages()).toBe("\x1b_Ga=d,d=A,q=2\x1b\\");
		expect(deleteAllKittyPlacements()).toBe("\x1b_Ga=d,d=a,q=2\x1b\\");
	});

	it("preserves renderImage's default terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2 });
			expect(result).toBeTruthy();
			expect(result!.sequence.includes(",C=1,")).toBeFalsy();
			expect(result!.rows).toBe(2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("can opt renderImage into no terminal-side cursor movement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 20, heightPx: 20 }, { maxWidthCells: 2, moveCursor: false });
			expect(result).toBeTruthy();
			expect(result!.sequence.includes(",C=1,")).toBeTruthy();
			expect(result!.rows).toBe(2);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("registers metadata and crops a partially visible placement", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage(
				"AAAA",
				{ widthPx: 100, heightPx: 100 },
				{ maxWidthCells: 3, imageId: 42, moveCursor: false },
			);
			expect(result).toBeTruthy();
			expect(getKittyImageMetadata(result!.sequence)).toStrictEqual({
				imageId: 42,
				columns: 3,
				rows: 3,
				widthPx: 100,
				heightPx: 100,
			});
			expect(cropKittyImageLine(result!.sequence, 2, 1).includes("y=66,h=34,r=1")).toBeTruthy();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("creates placement-only commands for uploaded and cropped images", () => {
		registerKittyImageMetadata({ imageId: 42, columns: 3, rows: 3, widthPx: 100, heightPx: 100 });
		const transmission = encodeKitty("A".repeat(8192), {
			columns: 3,
			rows: 3,
			imageId: 42,
			moveCursor: false,
		});
		const line = `left ${cropKittyImageLine(transmission, 2, 1)} right`;
		const placement = getKittyImagePlacement(line);
		expect(placement).toBeTruthy();
		expect(placement!.transmissionBytes).toBe(line.length - "left ".length - " right".length);
		expect(placement!.estimatedDecodedBytes).toBe(100 * 100 * 4);
		expect(placement!.sequence).toBe("\x1b_Ga=p,q=2,C=1,c=3,i=42,y=66,h=34,r=1\x1b\\");
		expect(placement!.replacementLine).toBe(`left ${placement!.sequence} right`);
		expect(placement!.replacementLine.includes("AAAA")).toBeFalsy();
	});

	it("honors maxHeightCells by reducing rendered width", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const result = renderImage("AAAA", { widthPx: 10, heightPx: 100 }, { maxWidthCells: 10, maxHeightCells: 5 });
			expect(result).toBeTruthy();
			expect(result!.rows).toBe(5);
			expect(result!.sequence.includes(",c=1,r=5")).toBeTruthy();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("caps Image component height to a square pixel box by default", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 20 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 10 },
				{ widthPx: 10, heightPx: 100 },
			);
			const lines = image.render(12);
			expect(lines.length).toBe(5);
			expect(lines[0].includes(",c=1,r=5")).toBeTruthy();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("places image sequence on first line with empty padding rows", () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const lines = image.render(4);
			const imageId = image.getImageId();
			expect(typeof imageId).toBe("number");
			expect(lines[0].startsWith("\x1b_G")).toBeTruthy();
			expect(lines[0].includes(",C=1,")).toBeTruthy();
			expect(lines[0].includes(`,i=${imageId}`)).toBeTruthy();
			expect(lines[0].endsWith("\x1b\\")).toBeTruthy();
			expect(lines.slice(1, lines.length)).toStrictEqual([""]);
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("truncates long image fallback lines to render width", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const longPath = join(
				homedir(),
				"images",
				`${"generated-image-with-a-very-long-absolute-path".repeat(4)}.png`,
			);
			const width = 40;
			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => `\x1b[33m${value}\x1b[0m` },
				{ filename: longPath },
				{ widthPx: 1280, heightPx: 720 },
			);
			const lines = image.render(width);
			expect(lines.length).toBe(1);
			expect(visibleWidth(lines[0]) <= width).toBeTruthy();
			expect(lines[0].includes("...")).toBeTruthy();
			expect(lines[0].includes("~")).toBeTruthy();
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("imageFallback", () => {
	it("shortens home-prefixed absolute paths without hyperlinks", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			const result = imageFallback("image/png", { widthPx: 1280, heightPx: 720 }, abs);
			expect(result).toBe("[Image: ~/.pi/agent/shot.png [image/png] 1280x720]");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("wraps shortened absolute paths in OSC 8 file links when hyperlinks are enabled", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const abs = join(homedir(), ".pi", "agent", "shot.png");
			const result = imageFallback("image/png", { widthPx: 10, heightPx: 10 }, abs);
			expect(result.includes("\x1b]8;;file://")).toBeTruthy();
			expect(result.includes(abs.replaceAll("\\", "/")) || result.includes(abs)).toBeTruthy();
			// Visible text must use ~/... not the expanded home path.
			const visible = result.replace(/\x1b\]8;;.*?\x1b\\/g, "");
			expect(visible).toBe("[Image: ~/.pi/agent/shot.png [image/png] 10x10]");
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("leaves bare basenames unchanged and does not hyperlink them", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: true });
		try {
			const result = imageFallback("image/png", { widthPx: 1, heightPx: 1 }, "clankolas.png");
			expect(result).toBe("[Image: clankolas.png [image/png] 1x1]");
			expect(result.includes("\x1b]8;")).toBeFalsy();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("omits filename segment when not provided", () => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		try {
			expect(imageFallback("image/png", { widthPx: 8, heightPx: 6 })).toBe("[Image: [image/png] 8x6]");
		} finally {
			resetCapabilitiesCache();
		}
	});
});

describe("hyperlink", () => {
	it("wraps text in OSC 8 open and close sequences", () => {
		const result = hyperlink("click me", "https://example.com");
		expect(result).toBe("\x1b]8;;https://example.com\x1b\\click me\x1b]8;;\x1b\\");
	});

	it("preserves ANSI styling inside the hyperlink", () => {
		const styled = "\x1b[4m\x1b[34mclick me\x1b[0m";
		const result = hyperlink(styled, "https://example.com");
		expect(result.startsWith("\x1b]8;;https://example.com\x1b\\")).toBeTruthy();
		expect(result.includes(styled)).toBeTruthy();
		expect(result.endsWith("\x1b]8;;\x1b\\")).toBeTruthy();
	});

	it("works with empty text", () => {
		const result = hyperlink("", "https://example.com");
		expect(result).toBe("\x1b]8;;https://example.com\x1b\\\x1b]8;;\x1b\\");
	});

	it("works with file:// URIs", () => {
		const result = hyperlink("README.md", "file:///home/user/README.md");
		expect(result.includes("file:///home/user/README.md")).toBeTruthy();
		expect(result.includes("README.md")).toBeTruthy();
	});
});
