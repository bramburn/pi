import type { TUI } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { createInteractiveTuiReference } from "../../../src/modes/interactive/interactive-mode.ts";

describe("TUI method wrapping", () => {
	it("calls the method captured before a replacement", () => {
		const renderer = {
			render: (width: number) => [`width: ${width}`],
		} as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const originalRender = tui.render;
		tui.render = (width: number) => originalRender(width);

		expect(tui.render(80)).toEqual(["width: 80"]);
	});

	it("routes a captured method to a replacement renderer", () => {
		const regularRequestRender = vi.fn();
		const newRequestRender = vi.fn();
		let renderer = { requestRender: regularRequestRender } as unknown as TUI;
		const tui = createInteractiveTuiReference(() => renderer);
		const requestRender = tui.requestRender;

		requestRender();
		renderer = { requestRender: newRequestRender } as unknown as TUI;
		requestRender();

		expect(regularRequestRender).toHaveBeenCalledOnce();
		expect(newRequestRender).toHaveBeenCalledOnce();
	});
});
