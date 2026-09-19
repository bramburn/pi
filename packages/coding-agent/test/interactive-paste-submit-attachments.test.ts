import type { ImageContent } from "@earendil-works/pi-ai/compat";
import type { PasteAttachment } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

type FollowUpEditor = {
	getText(): string;
	getExpandedText?(): string;
	getAttachments?(): PasteAttachment[];
	setText(text: string): void;
	addToHistory?(text: string): void;
	onSubmit?(payload: { text: string; attachments: PasteAttachment[] }): void;
};

type FollowUpContext = {
	editor: FollowUpEditor;
	session: {
		isCompacting: boolean;
		isStreaming: boolean;
		isBashRunning: boolean;
		prompt: (text: string, options?: unknown) => Promise<void>;
	};
	updatePendingMessagesDisplay(): void;
	ui: { requestRender: () => void };
	isExtensionCommand(text: string): boolean;
	queueCompactionMessage(text: string, mode: "steer" | "followUp", images: ImageContent[]): void;
};

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
	};
	updatePendingMessagesDisplay(): void;
	ui: { requestRender: () => void };
	isExtensionCommand(text: string): boolean;
	queueCompactionMessage(text: string, mode: "steer" | "followUp", images: ImageContent[]): void;
	onInputCallback?: (input: { text: string; images: ImageContent[] }) => void;
	pendingUserInputs: Array<{ text: string; images: ImageContent[] }>;
	flushPendingBashComponents(): void;
};

type InteractiveModePrivate = {
	handleFollowUp(this: FollowUpContext): Promise<void>;
	setupEditorSubmitHandler(this: SubmitContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrivate;

function makeImageBytes(): Uint8Array {
	return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
}

beforeEach(() => {
	vi.restoreAllMocks();
});

describe("InteractiveMode image-only submits", () => {
	it("setupEditorSubmitHandler does not short-circuit when text is empty but images are attached", async () => {
		const sessionPrompt = vi.fn(async () => {});
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
				prompt: sessionPrompt,
			},
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
			isExtensionCommand: vi.fn(() => false),
			queueCompactionMessage: vi.fn(),
			onInputCallback: vi.fn(),
			pendingUserInputs: [],
			flushPendingBashComponents: vi.fn(),
		};
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		const imageBytes = makeImageBytes();
		const attachments: PasteAttachment[] = [
			{ kind: "image", mimeType: "image/png", bytes: imageBytes, fileName: "shot.png" },
		];

		await context.defaultEditor.onSubmit?.({ text: "", attachments });

		expect(context.onInputCallback).toHaveBeenCalledWith({
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

	it("setupEditorSubmitHandler keeps the existing behaviour of dropping whitespace-only prompts without images", async () => {
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
			},
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
			isExtensionCommand: vi.fn(() => false),
			queueCompactionMessage: vi.fn(),
			onInputCallback: vi.fn(),
			pendingUserInputs: [],
			flushPendingBashComponents: vi.fn(),
		};
		interactiveModePrototype.setupEditorSubmitHandler.call(context);

		await context.defaultEditor.onSubmit?.({ text: "  \n  ", attachments: [] });

		expect(context.pendingUserInputs).toEqual([]);
		expect(context.onInputCallback).not.toHaveBeenCalled();
		expect(context.flushPendingBashComponents).not.toHaveBeenCalled();
	});

	it("handleFollowUp forwards an image-only payload when text is empty but images are attached", async () => {
		const sessionPrompt = vi.fn(async () => {});
		const editorOnSubmit = vi.fn();
		const context: FollowUpContext = {
			editor: {
				getText: () => "",
				getAttachments: vi.fn(() => []),
				setText: vi.fn(),
				onSubmit: editorOnSubmit,
			},
			session: {
				isCompacting: false,
				isStreaming: false,
				isBashRunning: false,
				prompt: sessionPrompt,
			},
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
			isExtensionCommand: vi.fn(() => false),
			queueCompactionMessage: vi.fn(),
		};

		const imageBytes = makeImageBytes();
		const attachments: PasteAttachment[] = [
			{ kind: "image", mimeType: "image/png", bytes: imageBytes, fileName: "shot.png" },
		];
		context.editor.getAttachments = vi.fn(() => attachments);

		await interactiveModePrototype.handleFollowUp.call(context);

		expect(context.editor.setText).toHaveBeenCalledWith("");
		expect(editorOnSubmit).toHaveBeenCalledWith({ text: "", attachments });
		// The important behaviour is that it did NOT short-circuit and drop the image.
		expect(sessionPrompt).not.toHaveBeenCalled();
		expect(context.queueCompactionMessage).not.toHaveBeenCalled();
	});

	it("handleFollowUp queues a follow-up with images during streaming", async () => {
		const sessionPrompt = vi.fn(async () => {});
		const context: FollowUpContext = {
			editor: {
				getText: () => "",
				getAttachments: vi.fn(() => []),
				addToHistory: vi.fn(),
				setText: vi.fn(),
			},
			session: {
				isCompacting: false,
				isStreaming: true,
				isBashRunning: false,
				prompt: sessionPrompt,
			},
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
			isExtensionCommand: vi.fn(() => false),
			queueCompactionMessage: vi.fn(),
		};

		const imageBytes = makeImageBytes();
		const attachments: PasteAttachment[] = [
			{ kind: "image", mimeType: "image/png", bytes: imageBytes, fileName: "shot.png" },
		];
		context.editor.getAttachments = vi.fn(() => attachments);

		await interactiveModePrototype.handleFollowUp.call(context);

		expect(sessionPrompt).toHaveBeenCalledWith(
			"",
			expect.objectContaining({
				streamingBehavior: "followUp",
				images: [
					{
						type: "image",
						mimeType: "image/png",
						data: Buffer.from(imageBytes).toString("base64"),
					},
				],
			}),
		);
	});

	it("handleFollowUp still short-circuits when both text and attachments are empty", async () => {
		const sessionPrompt = vi.fn(async () => {});
		const context: FollowUpContext = {
			editor: {
				getText: () => "",
				getAttachments: vi.fn(() => []),
				setText: vi.fn(),
			},
			session: {
				isCompacting: false,
				isStreaming: false,
				isBashRunning: false,
				prompt: sessionPrompt,
			},
			updatePendingMessagesDisplay: vi.fn(),
			ui: { requestRender: vi.fn() },
			isExtensionCommand: vi.fn(() => false),
			queueCompactionMessage: vi.fn(),
		};

		await interactiveModePrototype.handleFollowUp.call(context);

		expect(sessionPrompt).not.toHaveBeenCalled();
		expect(context.editor.setText).not.toHaveBeenCalled();
	});
});