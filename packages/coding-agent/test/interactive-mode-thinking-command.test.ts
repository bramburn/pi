import type { ThinkingLevel } from "@bramburn/qi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { ThinkingSelectorComponent } from "../src/modes/interactive/components/thinking-selector.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type SelectorShow = (create: (done: () => void) => { component: unknown; focus: unknown }) => void;

type ThinkingCommandContext = {
	setThinkingLevel: (level: ThinkingLevel) => void;
	session: {
		thinkingLevel: ThinkingLevel;
		getAvailableThinkingLevels: () => ThinkingLevel[];
		setThinkingLevel: (level: ThinkingLevel) => void;
	};
	settingsManager: { getDefaultThinkingLevel: () => ThinkingLevel | undefined };
	footer: { invalidate: () => void };
	updateEditorBorderColor: () => void;
	showWarning: (message: string) => void;
	showError: (message: string) => void;
	showStatus: (message: string) => void;
	showThinkingSelector: () => void;
	showSelector: SelectorShow;
	ui: { requestRender: () => void };
};

type InteractiveModePrototype = {
	handleThinkingCommand(this: ThinkingCommandContext, levelArg?: string): void;
	setThinkingLevel(this: ThinkingCommandContext, level: ThinkingLevel): void;
	showThinkingSelector(this: ThinkingCommandContext): void;
};

const interactiveModePrototype = InteractiveMode.prototype as unknown as InteractiveModePrototype;

function createContext(overrides: Partial<ThinkingCommandContext> = {}): ThinkingCommandContext {
	return {
		// Bound through `this` at the call site: the real setThinkingLevel runs
		// against the mock context (session/footer/border/status are all present).
		setThinkingLevel: interactiveModePrototype.setThinkingLevel,
		session: {
			thinkingLevel: "medium",
			getAvailableThinkingLevels: () => ["off", "minimal", "low", "medium", "high"] as ThinkingLevel[],
			setThinkingLevel: vi.fn(),
		},
		settingsManager: { getDefaultThinkingLevel: () => "low" },
		footer: { invalidate: vi.fn() },
		updateEditorBorderColor: vi.fn(),
		showWarning: vi.fn(),
		showError: vi.fn(),
		showStatus: vi.fn(),
		showThinkingSelector: vi.fn(),
		showSelector: vi.fn(),
		ui: { requestRender: vi.fn() },
		...overrides,
	};
}

describe("InteractiveMode /thinking", () => {
	// Regression test: the /thinking branch was missing from
	// setupEditorSubmitHandler, so "/thinking high" fell through to
	// session.prompt() and was sent to the model as a plain message.
	it("applies a valid level and refreshes footer and editor border", () => {
		const context = createContext();
		interactiveModePrototype.handleThinkingCommand.call(context, "high");

		expect(context.session.setThinkingLevel).toHaveBeenCalledWith("high");
		expect(context.footer.invalidate).toHaveBeenCalled();
		expect(context.updateEditorBorderColor).toHaveBeenCalled();
		expect(context.showStatus).toHaveBeenCalledWith("Thinking level: high");
		expect(context.showWarning).not.toHaveBeenCalled();
		expect(context.showThinkingSelector).not.toHaveBeenCalled();
	});

	it("warns instead of prompting when the level is not available", () => {
		const context = createContext();
		interactiveModePrototype.handleThinkingCommand.call(context, "xhigh");

		expect(context.showWarning).toHaveBeenCalledWith(
			'Unknown thinking level "xhigh". Available levels: off, minimal, low, medium, high',
		);
		expect(context.session.setThinkingLevel).not.toHaveBeenCalled();
		expect(context.showStatus).not.toHaveBeenCalled();
	});

	it("opens the thinking selector when no level argument is given", () => {
		const context = createContext();
		interactiveModePrototype.handleThinkingCommand.call(context);

		expect(context.showThinkingSelector).toHaveBeenCalledTimes(1);
		expect(context.session.setThinkingLevel).not.toHaveBeenCalled();
	});

	it("mounts a ThinkingSelectorComponent with session levels and the saved default", () => {
		initTheme("dark");
		const context = createContext();
		let created: { component: unknown; focus: unknown } | undefined;
		context.showSelector = vi.fn((create) => {
			created = create(() => {});
		});

		interactiveModePrototype.showThinkingSelector.call(context);

		expect(context.showSelector).toHaveBeenCalledTimes(1);
		expect(created).toBeDefined();
		expect(created?.component).toBeInstanceOf(ThinkingSelectorComponent);
		expect(created?.focus).toBe(created?.component);
	});
});
