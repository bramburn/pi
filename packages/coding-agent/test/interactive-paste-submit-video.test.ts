import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { PasteAttachment } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type SubmitContext = {
	defaultEditor: { onSubmit?: (payload: { text: string; attachments: PasteAttachment[] }) => void };
	editor: {
		getAttachments?(): PasteAttachment[];
		getText(): string;
		getExpandedText?(): string;
		setText(text: string): void;
		addToHistory?(text: string): void;
	};
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
		model?: { name: string; api: string; input: string[] };
	};
	updatePendingMessagesDisplay(): void;
	ui: { requestRender: () => void };
	isExtensionCommand(text: string): boolean;
	queueCompactionMessage(text: string, mode: "steer" | "followUp", images: ImageContent[]): void;
	onInputCallback?: (input: { text: string; images: ImageContent[] }) => void;
	pendingUserInputs: Array<{ text: string; images: ImageContent[] }>;
	flushPendingBashComponents(): void;
	showWarning(message: string): void;
};

type InteractiveModePrivate = {
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

const GOOGLE_MODEL = { name: "Gemini 2.5 Pro", api: "google-generative-ai", input: ["text", "image"] };
const NON_GOOGLE_MODEL = { name: "Claude", api: "anthropic-messages", input: ["text", "image"] };

function makeVideoAttachment(): PasteAttachment {
	return { kind: "video", mimeType: "video/mp4", bytes: new Uint8Array([0, 0, 0, 24]), fileName: "clip.mp4" };
}

function makePdfAttachment(): PasteAttachment {
	return {
		kind: "pdf",
		mimeType: "application/pdf",
		bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
		fileName: "doc.pdf",
	};
}

function makeContext(model?: { name: string; api: string; input: string[] }) {
	const onInputCallback = vi.fn<(input: { text: string; images: ImageContent[] }) => void>();
	const showWarning = vi.fn<(message: string) => void>();
	const context: SubmitContext = {
		defaultEditor: {},
		editor: {
			getAttachments: vi.fn(() => []),
			getText: () => "",
			setText: vi.fn(),
		},
		session: {
			isCompacting: false,
			isStreaming: false,
			isBashRunning: false,
			prompt: vi.fn(async () => {}),
			...(model && { model }),
		},
		updatePendingMessagesDisplay: vi.fn(),
		ui: { requestRender: vi.fn() },
		isExtensionCommand: vi.fn(() => false),
		queueCompactionMessage: vi.fn<(text: string, mode: "steer" | "followUp", images: ImageContent[]) => void>(),
		onInputCallback,
		pendingUserInputs: [],
		flushPendingBashComponents: vi.fn(),
		showWarning,
	};
	interactiveModePrototype.setupEditorSubmitHandler.call(context);
	return { context, onInputCallback, showWarning };
}

function videoBlock(): ImageContent {
	return {
		type: "video",
		mimeType: "video/mp4",
		data: Buffer.from([0, 0, 0, 24]).toString("base64"),
	} as unknown as ImageContent;
}

function pdfBlock(): ImageContent {
	return {
		type: "pdf",
		mimeType: "application/pdf",
		data: Buffer.from([0x25, 0x50, 0x44, 0x46]).toString("base64"),
	} as unknown as ImageContent;
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("InteractiveMode video submits", () => {
	it("forwards video attachments when the model API supports video", async () => {
		const { context, onInputCallback, showWarning } = makeContext(GOOGLE_MODEL);

		await context.defaultEditor.onSubmit?.({ text: "look at this", attachments: [makeVideoAttachment()] });

		expect(onInputCallback).toHaveBeenCalledWith({
			text: "look at this",
			images: [videoBlock()],
		});
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("submits a video-only message when the model API supports video", async () => {
		const { context, onInputCallback, showWarning } = makeContext(GOOGLE_MODEL);

		await context.defaultEditor.onSubmit?.({ text: "", attachments: [makeVideoAttachment()] });

		expect(onInputCallback).toHaveBeenCalledWith({
			text: "",
			images: [videoBlock()],
		});
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("drops video attachments with a warning when the model API does not support video", async () => {
		const { context, onInputCallback, showWarning } = makeContext(NON_GOOGLE_MODEL);

		await context.defaultEditor.onSubmit?.({ text: "look at this", attachments: [makeVideoAttachment()] });

		expect(onInputCallback).toHaveBeenCalledWith({
			text: "look at this",
			images: [],
		});
		expect(showWarning).toHaveBeenCalledWith(
			'"Claude" does not support video input; video attachments were not sent.',
		);
	});

	it("does not submit a video-only message when the model API does not support video", async () => {
		const { context, onInputCallback, showWarning } = makeContext(NON_GOOGLE_MODEL);

		await context.defaultEditor.onSubmit?.({ text: "", attachments: [makeVideoAttachment()] });

		expect(onInputCallback).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toHaveLength(0);
		expect(showWarning).toHaveBeenCalledWith(
			'"Claude" does not support video input; video attachments were not sent.',
		);
	});

	it("keeps image attachments alongside video handling", async () => {
		const { context, onInputCallback } = makeContext(NON_GOOGLE_MODEL);
		const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

		await context.defaultEditor.onSubmit?.({
			text: "both",
			attachments: [
				{ kind: "image", mimeType: "image/png", bytes: imageBytes, fileName: "shot.png" },
				makeVideoAttachment(),
			],
		});

		expect(onInputCallback).toHaveBeenCalledWith({
			text: "both",
			images: [
				{
					type: "image",
					mimeType: "image/png",
					data: Buffer.from(imageBytes).toString("base64"),
				},
			],
		});
	});

	it("forwards PDF attachments when the model accepts PDFs", async () => {
		const { context, onInputCallback, showWarning } = makeContext(GOOGLE_MODEL);

		await context.defaultEditor.onSubmit?.({ text: "see attached", attachments: [makePdfAttachment()] });

		expect(onInputCallback).toHaveBeenCalledWith({
			text: "see attached",
			images: [pdfBlock()],
		});
		expect(showWarning).not.toHaveBeenCalled();
	});

	it("drops video/pdf with warnings when the registry declares the model text-only", async () => {
		const textOnlyGemini = { name: "Gemini Lite", api: "google-generative-ai", input: ["text"] };
		const { context, onInputCallback, showWarning } = makeContext(textOnlyGemini);

		await context.defaultEditor.onSubmit?.({
			text: "both",
			attachments: [makeVideoAttachment(), makePdfAttachment()],
		});

		expect(onInputCallback).toHaveBeenCalledWith({ text: "both", images: [] });
		expect(showWarning).toHaveBeenCalledWith(
			'"Gemini Lite" does not support video input; video attachments were not sent.',
		);
		expect(showWarning).toHaveBeenCalledWith(
			'"Gemini Lite" does not support PDF input; PDF attachments were not sent.',
		);
	});

	it("does not submit a PDF-only message when the registry declares the model text-only", async () => {
		const textOnlyGemini = { name: "Gemini Lite", api: "google-generative-ai", input: ["text"] };
		const { context, onInputCallback, showWarning } = makeContext(textOnlyGemini);

		await context.defaultEditor.onSubmit?.({ text: "", attachments: [makePdfAttachment()] });

		expect(onInputCallback).not.toHaveBeenCalled();
		expect(context.pendingUserInputs).toHaveLength(0);
		expect(showWarning).toHaveBeenCalledWith(
			'"Gemini Lite" does not support PDF input; PDF attachments were not sent.',
		);
	});
});
