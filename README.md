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

## Differences from upstream

- `pi --version` prints `pi <version> [bramburn]` (fork marker, see
  `packages/coding-agent/src/config.ts` `FORK_NAME`).
- Workspace packages are published under the `@bramburn/*` npm scope on tag
  push via `.github/workflows/publish.yml` (currently blocked by npm 2FA OTP,
  see *Known issues* below).
- Fork-local fixes preserved across upstream merges:
  - **Per-sibling `toolResult` emission** in parallel tool batches (no
    orphans when one sibling stalls). `packages/agent/src/agent-loop.ts`.
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

```bash
npm install --ignore-scripts  # Install all dependencies without running lifecycle scripts
npm run build         # Refresh model data, then build all packages
npm run build:offline # Rebuild using existing model data without network access
npm run build:both    # Build Node.js and Bun targets in one shot (skips whichever runtime is missing)
npm run build:bun     # Build only the Bun binary (pi.exe on Windows, pi on Unix)
npm run check         # Lint, format, and type check
./test.sh             # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh          # Run pi from sources (can be run from any directory)
```

`npm run build:both` is the entry point for verifying the two build paths
end-to-end. It detects `node` and `bun` on `PATH` and reports each target as
`BUILT`, `SKIPPED (reason)`, or `FAILED (reason)`. See
[AGENTS.md § Building the Project (Node.js + Bun)](AGENTS.md#building-the-project-nodejs--bun)
for the full output format and platform wrappers.

## Building standalone binaries from release source

The `npm run release:local` script builds unpackaged Node and Bun binaries
under `/tmp/pi-local-release/`. Use it to smoke-test a release build before
publishing.

## Dependency security

We treat npm dependency changes as reviewed code changes.

- Direct external deps stay pinned to exact versions in `package.json` and
  `package-lock.json`.
- CI installs with `npm ci --ignore-scripts`, and a scheduled GitHub workflow
  runs `npm audit --omit=dev` plus `npm audit signatures --omit=dev`.
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
  fails.

## License

MIT
