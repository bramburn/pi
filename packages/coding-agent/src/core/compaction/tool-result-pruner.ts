/**
 * Tool-result re-pruner — model-free, replay-safe.
 *
 * Walks the current agent surface and rewrites over-budget tool
 * results in place: head + marker + tail. The session log retains
 * the original events; only the surface projection is rewritten.
 *
 * This is the second-tier defence in the DeepSeek Harness
 * pipeline (Phase 2, item 3 of the decision matrix). The first
 * tier (`truncateHead` / `truncateTail` at execution time) keeps
 * each tool result bounded. The second tier compresses the
 * already-truncated-but-still-large results that accumulate over
 * a long session.
 *
 * Defaults match the deepseek-harness `compaction-tool-result-pruner`:
 *   thresholdChars: 8192
 *   headChars: 4096
 *   tailChars: 1024
 *   pruneMarker: "\n\n[… tool result middle pruned …]\n\n"
 *
 * Tools whose `toolName` is in `skipToolNames` are exempt (default:
 * `["read"]`). The `read` tool exemption breaks the read → truncate
 * → read loop (decision matrix item 10).
 */
import type { AgentMessage } from "@earendil-works/pi-agent-core";

/** Configuration for the pruner. */
export interface PrunerConfig {
	/** Result blocks over this many characters are eligible for pruning. */
	thresholdChars: number;
	/** Number of leading characters to keep verbatim. */
	headChars: number;
	/** Number of trailing characters to keep verbatim. */
	tailChars: number;
	/** Marker inserted between the head and tail when the middle is dropped. */
	pruneMarker: string;
	/** Tool names that the pruner skips (e.g. "read"). */
	skipToolNames: string[];
}

/** Default pruner config. Matches the deepseek-harness defaults. */
export const DEFAULT_PRUNER_CONFIG: PrunerConfig = {
	thresholdChars: 8192,
	headChars: 4096,
	tailChars: 1024,
	pruneMarker: "\n\n[… tool result middle pruned …]\n\n",
	skipToolNames: ["read"],
};

/** Count characters in a tool-result content block, recursively. */
function charsInContent(blocks: ReadonlyArray<unknown>): number {
	let total = 0;
	for (const block of blocks) {
		if (!block || typeof block !== "object") continue;
		const b = block as { type?: string; text?: string };
		if (b.type === "text" && typeof b.text === "string") total += b.text.length;
	}
	return total;
}

/** Return a new content array with text blocks shortened to head+tail. */
function pruneContent(
	blocks: ReadonlyArray<{ type?: string; text?: string }>,
	config: PrunerConfig,
	totalChars: number,
): { content: unknown[]; changed: boolean } {
	if (totalChars <= config.thresholdChars) return { content: blocks as unknown[], changed: false };
	const removed = totalChars - config.headChars - config.tailChars;
	const out: unknown[] = [];
	for (const block of blocks) {
		if (!block || typeof block !== "object") {
			out.push(block);
			continue;
		}
		const b = block as { type?: string; text?: string };
		if (b.type !== "text" || typeof b.text !== "string") {
			out.push(block);
			continue;
		}
		const text = b.text;
		const head = text.slice(0, config.headChars);
		const tail = text.slice(text.length - config.tailChars);
		out.push({ ...b, text: head + config.pruneMarker + tail });
	}
	return { content: out, changed: true };
}

/**
 * Rewrite over-budget tool results in `messages`. Returns a new
 * array; the input is not mutated. `BashExecutionMessage` rows
 * with `excludeFromPrune: true` and `ToolResultMessage` rows
 * whose `toolName` is in `config.skipToolNames` are passed through
 * untouched.
 */
export function pruneSession(
	messages: ReadonlyArray<AgentMessage>,
	config: PrunerConfig = DEFAULT_PRUNER_CONFIG,
): AgentMessage[] {
	const skipNames = new Set(config.skipToolNames);
	const out: AgentMessage[] = [];
	for (const m of messages) {
		// `BashExecutionMessage` path: respects `excludeFromPrune`.
		if (
			m.role === "bashExecution" &&
			"excludeFromPrune" in m &&
			(m as { excludeFromPrune?: boolean }).excludeFromPrune === true
		) {
			out.push(m);
			continue;
		}
		// `ToolResultMessage` path: respect the `skipToolNames` allowlist.
		if (m.role === "toolResult") {
			const tr = m as { toolName?: string; content?: ReadonlyArray<unknown> };
			if (tr.toolName && skipNames.has(tr.toolName)) {
				out.push(m);
				continue;
			}
			const content = tr.content ?? [];
			const chars = charsInContent(content);
			if (chars <= config.thresholdChars) {
				out.push(m);
				continue;
			}
			const { content: newContent, changed } = pruneContent(
				content as ReadonlyArray<{ type?: string; text?: string }>,
				config,
				chars,
			);
			if (!changed) {
				out.push(m);
				continue;
			}
			out.push({ ...tr, content: newContent } as AgentMessage);
			continue;
		}
		out.push(m);
	}
	return out;
}
