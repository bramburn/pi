# NOTE: Step-definition bindings for this feature are aspirational ("aspirational": true in specs/manifest.json)
# until IMPL-EXTENSIONS wires them into packages/coding-agent/test/package-manager-compat-pinning.test.ts.
@domain:extensions
Feature: Install-time extension version pinning

  Installs extension packages at versions verified compatible with the 0.85 host baseline,
  persists exact resolved versions in settings, and protects pinned packages during updates.

  Background:
    Given the bundled 0.85 compatibility manifest lists package "alpha-ext" with compatible constraint "<=1.4.2"
    And the bundled 0.85 compatibility manifest lists repository "github.com/example/alpha-ext" with default revision "v1.4.2"
    And the package registry publishes versions "1.4.0", "1.4.2", and "2.0.0" for "alpha-ext"

  @requirement:R-EXT-001
  @happy-path
  Scenario: Installing an unpinned listed package resolves the highest 0.85-compatible version
    When the user runs the package install command for unpinned "npm:alpha-ext"
    Then the package installer installs "alpha-ext" at exact version "1.4.2"
    And version "2.0.0" is not installed

  @requirement:R-EXT-001
  @error-path
  Scenario: Installing a listed package at an explicit incompatible version warns the user
    When the user runs the package install command for explicit "npm:alpha-ext@2.0.0"
    Then the package installer emits a warning that "2.0.0" is outside the 0.85 compatible constraint "<=1.4.2"
    And the package installer installs "alpha-ext" at exact version "2.0.0"

  @requirement:R-EXT-002
  @happy-path
  Scenario: Persisting the exact resolved version into user settings after an unpinned install
    Given user settings contain no configured packages
    When the user runs the package install command for unpinned "npm:alpha-ext"
    Then user settings record the configured package as "npm:alpha-ext@1.4.2"

  @requirement:R-EXT-002
  @error-path
  Scenario: Failed installation does not persist a package entry in settings
    Given user settings contain no configured packages
    And the package registry is unreachable
    When the user runs the package install command for unpinned "npm:alpha-ext"
    Then the command exits with a non-zero status
    And user settings contain no configured packages

  @requirement:R-EXT-003
  @happy-path
  Scenario: Package update skips packages persisted with an exact version
    Given user settings contain the pinned package "npm:alpha-ext@1.4.2"
    And version "1.4.2" of "alpha-ext" is installed locally
    When the user runs the package update command for all extensions
    Then "alpha-ext" remains at installed version "1.4.2"
    And user settings still record "npm:alpha-ext@1.4.2"

  @requirement:R-EXT-003
  @error-path
  Scenario: Targeted update of an unconfigured package reports no matching package
    Given user settings contain only the pinned package "npm:alpha-ext@1.4.2"
    When the user runs the package update command targeting "npm:missing-ext"
    Then the command exits with a non-zero status reporting no matching package for "npm:missing-ext"

  @requirement:R-EXT-004
  @happy-path
  Scenario: Installing an unlisted package warns and falls back to the latest registry version
    Given package "unlisted-ext" is not present in the bundled 0.85 compatibility manifest
    And the package registry publishes versions "0.1.0" and "0.2.0" for "unlisted-ext"
    When the user runs the package install command for unpinned "npm:unlisted-ext"
    Then the package installer emits a warning that "unlisted-ext" is not in the compatibility manifest
    And the package installer installs "unlisted-ext" at exact version "0.2.0"
    And user settings record the configured package as "npm:unlisted-ext@0.2.0"

  @requirement:R-EXT-004
  @error-path
  Scenario: Installing an unlisted package that does not exist in the registry fails cleanly
    Given package "ghost-ext" is not present in the bundled 0.85 compatibility manifest
    And the package registry has no package named "ghost-ext"
    When the user runs the package install command for unpinned "npm:ghost-ext"
    Then the command exits with a non-zero status reporting "E_EXT_PACKAGE_NOT_FOUND"
    And user settings contain no entry for "ghost-ext"

  @requirement:R-EXT-005
  @happy-path
  Scenario: Compatibility manifest lookup operates without contacting upstream gallery endpoints
    Given outbound requests to upstream gallery hosts are blocked
    When the user runs the package install command for unpinned "npm:alpha-ext"
    Then the compatibility constraint "<=1.4.2" is resolved from the local bundled manifest
    And zero network requests are made to upstream gallery hosts

  @requirement:R-EXT-005
  @error-path
  Scenario: Malformed compatibility manifest entry is rejected by build verification
    Given a candidate compatibility manifest entry omits the required "lastReviewed" date
    When the manifest schema validation check runs
    Then validation fails identifying the missing "lastReviewed" property

  @requirement:R-EXT-006
  @happy-path
  Scenario: Installing an unpinned listed repository pins to the manifest default revision
    When the user runs the package install command for "https://github.com/example/alpha-ext"
    Then the repository checkout is pinned to revision "v1.4.2"
    And user settings record "https://github.com/example/alpha-ext@v1.4.2"

  @requirement:R-EXT-006
  @error-path
  Scenario: Installing a repository with a nonexistent explicit revision fails and cleans up
    When the user runs the package install command for "https://github.com/example/alpha-ext@nonexistent-tag"
    Then the command exits with a non-zero status
    And no partial repository directory remains in the managed install root

  @requirement:R-EXT-007
  @happy-path
  Scenario: Successful installation completes with zero error code and progress confirmation
    When the user runs the package install command for unpinned "npm:alpha-ext"
    Then the command exits with status zero
    And the terminal confirms installation of "npm:alpha-ext@1.4.2"

  @requirement:R-EXT-007
  @error-path
  Scenario: Listed package with no registry version matching compatible constraint fails with typed reason
    Given the bundled 0.85 compatibility manifest lists package "legacy-only-ext" with compatible constraint "<=0.5.0"
    And the package registry publishes only version "1.0.0" for "legacy-only-ext"
    When the user runs the package install command for unpinned "npm:legacy-only-ext"
    Then the command exits with a non-zero status reporting "E_EXT_NO_COMPATIBLE_VERSION"
    And user settings contain no entry for "legacy-only-ext"

  @requirement:R-EXT-007
  @error-path
  Scenario: Force flag overrides fail-hard for a listed package with no compatible version
    Given the bundled 0.85 compatibility manifest lists package "legacy-only-ext" with compatible constraint "<=0.5.0"
    And the package registry publishes only version "1.0.0" for "legacy-only-ext"
    When the user runs the package install command with force for unpinned "npm:legacy-only-ext"
    Then the package installer emits a warning that no version satisfies the constraint "<=0.5.0"
    And the package installer installs "legacy-only-ext" at exact version "1.0.0"

  @requirement:R-EXT-008
  @happy-path
  Scenario: Valid installed extension loads its registered tools and commands into the host
    Given "npm:alpha-ext@1.4.2" is installed and exports a valid extension factory
    When the extension host discovers and loads configured extensions
    Then "alpha-ext" is active with zero load errors

  @requirement:R-EXT-008
  @error-path
  Scenario: Incompatible extension throwing during initialization is isolated and reported
    Given an installed extension throws a missing symbol error during factory initialization
    When the extension host discovers and loads configured extensions
    Then partial registrations from the failing extension are discarded
    And the host reports a load error naming the extension path and failure message

# Resolved (R33): CLI output after installAndPersist displays the resolved spec (e.g. 'Installed npm:alpha-ext@1.4.2');
# packages/coding-agent/src/package-manager-cli.ts:956 logs the resolved source string rather than the raw input string.
# Resolved (R34): installing an unpinned git URL listed in the manifest persists '@<gitRef>' into settings.json
# (see 'Installing an unpinned listed repository pins to the manifest default revision' above).
#
# ## Traceability
# - Realises: REQ-EXT (R-EXT-001, R-EXT-002, R-EXT-003, R-EXT-004, R-EXT-005, R-EXT-006, R-EXT-007, R-EXT-008)
# - Depends on ADRs: ADR-0003
# - References: CONTRACT-EXT-COMPAT-MANIFEST, IMPL-EXTENSIONS
