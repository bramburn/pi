import { compare, rcompare, valid } from "semver";
import { PACKAGE_NAME } from "../config.ts";

// ADR-0002 / D4 severed the upstream version-check endpoint (fork hard cut).
// Self-update now resolves the latest version of the current package from the npm
// registry metadata for PACKAGE_NAME (human decision 2026-10-20: port `update --self`
// to the npm registry, not to upstream hosts or GitHub releases).
const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;
/** Total attempts (1 initial + retries) when `retry` is requested. */
const VERSION_CHECK_RETRY_ATTEMPTS = 3;
const VERSION_CHECK_RETRY_DELAY_MS = 200;

/** Registry metadata URL for a package name (`@scope/name` -> `@scope%2Fname`). */
export function getNpmRegistryUrl(packageName: string = PACKAGE_NAME): string {
	return `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName).replace(/^%40/, "@")}`;
}

export interface LatestQiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

interface NpmRegistryMetadata {
	name?: unknown;
	"dist-tags"?: { latest?: unknown } | undefined;
	versions?: unknown;
}

/** Extract the latest version from npm registry metadata. */
function pickLatestNpmVersion(metadata: unknown, packageName: string): string {
	if (typeof metadata !== "object" || metadata === null) {
		throw new Error(`Unexpected npm registry metadata for ${packageName}`);
	}
	const document = metadata as NpmRegistryMetadata;
	const distLatest = document["dist-tags"]?.latest;
	if (typeof distLatest === "string" && valid(distLatest.trim())) {
		return distLatest.trim();
	}
	if (typeof document.versions === "object" && document.versions !== null) {
		const latest = Object.keys(document.versions)
			.filter((candidate) => valid(candidate))
			.sort(rcompare)[0];
		if (latest) {
			return latest;
		}
	}
	throw new Error(`npm registry metadata for ${packageName} does not advertise a latest version`);
}

/**
 * Resolve the latest published version of the current package from the npm
 * registry. Returns undefined (without touching the network) when offline
 * (`QI_OFFLINE`); throws on network/registry errors so callers can format the
 * failure (`formatVersionCheckError`).
 */
export async function getLatestQiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestQiRelease | undefined> {
	if (process.env.QI_OFFLINE) return undefined;

	const url = getNpmRegistryUrl();
	const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS;
	const attempts = options.retry ? VERSION_CHECK_RETRY_ATTEMPTS : 1;
	let lastError: unknown;
	for (let attempt = 1; attempt <= attempts; attempt++) {
		try {
			const response = await fetch(url, {
				headers: {
					"User-Agent": `qi/${currentVersion}`,
					Accept: "application/vnd.npm.install-v1+json, application/json",
				},
				signal: AbortSignal.timeout(timeoutMs),
			});
			if (!response.ok) {
				throw new Error(`npm registry returned HTTP ${response.status} for ${PACKAGE_NAME}`);
			}
			const metadata: unknown = await response.json();
			const version = pickLatestNpmVersion(metadata, PACKAGE_NAME);
			// The registry metadata may advertise a renamed package (fork renames);
			// prefer the name the registry itself reports.
			const advertisedName = (metadata as NpmRegistryMetadata)?.name;
			return { version, packageName: typeof advertisedName === "string" ? advertisedName : PACKAGE_NAME };
		} catch (error: unknown) {
			lastError = error;
			if (attempt < attempts) {
				await new Promise((resolve) => setTimeout(resolve, VERSION_CHECK_RETRY_DELAY_MS));
			}
		}
	}
	throw lastError;
}

export async function getLatestQiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestQiRelease(currentVersion, options))?.version;
}

export async function checkForNewQiVersion(currentVersion: string): Promise<LatestQiRelease | undefined> {
	if (process.env.QI_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestQiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}
