import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PACKAGE_NAME } from "../src/config.ts";
import {
	checkForNewQiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestQiRelease,
	getLatestQiVersion,
	getNpmRegistryUrl,
	isNewerPackageVersion,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.QI_SKIP_VERSION_CHECK;

/** npm registry metadata for a package (the payload `https://registry.npmjs.org/<name>` returns). */
function npmRegistryMetadata(options: { name?: string; latest: string; versions?: string[] }): unknown {
	return {
		...(options.name ? { name: options.name } : {}),
		"dist-tags": { latest: options.latest },
		versions: Object.fromEntries((options.versions ?? [options.latest]).map((version) => [version, {}])),
	};
}

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.QI_SKIP_VERSION_CHECK;
	} else {
		process.env.QI_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("resolves the latest version from the npm registry for the current package", async () => {
		const fetchMock = vi.fn(async (_url: string | URL | Request) =>
			Response.json(npmRegistryMetadata({ name: PACKAGE_NAME, latest: "1.2.4" })),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestQiRelease("1.2.3")).resolves.toEqual({
			version: "1.2.4",
			packageName: PACKAGE_NAME,
		});
		await expect(getLatestQiVersion("1.2.3")).resolves.toBe("1.2.4");

		expect(fetchMock).toHaveBeenCalledTimes(2);
		// Resolution happens against the npm registry for the current package only.
		const requestedUrl = String(fetchMock.mock.calls[0]?.[0] ?? "");
		expect(requestedUrl).toBe(getNpmRegistryUrl());
		expect(requestedUrl.startsWith("https://registry.npmjs.org/")).toBe(true);
	});

	it("falls back to the highest published version when dist-tags is missing", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ name: PACKAGE_NAME, versions: { "1.2.3": {}, "1.10.0": {}, "1.9.9": {} } }),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestQiRelease("1.2.3")).resolves.toEqual({
			version: "1.10.0",
			packageName: PACKAGE_NAME,
		});
	});

	it("reports a newer registry release and skips current or older ones", async () => {
		const fetchMock = vi.fn(async () => Response.json(npmRegistryMetadata({ name: PACKAGE_NAME, latest: "1.2.4" })));
		vi.stubGlobal("fetch", fetchMock);

		const newer = await checkForNewQiVersion("1.2.3");
		expect(newer).toEqual({ version: "1.2.4", packageName: PACKAGE_NAME });

		await expect(checkForNewQiVersion("1.2.4")).resolves.toBeUndefined();
		await expect(checkForNewQiVersion("1.2.5")).resolves.toBeUndefined();
	});

	it("skips the network entirely when offline", async () => {
		vi.stubEnv("QI_OFFLINE", "1");
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestQiRelease("1.2.3")).resolves.toBeUndefined();
		await expect(getLatestQiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewQiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.QI_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json(npmRegistryMetadata({ latest: "1.2.4" })));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewQiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();

		// Explicit checks (e.g. `qi update --self`) are not gated by the skip flag.
		await expect(getLatestQiRelease("1.2.3")).resolves.toEqual({
			version: "1.2.4",
			packageName: PACKAGE_NAME,
		});
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("retries transient registry failures when a retry is requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json(npmRegistryMetadata({ latest: "1.2.4" })));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestQiRelease("1.2.3", { retry: true })).resolves.toEqual({
			version: "1.2.4",
			packageName: PACKAGE_NAME,
		});
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("does not retry by default and surfaces the last failure", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestQiRelease("1.2.3")).rejects.toThrow("fetch failed");
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("surfaces registry HTTP failures", async () => {
		const fetchMock = vi.fn(async () => new Response("Not Found", { status: 404 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestQiRelease("1.2.3")).rejects.toThrow(`npm registry returned HTTP 404 for ${PACKAGE_NAME}`);
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("keeps automatic checks silent on registry errors", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewQiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});
});
