import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

export type ClipboardModule = {
	getText: () => Promise<string>;
	setText: (text: string) => Promise<void>;
	hasImage: () => boolean;
	getImageBinary: () => Promise<Array<number>>;
};

type ClipboardRequire = (id: string) => unknown;

// Single probe: the fork-local Rust-native addon (`packages/clipboard-rs`).
// PR-A drops the upstream `@mariozechner/clipboard` optionalDependency
// because the Rust addon now covers the full surface (text + image) on
// every platform we ship a prebuild for. If a build ever needs to roll
// back to the JS addon, restore the second probe and the matching
// optionalDependencies entry.
const CLIPBOARD_PROBES = ["@bramburn/clipboard-rs"] as const;

const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);
const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

export function loadClipboardNative(
	requires: readonly ClipboardRequire[] = [moduleRequire, executableDirRequire],
): ClipboardModule | null {
	for (const requireClipboard of requires) {
		for (const probe of CLIPBOARD_PROBES) {
			try {
				return requireClipboard(probe) as ClipboardModule;
			} catch {
				// Try the next probe / resolution root.
			}
		}
	}
	return null;
}

const clipboard = !process.env.TERMUX_VERSION && hasDisplay ? loadClipboardNative() : null;

export { clipboard };