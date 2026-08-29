import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Terminal as XtermTerminalType } from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { Image } from "../src/components/image.ts";
import type { Terminal } from "../src/terminal.ts";
import {
	deleteKittyImage,
	encodeKitty,
	resetCapabilitiesCache,
	setCapabilities,
	setCellDimensions,
} from "../src/terminal-image.ts";
import type { Component, TUI } from "../src/tui.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	render(_width: number): string[] {
		return this.lines;
	}
	invalidate(): void {}
}

class InputComponent extends TestComponent {
	renderCount = 0;

	override render(width: number): string[] {
		this.renderCount += 1;
		return super.render(width);
	}

	handleInput(data: string): void {
		this.lines = [data];
	}
}

const MAX_RENDER_WRITE_CHARS = 1024 * 1024;

class BoundedWriteTerminal implements Terminal {
	readonly writes: string[] = [];
	columns = 80;
	rows = 24;
	readonly kittyProtocolActive = false;

	start(_onInput: (data: string) => void, _onResize: () => void): void {}
	stop(): void {}
	async drainInput(_maxMs?: number, _idleMs?: number): Promise<void> {}
	write(data: string): void {
		this.writes.push(data);
	}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

async function withEnv<T>(updates: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
	const previousValues = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(updates)) {
		previousValues.set(key, process.env[key]);
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}

	try {
		return await run();
	} finally {
		for (const [key, value] of previousValues) {
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

function getCellItalic(terminal: VirtualTerminal, row: number, col: number): number {
	const xterm = (terminal as unknown as { xterm: XtermTerminalType }).xterm;
	const buffer = xterm.buffer.active;
	const line = buffer.getLine(buffer.viewportY + row);
	expect(line).toBeTruthy();
	const cell = line!.getCell(col);
	expect(cell).toBeTruthy();
	return cell!.isItalic();
}

describe("TUI render scheduling", () => {
	it("renders keyboard input without waiting for a throttled frame", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new InputComponent();
		component.lines = ["initial"];
		tui.addChild(component);
		tui.setFocus(component);
		tui.start();
		tui.renderNow();
		const renderCountBeforeInput = component.renderCount;

		// Queue a normal throttled render first. Keyboard input should preempt it.
		component.lines = ["pending"];
		tui.requestRender();
		terminal.sendInput("first");
		terminal.sendInput("second");
		terminal.sendInput("typed");
		await new Promise<void>((resolve) => process.nextTick(resolve));

		expect(component.renderCount).toBe(renderCountBeforeInput + 1);
		expect(component.lines).toStrictEqual(["typed"]);
		tui.stop();
	});
});

describe("TUI debug logging", () => {
	it("writes redraw logs to the provided directory", async () => {
		const logDir = mkdtempSync(join(tmpdir(), "pi-tui-log-"));
		try {
			await withEnv({ PI_DEBUG_REDRAW: "1" }, async () => {
				const terminal = new VirtualTerminal(40, 10);
				const tui: TUI = new TuiMainScreen(terminal, undefined, logDir);
				const component = new TestComponent();
				tui.addChild(component);
				component.lines = ["test"];
				tui.start();
				await terminal.waitForRender();

				expect(readFileSync(join(logDir, "pi-debug.log"), "utf-8")).toMatch(/fullRender: first render/);
				tui.stop();
			});
		} finally {
			rmSync(logDir, { recursive: true, force: true });
		}
	});
});

describe("TUI bounded render output", () => {
	it("splits a large full render without changing its output", () => {
		const terminal = new BoundedWriteTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		const kittyLine = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
		component.lines = [kittyLine, kittyLine];
		tui.addChild(component);

		tui.renderNow();

		expect(terminal.writes.length > 2).toBeTruthy();
		expect(terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS)).toBeTruthy();
		expect(terminal.writes.join("")).toBe(`\x1b[?2026h${kittyLine}\r\n${kittyLine}\x1b[?2026l`);
	});

	it("splits large differential updates without a full redraw", () => {
		const terminal = new BoundedWriteTerminal();
		const tui = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);
		component.lines = ["before"];
		tui.renderNow();
		terminal.writes.length = 0;

		const kittyLine = `\x1b_Ga=T,f=100;${"A".repeat(1_200_000)}\x1b\\`;
		component.lines = ["before", kittyLine, kittyLine];
		tui.renderNow();

		expect(terminal.writes.length > 2).toBeTruthy();
		expect(terminal.writes.every((write) => write.length <= MAX_RENDER_WRITE_CHARS)).toBeTruthy();
		const output = terminal.writes.join("");
		expect(output.startsWith("\x1b[?2026h")).toBeTruthy();
		expect(output.endsWith("\x1b[?2026l")).toBeTruthy();
		expect(output.includes("\x1b[2J")).toBeFalsy();
	});
});

describe("TUI Kitty image cleanup", () => {
	it("clears reserved Kitty image rows before drawing appended image placements", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 2 },
				{ widthPx: 20, heightPx: 20 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			expect(writes.includes(`\x1b[2K\r\n\x1b[2K\x1b[1A${imageSequence}\x1b[1B`)).toBeTruthy();
			expect(writes.includes(`${imageSequence}\r\n\x1b[2K`)).toBeFalsy();

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("falls back to full redraw when Kitty image pre-clear would scroll", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 2);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			component.lines = ["before", ...image.render(40), "after"];
			tui.requestRender();
			await terminal.waitForRender();

			expect(tui.fullRedraws > redrawsBeforeImage).toBeTruthy();
			expect(terminal.getWrites().includes("\x1b[2J")).toBeTruthy();

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("reserves Kitty image rows before drawing during full redraw fallbacks", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["l0", "l1", "l2", "l3", "l4"];
			tui.start();
			await terminal.waitForRender();
			const redrawsBeforeImage = tui.fullRedraws;
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 3 },
				{ widthPx: 30, heightPx: 30 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			component.lines = ["l0", "l1", "l2", "l3", "l4", ...imageLines, "after"];
			tui.requestRender();
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			expect(tui.fullRedraws > redrawsBeforeImage).toBeTruthy();
			expect(writes.includes(`\r\n\r\n\x1b[2A${imageSequence}\x1b[2B`)).toBeTruthy();
			expect(writes.includes(`${imageSequence}\r\n\x1b[0m`)).toBeFalsy();

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("does not use cursor-up placement for Kitty images taller than the viewport", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		setCellDimensions({ widthPx: 10, heightPx: 10 });
		try {
			const terminal = new LoggingVirtualTerminal(40, 5);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["before"];
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const image = new Image(
				"AAAA",
				"image/png",
				{ fallbackColor: (value) => value },
				{ maxWidthCells: 6 },
				{ widthPx: 60, heightPx: 60 },
			);
			const imageLines = image.render(40);
			const imageSequence = imageLines[0];
			expect(imageLines.length > terminal.rows).toBeTruthy();

			component.lines = ["before", ...imageLines, "after"];
			tui.requestRender(true);
			await terminal.waitForRender();

			const writes = terminal.getWrites();
			expect(writes.includes(imageSequence)).toBeTruthy();
			expect(writes.includes(`\x1b[${imageLines.length - 1}A${imageSequence}`)).toBeFalsy();

			tui.stop();
		} finally {
			resetCapabilitiesCache();
			setCellDimensions({ widthPx: 9, heightPx: 18 });
		}
	});

	it("deletes changed image ids before drawing moved placements", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const oldImage = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 42, moveCursor: false });
		component.lines = ["top", oldImage];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		const newImage = encodeKitty("BBBB", { columns: 2, rows: 1, imageId: 42, moveCursor: false });
		component.lines = [newImage, ""];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(42));
		const drawIndex = writes.indexOf(newImage);
		expect(deleteIndex >= 0).toBeTruthy();
		expect(drawIndex >= 0).toBeTruthy();
		expect(deleteIndex < drawIndex).toBeTruthy();

		tui.stop();
	});

	it("redraws image lines when an earlier reserved image row changes", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		const image = encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 88, moveCursor: false });
		component.lines = ["", image];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["covered", image];
		tui.requestRender();
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(88));
		const drawIndex = writes.indexOf(image);
		expect(deleteIndex >= 0).toBeTruthy();
		expect(drawIndex >= 0).toBeTruthy();
		expect(deleteIndex < drawIndex).toBeTruthy();
		expect(writes.includes("\x1b[2J")).toBeFalsy();

		tui.stop();
	});

	it("deletes previously rendered image ids during full redraws", async () => {
		const terminal = new LoggingVirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = [encodeKitty("AAAA", { columns: 2, rows: 2, imageId: 77, moveCursor: false })];
		tui.start();
		await terminal.waitForRender();
		terminal.clearWrites();

		component.lines = ["plain text"];
		tui.requestRender(true);
		await terminal.waitForRender();

		const writes = terminal.getWrites();
		const deleteIndex = writes.indexOf(deleteKittyImage(77));
		const clearIndex = writes.indexOf("\x1b[2J");
		expect(deleteIndex >= 0).toBeTruthy();
		expect(clearIndex >= 0).toBeTruthy();
		expect(deleteIndex < clearIndex).toBeTruthy();

		tui.stop();
	});
});

describe("TUI resize handling", () => {
	it("triggers full re-render when terminal height changes", async () => {
		await withEnv({ TERMUX_VERSION: undefined }, async () => {
			const terminal = new VirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = ["Line 0", "Line 1", "Line 2"];
			tui.start();
			await terminal.waitForRender();

			const initialRedraws = tui.fullRedraws;

			// Resize height
			terminal.resize(40, 15);
			await terminal.waitForRender();

			// Should have triggered a full redraw
			expect(tui.fullRedraws > initialRedraws).toBeTruthy();

			const viewport = terminal.getViewport();
			expect(viewport[0]?.includes("Line 0")).toBeTruthy();

			tui.stop();
		});
	});

	it("skips full re-render on height changes in Termux", async () => {
		await withEnv({ TERMUX_VERSION: "1" }, async () => {
			const terminal = new LoggingVirtualTerminal(40, 10);
			const tui: TUI = new TuiMainScreen(terminal);
			const component = new TestComponent();
			tui.addChild(component);

			component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
			tui.start();
			await terminal.waitForRender();
			terminal.clearWrites();

			const initialRedraws = tui.fullRedraws;
			for (const height of [15, 8, 14, 11]) {
				terminal.resize(40, height);
				await terminal.waitForRender();
			}

			expect(tui.fullRedraws).toBe(initialRedraws);
			expect(terminal.getWrites().includes("\x1b[2J")).toBeFalsy();
			expect(terminal.getWrites().includes("\x1b[3J")).toBeFalsy();

			const viewport = terminal.getViewport();
			expect(viewport.join("\n").includes("Line 19")).toBeTruthy();

			tui.stop();
		});
	});

	it("triggers full re-render when terminal width changes", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Resize width
		terminal.resize(60, 10);
		await terminal.waitForRender();

		// Should have triggered a full redraw
		expect(tui.fullRedraws > initialRedraws).toBeTruthy();

		tui.stop();
	});
});

describe("TUI content shrinkage", () => {
	it("clears empty rows when content shrinks significantly", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		// Start with many lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4", "Line 5"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Shrink to fewer lines
		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		// Should have triggered a full redraw to clear empty rows
		expect(tui.fullRedraws > initialRedraws).toBeTruthy();

		const viewport = terminal.getViewport();
		expect(viewport[0]?.includes("Line 0")).toBeTruthy();
		expect(viewport[1]?.includes("Line 1")).toBeTruthy();
		// Lines below should be empty (cleared)
		expect(viewport[2]?.trim()).toBe("");
		expect(viewport[3]?.trim()).toBe("");

		tui.stop();
	});

	it("handles shrink to single line", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to single line
		component.lines = ["Only line"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		expect(viewport[0]?.includes("Only line")).toBeTruthy();
		expect(viewport[1]?.trim()).toBe("");

		tui.stop();
	});

	it("handles shrink to empty", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		tui.setClearOnShrink(true); // Explicitly enable (may be disabled via env var)
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// All lines should be empty
		expect(viewport[0]?.trim()).toBe("");
		expect(viewport[1]?.trim()).toBe("");

		tui.stop();
	});
});

describe("TUI differential rendering", () => {
	it("tracks cursor correctly when content shrinks with unchanged remaining lines", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: 5 identical lines
		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Shrink to 3 lines, all identical to before (no content changes in remaining lines)
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		// cursorRow should be 2 (last line of new content)
		// Verify by doing another render with a change on line 1
		component.lines = ["Line 0", "CHANGED", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		// Line 1 should show "CHANGED", proving cursor tracking was correct
		expect(viewport[1]?.includes("CHANGED")).toBeTruthy();

		tui.stop();
	});

	it("renders correctly when only a middle line changes (spinner case)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render
		component.lines = ["Header", "Working...", "Footer"];
		tui.start();
		await terminal.waitForRender();

		// Simulate spinner animation - only middle line changes
		const spinnerFrames = ["|", "/", "-", "\\"];
		for (const frame of spinnerFrames) {
			component.lines = ["Header", `Working ${frame}`, "Footer"];
			tui.requestRender();
			await terminal.waitForRender();

			const viewport = terminal.getViewport();
			expect(viewport[0]?.includes("Header")).toBeTruthy();
			expect(viewport[1]?.includes(`Working ${frame}`)).toBeTruthy();
			expect(viewport[2]?.includes("Footer")).toBeTruthy();
		}

		tui.stop();
	});

	it("resets styles after each rendered line", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["\x1b[3mItalic", "Plain"];
		tui.start();
		await terminal.waitForRender();

		expect(getCellItalic(terminal, 1, 0)).toBe(0);
		tui.stop();
	});

	it("renders correctly when first line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only first line
		component.lines = ["CHANGED", "Line 1", "Line 2", "Line 3"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		expect(viewport[0]?.includes("CHANGED")).toBeTruthy();
		expect(viewport[1]?.includes("Line 1")).toBeTruthy();
		expect(viewport[2]?.includes("Line 2")).toBeTruthy();
		expect(viewport[3]?.includes("Line 3")).toBeTruthy();

		tui.stop();
	});

	it("renders correctly when last line changes but rest stays same", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3"];
		tui.start();
		await terminal.waitForRender();

		// Change only last line
		component.lines = ["Line 0", "Line 1", "Line 2", "CHANGED"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		expect(viewport[0]?.includes("Line 0")).toBeTruthy();
		expect(viewport[1]?.includes("Line 1")).toBeTruthy();
		expect(viewport[2]?.includes("Line 2")).toBeTruthy();
		expect(viewport[3]?.includes("CHANGED")).toBeTruthy();

		tui.stop();
	});

	it("renders correctly when multiple non-adjacent lines change", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = ["Line 0", "Line 1", "Line 2", "Line 3", "Line 4"];
		tui.start();
		await terminal.waitForRender();

		// Change lines 1 and 3, keep 0, 2, 4 the same
		component.lines = ["Line 0", "CHANGED 1", "Line 2", "CHANGED 3", "Line 4"];
		tui.requestRender();
		await terminal.waitForRender();

		const viewport = terminal.getViewport();
		expect(viewport[0]?.includes("Line 0")).toBeTruthy();
		expect(viewport[1]?.includes("CHANGED 1")).toBeTruthy();
		expect(viewport[2]?.includes("Line 2")).toBeTruthy();
		expect(viewport[3]?.includes("CHANGED 3")).toBeTruthy();
		expect(viewport[4]?.includes("Line 4")).toBeTruthy();

		tui.stop();
	});

	it("handles transition from content to empty and back to content", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Start with content
		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.start();
		await terminal.waitForRender();

		let viewport = terminal.getViewport();
		expect(viewport[0]?.includes("Line 0")).toBeTruthy();

		// Clear to empty
		component.lines = [];
		tui.requestRender();
		await terminal.waitForRender();

		// Add content back - this should work correctly even after empty state
		component.lines = ["New Line 0", "New Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		viewport = terminal.getViewport();
		expect(viewport[0]?.includes("New Line 0")).toBeTruthy();
		expect(viewport[1]?.includes("New Line 1")).toBeTruthy();

		tui.stop();
	});

	it("full re-renders when deleted lines move the viewport upward", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 12 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = Array.from({ length: 7 }, (_, i) => `Line ${i}`);
		tui.requestRender();
		await terminal.waitForRender();

		expect(tui.fullRedraws > initialRedraws).toBeTruthy();
		expect(terminal.getViewport()).toStrictEqual(["Line 2", "Line 3", "Line 4", "Line 5", "Line 6"]);

		tui.stop();
	});

	it("appends after a shrink without another full redraw once the viewport is reset", async () => {
		const terminal = new VirtualTerminal(20, 5);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		component.lines = Array.from({ length: 8 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1"];
		tui.requestRender();
		await terminal.waitForRender();

		expect(tui.fullRedraws > initialRedraws).toBeTruthy();
		const redrawsAfterShrink = tui.fullRedraws;

		component.lines = ["Line 0", "Line 1", "Line 2"];
		tui.requestRender();
		await terminal.waitForRender();

		expect(tui.fullRedraws).toBe(redrawsAfterShrink);
		expect(terminal.getViewport()).toStrictEqual(["Line 0", "Line 1", "Line 2", "", ""]);

		tui.stop();
	});

	// Regression tests for issue #6050: scrolling up during streaming caused the
	// viewport to jump to the top because every off-screen change triggered a full
	// redraw (ESC[3J scrollback clear). The fix splits the old unconditional
	// fullRender into three cases: skip entirely when all changes are off-screen,
	// full redraw only when the buffer genuinely shrank, otherwise clamp.
	it("skips full redraw when only off-screen lines change (streaming append)", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: short content, viewport at top
		component.lines = ["Line 0", "Line 1"];
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Simulate streaming: append many lines so content overflows the viewport
		// (lines 0-9 are off-screen, only the last 10 are visible).
		component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
		tui.requestRender();
		await terminal.waitForRender();

		// Now streaming appends one more line. firstChanged is delta between
		// previousLines (length 20) and newLines (length 21) — the change is at
		// index 20, above the viewport top (10), so the diff triggers the
		// firstChanged < prevViewportTop branch. Before the fix this caused
		// fullRender(true) (scrollback clear) on every append.
		component.lines = [...Array.from({ length: 20 }, (_, i) => `Line ${i}`), "APPENDED LINE"];
		tui.requestRender();
		await terminal.waitForRender();

		// The fix: appended line is below the viewport (lastChanged >= prevViewportTop),
		// so Case C applies and the diff path is used instead of a full redraw.
		expect(tui.fullRedraws).toBe(initialRedraws);

		tui.stop();
	});

	it("skips full redraw when all changes are strictly above the viewport", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: content fits exactly in viewport
		component.lines = Array.from({ length: 10 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Grow the buffer so old content scrolls off-screen, then change ONLY
		// the off-screen lines. The visible viewport rows should not change.
		component.lines = [
			"REPLACED 0",
			"REPLACED 1",
			"REPLACED 2",
			"REPLACED 3",
			"REPLACED 4",
			"REPLACED 5",
			"REPLACED 6",
			"REPLACED 7",
			"REPLACED 8",
			"REPLACED 9",
			"Visible 0",
			"Visible 1",
			"Visible 2",
			"Visible 3",
			"Visible 4",
			"Visible 5",
			"Visible 6",
			"Visible 7",
			"Visible 8",
			"Visible 9",
		];
		tui.requestRender();
		await terminal.waitForRender();

		// Now change ONLY the off-screen lines (lines 0-9) without affecting
		// the visible 10 lines. The firstChanged = 0 is above the viewport,
		// but lastChanged = 9 is also above the viewport — Case A applies:
		// skip the draw entirely, sync state.
		component.lines = [
			"CHANGED 0",
			"CHANGED 1",
			"CHANGED 2",
			"CHANGED 3",
			"CHANGED 4",
			"CHANGED 5",
			"CHANGED 6",
			"CHANGED 7",
			"CHANGED 8",
			"CHANGED 9",
			"Visible 0",
			"Visible 1",
			"Visible 2",
			"Visible 3",
			"Visible 4",
			"Visible 5",
			"Visible 6",
			"Visible 7",
			"Visible 8",
			"Visible 9",
		];
		tui.requestRender();
		await terminal.waitForRender();

		// Case A: all changes off-screen → no full redraw, no diff write.
		expect(tui.fullRedraws).toBe(initialRedraws);

		tui.stop();
	});

	it("still triggers full redraw when buffer shrinks below the previous viewport top", async () => {
		const terminal = new VirtualTerminal(40, 10);
		const tui: TUI = new TuiMainScreen(terminal);
		const component = new TestComponent();
		tui.addChild(component);

		// Initial render: 20 lines, viewport top = 10
		component.lines = Array.from({ length: 20 }, (_, i) => `Line ${i}`);
		tui.start();
		await terminal.waitForRender();

		const initialRedraws = tui.fullRedraws;

		// Shrink to 5 lines. The new buffer (5) does not reach the previous
		// viewport top (10) — stale content from the old buffer would be
		// visible. Case B must trigger a full redraw.
		component.lines = ["A", "B", "C", "D", "E"];
		tui.requestRender();
		await terminal.waitForRender();

		expect(tui.fullRedraws > initialRedraws).toBeTruthy();

		tui.stop();
	});
});
