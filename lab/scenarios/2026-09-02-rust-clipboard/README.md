# 2026-09-02 — rust-clipboard

**Status:** scaffolded
**Type:** scenario + integration (real cross-platform binary, real CI on real machines)
**Owner:** mavis
**Related PRs:** #873, #874 (publish.yml + ci.yml fixes — the install-side half of the same problem)

## Problem

`@mariozechner/clipboard` is an `optionalDependency` of `packages/coding-agent` and the
only thing the coding-agent uses to talk to the system clipboard from native code. The
package ships ten platform-specific prebuilt `.node` addons (darwin-arm64,
darwin-universal, darwin-x64, linux-arm64-gnu, linux-arm64-musl, linux-riscv64-gnu,
linux-x64-gnu, linux-x64-musl, win32-arm64-msvc, win32-x64-msvc).

Two operational problems fall out of that:

1. **Linux CI install fragility.** `npm ci --ignore-scripts` refuses to install the
   darwin-arm64 prebuild on a linux-x64 runner with
   `EBADPLATFORM` (npm is strict about platform-specific optional deps). `bun install`
   is lenient, so we now use Bun in `ci.yml` and `publish.yml`. But Bun is masking
   the same problem `npm ci` always had — not fixing it.
2. **Vendor lock-in.** All ten binaries come from a single maintainer's npm package.
   If `@mariozechner/clipboard` is unpublished, yanked, or stops building on a
   platform the fork supports, the fork has no fallback path. The coding-agent
   already has a multi-layer fallback (Wayland, X11, pbcopy, clip.exe, OSC 52) but
   the native layer is the highest-fidelity one (image paste, setText latency).

## Hypothesis (falsifiable)

A small Rust crate, built once and distributed as a per-platform `.node` addon,
can replace `@mariozechner/clipboard` for the four-method API the coding-agent
actually uses — `getText`, `setText`, `hasImage`, `getImageBinary` — and produce
prebuilds that match (or beat) the upstream package on each of the six target
platforms:

| Target | Build env | Status |
| --- | --- | --- |
| `linux-x64-gnu`     | `ubuntu-latest`     | buildable? tests? |
| `linux-arm64-gnu`   | `ubuntu-24.04-arm`  | buildable? tests? |
| `darwin-x64`        | `macos-13`          | buildable? tests? |
| `darwin-arm64`      | `macos-latest`      | buildable? tests? |
| `win32-x64-msvc`    | `windows-latest`    | buildable? tests? |
| `win32-arm64-msvc`  | `windows-11-arm`    | buildable? tests? |

Falsification: if the Rust crate cannot build on at least one of these targets,
or if the round-trip integration test (write `text` → read `text` → identity)
fails on any target, the hypothesis is wrong and the conclusion is "keep
`@mariozechner/clipboard` and live with the install workaround".

## Why a Rust crate, not a C addon

The existing `packages/tui/native/{win32,darwin}/` already uses C + N-API for
`win32-console-mode.node`. We could extend that pattern. Two reasons to pick Rust
anyway:

1. **Single source of truth.** A pure-Rust clipboard library (`arboard` or
   `x11-clipboard` on Linux, `objc2` on macOS, `windows` on Windows) compiles the
   same way on every host. No per-platform N-API wrapper code to maintain.
2. **Smaller surface.** The C addon's `build.mjs` per platform is ~200 lines of
   bespoke toolchain glue (vswhere lookup, VsDevCmd.bat, mingw fallbacks). A Rust
   crate needs `napi-rs` and a `build.yml` matrix; the build itself is cargo.

## Plan

1. **Session 1 — scaffold the crate.** `packages/clipboard-rs/` with `Cargo.toml`,
   `src/lib.rs`, `package.json`, `napi-rs` config, build script. Target: `buildable`
   on linux-x64.
2. **Session 2 — implement the API.** Four N-API functions exposing `getText`,
   `setText`, `hasImage`, `getImageBinary`. Reference: current
   `packages/coding-agent/src/utils/clipboard-native.ts:5-10`. Target: `unit-tested`
   on linux-x64.
3. **Session 3 — CI matrix.** `.github/workflows/clipboard-rs-build.yml` builds the
   `.node` binary on all 6 target platforms, runs a round-trip test, and uploads
   the artifact. Target: `reference-validated` on each platform.
4. **Session 4 — wire it into the coding-agent.** Replace
   `@mariozechner/clipboard` in `packages/coding-agent/optionalDependencies` with
   the local `packages/clipboard-rs`. Update `clipboard-native.ts` to load the
   new package. Target: end-to-end smoke test.
5. **Session 5 — promote.** Remove the upstream optional dep, ship the Rust crate
   in the fork's npm publish. Requires human approval per the lab promotion rules.

## What this is NOT

- Not a replacement for the Wayland/X11/pbcopy/clip.exe/OSC 52 fallbacks. Those
  are still needed for Linux/headless/remote sessions. The Rust crate replaces
  only the topmost layer (`@mariozechner/clipboard`).
- Not an attempt to build for `linux-riscv64`. Upstream ships that prebuild but
  GitHub Actions runners do not include a riscv64 worker. Out of scope unless
  someone sponsors a self-hosted runner.
- Not a fork of `arboard`. We use `arboard` (or `x11rb` + raw Xlib bindings) as
  a dependency, not a fork.

## Open decisions (P-records to file later)

- `arboard` (one dep, broad) vs `x11rb` + `objc2` + `windows` (three deps, tighter
  per-platform). Benchmarks will tell.
- N-API version: `napi-rs` defaults to NAPI 6 (Node 16+). pi requires `node>=22.19`
  so anything NAPI 6+ is fine.
- Whether to publish the Rust prebuilds as a separate npm package or as part of
  `packages/coding-agent/optionalDependencies`. The latter mirrors upstream and
  keeps the install footprint the same.

## Linked work

- PR #873 (`fix/fork-publish-rename-deps`) — the publish-time rename fix that this
  crate will benefit from. Once the crate exists, the rename script will swap
  `@earendil-works/clipboard-rs` → `@bramburn/clipboard-rs` automatically.
- PR #874 (`fix/publish-yml-use-bun`) — the publish.yml switch to `bun install`
  that lets the matrix build run on linux-x64. The Rust crate is a new consumer
  of that infra.
