import {
	type Api,
	type AssistantMessage,
	type Context,
	type ImageContent,
	type Message,
	type Model,
	modelSupportsMediaUpload,
	type TextContent,
	type ToolCall,
	type ToolResultMessage,
} from "../types.ts";
import { sanitizeRequestText } from "../utils/sanitize-text.ts";

type MediaBlockKind = "image" | "video" | "pdf";

const MEDIA_PLACEHOLDERS: Record<"user" | "tool", Record<MediaBlockKind, string>> = {
	user: {
		image: "(image omitted: model does not support images)",
		video: "(video omitted: model does not support video)",
		pdf: "(pdf omitted: model does not support PDFs)",
	},
	tool: {
		image: "(tool image omitted: model does not support images)",
		video: "(tool video omitted: model does not support video)",
		pdf: "(tool pdf omitted: model does not support PDFs)",
	},
};

/**
 * Detect the media kind of a content block. Video/PDF blocks reach the
 * message union through the coding-agent paste path's local cast (the shared
 * union is text/image only), so this narrows by runtime discriminant.
 */
function mediaBlockKind(block: TextContent | ImageContent): MediaBlockKind | undefined {
	const type = (block as { type: string }).type;
	return type === "image" || type === "video" || type === "pdf" ? type : undefined;
}

function isMediaKindSupported<TApi extends Api>(model: Model<TApi>, kind: MediaBlockKind): boolean {
	return kind === "image" ? model.input.includes("image") : modelSupportsMediaUpload(model, kind);
}

/**
 * Replace media blocks the model cannot receive with text placeholders. Runs
 * on every request build, so media attached while one model was active
 * degrades to placeholders after a swap to a model lacking the modality — the
 * session history keeps the original blocks, only the request is reduced.
 */
function downgradeUnsupportedMediaBlocks<TApi extends Api>(
	content: (TextContent | ImageContent)[],
	model: Model<TApi>,
	scope: "user" | "tool",
): (TextContent | ImageContent)[] {
	const result: (TextContent | ImageContent)[] = [];
	let previousPlaceholderKind: MediaBlockKind | undefined;

	for (const block of content) {
		const kind = mediaBlockKind(block);
		if (kind !== undefined && !isMediaKindSupported(model, kind)) {
			// Collapse consecutive drops of the same kind into one placeholder.
			if (previousPlaceholderKind !== kind) {
				result.push({ type: "text", text: MEDIA_PLACEHOLDERS[scope][kind] });
			}
			previousPlaceholderKind = kind;
			continue;
		}

		result.push(block);
		previousPlaceholderKind = undefined;
	}

	return result;
}

function downgradeUnsupportedMedia<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
	const allMediaSupported =
		model.input.includes("image") &&
		modelSupportsMediaUpload(model, "video") &&
		modelSupportsMediaUpload(model, "pdf");
	if (allMediaSupported) {
		return messages;
	}

	return messages.map((msg) => {
		if (msg.role === "user" && Array.isArray(msg.content)) {
			return {
				...msg,
				content: downgradeUnsupportedMediaBlocks(msg.content, model, "user"),
			};
		}

		if (msg.role === "toolResult") {
			return {
				...msg,
				content: downgradeUnsupportedMediaBlocks(msg.content, model, "tool"),
			};
		}

		return msg;
	});
}

/**
 * Strip unpaired UTF-16 surrogates and U+FFFD from text content on a message.
 * Used as the first pass in `transformMessages` so that all text reaching a
 * provider is free of characters some providers reject with 400 "invalid
 * params" (e.g. MiniMax sub-code 2013).
 *
 * Returns the same message reference if no sanitization was needed, so the
 * downstream passes can rely on reference identity to skip work on clean
 * messages.
 */
function sanitizeMessageText(msg: Message): Message {
	if (msg.role === "user") {
		if (typeof msg.content === "string") {
			const cleaned = sanitizeRequestText(msg.content);
			return cleaned === msg.content ? msg : { ...msg, content: cleaned };
		}
		let changed = false;
		const next = msg.content.map((block) => {
			if (block.type === "text") {
				const cleaned = sanitizeRequestText(block.text);
				if (cleaned !== block.text) {
					changed = true;
					return { ...block, text: cleaned };
				}
			}
			return block;
		});
		return changed ? { ...msg, content: next } : msg;
	}

	if (msg.role === "assistant") {
		let changed = false;
		const next = msg.content.map((block) => {
			if (block.type === "text") {
				const cleaned = sanitizeRequestText(block.text);
				if (cleaned !== block.text) {
					changed = true;
					return { ...block, text: cleaned };
				}
			} else if (block.type === "thinking") {
				const thinking = block.thinking;
				const cleaned = sanitizeRequestText(thinking);
				if (cleaned !== thinking) {
					changed = true;
					return { ...block, thinking: cleaned };
				}
			}
			return block;
		});
		return changed ? { ...msg, content: next } : msg;
	}

	if (msg.role === "toolResult") {
		let changed = false;
		const next = msg.content.map((block) => {
			if (block.type === "text") {
				const cleaned = sanitizeRequestText(block.text);
				if (cleaned !== block.text) {
					changed = true;
					return { ...block, text: cleaned };
				}
			}
			return block;
		});
		return changed ? { ...msg, content: next } : msg;
	}

	return msg;
}

/**
 * Normalize tool call ID for cross-provider compatibility.
 * OpenAI Responses API generates IDs that are 450+ chars with special characters like `|`.
 * Anthropic APIs require IDs matching ^[a-zA-Z0-9_-]+$ (max 64 chars).
 */
export function transformMessages<TApi extends Api>(
	messages: Message[],
	model: Model<TApi>,
	normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
	// Build a map of original tool call IDs to normalized IDs
	const toolCallIdMap = new Map<string, string>();
	// Normalize null/undefined content from untyped callers (custom tools, hand-built
	// histories, old session files) so downstream code can rely on the type contract.
	const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
	// Strip characters that some providers (e.g. MiniMax) reject with 400 "invalid params":
	// unpaired UTF-16 surrogates and the U+FFFD replacement character. Runs before
	// media downgrade so all downstream text is provider-safe.
	const sanitizedMessages = normalizedMessages.map(sanitizeMessageText);
	const mediaAwareMessages = downgradeUnsupportedMedia(sanitizedMessages, model);

	// First pass: transform messages (unsupported media downgrade, thinking blocks, tool call ID normalization)
	const transformed = mediaAwareMessages.map((msg) => {
		// User messages pass through unchanged
		if (msg.role === "user") {
			return msg;
		}

		// Handle toolResult messages - normalize toolCallId if we have a mapping
		if (msg.role === "toolResult") {
			const normalizedId = toolCallIdMap.get(msg.toolCallId);
			if (normalizedId && normalizedId !== msg.toolCallId) {
				return { ...msg, toolCallId: normalizedId };
			}
			return msg;
		}

		// Assistant messages need transformation check
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			const isSameModel =
				assistantMsg.provider === model.provider &&
				assistantMsg.api === model.api &&
				assistantMsg.model === model.id;

			const transformedContent = assistantMsg.content.flatMap((block) => {
				if (block.type === "thinking") {
					// Redacted thinking is opaque encrypted content, only valid for the same model.
					// Drop it for cross-model to avoid API errors.
					if (block.redacted) {
						return isSameModel ? block : [];
					}
					// For same model: keep thinking blocks with signatures (needed for replay)
					// even if the thinking text is empty (OpenAI encrypted reasoning)
					if (isSameModel && block.thinkingSignature) return block;
					// Skip empty thinking blocks, convert others to plain text
					if (!block.thinking || block.thinking.trim() === "") return [];
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.thinking,
					};
				}

				if (block.type === "text") {
					if (isSameModel) return block;
					return {
						type: "text" as const,
						text: block.text,
					};
				}

				if (block.type === "toolCall") {
					const toolCall = block as ToolCall;
					let normalizedToolCall: ToolCall = toolCall;

					if (!isSameModel && toolCall.thoughtSignature) {
						normalizedToolCall = { ...toolCall };
						delete (normalizedToolCall as { thoughtSignature?: string }).thoughtSignature;
					}

					if (!isSameModel && normalizeToolCallId) {
						const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
						if (normalizedId !== toolCall.id) {
							toolCallIdMap.set(toolCall.id, normalizedId);
							normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
						}
					}

					return normalizedToolCall;
				}

				return block;
			});

			return {
				...assistantMsg,
				content: transformedContent,
			};
		}
		return msg;
	});

	// Second pass: insert synthetic empty tool results for orphaned tool calls
	// This preserves thinking signatures and satisfies API requirements
	const result: Message[] = [];
	let pendingToolCalls: ToolCall[] = [];
	let existingToolResultIds = new Set<string>();
	const insertSyntheticToolResults = () => {
		if (pendingToolCalls.length > 0) {
			for (const tc of pendingToolCalls) {
				if (!existingToolResultIds.has(tc.id)) {
					result.push({
						role: "toolResult",
						toolCallId: tc.id,
						toolName: tc.name,
						content: [{ type: "text", text: "No result provided" }],
						isError: true,
						timestamp: Date.now(),
					} as ToolResultMessage);
				}
			}
			pendingToolCalls = [];
			existingToolResultIds = new Set();
		}
	};

	for (let i = 0; i < transformed.length; i++) {
		const msg = transformed[i];

		if (msg.role === "assistant") {
			// If we have pending orphaned tool calls from a previous assistant, insert synthetic results now
			insertSyntheticToolResults();

			// Skip errored/aborted assistant messages entirely.
			// These are incomplete turns that shouldn't be replayed:
			// - May have partial content (reasoning without message, incomplete tool calls)
			// - Replaying them can cause API errors (e.g., OpenAI "reasoning without following item")
			// - The model should retry from the last valid state
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason === "error" || assistantMsg.stopReason === "aborted") {
				continue;
			}

			// Track tool calls from this assistant message
			const toolCalls = assistantMsg.content.filter((b) => b.type === "toolCall") as ToolCall[];
			if (toolCalls.length > 0) {
				pendingToolCalls = toolCalls;
				existingToolResultIds = new Set();
			}

			result.push(msg);
		} else if (msg.role === "toolResult") {
			existingToolResultIds.add(msg.toolCallId);
			result.push(msg);
		} else if (msg.role === "user") {
			// User message interrupts tool flow - insert synthetic results for orphaned calls
			insertSyntheticToolResults();
			result.push(msg);
		} else {
			result.push(msg);
		}
	}

	// If the conversation ends with unresolved tool calls, synthesize results now.
	insertSyntheticToolResults();

	return result;
}

/**
 * Strip unpaired UTF-16 surrogates and U+FFFD from text content on every
 * message in `messages`, returning a new array. Used by provider adapters
 * that handle their own image downgrade / tool call ID normalisation (e.g.
 * the `pi-messages` adapter and the agent's `streamProxy`) but still need
 * the sanitiser pass to prevent provider 400s on inputs the LLM would
 * otherwise reject (e.g. MiniMax sub-code 2013).
 *
 * Returns the same array reference when no message needed cleaning, so
 * downstream callers can short-circuit on identity.
 */
export function sanitizeMessages(messages: Message[]): Message[] {
	let changed = false;
	const out = new Array<Message>(messages.length);
	for (let i = 0; i < messages.length; i++) {
		const cleaned = sanitizeMessageText(messages[i]!);
		if (cleaned !== messages[i]) changed = true;
		out[i] = cleaned;
	}
	return changed ? out : messages;
}

/**
 * Sanitise a `Context` for outgoing requests: strip unpaired UTF-16
 * surrogates and U+FFFD from the system prompt and from every text block
 * in the message list. Returns the same Context reference when no
 * sanitisation was needed.
 *
 * Use this from any code path that ships a `Context` over the wire
 * without going through the per-provider `transformMessages()` call.
 */
export function sanitizeContext(context: Context): Context {
	const cleanedPrompt =
		typeof context.systemPrompt === "string" ? sanitizeRequestText(context.systemPrompt) : context.systemPrompt;
	const cleanedMessages = sanitizeMessages(context.messages);
	if (cleanedPrompt === context.systemPrompt && cleanedMessages === context.messages) {
		return context;
	}
	return { ...context, systemPrompt: cleanedPrompt, messages: cleanedMessages };
}
