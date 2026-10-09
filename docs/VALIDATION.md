# Validation and known limits

The initial public beta is based on the corrected collection tested on Claude Code **2.1.296**.

## Automated coverage

- Native plugin tests exercise parser behavior, mocked engine hooks, persistence, rendering trees, middleware composition, Git diff review, deadlines, model fallbacks and progress polling.
- Aside uses its upstream Node-based fake-engine test harness.
- Installer tests use temporary configuration directories and cover backups, stale file replacement, unrelated settings, invalid inputs and bundle dependencies.
- Catalog tests check plugin names, paths, versions, licences and local dependency resolution.
- CI is configured to install the pinned Claude CLI and run the checks on macOS and Ubuntu without model credentials. Hosted jobs did not execute for the initial release; inspect Actions for the current status.
- Marketplace installation is smoke-tested in an isolated Claude configuration before release.

For 0.1.0-beta.1, all 298 mod tests and 5 installer/catalog tests passed locally (303 total). Local and public-GitHub marketplace installation enabled all 13 entries in disposable configurations.

Run `python3 scripts/check.py` for the current test results. The GitHub Actions badge reflects the latest remote CI result; release notes record release-specific checks.

## What this does not establish

Mocked tests do not verify actual terminal painting, live model quality, billing, credentials, provider compatibility or real MCP connectivity. A Claude session with all 11 mods active has not been visually validated. Windows and Desktop UI have not been locally verified. Generated Claude TypeScript stubs are not committed; full `tsc` checks require generating them in a Claude development session. Native hook compilation is covered by validation and tests.

The README's preview is an illustration, not a runtime capture. Please include your terminal, OS, Claude version and reproduction steps when reporting visual issues. This release is intentionally marked a public beta.
