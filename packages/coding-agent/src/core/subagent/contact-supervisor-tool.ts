/**
 * `contact_supervisor` (issue #1048, Stage 3): the child's way to ask the parent
 * a question when a decision genuinely needs a human or the orchestrating model.
 *
 * Registration is env-gated on `PI_SUBAGENT_SUPERVISOR_DIR` — a child that was
 * not launched with a supervisor directory must not see this tool, because asking
 * would produce nothing but a hang.
 *
 * Semantics: write the request, then wait (bounded) for a reply file. If the wait
 * expires, the request stays open on disk and the tool reports that plainly — the
 * parent will raise it at settlement. This makes waiting cheap and safe rather
 * than a silent block.
 */

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { wrapToolDefinition } from "../tools/tool-definition-wrapper.ts";
import {
	hasSupervisorDir,
	postSupervisorRequest,
	SUPERVISOR_DEFAULT_TIMEOUT_MS,
	SUPERVISOR_MAX_TIMEOUT_MS,
	supervisorDirFromEnv,
	waitForSupervisorReply,
} from "./supervisor-channel.ts";

export const CONTACT_SUPERVISOR_TOOL_NAME = "contact_supervisor";

const ContactSupervisorParams = Type.Object({
	question: Type.String({
		description:
			"The question for the supervising agent, phrased so it can be answered without reading the whole task. Required.",
	}),
	context: Type.Optional(
		Type.String({
			description: "What you tried and what the options are. Short — this is supporting material, not a transcript.",
		}),
	),
	timeout_ms: Type.Optional(
		Type.Number({
			description: `How long to wait for an answer, in milliseconds. Defaults to ${SUPERVISOR_DEFAULT_TIMEOUT_MS}, capped at ${SUPERVISOR_MAX_TIMEOUT_MS}.`,
		}),
	),
});

export interface ContactSupervisorToolDetails {
	/** Supervisor dir the question was posted into, when one was configured. */
	dir?: string;
	requestId?: string;
	answered?: boolean;
	answer?: string;
	timedOut?: boolean;
}

export interface ContactSupervisorToolOptions {
	/** Environment to read the supervisor dir from. Defaults to `process.env`. */
	env?: NodeJS.ProcessEnv;
	/** Injectable sleep, for tests that must not wait on wall-clock time. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	pollIntervalMs?: number;
	/** Run/task id recorded on the request for diagnostics. */
	targetId?: string;
}

function successResult(
	text: string,
	details: ContactSupervisorToolDetails,
): AgentToolResult<ContactSupervisorToolDetails> {
	return { content: [{ type: "text", text }], details };
}

/**
 * The tool definition. Returns undefined when this process has no supervisor dir
 * — there is nothing to contact, and a tool that can only fail is worse than no
 * tool.
 */
export function createContactSupervisorToolDefinition(
	options: ContactSupervisorToolOptions = {},
): ToolDefinition<typeof ContactSupervisorParams, ContactSupervisorToolDetails> | undefined {
	const env = options.env ?? process.env;
	const dir = supervisorDirFromEnv(env);
	if (!dir) return undefined;

	const definition: ToolDefinition<typeof ContactSupervisorParams, ContactSupervisorToolDetails> = {
		name: CONTACT_SUPERVISOR_TOOL_NAME,
		label: "Contact Supervisor",
		description:
			"Ask the supervising agent a blocking question and wait for its answer. Use when a decision is not yours " +
			"to guess at. If no answer arrives before the timeout, the question stays open and is reported to the " +
			"supervisor when this run settles — say what you assumed and continue.",
		promptSnippet: "Ask the supervising agent a blocking question",
		promptGuidelines: [
			"Reserve contact_supervisor for decisions you cannot safely infer from the task and the code",
			"Ask one specific question, with the options you are weighing in `context`",
			"If it returns no answer, state the assumption you proceeded on instead of retrying silently",
		],
		parameters: ContactSupervisorParams,
		async execute(_toolCallId, params: Static<typeof ContactSupervisorParams>, signal) {
			const question = params.question ?? "";
			if (question.trim() === "") {
				return successResult("contact_supervisor: `question` must not be empty.", { dir, timedOut: false });
			}
			const { request, truncated } = postSupervisorRequest(dir, {
				question,
				...(params.context === undefined ? {} : { context: params.context }),
				...(options.targetId === undefined ? {} : { targetId: options.targetId }),
			});

			const reply = await waitForSupervisorReply(dir, request.id, {
				...(params.timeout_ms === undefined ? {} : { timeoutMs: params.timeout_ms }),
				...(options.pollIntervalMs === undefined ? {} : { intervalMs: options.pollIntervalMs }),
				...(options.sleep === undefined ? {} : { sleep: options.sleep }),
				...(signal === undefined ? {} : { signal }),
			});

			if (!reply) {
				return successResult(
					`No answer yet. The question stays open (id=${request.id}${truncated ? ", truncated to fit the size bound" : ""}) ` +
						"and the supervisor is notified when this run settles. State the assumption you are proceeding on and continue.",
					{ dir, requestId: request.id, answered: false, timedOut: true },
				);
			}
			return successResult(`Supervisor answered (id=${request.id}): ${reply.answer}`, {
				dir,
				requestId: request.id,
				answered: true,
				answer: reply.answer,
			});
		},
	};
	return definition;
}

/** Runtime (wrapped) form of the tool, or undefined when it is not configured. */
export function createContactSupervisorTool(options: ContactSupervisorToolOptions = {}): AgentTool | undefined {
	const definition = createContactSupervisorToolDefinition(options);
	return definition ? (wrapToolDefinition(definition) as AgentTool) : undefined;
}

/** Whether this process should get the tool at all, for the session's wiring. */
export function shouldRegisterContactSupervisorTool(env: NodeJS.ProcessEnv = process.env): boolean {
	return hasSupervisorDir(env);
}

export { SUPERVISOR_DEFAULT_TIMEOUT_MS, SUPERVISOR_MAX_TIMEOUT_MS };
