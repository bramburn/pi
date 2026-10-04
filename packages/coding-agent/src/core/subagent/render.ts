/**
 * Rendering for the native `subagent` tool: the call line and the
 * collapsed/expanded result views, ported from the reference extension.
 *
 * Format contracts (asserted by the smoke run):
 * - Usage line: `N turns ↑in ↓out Rcache Wcache $X.XXXX ctx:N model`, each part
 *   omitted when zero.
 * - Collapsed single: `✓ role` + last N display items + usage line.
 * - Parallel: ⏳ while anything runs, ◐ when done with failures, ✓ all good;
 *   per-task ⏳/✓/✗; status `N/M done, K running`.
 * - Chain: `✓ chain N/M steps` with per-step sections.
 *
 * Unlike `bash.ts`, this module keeps rendering pure string composition inside
 * pi-tui `Text`/`Container` components — the subagent result is a tree of small
 * sections, not a scrollback.
 */

import { homedir } from "node:os";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Message } from "@earendil-works/pi-ai";
import { type Component, Container, Markdown, Spacer, Text } from "@earendil-works/pi-tui";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.ts";
import { getMarkdownTheme, type Theme } from "../../modes/interactive/theme/theme.ts";
import type { SubagentToolDetails, SubagentToolInput } from "./subagent-tool.ts";
import { isFailedSubagentResult, type SubagentResult, type SubagentUsage } from "./types.ts";

/** Collapsed single view shows at most this many display items. */
export const COLLAPSED_ITEM_COUNT = 10;

/** How many items a step/task shows in collapsed chain/parallel sections. */
const COLLAPSED_SECTION_ITEMS = 5;

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1000000).toFixed(1)}M`;
}

export function formatUsageStats(usage: Partial<SubagentUsage>, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens && usage.contextTokens > 0) {
		parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	}
	if (model) parts.push(model);
	return parts.join(" ");
}

function shortenPath(p: string): string {
	const home = homedir();
	return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function formatToolCall(toolName: string, args: Record<string, unknown>, theme: Theme): string {
	const fg = (color: Parameters<Theme["fg"]>[0], text: string) => theme.fg(color, text);

	switch (toolName) {
		case "bash": {
			const command = (args.command as string) || "...";
			const preview = command.length > 60 ? `${command.slice(0, 60)}...` : command;
			return fg("muted", "$ ") + fg("toolOutput", preview);
		}
		case "read": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const offset = args.offset as number | undefined;
			const limit = args.limit as number | undefined;
			let text = fg("accent", filePath);
			if (offset !== undefined || limit !== undefined) {
				const startLine = offset ?? 1;
				const endLine = limit !== undefined ? startLine + limit - 1 : "";
				text += fg("warning", `:${startLine}${endLine ? `-${endLine}` : ""}`);
			}
			return fg("muted", "read ") + text;
		}
		case "write": {
			const rawPath = (args.file_path || args.path || "...") as string;
			const filePath = shortenPath(rawPath);
			const content = (args.content || "") as string;
			const lines = content.split("\n").length;
			let text = fg("muted", "write ") + fg("accent", filePath);
			if (lines > 1) text += fg("dim", ` (${lines} lines)`);
			return text;
		}
		case "edit": {
			const rawPath = (args.file_path || args.path || "...") as string;
			return fg("muted", "edit ") + fg("accent", shortenPath(rawPath));
		}
		case "ls": {
			const rawPath = (args.path || ".") as string;
			return fg("muted", "ls ") + fg("accent", shortenPath(rawPath));
		}
		case "find": {
			const pattern = (args.pattern || "*") as string;
			const rawPath = (args.path || ".") as string;
			return fg("muted", "find ") + fg("accent", pattern) + fg("dim", ` in ${shortenPath(rawPath)}`);
		}
		case "grep": {
			const pattern = (args.pattern || "") as string;
			const rawPath = (args.path || ".") as string;
			return fg("muted", "grep ") + fg("accent", `/${pattern}/`) + fg("dim", ` in ${shortenPath(rawPath)}`);
		}
		default: {
			const argsStr = JSON.stringify(args);
			const preview = argsStr.length > 50 ? `${argsStr.slice(0, 50)}...` : argsStr;
			return fg("accent", toolName) + fg("dim", ` ${preview}`);
		}
	}
}

export type DisplayItem = { type: "text"; text: string } | { type: "toolCall"; name: string; args: Record<string, unknown> };

/** Flatten the child transcript into display items: assistant text and tool calls. */
export function getDisplayItems(messages: Message[]): DisplayItem[] {
	const items: DisplayItem[] = [];
	for (const msg of messages) {
		if (msg.role === "assistant") {
			for (const part of msg.content) {
				if (part.type === "text") items.push({ type: "text", text: part.text });
				else if (part.type === "toolCall") items.push({ type: "toolCall", name: part.name, args: part.arguments });
			}
		}
	}
	return items;
}

function renderDisplayItems(theme: Theme, items: DisplayItem[], limit: number | undefined, expanded: boolean): string {
	const toShow = limit ? items.slice(-limit) : items;
	const skipped = limit && items.length > limit ? items.length - limit : 0;
	let text = "";
	if (skipped > 0) text += theme.fg("muted", `... ${skipped} earlier items\n`);
	for (const item of toShow) {
		if (item.type === "text") {
			const preview = expanded ? item.text : item.text.split("\n").slice(0, 3).join("\n");
			text += `${theme.fg("toolOutput", preview)}\n`;
		} else {
			text += `${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme)}\n`;
		}
	}
	return text.trimEnd();
}

export function aggregateUsage(results: SubagentResult[]): Omit<SubagentUsage, "contextTokens"> {
	const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
	for (const r of results) {
		total.input += r.usage.input;
		total.output += r.usage.output;
		total.cacheRead += r.usage.cacheRead;
		total.cacheWrite += r.usage.cacheWrite;
		total.cost += r.usage.cost;
		total.turns += r.usage.turns;
	}
	return total;
}

export function renderSubagentCall(args: SubagentToolInput, theme: Theme): Component {
	if (args.chain && args.chain.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `chain (${args.chain.length} steps)`) +
			(args.background ? theme.fg("muted", " [background]") : "");
		for (let i = 0; i < Math.min(args.chain.length, 3); i++) {
			const step = args.chain[i];
			const cleanTask = step.instructions.replace(/\{previous\}/g, "").trim();
			const preview = cleanTask.length > 40 ? `${cleanTask.slice(0, 40)}...` : cleanTask;
			text += `\n ${theme.fg("muted", `${i + 1}.`)} ${theme.fg("accent", step.role)} ${theme.fg("dim", preview)}`;
		}
		if (args.chain.length > 3) text += `\n ${theme.fg("muted", `... +${args.chain.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	if (args.tasks && args.tasks.length > 0) {
		let text =
			theme.fg("toolTitle", theme.bold("subagent ")) +
			theme.fg("accent", `parallel (${args.tasks.length} tasks)`) +
			(args.background ? theme.fg("muted", " [background]") : "");
		for (const t of args.tasks.slice(0, 3)) {
			const preview = t.instructions.length > 40 ? `${t.instructions.slice(0, 40)}...` : t.instructions;
			text += `\n ${theme.fg("accent", t.role)} ${theme.fg("dim", preview)}`;
		}
		if (args.tasks.length > 3) text += `\n ${theme.fg("muted", `... +${args.tasks.length - 3} more`)}`;
		return new Text(text, 0, 0);
	}
	const role = args.role || "...";
	const preview = args.instructions ? (args.instructions.length > 60 ? `${args.instructions.slice(0, 60)}...` : args.instructions) : "...";
	let text =
		theme.fg("toolTitle", theme.bold("subagent ")) +
		theme.fg("accent", role) +
		(args.background ? theme.fg("muted", " [background]") : "");
	text += `\n ${theme.fg("dim", preview)}`;
	return new Text(text, 0, 0);
}

function stepUsageLine(results: SubagentResult[], model?: string): string {
	return formatUsageStats(aggregateUsage(results), model);
}

export function renderSubagentResult(
	result: AgentToolResult<SubagentToolDetails | undefined>,
	options: { expanded: boolean },
	theme: Theme,
): Component {
	const expanded = options.expanded;
	const details = result.details;
	if (!details || details.results.length === 0) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(no output)", 0, 0);
	}

	const mdTheme = getMarkdownTheme();

	if (details.mode === "single" && details.results.length === 1) {
		const r = details.results[0];
		const failed = isFailedSubagentResult(r);
		const running = r.exitCode === -1;
		const icon = running ? theme.fg("warning", "⏳") : failed ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const displayItems = getDisplayItems(r.messages);
		const finalOutput = r.finalOutput;

		if (expanded) {
			const container = new Container();
			let header = `${icon} ${theme.fg("toolTitle", theme.bold(r.role))}`;
			if (failed && r.stopReason) header += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
			container.addChild(new Text(header, 0, 0));
			if (failed && r.errorMessage) container.addChild(new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Task ───"), 0, 0));
			container.addChild(new Text(theme.fg("dim", r.task), 0, 0));
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("muted", "─── Output ───"), 0, 0));
			if (displayItems.length === 0 && !finalOutput) {
				container.addChild(new Text(theme.fg("muted", "(no output)"), 0, 0));
			} else {
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(new Text(`${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme)}`, 0, 0));
					}
				}
				if (finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
				}
			}
			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold(r.role))}`;
		if (failed && r.stopReason) text += ` ${theme.fg("error", `[${r.stopReason}]`)}`;
		if (failed && r.errorMessage) text += `\n${theme.fg("error", `Error: ${r.errorMessage}`)}`;
		else if (displayItems.length === 0) text += `\n${theme.fg("muted", finalOutput ? finalOutput.split("\n").slice(0, 3).join("\n") : "(no output)")}`;
		else {
			text += `\n${renderDisplayItems(theme, displayItems, COLLAPSED_ITEM_COUNT, false)}`;
			if (displayItems.length > COLLAPSED_ITEM_COUNT) {
				text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
			}
		}
		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
		return new Text(text, 0, 0);
	}

	if (details.mode === "chain") {
		const successCount = details.results.filter((r) => !isFailedSubagentResult(r) && r.exitCode !== -1).length;
		const done = successCount === details.results.length && details.results.every((r) => r.exitCode !== -1);
		const icon = details.results.some((r) => r.exitCode === -1)
			? theme.fg("warning", "⏳")
			: done
				? theme.fg("success", "✓")
				: theme.fg("error", "✗");

		if (expanded && done) {
			const container = new Container();
			container.addChild(
				new Text(
					`${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`,
					0,
					0,
				),
			);
			for (const r of details.results) {
				const rIcon = isFailedSubagentResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
				const displayItems = getDisplayItems(r.messages);
				container.addChild(new Container());
				container.addChild(
					new Text(`${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.role)} ${rIcon}`, 0, 0),
				);
				container.addChild(new Text(`${theme.fg("muted", "Task: ")}${theme.fg("dim", r.task)}`, 0, 0));
				for (const item of displayItems) {
					if (item.type === "toolCall") {
						container.addChild(new Text(`${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme)}`, 0, 0));
					}
				}
				if (r.finalOutput) {
					container.addChild(new Spacer(1));
					container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
				}
				const stepUsage = formatUsageStats(r.usage, r.model);
				if (stepUsage) container.addChild(new Text(theme.fg("dim", stepUsage), 0, 0));
			}
			const usageStr = stepUsageLine(details.results);
			if (usageStr) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
			}
			return container;
		}

		let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain "))}${theme.fg("accent", `${successCount}/${details.results.length} steps`)}`;
		for (const r of details.results) {
			const rIcon =
				r.exitCode === -1 ? theme.fg("warning", "⏳") : isFailedSubagentResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const displayItems = getDisplayItems(r.messages);
			text += `\n\n${theme.fg("muted", `─── Step ${r.step}: `)}${theme.fg("accent", r.role)} ${rIcon}`;
			if (displayItems.length === 0) {
				text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
			} else {
				text += `\n${renderDisplayItems(theme, displayItems, COLLAPSED_SECTION_ITEMS, false)}`;
			}
		}
		if (done) {
			const usageStr = stepUsageLine(details.results);
			if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
		}
		if (!expanded) text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
		return new Text(text, 0, 0);
	}

	// parallel
	const runningCount = details.results.filter((r) => r.exitCode === -1).length;
	const successCount = details.results.filter((r) => r.exitCode !== -1 && !isFailedSubagentResult(r)).length;
	const failCount = details.results.filter((r) => r.exitCode !== -1 && isFailedSubagentResult(r)).length;
	const isRunning = runningCount > 0;
	const icon = isRunning ? theme.fg("warning", "⏳") : failCount > 0 ? theme.fg("warning", "◐") : theme.fg("success", "✓");
	const status = isRunning
		? `${successCount + failCount}/${details.results.length} done, ${runningCount} running`
		: `${successCount}/${details.results.length} tasks`;

	if (expanded && !isRunning) {
		const container = new Container();
		container.addChild(
			new Text(`${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`, 0, 0),
		);
		for (const r of details.results) {
			const rIcon = isFailedSubagentResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
			const displayItems = getDisplayItems(r.messages);
			container.addChild(new Spacer(1));
			container.addChild(new Text(`${theme.fg("muted", "─── ")}${theme.fg("accent", r.role)} ${rIcon}`, 0, 0));
			container.addChild(new Text(`${theme.fg("muted", "Task: ")}${theme.fg("dim", r.task)}`, 0, 0));
			for (const item of displayItems) {
				if (item.type === "toolCall") {
					container.addChild(new Text(`${theme.fg("muted", "→ ")}${formatToolCall(item.name, item.args, theme)}`, 0, 0));
				}
			}
			if (r.finalOutput) {
				container.addChild(new Spacer(1));
				container.addChild(new Markdown(r.finalOutput.trim(), 0, 0, mdTheme));
			}
			const taskUsage = formatUsageStats(r.usage, r.model);
			if (taskUsage) container.addChild(new Text(theme.fg("dim", taskUsage), 0, 0));
		}
		const usageStr = stepUsageLine(details.results);
		if (usageStr) {
			container.addChild(new Spacer(1));
			container.addChild(new Text(theme.fg("dim", `Total: ${usageStr}`), 0, 0));
		}
		return container;
	}

	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel "))}${theme.fg("accent", status)}`;
	for (const r of details.results) {
		const rIcon =
			r.exitCode === -1 ? theme.fg("warning", "⏳") : isFailedSubagentResult(r) ? theme.fg("error", "✗") : theme.fg("success", "✓");
		const displayItems = getDisplayItems(r.messages);
		text += `\n\n${theme.fg("muted", "─── ")}${theme.fg("accent", r.role)} ${rIcon}`;
		if (displayItems.length === 0) {
			text += `\n${theme.fg("muted", r.exitCode === -1 ? "(running...)" : "(no output)")}`;
		} else {
			text += `\n${renderDisplayItems(theme, displayItems, COLLAPSED_SECTION_ITEMS, false)}`;
		}
	}
	if (!isRunning) {
		const usageStr = stepUsageLine(details.results);
		if (usageStr) text += `\n\n${theme.fg("dim", `Total: ${usageStr}`)}`;
	}
	if (!expanded) text += `\n${theme.fg("muted", `(${keyHint("app.tools.expand", "to expand")})`)}`;
	return new Text(text, 0, 0);
}
