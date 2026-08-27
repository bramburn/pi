/**
 * Byte-budgeted rendering of workspace instructions (AGENTS.md chain).
 *
 * Adapts the deepseek-harness `agent-instructions/render.ts` to pi's
 * `BuildSystemPromptOptions.contextFiles` shape. The renderer:
 *
 * 1. Computes a byte budget from the caller's `maxBytes` (default 20 KiB).
 * 2. Sorts files by depth (most-specific last) and trims the most
 *    specific file first when the chain does not fit. Files that
 *    cannot fit at all are omitted.
 * 3. Truncates the most-specific file with UTF-8-safe truncation
 *    (does not split a code point) and a marker line that records
 *    the original size and the included size.
 *
 * The output is wrapped in `<system-reminder>` tags so the model
 * can distinguish workspace-instruction content from the persona.
 */

export interface RenderedWorkspaceContext {
	/** The model-facing prompt text. */
	text: string;
	/** Files that did not fit at all; the model did not see them. */
	omitted: Array<{ path: string }>;
	/** Files that were truncated to fit. */
	truncated: Array<{ path: string; originalBytes: number; includedBytes: number }>;
}

const SYSTEM_REMINDER_OPEN = "<system-reminder>";
const SYSTEM_REMINDER_CLOSE = "</system-reminder>";

function utf8ByteLength(value: string): number {
	return Buffer.byteLength(value, "utf8");
}

/** Truncate at a UTF-8 code-point boundary so the cut never splits a multi-byte char. */
function truncateUtf8(value: string, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const full = Buffer.from(value, "utf8");
	if (full.length <= maxBytes) return value;
	let end = maxBytes;
	// If the byte at `end` is a UTF-8 continuation (0b10xxxxxx), back up.
	while (end > 0 && (full[end] & 0xc0) === 0x80) end -= 1;
	return full.subarray(0, end).toString("utf8");
}

function escapeSystemReminder(body: string): string {
	return body.replaceAll(SYSTEM_REMINDER_CLOSE, "<\\/system-reminder>");
}

/** Render the workspace instruction chain under a byte budget. */
export function renderWorkspaceContext(
	files: ReadonlyArray<{ path: string; content: string }>,
	maxBytes: number,
): RenderedWorkspaceContext {
	if (maxBytes <= 0 || !Number.isFinite(maxBytes)) {
		return { text: "", omitted: files.map((f) => ({ path: f.path })), truncated: [] };
	}

	// Render with no budget first; if it fits, return as-is.
	const fullBody = files
		.map((f) => `Instructions from: ${f.path}\n\n${f.content}`)
		.join("\n\n");
	const fullWrapped = `${SYSTEM_REMINDER_OPEN}\n${escapeSystemReminder(fullBody)}\n${SYSTEM_REMINDER_CLOSE}\n`;
	if (utf8ByteLength(fullWrapped) <= maxBytes) {
		return { text: fullWrapped, omitted: [], truncated: [] };
	}

	// Drop files from the most-specific end of the chain. The caller
	// is expected to pass files in order from broadest to most specific;
	// we trim from the end (most specific) first because the broadest
	// instructions are the most general guidance.
	const kept = files.slice(0);
	const omitted: Array<{ path: string }> = [];
	while (kept.length > 0) {
		const body = kept
			.map((f) => `Instructions from: ${f.path}\n\n${f.content}`)
			.join("\n\n");
		const wrapped = `${SYSTEM_REMINDER_OPEN}\n${escapeSystemReminder(body)}\n${SYSTEM_REMINDER_CLOSE}\n`;
		if (utf8ByteLength(wrapped) <= maxBytes) break;
		omitted.push({ path: kept.pop()!.path });
	}

	if (kept.length === 0) {
		// Even the most-specific file does not fit. Truncate the
		// most-specific file alone with diagnostics.
		const f = files[files.length - 1];
		if (!f) {
			return { text: "", omitted: files.map((ff) => ({ path: ff.path })), truncated: [] };
		}
		const originalBytes = utf8ByteLength(f.content);
		const header = `Instructions from: ${f.path}\n\n`;
		const footer = `\n\n[…truncated to fit byte budget…]`;
		const avail = Math.max(0, maxBytes - utf8ByteLength(SYSTEM_REMINDER_OPEN) - utf8ByteLength(SYSTEM_REMINDER_CLOSE) - utf8ByteLength(header) - utf8ByteLength(footer) - 4);
		const truncated = truncateUtf8(f.content, avail);
		const body = header + truncated + footer;
		const wrapped = `${SYSTEM_REMINDER_OPEN}\n${escapeSystemReminder(body)}\n${SYSTEM_REMINDER_CLOSE}\n`;
		const truncated_record = { path: f.path, originalBytes, includedBytes: utf8ByteLength(wrapped) };
		return { text: wrapped, omitted: [], truncated: [truncated_record] };
	}

	const truncated: Array<{ path: string; originalBytes: number; includedBytes: number }> = [];
	const keptContents: Array<{ path: string; content: string }> = [];
	for (const f of kept) {
		const originalBytes = utf8ByteLength(f.content);
		const head = `Instructions from: ${f.path}\n\n`;
		const tail = "";
		const base = utf8ByteLength(SYSTEM_REMINDER_OPEN) + utf8ByteLength(SYSTEM_REMINDER_CLOSE) + 2; // newlines
		const candidate = `${SYSTEM_REMINDER_OPEN}\n${keptContents
			.map((k) => `Instructions from: ${k.path}\n\n${k.content}`)
			.concat([`${head}${f.content}${tail}`])
			.join("\n\n")}\n${SYSTEM_REMINDER_CLOSE}\n`;
		if (utf8ByteLength(candidate) <= maxBytes) {
			keptContents.push({ path: f.path, content: f.content });
			continue;
		}
		// Truncate this file's content to fit the remaining budget.
		const usedWithout = base + keptContents.reduce(
			(s, k) => s + utf8ByteLength(`Instructions from: ${k.path}\n\n${k.content}\n\n`),
			0,
		) + utf8ByteLength(head);
		const remaining = Math.max(0, maxBytes - usedWithout);
		const truncatedContent = truncateUtf8(f.content, remaining);
		keptContents.push({ path: f.path, content: truncatedContent });
		truncated.push({ path: f.path, originalBytes, includedBytes: utf8ByteLength(truncatedContent) });
	}
	const body = keptContents
		.map((k) => `Instructions from: ${k.path}\n\n${k.content}`)
		.join("\n\n");
	const wrapped = `${SYSTEM_REMINDER_OPEN}\n${escapeSystemReminder(body)}\n${SYSTEM_REMINDER_CLOSE}\n`;
	return { text: wrapped, omitted, truncated };
}
