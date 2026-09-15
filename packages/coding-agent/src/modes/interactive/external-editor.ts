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

// Tokenize a single command string into [executable, ...args] respecting double
// quotes. Required because `options.command` is user-supplied and may contain
// quoted segments (e.g. `"C:\Program Files\Vim\vim.exe" -p`), and on POSIX we
// invoke the child via `spawn(executable, args, { shell: false })` — passing
// the entire string as one arg would make the kernel look for a binary whose
// name includes the leading `"`.
function tokenizeCommand(command: string): string[] {
	const tokens: string[] = [];
	let current = "";
	let inQuotes = false;
	for (let i = 0; i < command.length; i++) {
		const ch = command[i];
		if (ch === '"') {
			inQuotes = !inQuotes;
		} else if (ch === " " && !inQuotes) {
			if (current.length > 0) {
				tokens.push(current);
				current = "";
			}
		} else {
			current += ch;
		}
	}
	if (current.length > 0) tokens.push(current);
	return tokens;
}

export async function editInExternalEditor(options: ExternalEditorOptions): Promise<ExternalEditorResult> {
	const directory = mkdtempSync(join(tmpdir(), "pi-editor-"));
	const filePath = join(directory, "prompt.md");
	try {
		writeFileSync(filePath, options.content, "utf-8");
		const tokens = tokenizeCommand(options.command);
		const editor = tokens[0] ?? "";
		const editorArgs = tokens.slice(1);
		process.stdout.write(`Launching external editor: ${options.command}\nPi will resume when the editor exits.\n`);

		// Do not use spawnSync here. On Windows, synchronous child_process calls can keep
		// Node/libuv's console input read active after the parent pauses stdin, racing
		// vim/nvim for the console input buffer until Ctrl+C cancels the pending read.
		// On Windows, `shell: true` runs the command through cmd.exe, which splits
		// unquoted paths on spaces. If the editor executable path contains spaces
		// (e.g. `C:\Program Files\Vim\vim.exe`), quote it before passing to the
		// shell. POSIX keeps `shell: false` so the kernel receives a clean argv.
		const exitCode = await new Promise<number | null>((resolve) => {
			let child: ReturnType<typeof spawn>;
			if (process.platform === "win32") {
				const quoted = [editor, ...editorArgs]
					.map((arg) => (/\s|"/.test(arg) ? `"${arg.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : arg))
					.join(" ");
				child = spawn(quoted, [filePath], {
					stdio: "inherit",
					shell: true,
				});
			} else {
				child = spawn(editor, [...editorArgs, filePath], {
					stdio: "inherit",
				});
			}
			child.on("error", () => resolve(null));
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
