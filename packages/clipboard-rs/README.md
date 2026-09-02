# @bramburn/clipboard-rs

Fork-local cross-platform clipboard native addon for `pi-coding-agent`. Replaces
`@mariozechner/clipboard` so the fork no longer depends on a single-maintainer
npm package for the topmost layer of its clipboard stack.

Built on all six target platforms by `.github/workflows/clipboard-rs-build.yml`:

| Target              | GitHub runner        | Rust target triple           |
| ------------------- | -------------------- | ---------------------------- |
| `linux-x64-gnu`     | `ubuntu-latest`      | `x86_64-unknown-linux-gnu`   |
| `linux-arm64-gnu`   | `ubuntu-24.04-arm`   | `aarch64-unknown-linux-gnu`  |
| `darwin-x64`        | `macos-13`           | `x86_64-apple-darwin`        |
| `darwin-arm64`      | `macos-latest`       | `aarch64-apple-darwin`       |
| `win32-x64-msvc`    | `windows-latest`     | `x86_64-pc-windows-msvc`     |
| `win32-arm64-msvc`  | `windows-11-arm`     | `aarch64-pc-windows-msvc`    |

## API

Mirrors `@mariozechner/clipboard` exactly so the loader at
`packages/coding-agent/src/utils/clipboard-native.ts` can switch the import path
without any other code changes:

```ts
export type ClipboardModule = {
    getText: () => Promise<string | null>;
    setText: (text: string) => Promise<void>;
    hasImage: () => boolean;
    getImageBinary: () => Promise<Array<number>>;
    addonMarker: () => string;
};
```

`hasImage` and `getImageBinary` are v1 stubs — see
`lab/scenarios/2026-09-02-rust-clipboard/README.md` for the rationale and the
follow-up session plan for real image support.

## Local build

```sh
# one-time
npm install -g @napi-rs/cli
rustup target add <your-target>

# build for the host platform
cd packages/clipboard-rs
npm run build:local
```

`build:local` produces `dist/index.js`, `dist/index.d.ts`, and a `.node` file
in `dist/<platform>-<arch>/`. CI places the binary in
`prebuilds/<platform>-<arch>/clipboard-rs.node` so the runtime loader can find
it without `optionalDependencies` fan-out.

## Tests

```sh
cd packages/clipboard-rs
node --test test/round-trip.test.mjs
```

Skipped automatically when no prebuild is present for the host platform. The
CI matrix runs the test on all six targets.

## Why a fork-local Rust crate

`@mariozechner/clipboard` ships ten platform-specific prebuilds as separate
npm packages. On a linux-x64 runner, `npm ci --ignore-scripts` refuses to
install the darwin-arm64 prebuild (`EBADPLATFORM`), and the fork had to switch
to `bun install` in `ci.yml` + `publish.yml` to work around that.

This crate uses a single Cargo crate, a single npm package, and a single
`prebuilds/` directory checked in next to the JS. The install is one tarball
with six binaries. No `optionalDependencies` dance, no platform-dep refusal.
