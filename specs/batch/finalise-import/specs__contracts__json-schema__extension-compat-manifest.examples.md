# Extension Compatibility Manifest (v1) — Policy & Examples

**Schema:** `specs/contracts/json-schema/extension-compat-manifest.schema.json`
**Contract ID:** `CONTRACT-EXT-COMPAT-MANIFEST`
**Version:** `1`

## Backwards-Compatibility & Keying Policy

- **Within v1 (additive-only):** New optional fields may be added to the root manifest object or to `$defs/PackageCompatEntry` without incrementing `version`. Consumers must ignore unknown optional fields only after a minor schema revision adds them; the checked-in schema enforces `additionalProperties: false` in CI so typos in the checked-in manifest fail `bun run check`.
- **Breaking changes:** Removing any existing field, making an optional field required, narrowing a field's type or regex constraint, or changing how `compatibleRange` / `gitRef` are interpreted requires incrementing the top-level `"version"` field to `2` and introducing a v2 schema.
- **Canonical keys:** Extensions published to npm are keyed in `packages` by their canonical npm package name, while git-only gallery extensions without an npm package name are keyed by `"git:<host>/<owner>/<repo>"` (matching `packages/coding-agent/src/core/package-manager.ts:1691-1704`).
- **Deprecated or incompatible extensions:** Packages that have no working 0.85 release are represented via `"compatibleRange": "<0.0.0"` with a `"notes"` explanation so installs fail hard with `E_EXT_NO_COMPATIBLE_VERSION` (unless `--force` is passed) and surface the audit note to the user.

## Examples

### 1. Valid manifest (`extension-compat-manifest.json`)

```json
{
	"version": 1,
	"baselineVersion": "0.85.0-b1",
	"generatedAt": "2026-10-20",
	"packages": {
		"shitty-extensions": {
			"name": "shitty-extensions",
			"compatibleRange": "<=1.0.1",
			"recommendedVersion": "1.0.1",
			"gitUrl": "https://github.com/example/shitty-extensions",
			"gitRef": "v1.0.1",
			"lastReviewed": "2026-10-20",
			"notes": "v1.0.1 is the last release targeting the 0.85 ExtensionAPI."
		},
		"@foo/pi-mcp-bridge": {
			"name": "@foo/pi-mcp-bridge",
			"compatibleRange": "^0.4.0 <0.5.0",
			"recommendedVersion": "0.4.3",
			"lastReviewed": "2026-10-20",
			"notes": "0.5.0+ uses upstream 0.86 provider registration."
		},
		"git:github.com/user/custom-skill-pack": {
			"name": "git:github.com/user/custom-skill-pack",
			"compatibleRange": "0.0.0",
			"gitUrl": "https://github.com/user/custom-skill-pack",
			"gitRef": "v0.85.0",
			"lastReviewed": "2026-10-20",
			"notes": "Git-only package from the 0.85 gallery snapshot; pinned by tag."
		}
	}
}
```

### 2. Invalid manifest examples (rejected by schema validation)

```json
{
	"version": 2,
	"baselineVersion": "0.85.0-b1",
	"generatedAt": "2026-10-20",
	"packages": {
		"broken-entry": {
			"name": "broken-entry",
			"compatibleRange": "^1.0.0",
			"gitUrl": "https://github.com/example/broken-entry"
		}
	}
}
```

Why invalid:
1. `version` is `2` (`const: 1` violation).
2. `packages["broken-entry"]` omits required field `lastReviewed`.
3. `packages["broken-entry"]` specifies `gitUrl` without `gitRef` (`dependentRequired` violation).

### 3. Example install-time resolution traces

| User command | Manifest lookup | Registry versions | Resolved install target | Persisted in `settings.json` | Console output |
|---|---|---|---|---|---|
| `qi install npm:shitty-extensions` | Matches `shitty-extensions` (`compatibleRange: "<=1.0.1"`) | `["1.0.0", "1.0.1", "2.0.0"]` | `shitty-extensions@1.0.1` | `"npm:shitty-extensions@1.0.1"` | `Installed npm:shitty-extensions@1.0.1` |
| `qi install npm:shitty-extensions@1.0.0` | Matches `shitty-extensions` (`pinned: true`, satisfies `<=1.0.1`) | `["1.0.0", "1.0.1", "2.0.0"]` | `shitty-extensions@1.0.0` | `"npm:shitty-extensions@1.0.0"` | `Installed npm:shitty-extensions@1.0.0` |
| `qi install npm:shitty-extensions@2.0.0` | Matches `shitty-extensions` (explicit version outside `<=1.0.1`) | `["1.0.0", "1.0.1", "2.0.0"]` | `shitty-extensions@2.0.0` | `"npm:shitty-extensions@2.0.0"` | Warning (outside compatible range `<=1.0.1`) + `Installed npm:shitty-extensions@2.0.0` |
| `qi install npm:@community/new-ext` | No entry found (`undefined`) | `["0.2.0", "0.3.0"]` | `@community/new-ext@0.3.0` | `"npm:@community/new-ext@0.3.0"` | Warning (unlisted in 0.85 compatibility manifest; installing `latest` `0.3.0`) + `Installed npm:@community/new-ext@0.3.0` |
| `qi install https://github.com/example/shitty-extensions` | Matches `gitUrl` (`gitRef: "v1.0.1"`) | N/A (git) | Clone + checkout `v1.0.1` | `"https://github.com/example/shitty-extensions@v1.0.1"` | `Installed https://github.com/example/shitty-extensions@v1.0.1` |
| `qi install npm:@foo/pi-mcp-bridge` | Matches `@foo/pi-mcp-bridge` (`^0.4.0 <0.5.0`) | `["0.5.0", "0.6.0"]` | Aborted (`E_EXT_NO_COMPATIBLE_VERSION`) | Unchanged | Error: no version of `@foo/pi-mcp-bridge` satisfies 0.85 compatible range `^0.4.0 <0.5.0` |

## Traceability

- **Realises:** `REQ-EXT` (`R-EXT-001`, `R-EXT-002`, `R-EXT-004`, `R-EXT-005`, `R-EXT-006`, `R-EXT-007`)
- **Depends on ADRs:** `ADR-0003`
- **Referenced by:** `CONTRACT-EXT-COMPAT-MANIFEST`, `BEHAV-EXT-INSTALL-PINNING`, `IMPL-EXTENSIONS`
