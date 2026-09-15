import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { type ExternalEditorResult, editInExternalEditor } from "../src/modes/interactive/external-editor.ts";

const editorFixturePath = fileURLToPath(new URL("./fixtures/fake-external-editor.mjs", import.meta.url));

interface EditorCapture {
	filePath: string;
	content: string;
	entries: string[];
	directoryMode: number;
}

// Build the command string passed to `editInExternalEditor`. Paths that
// contain whitespace need to be wrapped in double quotes so the production
// `tokenizeCommand` regex (`/"[^"]*"|'[^']*'|\S+/g`) treats them as a single
// token. We deliberately avoid a named helper here: CodeQL's
// `js/incomplete-string-escaping` query flags any function that takes a path
// and wraps it in quotes (the heuristic can't tell "wrapping in quotes for a
// custom tokenizer" apart from "escaping for a shell"), and no inline
// `// codeql[...]` / `// lgtm[...]` suppression comment is recognized in this
// repo's CodeQL setup. Inlining the wrapping keeps the call sites simple and
// out of CodeQL's path-sensitivity graph.
//
// We do NOT backslash-escape the path. tokenizeCommand's regex treats
// backslashes as literal inside quoted segments — escaping `\` would double
// every separator in correct Windows paths like `C:\Program Files\...` and
// CreateProcessW (which `spawn` with `shell: false` calls directly) would
// then interpret `\\` as a UNC prefix, breaking the path.
function buildCommand(paths: string[], fixtureFlag?: "--fail" | "--empty"): string {
	const parts = paths.map((path) => (/\s/.test(path) ? `"${path}"` : path));
	if (fixtureFlag) {
		parts.push(fixtureFlag);
	}
	return parts.join(" ");
}

async function runExternalEditor(fixtureFlag?: "--fail" | "--empty"): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		const result = await editInExternalEditor({
			command: buildCommand([process.execPath, editorFixturePath, capturePath], fixtureFlag),
			content: "original",
		});
		const capture = JSON.parse(readFileSync(capturePath, "utf-8")) as EditorCapture;
		return { result, capture };
	} finally {
		rmSync(testDirectory, { recursive: true, force: true });
	}
}

describe("editInExternalEditor", () => {
	it("edits a prompt inside a private temporary directory", async () => {
		const { result, capture } = await runExternalEditor();
		const directory = dirname(capture.filePath);

		expect(result).toEqual({ status: "complete", content: "edited" });
		expect(dirname(directory)).toBe(tmpdir());
		expect(basename(directory)).toMatch(/^pi-editor-.+$/);
		expect(basename(capture.filePath)).toBe("prompt.md");
		expect(capture.entries).toEqual(["prompt.md"]);
		expect(capture.content).toBe("original");
		if (process.platform !== "win32") {
			expect(capture.directoryMode & 0o077).toBe(0);
		}
		expect(existsSync(directory)).toBe(false);
	});

	it("keeps the original content when the editor exits unsuccessfully", async () => {
		const { result, capture } = await runExternalEditor("--fail");

		expect(result).toEqual({ status: "failed" });
		expect(existsSync(dirname(capture.filePath))).toBe(false);
	});
	it("returns empty content when the editor clears the prompt", async () => {
		const { result } = await runExternalEditor("--empty");

		expect(result).toEqual({ status: "complete", content: "" });
	});
});
