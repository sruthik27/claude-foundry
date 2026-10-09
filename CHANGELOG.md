# Changelog

## 0.1.0-beta.1 — 2026-10-10

First public marketplace release of Claude Foundry.

- Publish 11 independent mods plus one-command `starter-kit` and `all-mods` bundles.
- Add marketplace metadata, per-mod installation guides, compatibility and model-usage documentation, contributor instructions and automated CI.
- Preserve Prismantis, Aside and bundled third-party notices.
- Fix state restoration across clear/resume/fork, shared progress UI composition, reporting metadata leakage and quoted-tag handling.
- Keep deleted files and their removed contents visible in code review.
- Tighten self-drive's Git-option guards and deadline gates; cancel queued work on session transitions.
- Fix progress summary timing, concurrent polling, stale search results and false MCP readiness reports.
- Recognize marketplace-installed Lumen theme settings in the panes.
- Replace stale installed sources safely, keep backups and expand local bundle dependencies in the legacy installer.

This is a public beta. Offline tests and isolated installation checks do not replace real-model and terminal-painting validation. See [validation notes](docs/VALIDATION.md).
