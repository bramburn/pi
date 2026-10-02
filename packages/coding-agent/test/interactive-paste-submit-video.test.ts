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
		model?: { name: string; api: string };
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

const GOOGLE_MODEL = { name: "Gemini 2.5 Pro", api: "google-generative-ai" };
const NON_GOOGLE_MODEL = { name: "Claude", api: "anthropic-messages" };

function makeVideoAttachment(): PasteAttachment {
	return { kind: "video", mimeType: "video/mp4", bytes: new Uint8Array([0, 0, 0, 24]), fileName: "clip.mp4" };
}

function makeContext(model?: { name: string; api: string }) {
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
});
