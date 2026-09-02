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
// We do not use `bindings` because we want a small dependency surface
// and the lookup is two lines.

import { createRequire } from "node:module";
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
if (!platform || !arch) {
	throw new Error(
		`@bramburn/clipboard-rs: no prebuild for ${process.platform}-${process.arch}`,
	);
}

const binaryPath = join(here, "prebuilds", `${platform}-${arch}`, "clipboard-rs.node");

// `require` will throw ENOENT on platforms without a prebuild. Callers
// should catch and fall back to the platform tools (pbcopy, wl-copy, etc.).
export const addon = require(binaryPath);

export const getText = addon.getText;
export const setText = addon.setText;
export const hasImage = addon.hasImage;
export const getImageBinary = addon.getImageBinary;
export const addonMarker = addon.addonMarker;
