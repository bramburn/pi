import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripBom } from "../../utils/text.ts";

export interface ExternalEditorOptions {
	command: string;
	content: string;
}

export type ExternalEditorResult = { status: "complete"; content: string } | { status: "failed" };

// Tokenize a single command string into [executable, ...args] respecting both
// single and double quotes. Required because `options.command` is user-supplied
// and may contain quoted segments (e.g. `"C:\Program Files\Vim\vim.exe" -p`),
// and on POSIX we invoke the child via `spawn(executable, args, { shell: false })`
// — passing the entire string as one arg would make the kernel look for a
// binary whose name includes the leading `"`. Quoted tokens have their
// surrounding quotes stripped and `\"` / `\'` inside them unescaped.
function tokenizeCommand(command: string): string[] {
	const raw = command.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
	return raw.map((token) => {
		if (token.length >= 2 && token.startsWith('"') && token.endsWith('"')) {
			return token.slice(1, -1).replace(/\\"/g, '"');
		}
		if (token.length >= 2 && token.startsWith("'") && token.endsWith("'")) {
			return token.slice(1, -1).replace(/\\'/g, "'");
		}
		return token;
	});
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), `pi-editor-${crypto.randomUUID()}-`));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const tokens = tokenizeCommand(options.command);
		const editor = tokens[0] ?? "";
		const editorArgs = tokens.slice(1);
		// Only show the executable, not the full command — the command may include
		// sensitive args (e.g. SSH key paths, credentials) the user supplied.
		process.stdout.write(`Launching external editor: ${tokens[0] ?? options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		// Use `shell: false` so the kernel receives a clean argv. tokenizeCommand has
		// already split the command into individual tokens; passing them as an array
		// avoids any further shell-side splitting. CreateProcessW handles paths with
		// spaces on Windows, so we do NOT need to wrap the executable in quotes (which
		// would make Node look for a file whose name literally contains the quotes).
		const exitCode = await new Promise<number | null>((resolve) => {
			const child = spawn(editor, [...editorArgs, filePath], {
				stdio: "inherit",
				shell: false,
			});
			child.on("error", (err) => {
				// Log the spawn failure so the user can see why the editor didn't launch
				// (missing binary, permission denied, etc.) instead of silently returning null.
				console.error(`[external-editor] spawn error: ${err.message}`);
				resolve(null);
			});
			child.on("close", (code) => resolve(code));
		});

		if (exitCode !== 0) {
			return { status: "failed" };
		}

		return { status: "complete", content: stripBom(readFileSync(filePath, "utf-8")).replace(/\n$/, "") };
	} finally {
		try {
			rmSync(directory, { recursive: true, force: true });
		} catch {
			// Cleanup is best effort.
		}
	}
}
