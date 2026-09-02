// Round-trip test for @bramburn/clipboard-rs.
//
// Skipped automatically on platforms where the prebuild is missing
// (e.g. local dev on a platform not in the matrix). The full matrix
// runs in `.github/workflows/clipboard-rs-build.yml`.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { getText, setText, hasImage, getImageBinary, addonMarker } from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const platformMap = { linux: "linux", darwin: "darwin", win32: "win32" };
const archMap = { x64: "x64", arm64: "arm64" };
const platform = platformMap[process.platform];
const arch = archMap[process.arch];
const binaryPath = join(here, "..", "prebuilds", `${platform}-${arch}`, "clipboard-rs.node");

if (!platform || !arch || !existsSync(binaryPath)) {
	test(`@bramburn/clipboard-rs round-trip on ${process.platform}-${process.arch}`, { skip: true }, () => {
		// Skip: no prebuild for this platform in the current checkout.
		// The CI matrix builds all six targets.
	});
} else {
	test(`@bramburn/clipboard-rs round-trip on ${process.platform}-${arch}`, async () => {
		// Confirm the right addon is loaded.
		const marker = addonMarker();
		assert.match(marker, /^@bramburn\/clipboard-rs v/);

		// hasImage stub: v1 always returns false. Image round-trip is a
		// follow-up session.
		assert.equal(hasImage(), false);

		// getImageBinary stub: v1 always returns an empty array.
		const bin = await getImageBinary();
		assert.deepEqual(bin, []);

		// The real assertion: write a unique string, read it back,
		// expect identity.
		const payload = `hello clipboard from rust @ ${Date.now()}`;
		await setText(payload);
		const read = await getText();
		assert.equal(read, payload, `round-trip failed: wrote ${JSON.stringify(payload)}, read ${JSON.stringify(read)}`);
	});
}
