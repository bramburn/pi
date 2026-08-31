<p align="center">
  <a href="https://pi.dev">
    <img alt="pi logo" src="https://pi.dev/logo-auto.svg" width="128">
  </a>
</p>
<p align="center">
  <a href="https://www.npmjs.com/package/@earendil-works/pi-coding-agent"><img alt="npm" src="https://img.shields.io/npm/v/@earendil-works/pi-coding-agent?style=flat-square" /></a>
</p>

# Pi Coding Agent — bramburn fork

Fork of [earendil-works/pi](https://github.com/earendil-works/pi) maintained by
[Kaps Ramburn](https://github.com/bramburn) (`nitrogen@gmail.com`).

Current fork release: **v0.84.2-b1** (fork version on the upstream v0.84.2
baseline). Tracks `origin/main` (earendil-works/pi) and re-applies the fork
markers after each sync.

> **Runtime: Bun (primary), Node.js (legacy).** The fork has migrated its
> CI, build, and most scripts to Bun. Node.js is still supported for legacy
> scripts and for the `npm publish` step in `.github/workflows/publish.yml`
> (npm registry trusted publishing via OIDC), but Node is being phased
> out. See *Runtime support* below.

## Runtime support

The fork runs on **Bun** (1.3.14+). Bun is the default for installs,
package.json scripts, and CI. Node.js (22.x) is still available for
legacy scripts (e.g. `test.sh` wraps `npm test` in an isolated HOME; the
test runner is vitest + `node --test`, both of which work when invoked
from a Bun-launched subprocess). The `npm publish` step in the
`publish.yml` workflow uses the npm CLI for OIDC trusted publishing;
that is the only remaining `setup-node` step.

Why Bun:

- `bun install` is more lenient about platform-specific optional
  dependencies than `npm ci` (this is what fixed the failing `build-check-test`
  CI run on `@mariozechner/clipboard-darwin-arm64`).
- `bun run` can execute the existing `package.json` scripts (including
  the chained `cd && npm run build` build pipeline) without rewriting
  them.
- `bun build --compile` produces a single-file binary (`pi.exe` on
  Windows, `pi` on Unix) without external runtime; the Node target still
  ships for users who prefer it.

To install Bun: <https://bun.sh/docs/installation>.

## Differences from upstream

- `pi --version` prints `pi <version> [bramburn]` (fork marker, see
  `packages/coding-agent/src/config.ts` `FORK_NAME`).
- Workspace packages are published under the `@bramburn/*` npm scope on tag
  push via `.github/workflows/publish.yml` (currently blocked by npm 2FA OTP,
  see *Known issues* below).
- **CI runs on Bun** (1.3.14). The `ci.yml`, `publish-model-catalog.yml`,
  and `docs.yml` workflows use `oven-sh/setup-bun` and `bun install` /
  `bun run` instead of `actions/setup-node` + `npm ci`. Node remains
  available on the runner image for the test step and for any workflow
  that explicitly uses it.
- Fork-local fixes preserved across upstream merges:
  - **Per-sibling `toolResult` emission** in parallel tool batches (no
    orphans when one sibling stalls). `packages/agent/src/agent-loop.ts`.
  - **Per-session default model** (planned, not yet implemented) — allow each
    `.pi-session` file to carry its own `defaultModel`, overriding the global
    setting. See `docs/per-session-model-plan.md` for the architecture plan.
  - **Scrollback-jump guard** while streaming with the viewport scrolled up.
    The pre-v0.84 fix targeted the old class-based `TuiMainScreen`; upstream
    v0.84.2 rewrote the TUI in a functional architecture that gates
    `fullRender(true)` on `firstChanged < prevViewportTop`, which already
    prevents the same scrollback-jump class.
  - **`validateLlmMessages()` extension-transform check** in
    `packages/agent/src/agent-loop.ts`, with regression test in
    `packages/agent/test/validate-llm-messages.test.ts`.
- Workspace package versions are `0.84.2-b1` (pre-release suffix on the
  upstream `0.84.2` baseline). The `--version` test regex accepts the
  pre-release suffix.
- Workspace npm scope stays at `@earendil-works/*` for workspace resolution;
  only the published scope switches to `@bramburn/*`.

## All packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/pi-telemetry](packages/telemetry)** | Vendor-neutral telemetry contracts, reference adapter, conformance tests, and typed schemas |
| **[@earendil-works/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@earendil-works/pi-protocol](packages/protocol)** | Transport-neutral CBOR protocol schemas for remote pi sessions |
| **[@earendil-works/pi-client](packages/client)** | Remote pi session client (`RemoteSession` controller) |
| **[@earendil-works/pi-server](packages/server)** | Remote pi session server |
| **[@earendil-works/pi-session-backend-sqlite-node](packages/session-backends/sqlite-node)** | Node sqlite session backend for v4 SessionRepo |

If you need stronger boundaries, containerize or sandbox Pi. See [packages/coding-agent/README.md](packages/coding-agent/README.md) for details.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

Bun is the default. Node.js still works for the legacy commands below; the
two are interchangeable for the package.json scripts.

```bash
# Primary (Bun)
bun install --ignore-scripts  # Install all dependencies without running lifecycle scripts
bun run build         # Refresh model data, then build all packages
bun run build:offline # Rebuild using existing model data without network access
bun run build:both    # Build Node.js and Bun targets in one shot (skips whichever runtime is missing)
bun run build:bun     # Build only the Bun binary (pi.exe on Windows, pi on Unix)
bun run check         # Lint, format, and type check
./test.sh             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh          # Run pi from sources (can be run from any directory)

# Legacy (Node.js / npm) — still works but no longer the default
npm install --ignore-scripts
npm run build
npm run check
npm test
```

`bun run build:both` is the entry point for verifying the two build paths
end-to-end. It detects `node` and `bun` on `PATH` and reports each target as
`BUILT`, `SKIPPED (reason)`, or `FAILED (reason)`. See
[AGENTS.md § Building the Project (Node.js + Bun)](AGENTS.md#building-the-project-nodejs--bun)
for the full output format and platform wrappers.

## Building standalone binaries from release source

The `bun run release:local` script builds unpackaged Node and Bun binaries
under `/tmp/pi-local-release/`. Use it to smoke-test a release build before
publishing.

## Dependency security

We treat npm dependency changes as reviewed code changes.

- Direct external deps stay pinned to exact versions in `package.json` and
  `package-lock.json`.
- CI installs with `bun install --ignore-scripts` (more lenient about
  platform-specific optional deps than `npm ci`); a scheduled GitHub
  workflow runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`
  for security advisories.
- Shrinkwrap generation has an explicit allowlist for dependency lifecycle
  scripts; new lifecycle-script deps fail checks until reviewed.

## Known issues

- **npm publish blocked by 2FA OTP.** `.github/workflows/publish.yml` runs
  `npm publish` with `secrets.NPM_TOKEN`, which is tied to an npm account
  that has 2FA enabled. The workflow has no way to supply an OTP and fails
  with `npm error code EOTP`. To unblock, either configure npm trusted
  publishing via GitHub Actions OIDC on the `@bramburn` scope (matching
  upstream's approach) or replace `NPM_TOKEN` with a 2FA-bypassable
  automation token. The build itself succeeds; only the registry upload
  fails. (Node.js is the only remaining runtime in the publish workflow
  because `npm publish` needs the npm CLI; once the registry is migrated
  to OIDC, the publish step can switch to Bun too.)

## License

MIT
