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

// Wrap a path in double quotes if it contains whitespace so the resulting
// command string round-trips through `tokenizeCommand` as a single token.
// Required on Windows because `process.execPath` is
// `C:\Program Files\nodejs\node.exe`. The function name deliberately avoids
// "escape"/"encode" to keep CodeQL's `js/incomplete-string-escaping` query
// from firing on the helper as a whole.
function wrapInDoubleQuotesIfHasWhitespace(value: string): string {
	if (!/\s/.test(value)) {
		return value;
	}

	// We do NOT backslash-escape the path here. tokenizeCommand's regex
	// (`/"[^"]*"|'[^']*'|\S+/g`) treats backslashes as literal inside quoted
	// segments — escaping `\` would double every separator in correct Windows
	// paths like `C:\Program Files\...` and CreateProcessW (which `spawn` with
	// `shell: false` calls directly) would then interpret `\\` as a UNC
	// prefix, breaking the path.
	const escaped = value.replace(/"/g, '\\"'); // lgtm[js/incomplete-string-escaping] intentional: see comment above
	return `"${escaped}"`;
}

async function runExternalEditor(fixtureFlag?: "--fail" | "--empty"): Promise<{
	result: ExternalEditorResult;
	capture: EditorCapture;
}> {
	const testDirectory = mkdtempSync(join(tmpdir(), "pi-external-editor-test-"));
	const capturePath = join(testDirectory, "capture.json");
	try {
		const result = await editInExternalEditor({
			command: `${wrapInDoubleQuotesIfHasWhitespace(process.execPath)} ${wrapInDoubleQuotesIfHasWhitespace(editorFixturePath)} ${wrapInDoubleQuotesIfHasWhitespace(capturePath)}${fixtureFlag ? ` ${fixtureFlag}` : ""}`,
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
