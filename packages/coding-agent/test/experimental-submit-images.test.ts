import type { ImageContent } from "@earendil-works/pi-ai";
import type { PasteAttachment } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { LaneServiceApi } from "../src/experimental/mini/shared/protocol.ts";
import type { MicroController } from "../src/experimental/micro/api.ts";

/**
 * Type-level smoke test: the controllers in the experimental mini/micro TUIs now expose an optional
 * `images` parameter on `prompt`/`steer`/`followUp`. This file documents the expected signature
 * shape by constructing handlers with the same shape used by `view.ts` and `tui.ts` and asserts
 * that they accept the widened payload.
 */
describe("Experimental mini/micro submit payload forwarding", () => {
	it("LaneServiceApi.prompt accepts an optional images array", () => {
		const images: ImageContent[] = [
			{ type: "image", data: "Zm9v", mimeType: "image/png" },
		];
		const lane: LaneServiceApi = {
			watch: vi.fn(),
			start: vi.fn(),
			unwatch: vi.fn(),
			prompt: vi.fn(),
			steer: vi.fn(),
			followUp: vi.fn(),
			compact: vi.fn(),
			abort: vi.fn(),
			setModel: vi.fn(),
		};
		lane.prompt("hello", images);
		expect(lane.prompt).toHaveBeenCalledWith("hello", images);
	});

	it("MicroController.prompt/steer/followUp accept an optional images array", () => {
		const images: ImageContent[] = [
			{ type: "image", data: "Zm9v", mimeType: "image/png" },
		];
		const controller: MicroController = {
			prompt: vi.fn(async () => {}),
			steer: vi.fn(async () => {}),
			followUp: vi.fn(async () => {}),
			compact: vi.fn(async () => {}),
			abort: vi.fn(async () => {}),
			cycleThinking: vi.fn(async () => {}),
			setModel: vi.fn(async () => {}),
			refreshModels: vi.fn(async () => {}),
			login: vi.fn(async () => {}),
			replyAuth: vi.fn(async () => {}),
			cancelLogin: vi.fn(async () => {}),
		};
		controller.prompt("", images);
		controller.steer("describe this", images);
		controller.followUp("hi", []);
		expect(controller.prompt).toHaveBeenCalledWith("", images);
		expect(controller.steer).toHaveBeenCalledWith("describe this", images);
		expect(controller.followUp).toHaveBeenCalledWith("hi", []);
	});

	it("paste-marker attachments can be converted to images (sanity check mirroring the runtime helper)", () => {
		// Mirrors the in-file `attachmentsToImages` helpers used by the experimental TUIs to ensure
		// the shape of the conversion agrees with what the controllers expect.
		const attachments: PasteAttachment[] = [
			{ kind: "image", mimeType: "image/png", bytes: Uint8Array.from([0x89, 0x50, 0x4e, 0x47]), fileName: "x.png" },
			{ kind: "text", content: "long blob" },
		];
		const images: ImageContent[] = [];
		for (const attachment of attachments) {
			if (attachment.kind === "image") {
				images.push({
					type: "image",
					data: Buffer.from(attachment.bytes).toString("base64"),
					mimeType: attachment.mimeType,
				});
			}
		}
		expect(images).toHaveLength(1);
		expect(images[0]?.mimeType).toBe("image/png");
		expect(images[0]?.data).toBe(Buffer.from(Uint8Array.from([0x89, 0x50, 0x4e, 0x47])).toString("base64"));
	});
});