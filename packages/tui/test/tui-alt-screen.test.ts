import { describe, expect, it } from "vitest";
import { findAltScreenSearchMatches } from "../src/alt-screen-search.ts";
import { HStack } from "../src/components/h-stack.ts";
import { Image } from "../src/components/image.ts";
import { ScrollView } from "../src/components/scroll-view.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import { getKeybindings, KeybindingsManager, setKeybindings, TUI_KEYBINDINGS } from "../src/keybindings.ts";
import {
	encodeKitty,
	hyperlink,
	registerKittyImageMetadata,
	resetCapabilitiesCache,
	setCapabilities,
} from "../src/terminal-image.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";

class InputOverlay {
	focused = false;
	inputs: string[] = [];

	handleInput(data: string): void {
		this.inputs.push(data);
	}

	render(): string[] {
		return ["overlay"];
	}

	invalidate(): void {}
}

class RecordingTerminal extends VirtualTerminal {
	readonly events: Array<{ type: "write"; data: string } | { type: "start" } | { type: "stop" }> = [];

	override start(onInput: (data: string) => void, onResize: () => void): void {
		this.events.push({ type: "start" });
		super.start(onInput, onResize);
	}

	override write(data: string): void {
		this.events.push({ type: "write", data });
		super.write(data);
	}

	override stop(): void {
		this.events.push({ type: "stop" });
		super.stop();
	}
}

describe("TuiAltScreen", () => {
	it("renders a terminal-height viewport and preserves manual scroll position", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const text = new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		tui.addChild(text);
		tui.start();
		await terminal.waitForRender();

		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 7",
			"line 8",
			"line 9",
			"line 10",
		]);
		expect(tui.isFollowingOutput).toBe(true);

		terminal.sendInput("\x1b[<64;1;1M");
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 6",
			"line 7",
			"line 8",
			"line 9",
		]);
		expect(tui.viewportTop).toBe(5);
		expect(tui.isFollowingOutput).toBe(false);

		text.setText(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 6",
			"line 7",
			"line 8",
			"line 9",
		]);

		tui.stop();
	});

	it("keeps an explicit dock fixed while the transcript scrolls", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const dock = new VStack([new Text("editor", 0, 0), new Text("footer", 0, 0)]);
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: dock, basis: "auto", minSize: 1 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 5",
			"line 6",
			"line 7",
			"line 8",
			"editor",
			"footer",
		]);

		// Wheel over the dock falls back to the primary transcript scroll view.
		terminal.sendInput("\x1b[<64;1;6M");
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 4",
			"line 5",
			"line 6",
			"line 7",
			"editor",
			"footer",
		]);
		expect(transcript.isFollowingEnd).toBe(false);

		transcriptText.setText(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
		tui.requestRender();
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 4",
			"line 5",
			"line 6",
			"line 7",
			"editor",
			"footer",
		]);

		tui.scrollToBottom();
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 7",
			"line 8",
			"line 9",
			"line 10",
			"editor",
			"footer",
		]);
		tui.stop();
	});

	it("invalidates overlays with an explicit layout root", () => {
		const tui = new TuiAltScreen(new VirtualTerminal());
		const overlay = new Text("overlay", 0, 0);
		let invalidated = false;
		overlay.invalidate = () => {
			invalidated = true;
		};
		tui.setLayoutRoot(new Text("root", 0, 0));
		tui.showOverlay(overlay);

		tui.invalidate();

		expect(invalidated).toBe(true);
		tui.stop();
	});

	it("routes wheel input to the scroll view under the pointer", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		const left = new ScrollView(new Text("a1\na2\na3\na4\na5\na6\na7", 0, 0), {
			follow: "end",
			primary: true,
		});
		const right = new ScrollView(new Text("b1\nb2\nb3\nb4\nb5\nb6\nb7", 0, 0), { follow: "end" });
		tui.setLayoutRoot(
			new HStack([
				{ component: left, basis: 10, shrink: 0 },
				{ component: right, basis: 10, shrink: 0 },
			]),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<64;15;1M");
		await terminal.waitForRender();
		expect(left.scrollTop).toBe(3);
		expect(right.scrollTop).toBe(2);
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"a4        b3",
			"a5        b4",
			"a6        b5",
			"a7        b6",
		]);
		tui.stop();
	});

	it("uses button-motion tracking inside terminal multiplexers", () => {
		const environmentKeys = ["TMUX", "ZELLIJ", "STY", "TERM"] as const;
		const previousEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
		try {
			for (const key of environmentKeys) delete process.env[key];
			process.env.TERM = "xterm-256color";
			const directTerminal = new RecordingTerminal();
			const directTui = new TuiAltScreen(directTerminal);
			directTui.start();
			const directWrites = directTerminal.events
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			expect(directWrites.includes("\x1b[?1003h")).toBeTruthy();
			directTui.stop();

			const multiplexers = [
				{ name: "tmux environment", environment: { TMUX: "/tmp/tmux/default,1,0" } },
				{ name: "tmux TERM", environment: { TERM: "tmux-256color" } },
				{ name: "Zellij environment", environment: { ZELLIJ: "0" } },
				{ name: "Screen environment", environment: { STY: "123.session" } },
				{ name: "Screen TERM", environment: { TERM: "screen-256color" } },
			];
			for (const { name: _name, environment } of multiplexers) {
				for (const key of environmentKeys) delete process.env[key];
				for (const [key, value] of Object.entries(environment)) process.env[key] = value;
				const terminal = new RecordingTerminal();
				const tui = new TuiAltScreen(terminal);
				tui.start();
				const writes = terminal.events
					.filter((event): event is { type: "write"; data: string } => event.type === "write")
					.map((event) => event.data)
					.join("");
				expect(writes.includes("\x1b[?1002h")).toBeTruthy();
				expect(writes.includes("\x1b[?1003h")).toBeFalsy();
				expect(writes.includes("\x1b[?1006h")).toBeTruthy();
				tui.stop();
			}
		} finally {
			for (const key of environmentKeys) {
				const value = previousEnvironment.get(key);
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	});

	it("invokes the right-click paste handler only on Windows outside VS Code", () => {
		const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
		const termProgram = process.env.TERM_PROGRAM;
		expect(platformDescriptor).toBeTruthy();
		const terminal = new VirtualTerminal();
		let pasteCount = 0;
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			onRightClickPaste: () => {
				pasteCount += 1;
			},
		});
		try {
			Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
			delete process.env.TERM_PROGRAM;
			tui.start();
			terminal.sendInput("\x1b[<2;1;1M");
			terminal.sendInput("\x1b[<2;1;1m");
			expect(pasteCount).toBe(1);

			process.env.TERM_PROGRAM = "vscode";
			terminal.sendInput("\x1b[<2;1;1M");
			expect(pasteCount).toBe(1);

			Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
			delete process.env.TERM_PROGRAM;
			terminal.sendInput("\x1b[<2;1;1M");
			expect(pasteCount).toBe(1);
		} finally {
			tui.stop();
			Object.defineProperty(process, "platform", platformDescriptor!);
			if (termProgram === undefined) delete process.env.TERM_PROGRAM;
			else process.env.TERM_PROGRAM = termProgram;
		}
	});

	it("drags a visible scrollbar thumb and keeps it visible until release", async () => {
		const terminal = new RecordingTerminal(10, 5);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(
			new Text(Array.from({ length: 20 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{
				primary: true,
				scrollbar: "auto",
				scrollbarHideDelayMs: 50,
			},
		);
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		expect(scrollView.isScrollbarVisible).toBe(false);

		terminal.sendInput("\x1b[<65;10;1M");
		await terminal.waitForRender();
		expect(scrollView.scrollTop).toBe(1);
		expect(scrollView.isScrollbarVisible).toBe(true);

		terminal.sendInput("\x1b[<0;10;1M");
		await terminal.waitForRender();
		await new Promise((resolve) => setTimeout(resolve, 70));
		expect(scrollView.isScrollbarVisible).toBe(true);

		terminal.sendInput("\x1b[<32;10;4M");
		await terminal.waitForRender();
		expect(scrollView.scrollTop).toBe(15);
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 16",
			"line 17",
			"line 18",
			"line 19",
			"line 20",
		]);

		terminal.sendInput("\x1b[<0;10;4m");
		await terminal.waitForRender();
		expect(scrollView.isScrollbarVisible).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 70));
		expect(scrollView.isScrollbarVisible).toBe(true);
		terminal.sendInput("\x1b[<35;9;4M");
		await new Promise((resolve) => setTimeout(resolve, 70));
		expect(scrollView.isScrollbarVisible).toBe(false);

		terminal.sendInput("\x1b[<64;10;5M");
		await terminal.waitForRender();
		expect(scrollView.scrollTop).toBe(14);
		await new Promise((resolve) => setTimeout(resolve, 70));
		expect(scrollView.isScrollbarVisible).toBe(true);
		terminal.sendInput("\x1b[<35;9;5M");
		await new Promise((resolve) => setTimeout(resolve, 70));
		expect(scrollView.isScrollbarVisible).toBe(false);

		expect(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
		).toBeTruthy();
		tui.stop();
	});

	it("keeps the scrollbar column selectable while the thumb is hidden", async () => {
		const terminal = new RecordingTerminal(10, 2);
		const tui = new TuiAltScreen(terminal);
		const scrollView = new ScrollView(new Text("123456789A\nabcdefghij\nmore\nlines", 0, 0), {
			scrollbar: "auto",
		});
		tui.setLayoutRoot(scrollView);
		tui.start();
		await terminal.waitForRender();
		expect(scrollView.isScrollbarVisible).toBe(false);

		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<32;10;2M");
		terminal.sendInput("\x1b[<0;10;2m");
		await terminal.waitForRender();

		const expected = `\x1b]52;c;${Buffer.from("A\nabcdefghij").toString("base64")}\x07`;
		expect(terminal.events.some((event) => event.type === "write" && event.data.includes(expected))).toBeTruthy();
		tui.stop();
	});

	it("chains unused wheel delta to an outer scroll view", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, { wheelScrollLines: 3 });
		const inner = new ScrollView(new Text("i1\ni2\ni3\ni4\ni5\ni6", 0, 0));
		const outer = new ScrollView(
			new VStack([{ component: inner, basis: 2 }, new Text("tail1\ntail2\ntail3\ntail4\ntail5", 0, 0)]),
			{ primary: true },
		);
		tui.setLayoutRoot(outer);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		expect(inner.scrollTop).toBe(3);
		expect(outer.scrollTop).toBe(0);

		terminal.sendInput("\x1b[<65;1;1M");
		await terminal.waitForRender();
		expect(inner.scrollTop).toBe(4);
		expect(outer.scrollTop).toBe(2);
		tui.stop();
	});

	it("supports configurable keyboard viewport navigation with four rows of page overlap", async () => {
		const terminal = new VirtualTerminal(20, 8);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[57421u");
		terminal.sendInput("\x1b[57421;1:3u");
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 1",
			"line 2",
			"line 3",
			"line 4",
			"line 5",
			"line 6",
			"line 7",
			"line 8",
		]);

		terminal.sendInput("\x1b[57422u");
		terminal.sendInput("\x1b[57422;1:3u");
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 5",
			"line 6",
			"line 7",
			"line 8",
			"line 9",
			"line 10",
			"line 11",
			"line 12",
		]);

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 1",
			"line 2",
			"line 3",
			"line 4",
			"line 5",
			"line 6",
			"line 7",
			"line 8",
		]);

		terminal.sendInput("\x1bOF");
		await terminal.waitForRender();
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 5",
			"line 6",
			"line 7",
			"line 8",
			"line 9",
			"line 10",
			"line 11",
			"line 12",
		]);

		tui.stop();
	});

	it("searches normalized rendered transcript text across rows", () => {
		expect(findAltScreenSearchMatches(["alpha QUICK", "brown fox"], "quick brown")).toStrictEqual([
			{
				segments: [
					{ row: 0, startCol: 6, endCol: 11 },
					{ row: 1, startCol: 0, endCol: 5 },
				],
			},
		]);
	});

	it("uses configured styles for current and non-current search matches", async () => {
		const terminal = new RecordingTerminal(60, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			searchMatchStyle: (text) => `\x1b[41m${text}\x1b[49m`,
			searchCurrentMatchStyle: (text) => `\x1b[42m${text}\x1b[49m`,
		});
		tui.addChild(new Text("needle first\nmiddle\nneedle second\nend", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();

		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[42mneedle\x1b[49m")),
		).toBeTruthy();
		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[41mneedle\x1b[49m")),
		).toBeTruthy();
		tui.stop();
	});

	it("searches the transcript with Ctrl+Shift+F and restores editor focus on close", async () => {
		const terminal = new RecordingTerminal(60, 8);
		const tui = new TuiAltScreen(terminal);
		const transcriptText = new Text(
			Array.from({ length: 12 }, (_, index) => {
				if (index === 4) return "line 5 needle one";
				if (index === 9) return "line 10 needle two";
				return `line ${index + 1}`;
			}).join("\n"),
			0,
			0,
		);
		const transcript = new ScrollView(transcriptText, { follow: "end", primary: true });
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[102;6u");
		terminal.sendInput("needle");
		await terminal.waitForRender();
		expect(transcript.isFollowingEnd).toBe(false);
		expect(
			terminal.getViewport().some((line) => line.includes("Find transcript") && line.includes("2/2")),
		).toBeTruthy();
		expect(terminal.getViewport().some((line) => line.includes("line 10 needle two"))).toBeTruthy();
		expect(editorInputs).toStrictEqual([]);
		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[1;7mneedle\x1b[22;27m")),
		).toBeTruthy();

		for (let index = 0; index < 6; index++) terminal.sendInput("\x1b[<64;1;4M");
		await terminal.waitForRender();
		expect(transcript.scrollTop).toBe(0);
		expect(terminal.getViewport().some((line) => line.includes("> needle"))).toBeTruthy();

		terminal.sendInput("\x07");
		await terminal.waitForRender();
		expect(
			terminal.getViewport().some((line) => line.includes("Find transcript") && line.includes("1/2")),
		).toBeTruthy();
		expect(terminal.getViewport().some((line) => line.includes("line 5 needle one"))).toBeTruthy();

		terminal.sendInput("\x1b[103;6u");
		await terminal.waitForRender();
		expect(
			terminal.getViewport().some((line) => line.includes("Find transcript") && line.includes("2/2")),
		).toBeTruthy();
		expect(terminal.getViewport().some((line) => line.includes("line 10 needle two"))).toBeTruthy();

		terminal.sendInput("\x1b");
		terminal.sendInput("x");
		await terminal.waitForRender();
		expect(terminal.getViewport().some((line) => line.includes("Find transcript"))).toBeFalsy();
		expect(editorInputs).toStrictEqual(["x"]);

		tui.stop();
	});

	it("scrolls the transcript by half a page with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.halfPageUp": "ctrl+u",
				"tui.altScreen.halfPageDown": "ctrl+d",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			expect(tui.viewportTop).toBe(20);

			terminal.sendInput("\x15");
			await terminal.waitForRender();
			expect(tui.viewportTop).toBe(15);

			terminal.sendInput("\x04");
			await terminal.waitForRender();
			expect(tui.viewportTop).toBe(20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("scrolls the transcript by one line with custom bindings", async () => {
		const originalKeybindings = getKeybindings();
		const terminal = new VirtualTerminal(20, 10);
		const tui = new TuiAltScreen(terminal);
		setKeybindings(
			new KeybindingsManager(TUI_KEYBINDINGS, {
				"tui.altScreen.lineUp": "ctrl+y",
				"tui.altScreen.lineDown": "ctrl+e",
			}),
		);
		try {
			tui.addChild(new Text(Array.from({ length: 30 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
			tui.start();
			await terminal.waitForRender();
			expect(tui.viewportTop).toBe(20);

			terminal.sendInput("\x19");
			await terminal.waitForRender();
			expect(tui.viewportTop).toBe(19);

			terminal.sendInput("\x05");
			await terminal.waitForRender();
			expect(tui.viewportTop).toBe(20);
		} finally {
			tui.stop();
			setKeybindings(originalKeybindings);
		}
	});

	it("routes Ctrl-modified viewport navigation to the focused component", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const transcript = new ScrollView(
			new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0),
			{ follow: "end", primary: true },
		);
		const editorInputs: string[] = [];
		const editor = {
			focused: false,
			render: () => ["editor"],
			invalidate: () => {},
			handleInput: (data: string) => editorInputs.push(data),
		};
		tui.setLayoutRoot(
			new VStack([
				{ component: transcript, basis: 0, grow: 1, minSize: 1 },
				{ component: editor, basis: 1, shrink: 0 },
			]),
		);
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1bOH");
		await terminal.waitForRender();
		expect(transcript.scrollTop).toBe(0);
		expect(editorInputs).toStrictEqual([]);

		const modifiedInputs = ["\x1b[1;5H", "\x1b[1;5F", "\x1b[5;5~", "\x1b[6;5~", "\x1b[57423;5u"];
		for (const input of modifiedInputs) terminal.sendInput(input);
		terminal.sendInput("\x1b[57423;5:3u");
		await terminal.waitForRender();
		expect(transcript.scrollTop).toBe(0);
		expect(editorInputs).toStrictEqual(modifiedInputs);

		terminal.sendInput("\x1b[6~");
		await terminal.waitForRender();
		expect(transcript.scrollTop).toBe(1);
		expect(editorInputs).toStrictEqual(modifiedInputs);

		tui.stop();
	});

	it("jumps between OSC 133 semantic prompt markers", async () => {
		const terminal = new VirtualTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(
			new Text(
				[1, 2, 3, 4].flatMap((message) => [`${OSC133_ZONE_START}message ${message}`, "detail"]).join("\n"),
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();
		expect(tui.viewportTop).toBe(5);

		terminal.sendInput("\x1b[57419;6u");
		terminal.sendInput("\x1b[57419;6:3u");
		await terminal.waitForRender();
		expect(tui.viewportTop).toBe(4);
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("message 3");

		terminal.sendInput("\x1b[1;6A");
		await terminal.waitForRender();
		expect(tui.viewportTop).toBe(2);
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("message 2");

		terminal.sendInput("\x1b[57420;6u");
		terminal.sendInput("\x1b[57420;6:3u");
		await terminal.waitForRender();
		expect(tui.viewportTop).toBe(4);
		expect(terminal.getViewport()[0]?.trimEnd()).toBe("message 3");

		terminal.sendInput("\x1b[1;6B");
		await terminal.waitForRender();
		expect(tui.viewportTop).toBe(5);
		expect(terminal.getViewport()[1]?.trimEnd()).toBe("message 4");
		expect(tui.isFollowingOutput).toBe(true);

		tui.stop();
	});

	it("does not emit Kitty graphics commands or OSC 133 zones in iTerm2", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			tui.addChild({
				render: () => ["\x1b]133;B\x07\x1b]133;C\x07\x1b]133;A\x07content"],
				invalidate: () => {},
			});
			tui.addChild(
				new Image(
					"AAAA",
					"image/png",
					{ fallbackColor: (value) => value },
					{ filename: "example.png" },
					{ widthPx: 10, heightPx: 10 },
				),
			);
			tui.start();
			await terminal.waitForRender();
			tui.stop();
			expect(
				terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b_G")),
			).toBeTruthy();
			expect(
				terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]133;")),
			).toBeTruthy();
			expect(
				terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]1337;File=")),
			).toBeTruthy();
			expect(terminal.events.some((event) => event.type === "write" && event.data.includes("[Image:"))).toBeTruthy();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("clears stale iTerm2 image placements when they leave the viewport", async () => {
		setCapabilities({ images: "iterm2", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 3);
			const tui = new TuiAltScreen(terminal);
			const imageLine = "\x1b]1337;File=inline=1;width=2;height=auto:AAAA\x07";
			tui.addChild({
				render: () => [imageLine, "", "", "after", "more", "end"],
				invalidate: () => {},
			});
			tui.start();
			await terminal.waitForRender();
			tui.scrollToTop();
			await terminal.waitForRender();
			const eventCount = terminal.events.length;

			tui.scrollBy(1);
			await terminal.waitForRender();
			expect(
				terminal.events.slice(eventCount).some((event) => event.type === "write" && event.data.includes("\x1b[2J")),
			).toBeTruthy();
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("crops a Kitty image whose first line is above the viewport", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		const imageId = 123;
		const imageLine = encodeKitty("AAAA", { columns: 2, rows: 3, imageId, moveCursor: false });
		registerKittyImageMetadata({ imageId, columns: 2, rows: 3, widthPx: 100, heightPx: 100 });
		tui.addChild({
			render: () => ["before", imageLine, "", "", "after", "end"],
			invalidate: () => {},
		});
		tui.start();
		await terminal.waitForRender();

		expect(tui.viewportTop).toBe(3);
		expect(
			terminal.events.some(
				(event) => event.type === "write" && event.data.includes("i=123") && event.data.includes("y=66,h=34,r=1"),
			),
		).toBeTruthy();

		tui.stop();
	});

	it("reuses moved Kitty images without dropping HStack siblings", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 6);
			const tui = new TuiAltScreen(terminal);
			const label = new Text("left", 0, 0);
			const image = new Image(
				"A".repeat(8192),
				"image/png",
				{ fallbackColor: (value) => value },
				{},
				{ widthPx: 100, heightPx: 100 },
			);
			const header = new Text("header", 0, 0);
			const row = new HStack([
				{ component: label, basis: 10 },
				{ component: image, basis: 10 },
			]);
			tui.setLayoutRoot(
				new VStack([
					{ component: header, basis: "auto" },
					{ component: row, basis: 4 },
				]),
			);
			tui.start();
			await terminal.waitForRender();
			expect(
				terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")),
			).toBeTruthy();

			const eventCount = terminal.events.length;
			label.setText("changed");
			header.setText("header\nsecond");
			tui.requestRender();
			await terminal.waitForRender();
			const redrawWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			const placementIndex = redrawWrites.indexOf("\x1b_Ga=p,q=2");
			expect(redrawWrites.includes("\x1b_Ga=d,d=a,q=2\x1b\\")).toBeTruthy();
			expect(placementIndex > redrawWrites.indexOf("changed")).toBeTruthy();
			expect(redrawWrites.includes("\x1b_Ga=T")).toBeFalsy();
			expect(redrawWrites.length < 2000).toBeTruthy();
			expect(terminal.getViewport().some((line) => line.trimEnd() === "changed")).toBeTruthy();
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("retains recently offscreen Kitty images for placement-only reuse", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const imageId = 321;
			const imageLine = encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => [imageLine, "after"],
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			expect(
				terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b_Ga=T")),
			).toBeTruthy();

			const eventCount = terminal.events.length;
			tui.scrollBy(1);
			await terminal.waitForRender();
			tui.scrollBy(-1);
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			expect(reentryWrites.includes("\x1b_Ga=p,q=2")).toBeTruthy();
			expect(reentryWrites.includes("\x1b_Ga=T")).toBeFalsy();
			expect(reentryWrites.includes(`\x1b_Ga=d,d=I,i=${imageId},q=2\x1b\\`)).toBeFalsy();
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts the least recently visible Kitty image when the cache is full", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 500;
			const imageLines = Array.from({ length: 18 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 100, heightPx: 50 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			expect(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			).toBeTruthy();

			const eventCount = terminal.events.length;
			tui.scrollToTop();
			await terminal.waitForRender();
			const reentryWrites = terminal.events
				.slice(eventCount)
				.filter((event): event is { type: "write"; data: string } => event.type === "write")
				.map((event) => event.data)
				.join("");
			expect(reentryWrites.includes("\x1b_Ga=T")).toBeTruthy();
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("evicts offscreen Kitty images when decoded raster memory exceeds the cache quota", async () => {
		setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
		try {
			const terminal = new RecordingTerminal(20, 1);
			const tui = new TuiAltScreen(terminal);
			const firstImageId = 600;
			const imageLines = Array.from({ length: 4 }, (_, index) => {
				const imageId = firstImageId + index;
				registerKittyImageMetadata({ imageId, columns: 2, rows: 1, widthPx: 3840, heightPx: 2160 });
				return encodeKitty("AAAA", { columns: 2, rows: 1, imageId, moveCursor: false });
			});
			tui.setLayoutRoot(
				new ScrollView(
					{
						render: () => imageLines,
						invalidate: () => {},
					},
					{ primary: true },
				),
			);
			tui.start();
			await terminal.waitForRender();
			for (let index = 1; index < imageLines.length; index++) {
				tui.scrollBy(1);
				await terminal.waitForRender();
			}
			expect(
				terminal.events.some(
					(event) => event.type === "write" && event.data.includes(`\x1b_Ga=d,d=I,i=${firstImageId},q=2\x1b\\`),
				),
			).toBeTruthy();
			tui.stop();
		} finally {
			resetCapabilitiesCache();
		}
	});

	it("opens an OSC 8 hyperlink with specific or generic release codes, but not on drag", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const openedUrls: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			openUrl: (url) => openedUrls.push(url),
		});
		const url = "https://example.com/path?q=1";
		const belUrl = "https://example.com/bel";
		const emojiUrl = "https://example.com/emoji";
		tui.addChild(
			new Text(
				`${hyperlink("link", url)}\n\x1b]8;;${belUrl}\x07link\x1b]8;;\x07\n${hyperlink("🙂", emojiUrl)}`,
				0,
				0,
			),
		);
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<3;2;1m");
		await terminal.waitForRender();
		expect(openedUrls).toStrictEqual([url]);

		terminal.sendInput("\x1b[<0;2;2M");
		terminal.sendInput("\x1b[<0;2;2m");
		await terminal.waitForRender();
		expect(openedUrls).toStrictEqual([url, belUrl]);

		terminal.sendInput("\x1b[<0;2;3M");
		terminal.sendInput("\x1b[<0;2;3m");
		await terminal.waitForRender();
		expect(openedUrls).toStrictEqual([url, belUrl, emojiUrl]);

		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		expect(openedUrls).toStrictEqual([url, belUrl, emojiUrl]);

		tui.stop();
	});

	it("selects visible text with the mouse and copies it with OSC 52 after a generic release", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("\x1b[1mal\x1b[0mpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<3;4;2m");
		await terminal.waitForRender();

		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from("alpha\nbeta").toString("base64")}\x07`;
		const clipboardWrites = terminal.events.filter(
			(event) => event.type === "write" && event.data.includes("\x1b]52;c;"),
		);
		expect(
			clipboardWrites.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
		).toBeTruthy();
		expect(terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[7m"))).toBeTruthy();
		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes("al\x1b[0m\x1b[7mpha")),
		).toBeTruthy();
		expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBeTruthy();

		tui.stop();
	});

	it("uses an injected copySelection handler instead of OSC 52 and reports success", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const copied: string[] = [];
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async (text) => {
				copied.push(text);
				return true;
			},
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		expect(copied).toStrictEqual(["alpha\nbeta"]);
		expect(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
		).toBeTruthy();
		expect(terminal.getViewport().some((line) => line.includes("Copied!"))).toBeTruthy();

		tui.stop();
	});

	it("flashes an error when the injected copySelection handler fails", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal, undefined, undefined, {
			copySelection: async () => false,
		});
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();

		expect(terminal.getViewport().some((line) => line.includes("Copy failed"))).toBeTruthy();
		expect(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
		).toBeTruthy();

		tui.stop();
	});

	it("does not append whitespace to double-click word highlighting", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;3;1M");
		await terminal.waitForRender();

		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes("foo\x1b[27m")),
		).toBeTruthy();
		tui.stop();
	});

	it("coalesces slash and hyphen separated segments for double-click word selection", async () => {
		for (const { line, needle } of [
			{ line: "extensions/starline/fixed-editor/compositor.ts", needle: "starline" },
			{ line: "earendil-works/pi-tui", needle: "works" },
		]) {
			const copied: string[] = [];
			const terminal = new RecordingTerminal(80, 1);
			const tui = new TuiAltScreen(terminal, undefined, undefined, {
				copySelection: async (text) => {
					copied.push(text);
					return true;
				},
			});
			tui.addChild(new Text(line, 0, 0));
			tui.start();
			await terminal.waitForRender();

			const oneBasedClickColumn = line.indexOf(needle) + 1;
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1M`);
			terminal.sendInput(`\x1b[<0;${oneBasedClickColumn};1m`);
			await terminal.waitForRender();

			expect(copied).toStrictEqual([line]);
			tui.stop();
		}
	});

	it("highlights a complete whitespace segment during a word drag", async () => {
		const terminal = new RecordingTerminal(20, 1);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("foo  bar", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<0;2;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		await terminal.waitForRender();

		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes("foo  \x1b[27m")),
		).toBeTruthy();
		tui.stop();
	});

	it("selects whole words on double click, extends word drags, and selects lines on triple click", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("zero alpha beta\ngamma delta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		// The second click lands on a different character in alpha.
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<0;6;1m");
		terminal.sendInput("\x1b[<0;10;1M");
		terminal.sendInput("\x1b[<0;10;1m");
		await terminal.waitForRender();
		const alpha = `\x1b]52;c;${Buffer.from("alpha").toString("base64")}\x07`;
		expect(terminal.events.some((event) => event.type === "write" && event.data.includes(alpha))).toBeTruthy();

		// A double-click drag includes each word touched, rather than partial words.
		terminal.sendInput("\x1b[<0;12;1M");
		terminal.sendInput("\x1b[<0;12;1m");
		terminal.sendInput("\x1b[<0;14;1M");
		terminal.sendInput("\x1b[<32;3;2M");
		terminal.sendInput("\x1b[<0;3;2m");
		await terminal.waitForRender();
		const words = `\x1b]52;c;${Buffer.from("beta\ngamma").toString("base64")}\x07`;
		expect(terminal.events.some((event) => event.type === "write" && event.data.includes(words))).toBeTruthy();

		terminal.sendInput("\x1b[<0;7;2M");
		terminal.sendInput("\x1b[<0;7;2m");
		terminal.sendInput("\x1b[<0;9;2M");
		terminal.sendInput("\x1b[<0;9;2m");
		terminal.sendInput("\x1b[<0;11;2M");
		terminal.sendInput("\x1b[<0;11;2m");
		await terminal.waitForRender();
		const line = `\x1b]52;c;${Buffer.from("gamma delta").toString("base64")}\x07`;
		expect(terminal.events.some((event) => event.type === "write" && event.data.includes(line))).toBeTruthy();

		tui.stop();
	});

	it("does not repaint idle or zero-width selections on focus loss", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const writeCount = () => terminal.events.filter((event) => event.type === "write").length;
		const clipboardWriteCount = () =>
			terminal.events.filter((event) => event.type === "write" && event.data.includes("\x1b]52;c;")).length;

		const idleWriteCount = writeCount();
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		expect(writeCount()).toBe(idleWriteCount);

		// A completed click leaves a zero-width anchor, but later orphaned drag/release events must not extend it.
		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<0;1;1m");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		expect(clipboardWriteCount()).toBe(0);

		// Losing focus after a press without a drag cancels the press without repainting.
		terminal.sendInput("\x1b[<0;1;3M");
		await terminal.waitForRender();
		const pressedWriteCount = writeCount();
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		expect(writeCount()).toBe(pressedWriteCount);
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		expect(clipboardWriteCount()).toBe(0);
		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004h")),
		).toBeTruthy();

		tui.stop();
		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes("\x1b[?1004l")),
		).toBeTruthy();
	});

	it("clears an active visible selection on focus loss and ignores orphan events", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		await terminal.waitForRender();
		const focusLossEventCount = terminal.events.length;
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		const focusLossWrites = terminal.events
			.slice(focusLossEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		expect(focusLossWrites.includes("alpha")).toBeTruthy();
		expect(focusLossWrites.includes("beta")).toBeTruthy();
		expect(focusLossWrites.includes("\x1b[7m")).toBeFalsy();

		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		expect(
			terminal.events.every((event) => event.type !== "write" || !event.data.includes("\x1b]52;c;")),
		).toBeTruthy();
		tui.stop();
	});

	it("retains a completed visible selection across focus changes", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("alpha\nbeta\ngamma\ndelta", 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<0;1;1M");
		terminal.sendInput("\x1b[<32;4;2M");
		terminal.sendInput("\x1b[<0;4;2m");
		await terminal.waitForRender();
		const completedWriteCount = terminal.events.filter((event) => event.type === "write").length;
		terminal.sendInput("\x1b[O");
		terminal.sendInput("\x1b[I");
		await terminal.waitForRender();
		expect(terminal.events.filter((event) => event.type === "write").length).toBe(completedWriteCount);

		const redrawEventCount = terminal.events.length;
		tui.renderNow(true);
		const redrawWrites = terminal.events
			.slice(redrawEventCount)
			.filter((event): event is { type: "write"; data: string } => event.type === "write")
			.map((event) => event.data)
			.join("");
		expect(redrawWrites.includes("alpha")).toBeTruthy();
		expect(redrawWrites.includes("beta")).toBeTruthy();
		expect(redrawWrites.includes("\x1b[7m")).toBeTruthy();
		tui.stop();
	});

	it("stacks flash messages and collapses them as they expire", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("one\ntwo\nthree\nfour", 0, 0));
		tui.start();
		await terminal.waitForRender();

		tui.flash("First", 80);
		tui.flash("Second", 500);
		await terminal.waitForRender();
		let viewport = terminal.getViewport();
		expect(viewport[0]?.endsWith(" First ")).toBeTruthy();
		expect(viewport[1]?.endsWith(" Second ")).toBeTruthy();

		await new Promise((resolve) => setTimeout(resolve, 100));
		await terminal.waitForRender();
		viewport = terminal.getViewport();
		expect(viewport[0]?.endsWith(" Second ")).toBeTruthy();
		expect(viewport.some((line) => line.includes("First"))).toBeFalsy();

		tui.stop();
	});

	it("auto-scrolls and extends a drag selection held at the viewport edge", async () => {
		const terminal = new RecordingTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		expect(tui.viewportTop).toBe(6);

		terminal.sendInput("\x1b[<0;1;3M");
		terminal.sendInput("\x1b[<32;1;1M");
		await new Promise((resolve) => setTimeout(resolve, 130));
		await terminal.waitForRender();

		const selectionTop = tui.viewportTop;
		expect(selectionTop < 6).toBeTruthy();
		terminal.sendInput("\x1b[<0;1;1m");
		await terminal.waitForRender();

		const selectedLines = Array.from({ length: 8 - selectionTop }, (_, index) => `line ${selectionTop + index + 1}`);
		selectedLines.push("l");
		const expectedClipboardSequence = `\x1b]52;c;${Buffer.from(selectedLines.join("\n")).toString("base64")}\x07`;
		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes(expectedClipboardSequence)),
		).toBeTruthy();
		tui.stop();
	});

	it("snaps mouse selection to CJK, emoji, and combining grapheme boundaries", async () => {
		const terminal = new RecordingTerminal(20, 2);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("A界🙂éZ", 0, 0));
		tui.start();
		await terminal.waitForRender();

		const wideSelection = `\x1b]52;c;${Buffer.from("界🙂").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;3;1M");
		terminal.sendInput("\x1b[<32;4;1M");
		terminal.sendInput("\x1b[<0;4;1m");
		await terminal.waitForRender();
		expect(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
		).toBe(1);

		terminal.sendInput("\x1b[<0;5;1M");
		terminal.sendInput("\x1b[<32;2;1M");
		terminal.sendInput("\x1b[<0;2;1m");
		await terminal.waitForRender();
		expect(
			terminal.events.filter((event) => event.type === "write" && event.data.includes(wideSelection)).length,
		).toBe(2);

		const combiningSelection = `\x1b]52;c;${Buffer.from("éZ").toString("base64")}\x07`;
		terminal.sendInput("\x1b[<0;6;1M");
		terminal.sendInput("\x1b[<32;7;1M");
		terminal.sendInput("\x1b[<0;7;1m");
		await terminal.waitForRender();
		expect(
			terminal.events.some((event) => event.type === "write" && event.data.includes(combiningSelection)),
		).toBeTruthy();

		tui.stop();
	});

	it("ignores horizontal trackpad wheel events", async () => {
		const terminal = new VirtualTerminal(20, 4);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();

		terminal.sendInput("\x1b[<66;1;1M");
		terminal.sendInput("\x1b[<67;1;1M");
		await terminal.waitForRender();
		expect(tui.viewportTop).toBe(4);
		expect(terminal.getViewport().map((line) => line.trimEnd())).toStrictEqual([
			"line 5",
			"line 6",
			"line 7",
			"line 8",
		]);

		tui.stop();
	});

	it("restores keyboard state before leaving alt mode and prints the full document", async () => {
		const terminal = new RecordingTerminal(20, 3);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text("first\nsecond\nthird\nfourth\nfifth\nsixth", 0, 0));
		tui.start();
		await terminal.waitForRender();
		tui.stop();

		const startIndex = terminal.events.findIndex((event) => event.type === "start");
		const altScreenEnterIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049h"),
		);
		const stopIndex = terminal.events.findIndex((event) => event.type === "stop");
		const mouseDisableIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1006l"),
		);
		const mainScreenRestoreIndex = terminal.events.findIndex(
			(event) => event.type === "write" && event.data.includes("\x1b[?1049l"),
		);
		expect(altScreenEnterIndex >= 0 && altScreenEnterIndex < startIndex).toBeTruthy();
		expect(mouseDisableIndex >= 0 && mouseDisableIndex < stopIndex).toBeTruthy();
		expect(mainScreenRestoreIndex > stopIndex).toBeTruthy();

		const restoreEvent = terminal.events[mainScreenRestoreIndex];
		expect(restoreEvent?.type).toBe("write");
		if (restoreEvent?.type === "write") {
			expect(restoreEvent.data.includes("first")).toBeTruthy();
			expect(restoreEvent.data.includes("second")).toBeTruthy();
			expect(restoreEvent.data.includes("third")).toBeTruthy();
			expect(restoreEvent.data.includes("fourth")).toBeTruthy();
			expect(restoreEvent.data.includes("fifth")).toBeTruthy();
			expect(restoreEvent.data.includes("sixth")).toBeTruthy();
			expect(restoreEvent.data.indexOf("first") < restoreEvent.data.indexOf("sixth")).toBeTruthy();
		}
	});

	it("gives wheel and viewport keys to a focused overlay", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		const overlay = new InputOverlay();
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;
		const handle = tui.showOverlay(overlay);
		await terminal.waitForRender();
		expect(overlay.focused).toBe(true);

		const wheel = "\x1b[<64;10;3M";
		const keys = ["\x1b[5~", "\x1b[6~", "\x1bOH", "\x1bOF", wheel];
		for (const key of keys) terminal.sendInput(key);
		await terminal.waitForRender();

		expect(overlay.inputs).toStrictEqual(keys);
		expect(tui.viewportTop).toBe(topBefore);

		handle.hide();
		await terminal.waitForRender();
		terminal.sendInput("\x1b[5~");
		await terminal.waitForRender();
		expect(tui.viewportTop < topBefore).toBeTruthy();
		tui.stop();
	});

	it("keeps viewport scrolling when an overlay is not focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		const editor = new InputOverlay();
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.setFocus(editor);
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;

		const hidden = tui.showOverlay(new InputOverlay());
		hidden.setHidden(true);
		const nonCapturing = new InputOverlay();
		tui.showOverlay(nonCapturing, { nonCapturing: true });
		const unfocused = new InputOverlay();
		const unfocusedHandle = tui.showOverlay(unfocused);
		unfocusedHandle.unfocus();
		await terminal.waitForRender();
		expect(nonCapturing.focused).toBe(false);
		expect(unfocused.focused).toBe(false);

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;10;3M");
		await terminal.waitForRender();
		expect(tui.viewportTop < topBefore).toBeTruthy();
		expect(nonCapturing.inputs).toStrictEqual([]);
		expect(unfocused.inputs).toStrictEqual([]);
		tui.stop();
	});

	it("keeps viewport scrolling while transcript search is focused", async () => {
		const terminal = new VirtualTerminal(20, 6);
		const tui = new TuiAltScreen(terminal);
		tui.addChild(new Text(Array.from({ length: 12 }, (_, index) => `line ${index + 1}`).join("\n"), 0, 0));
		tui.start();
		await terminal.waitForRender();
		const topBefore = tui.viewportTop;

		terminal.sendInput("\x1b[102;6u");
		await terminal.waitForRender();
		expect(terminal.getViewport().some((line) => line.includes("Find transcript"))).toBeTruthy();

		terminal.sendInput("\x1b[5~");
		terminal.sendInput("\x1b[<64;1;4M");
		await terminal.waitForRender();
		expect(tui.viewportTop < topBefore).toBeTruthy();
		expect(terminal.getViewport().some((line) => line.includes("Find transcript"))).toBeTruthy();
		tui.stop();
	});
});
