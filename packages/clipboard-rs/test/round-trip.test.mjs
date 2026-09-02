// Round-trip test for @bramburn/clipboard-rs.
//
// Two skip paths:
//   1. Platform/arch not in the prebuilds/ matrix. Local dev only;
//      CI runs the matrix on all 6 targets.
//   2. Linux CI has no display server. The coding-agent's JS layer
//      already falls back to wl-copy / xclip / OSC 52 on Linux; the
//      Rust crate is not exercised on headless Linux. We still
//      verify the addon loads (so a corrupt .node would fail the
//      test), but skip the actual round-trip.

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { test } from "node:test";

import * as clipboard from "../index.js";

const here = dirname(fileURLToPath(import.meta.url));
const platformMap = { linux: "linux", darwin: "darwin", win32: "win32" };
const archMap = { x64: "x64", arm64: "arm64" };
const platform = platformMap[process.platform];
const arch = archMap[process.arch];
const binaryPath = join(here, "..", "prebuilds", `${platform}-${arch}`, "clipboard-rs.node");

if (!platform || !arch || !existsSync(binaryPath)) {
	test(`@bramburn/clipboard-rs on ${process.platform}-${process.arch}`, { skip: true }, () => {
		// Skip: no prebuild for this platform in the current checkout.
		// The CI matrix builds all six targets.
	});
} else {
	test(`@bramburn/clipboard-rs addon loads on ${platform}-${arch}`, () => {
		// Confirm the right addon is loaded and exports the expected
		// four-method surface. Runs on every platform including
		// headless Linux — a corrupt .node would fail this test.
		const marker = clipboard.addonMarker();
		assert.match(marker, /^pi-clipboard-rs v/);
		assert.equal(typeof clipboard.getText, "function");
		assert.equal(typeof clipboard.setText, "function");
		assert.equal(typeof clipboard.hasImage, "function");
		assert.equal(typeof clipboard.getImageBinary, "function");
	});

	test(`@bramburn/clipboard-rs hasImage stub on ${platform}-${arch}`, () => {
		// v1 stub: hasImage always returns false. Image round-trip
		// is a follow-up session.
		assert.equal(clipboard.hasImage(), false);
	});

	test(`@bramburn/clipboard-rs round-trip on ${platform}-${arch}`, async (t) => {
		// Skip the actual write/read on headless Linux — the JS layer
		// falls back to wl-copy / xclip / OSC 52 there, and the CI
		// runner has no display for arboard to talk to.
		if (platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
			t.skip();
			return;
		}

		const payload = `hello clipboard from rust @ ${Date.now()}`;
		await clipboard.setText(payload);
		const read = await clipboard.getText();
		assert.equal(
			read,
			payload,
			`round-trip failed: wrote ${JSON.stringify(payload)}, read ${JSON.stringify(read)}`,
		);
	});
}
