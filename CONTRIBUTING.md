# Contributing

Install Claude Code 2.1.296, Node.js 22.18+ and Python 3. The automated checks do not require sign-in or model credentials.

```bash
git clone https://github.com/sruthik27/claude-code-mods
cd claude-code-mods
python3 scripts/check.py
```

Each mod lives in `mods/<name>` with `.claude-plugin/plugin.json`, `hooks/hooks.json`, its hooks and tests. `starter-kit` and `all-mods` are dependency-only plugins. The root `.claude-plugin/marketplace.json` is the public catalog.

For a quick iteration:

```bash
claude plugin validate --strict mods/insight-pane/.claude-plugin/plugin.json
claude plugin test mods/insight-pane
node --test mods/aside/tests/register.test.ts
```

Use `claude --plugin-dir ./mods/<name>` for manual development. Do not simultaneously load the same mod from the marketplace. Keep tests focused on user-visible behavior and meaningful regressions. Prefer independent mods and optional rendering integrations.

Claude generates local TypeScript API stubs when loading a mod. Once those exist, run `npx -p typescript@5 tsc --noEmit -p mods/<name>`. Never emit JavaScript beside TypeScript: it can shadow the source. Do not commit generated types, caches, transcripts, settings or credentials.

Open a focused pull request explaining the problem, resulting behavior, and validation. Keep upstream notices for copied or modified code.

## Releasing

1. Bump each changed plugin's version and the matching catalog entry. Bundle versions change when their dependency list or behavior changes.
2. Update `CHANGELOG.md` and run `python3 scripts/check.py`.
3. Run `python3 scripts/smoke_install.py --source .` for isolated installation and dependency checks.
4. Inspect the diff and test a real session when model access is available; document any unverified behavior.
5. Push a release commit, wait for CI, and tag `v<collection-version>`. Tag plugin releases `<name>--v<version>` if publishing version-constrained dependencies later.
6. Publish a GitHub release with versioned archives and SHA256 checksums. Run the remote marketplace smoke test with `--source sruthik27/claude-code-mods`.

The custom marketplace does not enable automatic updates for users by default. Always bump versions; otherwise users can keep an old cached plugin.
