import { createRequire } from "module";
import { dirname, join } from "path";
import { pathToFileURL } from "url";

export type ClipboardModule = {
	getText: () => Promise<string>;
	setText: (text: string) => Promise<void>;
	hasImage: () => Promise<boolean>;
	// The fork addon returns a napi Buffer (a Uint8Array subclass); the
	// upstream @mariozechner/clipboard addon returned Array<number>.
	// Callers accept both shapes so either prebuild keeps working.
	getImageBinary: () => Promise<Uint8Array | Array<number>>;
	// Fork-only: returns "pi-clipboard-rs v..." when the addon is usable,
	// or an "@bramburn/clipboard-rs: no prebuild ..." sentinel when the
	// .node file is missing or fails to load. Upstream has no marker.
	addonMarker?: () => string;
};

type ClipboardRequire = (id: string) => unknown;

// Probe order: the fork-local Rust-native addon (`packages/clipboard-rs`)
// first, the upstream `@mariozechner/clipboard` second as a transitional
// fallback. PR-A dropped the upstream optionalDependency because the Rust
// addon now covers the full surface (text + image) on every platform we
// ship a prebuild for, but the second probe stays reachable for builds
// that still carry the upstream package.
//
// Requiring the fork does NOT prove it is usable: packages/clipboard-rs
// loads its .node lazily, so require() succeeds even when the prebuild
// is missing — the failure only surfaces at call time. Each probe is
// therefore validated via addonMarker(): the fork returns a "no
// prebuild" sentinel (or throws) when broken, which makes this loop
// fall through to the next probe instead of handing back a module that
// throws on first use.
const CLIPBOARD_PROBES = ["@bramburn/clipboard-rs", "@mariozechner/clipboard"] as const;

function isUsableClipboardModule(module: unknown): module is ClipboardModule {
	if (typeof module !== "object" || module === null) return false;
	const addonMarker = (module as ClipboardModule).addonMarker;
	if (!addonMarker) return true; // Upstream shape has no marker; require() succeeded.
	try {
		const marker = addonMarker.call(module);
		return typeof marker === "string" && !marker.startsWith("@bramburn/clipboard-rs:");
	} catch {
		return false;
	}
}

const moduleRequire = createRequire(import.meta.url);
const executableDirRequire = createRequire(pathToFileURL(join(dirname(process.execPath), "package.json")).href);
const hasDisplay = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);

export function loadClipboardNative(
	requires: readonly ClipboardRequire[] = [moduleRequire, executableDirRequire],
): ClipboardModule | null {
	for (const requireClipboard of requires) {
		for (const probe of CLIPBOARD_PROBES) {
			try {
				const module = requireClipboard(probe);
				if (isUsableClipboardModule(module)) return module;
			} catch {
				// Try the next probe / resolution root.
			}
		}
	}
	return null;
}

const clipboard = !process.env.TERMUX_VERSION && hasDisplay ? loadClipboardNative() : null;

export { clipboard };
