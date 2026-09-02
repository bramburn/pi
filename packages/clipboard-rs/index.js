// @bramburn/clipboard-rs — runtime loader.
//
// The CI build (`.github/workflows/clipboard-rs-build.yml`) produces a
// per-platform `.node` file in `prebuilds/<platform>-<arch>/`. This
// shim picks the right one based on `process.platform` and
// `process.arch`, then re-exports the N-API functions under the same
// names that `@mariozechner/clipboard` exposes.
//
// Why a shim instead of an `optionalDependencies` fan-out:
//   The fork's previous CI was failing on `npm ci --ignore-scripts`
//   because npm is strict about platform-specific optional deps and
//   refused to install `@mariozechner/clipboard-darwin-arm64` on a
//   linux-x64 runner. Committing all 6 prebuilds to the main package
//   side-steps that problem entirely — npm just downloads the single
//   tarball and the JS picks the right binary at runtime.
//
// Why a lazy require instead of an eager top-level require:
//   The .node file is platform-specific. Importing this module on a
//   platform without a prebuild (e.g. local dev on windows-x64 when
//   only darwin prebuilds are present) would throw ENOENT at import
//   time. The lazy require inside the wrapper functions makes
//   importing safe and lets the test suite skip the round-trip on
//   platforms without a prebuild.

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

const platformMap = {
	linux: "linux",
	darwin: "darwin",
	win32: "win32",
};
const archMap = {
	x64: "x64",
	arm64: "arm64",
};

const platform = platformMap[process.platform];
const arch = archMap[process.arch];
const binaryPath =
	platform && arch ? join(here, "prebuilds", `${platform}-${arch}`, "clipboard-rs.node") : null;

// The addon is loaded on the first function call. If the prebuild is
// missing (e.g. local dev checkout with no committed prebuilds), the
// require throws ENOENT, and we surface a clear error message
// instead of crashing at import time.
let addon = null;
let loadError = null;
function loadAddon() {
	if (addon) return addon;
	if (loadError) throw loadError;
	if (!binaryPath) {
		loadError = new Error(
			`@bramburn/clipboard-rs: no prebuild path for ${process.platform}-${process.arch}`,
		);
		throw loadError;
	}
	if (!existsSync(binaryPath)) {
		loadError = new Error(
			`@bramburn/clipboard-rs: prebuild not found at ${binaryPath}. ` +
				`Run the matrix build in .github/workflows/clipboard-rs-build.yml ` +
				`or copy a prebuild into prebuilds/${process.platform}-${process.arch}/`,
		);
		throw loadError;
	}
	try {
		addon = require(binaryPath);
		return addon;
	} catch (e) {
		loadError = e;
		throw e;
	}
}

export async function getText() {
	return loadAddon().getText();
}

export async function setText(text) {
	return loadAddon().setText(text);
}

export function hasImage() {
	return loadAddon().hasImage();
}

export async function getImageBinary() {
	return loadAddon().getImageBinary();
}

export function addonMarker() {
	try {
		return loadAddon().addonMarker();
	} catch {
		return `@bramburn/clipboard-rs: no prebuild for ${process.platform}-${process.arch}`;
	}
}
