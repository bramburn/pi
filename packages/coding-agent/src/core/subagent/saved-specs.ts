/**
 * Persistent spec templates for native subagents.
 *
 * A `SubagentSpec` is normally authored inline at call time, but recurring
 * specialists (a code-reviewer, a test-runner) are worth keeping. This module
 * is the file-backed store for named templates, one small JSON file per spec:
 *
 * ~/.pi/agent/subagent-specs/<name>.json
 *
 * Each file is the persisted spec fields plus a `savedAt` stamp. The spec is
 * stored as a *template*, so the per-run `sessionFile` is intentionally not
 * persisted — a session file names one finished run, not a reusable role.
 *
 * I/O is `node:fs` sync: the files are a few hundred bytes, so streaming and
 * async adds nothing. Names are flat filenames — path separators are rejected
 * so a saved spec can never escape the specs directory.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { getAgentDir } from "../../config.ts";
import { THINKING_LEVEL_OPTIONS } from "../defaults.ts";
import type { SubagentGate, SubagentSpec } from "./types.ts";

export const SPECS_DIR_NAME = "subagent-specs";
const SPEC_FILE_EXT = ".json";

export interface SavedSpec {
	/** Filename without the `.json` extension. */
	name: string;
	/** The persisted spec fields (notably: no `savedAt`, no `sessionFile`). */
	spec: SubagentSpec;
	/** ISO timestamp recorded when the spec was saved. */
	savedAt: string;
}

/** On-disk shape: the persisted spec fields plus the save timestamp. */
interface SavedSpecFile {
	role: string;
	instructions: string;
	model?: string;
	tools?: string[];
	cwd?: string | null;
	thinking?: ThinkingLevel;
	outputSchema?: Record<string, unknown>;
	gate?: SubagentGate;
	savedAt: string;
}

/** Absolute path of the saved-specs directory under the agent dir. */
export function specsDir(): string {
	return join(getAgentDir(), SPECS_DIR_NAME);
}

function specPath(name: string): string {
	if (name.length === 0) {
		throw new Error("invalid spec name: name must not be empty");
	}
	if (name.includes("/") || name.includes("\\")) {
		throw new Error(`invalid spec name "${name}": names must not contain path separators`);
	}
	return join(specsDir(), `${name}${SPEC_FILE_EXT}`);
}

/** Project the parsed file back onto the optional-field `SubagentSpec` shape. */
function toSpec(file: SavedSpecFile): SubagentSpec {
	const spec: SubagentSpec = { role: file.role, instructions: file.instructions };
	if (typeof file.model === "string") spec.model = file.model;
	if (Array.isArray(file.tools)) {
		spec.tools = file.tools.filter((tool): tool is string => typeof tool === "string");
	}
	if (typeof file.cwd === "string") spec.cwd = file.cwd;
	// `thinking` names a CLI value, so an unrecognized one is dropped rather than
	// passed through — same rule as the contract fields above.
	if (typeof file.thinking === "string" && (THINKING_LEVEL_OPTIONS as readonly string[]).includes(file.thinking)) {
		spec.thinking = file.thinking as ThinkingLevel;
	}
	// The contract fields come from a hand-editable file, so they are re-checked
	// structurally here. An unusable one is dropped rather than trusted: saving a
	// spec is not the place to fail a later dispatch, and `checkContractSpec`
	// reports anything genuinely required.
	if (isPlainObject(file.outputSchema)) spec.outputSchema = file.outputSchema;
	const gate = readGate(file.gate);
	if (gate !== undefined) spec.gate = gate;
	return spec;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Read a persisted gate, keeping only the fields that are the right type. */
function readGate(value: unknown): SubagentGate | undefined {
	if (!isPlainObject(value)) return undefined;
	if (typeof value.command !== "string" || value.command.trim() === "") return undefined;
	const gate: SubagentGate = { command: value.command };
	if (typeof value.cwd === "string") gate.cwd = value.cwd;
	if (typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs) && value.timeoutMs > 0) {
		gate.timeoutMs = value.timeoutMs;
	}
	return gate;
}

/** List all saved specs, sorted by name. A missing directory reads as empty. */
export function listSpecs(): SavedSpec[] {
	const dir = specsDir();
	if (!existsSync(dir)) {
		return [];
	}
	const specs: SavedSpec[] = [];
	for (const entry of readdirSync(dir)) {
		if (!entry.endsWith(SPEC_FILE_EXT)) {
			continue;
		}
		const name = entry.slice(0, -SPEC_FILE_EXT.length);
		try {
			const parsed = JSON.parse(readFileSync(join(dir, entry), "utf8")) as SavedSpecFile;
			specs.push({ name, spec: toSpec(parsed), savedAt: parsed.savedAt });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.warn(`subagent-saved-specs: skipping unreadable spec "${name}": ${message}`);
		}
	}
	specs.sort((a, b) => a.name.localeCompare(b.name));
	return specs;
}

/** Load one spec by name. Throws when no saved spec exists. */
export function loadSpec(name: string): SubagentSpec {
	const path = specPath(name);
	if (!existsSync(path)) {
		throw new Error(`no saved specs found for "${name}"`);
	}
	const parsed = JSON.parse(readFileSync(path, "utf8")) as SavedSpecFile;
	return toSpec(parsed);
}

/** Save (create or overwrite) a spec template. */
export function saveSpec(name: string, spec: SubagentSpec): void {
	const path = specPath(name);
	mkdirSync(specsDir(), { recursive: true });
	const file: SavedSpecFile = {
		role: spec.role,
		instructions: spec.instructions,
		savedAt: new Date().toISOString(),
	};
	if (spec.model !== undefined) file.model = spec.model;
	if (spec.tools !== undefined) file.tools = [...spec.tools];
	if (spec.cwd !== undefined) file.cwd = spec.cwd;
	if (spec.thinking !== undefined) file.thinking = spec.thinking;
	if (spec.outputSchema !== undefined) file.outputSchema = spec.outputSchema;
	if (spec.gate !== undefined) file.gate = { ...spec.gate };
	writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, "utf8");
}

/** Delete a spec by name. Throws when no saved spec exists. */
export function deleteSpec(name: string): void {
	const path = specPath(name);
	if (!existsSync(path)) {
		throw new Error(`no saved spec found: "${name}"`);
	}
	unlinkSync(path);
}
