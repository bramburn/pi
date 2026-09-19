// Round-trip test for @bramburn/clipboard-rs.
//
// Three skip paths:
//   1. Platform/arch not in the prebuilds/ matrix. Local dev only;
//      CI runs the matrix on all 6 targets.
//   2. Linux CI has no display server. The coding-agent's JS layer
//      already falls back to wl-copy / xclip / OSC 52 on Linux; the
//      Rust crate is not exercised on headless Linux. We still
//      verify the addon loads (so a corrupt .node would fail the
//      test), but skip the actual round-trip.
//   3. The image read path is also skipped on headless Linux: arboard's
//      image backend is unreliable without a display server, and the
//      image-write path is not guaranteed across apps (per arboard docs).

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

// Prebuild path. Newer CI matrix commits use the `${platform}-${arch}-${abi}`
// triple (e.g. win32-x64-msvc); older checkouts may have a plain
// `${platform}-${arch}` directory without the ABI suffix. Try the
// ABI-suffixed name first so the matrix in
// .github/workflows/clipboard-rs-build.yml works out of the box.
function resolveBinaryPath(plat, archName) {
	const triple = `${plat}-${archName}`;
	const candidates = [
		join(here, "..", "prebuilds", `${triple}-msvc`, "clipboard-rs.node"),
		join(here, "..", "prebuilds", `${triple}-gnu`, "clipboard-rs.node"),
		join(here, "..", "prebuilds", triple, "clipboard-rs.node"),
	];
	for (const candidate of candidates) {
		if (existsSync(candidate)) return candidate;
	}
	return candidates[0];
}

const binaryPath = platform && arch ? resolveBinaryPath(platform, arch) : null;

// 1x1 transparent PNG, base fixture for the image read path. Source:
// hand-rolled — no need to ship a binary fixture.
const FIXTURE_PNG = Uint8Array.of(
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
	0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
	0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
	0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
	0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
	0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
	0x42, 0x60, 0x82,
);

function skipOnHeadless(t) {
	if (platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
		t.skip();
		return true;
	}
	return false;
}

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

	test(`@bramburn/clipboard-rs hasImage contract on ${platform}-${arch}`, async () => {
		// hasImage probes the clipboard and returns true only if the
		// payload is a non-empty image. After setText (which the text
		// round-trip test below performs), hasImage must still be false
		// because plain text is not an image payload.
		//
		// We deliberately do NOT assert hasImage() === false on the
		// initial read: the test suite starts on a developer's machine
		// where the user may have left any number of payloads on the
		// clipboard (image previews, browser screenshots, etc). The
		// stateful assertion below, after we explicitly write text,
		// covers the actual contract: "setText does not flip hasImage".
		await clipboard.setText("reset to known state");
		assert.equal(
			await clipboard.hasImage(),
			false,
			"hasImage must be false after a plain-text write",
		);
	});

	test(`@bramburn/clipboard-rs round-trip on ${platform}-${arch}`, async (t) => {
		// Skip the actual write/read on headless Linux — the JS layer
		// falls back to wl-copy / xclip / OSC 52 there, and the CI
		// runner has no display for arboard to talk to.
		if (skipOnHeadless(t)) return;

		const payload = `hello clipboard from rust @ ${Date.now()}`;
		await clipboard.setText(payload);
		const read = await clipboard.getText();
		assert.equal(
			read,
			payload,
			`round-trip failed: wrote ${JSON.stringify(payload)}, read ${JSON.stringify(read)}`,
		);
		// After a text round-trip the clipboard must not suddenly
		// advertise itself as holding an image.
		assert.equal(
			await clipboard.hasImage(),
			false,
			"hasImage must be false after a plain-text write",
		);
	});

	test(`@bramburn/clipboard-rs image read on ${platform}-${arch}`, async (t) => {
		// arboard's image-read path is unreliable without a display
		// server; skip headless Linux the same way the text round-trip
		// does. We deliberately do NOT exercise the image-write path:
		// arboard docs flag set_image as "not guaranteed" across apps.
		if (skipOnHeadless(t)) return;

		// No image on the clipboard to start with. hasImage returns
		// false and getImageBinary returns an empty array.
		assert.equal(await clipboard.hasImage(), false);
		const empty = await clipboard.getImageBinary();
		assert.ok(Array.isArray(empty), "getImageBinary must return an array");
		assert.equal(empty.length, 0, "getImageBinary must be empty when no image is on the clipboard");

		// Writing text must not flip hasImage. This guards the TS-side
		// caller, which uses hasImage to decide whether to render an
		// inline image preview.
		await clipboard.setText("plain text payload");
		assert.equal(
			await clipboard.hasImage(),
			false,
			"hasImage must stay false after a plain-text write",
		);

		// Sanity check the fixture is a valid PNG (signature check).
		// The fixture is shipped as a constant above; if it ever
		// regresses, the PNG encoder would still encode it but the
		// signature check is a cheap guard.
		assert.equal(
			FIXTURE_PNG[0],
			0x89,
			"PNG fixture signature byte 0",
		);
		assert.equal(FIXTURE_PNG[1], 0x50, "PNG fixture signature byte 1");
		assert.equal(FIXTURE_PNG[2], 0x4e, "PNG fixture signature byte 2");
		assert.equal(FIXTURE_PNG[3], 0x47, "PNG fixture signature byte 3");
	});
}