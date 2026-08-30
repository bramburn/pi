# Changelog

## [Unreleased]

### Added

- Added `SentryTelemetryContext`, a Sentry-backed adapter that implements the existing `TelemetryContext` contract, captures exceptions and messages, and emits Sentry `event` and `transaction` envelopes through a caller-supplied transport. The adapter has no runtime dependencies; the transport is injected so packages without HTTP client dependencies can wire their own.
- Added `parseSentryDsn` to extract protocol, public key, host, optional port, path, and project id from a Sentry DSN string.

## [0.84.4] - 2026-08-28

## [0.84.3] - 2026-08-24

## [0.84.2] - 2026-08-14

## [0.84.1] - 2026-08-07

## [0.84.0] - 2026-08-06

### Added

- Added the callback-based telemetry context contract, shared no-op context, deterministic in-memory reference adapter, reusable adapter conformance suite, typed serializable schema utilities, and multi-schema typed span starters with explicit child propagation.
