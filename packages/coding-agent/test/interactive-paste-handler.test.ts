import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { Editor, PasteAttachment } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const clipboardMocks = vi.hoisted(() => ({
	readClipboardImage: vi.fn(),
	readClipboardText: vi.fn(),
	processImage: vi.fn(),
	extensionForImageMimeType: vi.fn(),
}));

vi.mock("../src/utils/clipboard-image.ts", () => ({
	readClipboardImage: clipboardMocks.readClipboardImage,
	extensionForImageMimeType: clipboardMocks.extensionForImageMimeType,
}));

vi.mock("../src/utils/clipboard.ts", () => ({
	readClipboardText: clipboardMocks.readClipboardText,
}));

vi.mock("../src/utils/image-process.ts", () => ({
	processImage: clipboardMocks.processImage,
}));

type PasteEditorStub = Pick<Editor, "pasteText" | "pasteImage">;

type PasteHandlerContext = {
	editor: PasteEditorStub;
	ui: { requestRender: () => void };
};

type SubmitHandlerContext = {
	defaultEditor: { onSubmit?: (payload: { text: string; attachments: PasteAttachment[] }) => void };
	editor: { addToHistory?: (text: string) => void; setText: (text: string) => void };
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	flushPendingBashComponents: () => void;
	onInputCallback?: (input: { text: string; images: ImageContent[] }) => void;
	pendingUserInputs: Array<{ text: string; images: ImageContent[] }>;
};

type InteractiveModePrivate = {
	handleClipboardPasteText(this: PasteHandlerContext): Promise<void>;
	setupEditorSubmitHandler(this: SubmitHandlerContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function makeImageBytes(): Uint8Array {
	return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

beforeEach(() => {
	clipboardMocks.readClipboardImage.mockReset();
	clipboardMocks.readClipboardText.mockReset();
	clipboardMocks.processImage.mockReset();
	clipboardMocks.extensionForImageMimeType.mockReset();
});

describe("InteractiveMode paste handlers", () => {
	it("handleClipboardPasteText forces the text through the editor's pasteText with forceMarker", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("Hello, world");
		const pasteText = vi.fn();
		const context: PasteHandlerContext = {
			editor: { pasteText, pasteImage: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await interactiveModePrototype.handleClipboardPasteText.call(context);

		expect(clipboardMocks.readClipboardText).toHaveBeenCalledTimes(1);
		expect(pasteText).toHaveBeenCalledWith("Hello, world", { forceMarker: true });
		expect(context.ui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("handleClipboardPasteText does nothing when the clipboard is empty", async () => {
		clipboardMocks.readClipboardText.mockResolvedValue("");
		const pasteText = vi.fn();
		const requestRender = vi.fn();
		const context: PasteHandlerContext = {
			editor: { pasteText, pasteImage: vi.fn() },
			ui: { requestRender },
		};

		await interactiveModePrototype.handleClipboardPasteText.call(context);

		expect(pasteText).not.toHaveBeenCalled();
		expect(requestRender).not.toHaveBeenCalled();
	});

	it("handleClipboardPasteText swallows clipboard errors", async () => {
		clipboardMocks.readClipboardText.mockRejectedValue(new Error("permission denied"));
		const pasteText = vi.fn();
		const context: PasteHandlerContext = {
			editor: { pasteText, pasteImage: vi.fn() },
			ui: { requestRender: vi.fn() },
		};

		await expect(interactiveModePrototype.handleClipboardPasteText.call(context)).resolves.toBeUndefined();
		expect(pasteText).not.toHaveBeenCalled();
	});
});

describe("InteractiveMode submit image extraction", () => {
	function createSubmitContext(): SubmitHandlerContext {
		return {
			defaultEditor: {},
			editor: {
				addToHistory: vi.fn(),
				setText: vi.fn(),
			},
			session: {
				isCompacting: false,
				isStreaming: false,
				isBashRunning: false,
				prompt: vi.fn(async () => {}),
			},
			flushPendingBashComponents: vi.fn(),
			pendingUserInputs: [],
		};
	}

	it("extracts image attachments and forwards them to session.prompt as ImageContent", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);
		// Installing an input callback short-circuits the pending queue path and
		// routes the prompt straight into session.prompt with the images payload.
		context.onInputCallback = vi.fn();

		const imageBytes = makeImageBytes();
		const attachments: PasteAttachment[] = [
			{ kind: "image", mimeType: "image/png", bytes: imageBytes, fileName: "shot.png" },
		];

		await context.defaultEditor.onSubmit?.({ text: " describe this", attachments });

		expect(context.onInputCallback).toHaveBeenCalledWith({
			text: "describe this",
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: Buffer.from(imageBytes).toString("base64"),
				},
			],
		});
	});

	it("propagates images through pendingUserInputs when no callback is installed", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		const imageBytes = makeImageBytes();
		const attachments: PasteAttachment[] = [
			{ kind: "image", mimeType: "image/png", bytes: imageBytes, fileName: "shot.png" },
		];

		await context.defaultEditor.onSubmit?.({ text: "hello", attachments });

		expect(context.pendingUserInputs).toHaveLength(1);
		expect(context.pendingUserInputs[0]?.text).toBe("hello");
		expect(context.pendingUserInputs[0]?.images).toEqual([
			{
				type: "image",
				mimeType: "image/png",
				data: Buffer.from(imageBytes).toString("base64"),
			},
		]);
	});

	it("does not produce image blocks for text-only attachments", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		const attachments: PasteAttachment[] = [{ kind: "text", content: "long pasted blob" }];

		await context.defaultEditor.onSubmit?.({ text: "describe", attachments });

		expect(context.pendingUserInputs).toEqual([{ text: "describe", images: [] }]);
		// The session.prompt helper is only invoked for non-pending flows; ensure no
		// images leak through the in-memory queue.
		expect(context.pendingUserInputs[0]?.images).toEqual([]);
	});

	it("returns images as undefined when there are no attachments", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.({ text: "plain prompt", attachments: [] });

		expect(context.pendingUserInputs).toEqual([{ text: "plain prompt", images: [] }]);
	});

	it("submits an image-only payload when the user clears the text", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		const imageBytes = makeImageBytes();
		const attachments: PasteAttachment[] = [
			{ kind: "image", mimeType: "image/png", bytes: imageBytes, fileName: "shot.png" },
		];

		await context.defaultEditor.onSubmit?.({ text: "", attachments });

		expect(context.pendingUserInputs).toHaveLength(1);
		expect(context.pendingUserInputs[0]).toEqual({
			text: "",
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: Buffer.from(imageBytes).toString("base64"),
				},
			],
		});
	});

	it("skips the submit when text is empty and there are no image attachments", async () => {
		const context = createSubmitContext();
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.({ text: "   ", attachments: [] });

		expect(context.pendingUserInputs).toEqual([]);
		expect(context.session.prompt).not.toHaveBeenCalled();
		expect(context.editor.addToHistory).not.toHaveBeenCalled();
	});
});
