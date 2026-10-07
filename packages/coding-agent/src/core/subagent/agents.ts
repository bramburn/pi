/**
 * Agent definition files (GitHub issue #1046).
 *
 * A definition is a markdown file with YAML frontmatter — a reusable subagent
 * *configuration* the user authors once and a tool call then names via
 * `{ agent: "<name>" }`. The file supplies defaults (model, tool allowlist,
 * thinking level, standing system prompt); the task itself always arrives
 * inline as `instructions`, because the whole point of delegation is that the
 * orchestrator knows what needs doing and the file does not.
 *
 * Discovery reads exactly two scopes, first match wins:
 *   1. project — `<cwd>/.pi/agents/*.md` (the same project-dir primitive the
 *      skills and prompt-template loaders use: `join(cwd, CONFIG_DIR_NAME, …)`)
 *   2. user    — `<agentDir>/agents/*.md` (`getAgentDir()`, honouring
 *      `PI_CODING_AGENT_DIR`)
 *
 * Frontmatter is read through the shared `parseFrontmatter` primitive, so there
 * is no second YAML parser in the codebase and no new dependency. Only the keys
 * listed in `AgentDefinition` are consumed; unknown keys are ignored, which is
 * what lets a definition written for a newer pi keep working on an older one.
 * A file whose *known* keys are unusable (no `name`, an invalid `thinking`
 * level) is skipped with a line on stderr: silently dropping it would read as
 * "that agent does not exist", and silently dropping the bad key would run the
 * child with a configuration nobody wrote.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { CONFIG_DIR_NAME, getAgentDir } from "../../config.ts";
import { parseFrontmatter } from "../../utils/frontmatter.ts";
import { THINKING_LEVEL_OPTIONS } from "../defaults.ts";

/** Directory name holding agent definitions inside each scope. */
export const AGENTS_DIR_NAME = "agents";

/** Which scope provided a definition. Project wins on name collision. */
export type AgentScope = "project" | "user";

/** One discovered agent definition file. */
export interface AgentDefinition {
	/** Lookup key, from the frontmatter `name` (a leading `@` is stripped). */
	name: string;
	/** What the agent is for. Not sent to the child; it is the human/model-facing label. */
	description?: string;
	/** Built-in tool allowlist. `model` / `tools` / `thinking` are defaults for the merge in `subagent-tool.ts`. */
	tools?: string[];
	/** Model id, unvalidated here — the dispatch path resolves and validates it. */
	model?: string;
	/** Thinking level, validated against the CLI's enum at parse time. */
	thinking?: ThinkingLevel;
	/** Standing prompt, prepended to the inline `instructions` at dispatch. */
	systemPrompt?: string;
	scope: AgentScope;
	/** Absolute path of the file this came from, for error messages. */
	filePath: string;
}

/** One discovery scope: where to look and what it is called. */
export interface AgentsDir {
	scope: AgentScope;
	dir: string;
}

/** The two agent directories, in precedence order (project first). */
export function agentsDirs(cwd: string): AgentsDir[] {
	const resolvedCwd = resolve(cwd);
	return [
		{ scope: "project", dir: join(resolvedCwd, CONFIG_DIR_NAME, AGENTS_DIR_NAME) },
		{ scope: "user", dir: join(getAgentDir(), AGENTS_DIR_NAME) },
	];
}

function warn(message: string): void {
	console.warn(`subagent-agents: ${message}`);
}

function asTrimmedString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}

/**
 * `tools` accepts the two shapes a hand-written file lands in: a comma list
 * (`tools: read, grep`) or a YAML sequence. Entries are trimmed, empties
 * dropped, duplicates collapsed, order preserved.
 */
function asToolList(value: unknown): string[] | undefined {
	if (value === undefined || value === null) return undefined;
	const items = Array.isArray(value) ? value : String(value).split(",");
	const tools: string[] = [];
	for (const item of items) {
		const entry = asTrimmedString(item);
		if (entry !== undefined && !tools.includes(entry)) tools.push(entry);
	}
	return tools.length > 0 ? tools : undefined;
}

/**
 * A name is a lookup key, never a path: reject separators and dot forms so a
 * frontmatter typo cannot name something the dispatcher cannot express.
 */
function asAgentName(value: unknown): string | undefined {
	const raw = asTrimmedString(value);
	if (raw === undefined) return undefined;
	// Tolerate the `@name` form the tool call uses in its own `agent` field.
	const name = raw.startsWith("@") ? raw.slice(1).trim() : raw;
	if (name === "" || name.includes("/") || name.includes("\\") || name.includes("..")) return undefined;
	return name;
}

/**
 * Parse one agent definition file.
 *
 * Returns `undefined` when the file cannot define an agent — unreadable, not
 * valid frontmatter, no usable `name`, or a `thinking` value outside the CLI's
 * enum — after reporting why.
 */
export function parseAgentFile(filePath: string, scope: AgentScope): AgentDefinition | undefined {
	let rawContent: string;
	try {
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		warn(`cannot read ${scope} definition ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}

	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(rawContent));
	} catch (error) {
		warn(`invalid frontmatter in ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}

	const name = asAgentName(frontmatter.name);
	if (name === undefined) {
		warn(`${filePath} has no usable \`name\` frontmatter key and is skipped`);
		return undefined;
	}

	// A known key with a bad value invalidates the whole definition: falling back
	// to "no thinking level" would dispatch with a level nobody asked for. The
	// enum is the one the CLI's `--thinking` flag and the settings UI accept.
	const thinkingValue = asTrimmedString(frontmatter.thinking);
	if (thinkingValue !== undefined && !isThinkingLevel(thinkingValue)) {
		warn(
			`${filePath} has invalid \`thinking: ${thinkingValue}\` (expected one of: ${THINKING_LEVEL_OPTIONS.join(", ")})`,
		);
		return undefined;
	}

	// The prompt is the frontmatter key when present, else the markdown body —
	// the shape every other pi markdown resource (skills, prompt templates,
	// Claude Code agent files) has trained people to write.
	const systemPrompt = asTrimmedString(frontmatter.systemPrompt) ?? asTrimmedString(body);
	const description = asTrimmedString(frontmatter.description);
	const model = asTrimmedString(frontmatter.model);
	const tools = asToolList(frontmatter.tools);

	return {
		name,
		...(description === undefined ? {} : { description }),
		...(tools === undefined ? {} : { tools }),
		...(model === undefined ? {} : { model }),
		...(thinkingValue === undefined ? {} : { thinking: thinkingValue }),
		...(systemPrompt === undefined ? {} : { systemPrompt }),
		scope,
		filePath,
	};
}

/** Markdown files directly inside `dir` (non-recursive, symlinks resolved). */
function listDefinitionFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch (error) {
		warn(`cannot list ${dir}: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
	const files: string[] = [];
	for (const entry of entries) {
		if (!entry.endsWith(".md")) continue;
		const filePath = join(dir, entry);
		try {
			if (!statSync(filePath).isFile()) continue;
		} catch {
			continue;
		}
		files.push(filePath);
	}
	return files.sort();
}

/**
 * Every valid agent definition, project scope first. On a name collision the
 * project definition wins, so a repo can pin an agent over a personal one.
 */
export function listAgents(cwd: string): AgentDefinition[] {
	const byName = new Map<string, AgentDefinition>();
	for (const { scope, dir } of agentsDirs(cwd)) {
		for (const filePath of listDefinitionFiles(dir)) {
			const definition = parseAgentFile(filePath, scope);
			if (definition === undefined || byName.has(definition.name)) continue;
			byName.set(definition.name, definition);
		}
	}
	return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Resolve one definition by name (a leading `@` is tolerated). */
export function resolveAgent(name: string, cwd: string): AgentDefinition | undefined {
	const key = asAgentName(name);
	if (key === undefined) return undefined;
	return listAgents(cwd).find((definition) => definition.name === key);
}

/** True when `value` is one of the CLI's thinking levels. */
function isThinkingLevel(value: string): value is ThinkingLevel {
	return (THINKING_LEVEL_OPTIONS as readonly string[]).includes(value);
}
