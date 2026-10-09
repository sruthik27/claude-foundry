# Installation and compatibility

## Requirements

Use Claude Code **2.1.296+**, our tested baseline. Check with `claude --version`; update with `claude update` if your installation supports it. Mods are enabled by default in current Claude Code. The old `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` flag is not required.

Some mods call `git`, `python3` or `tail`. macOS is the locally tested platform; CI also checks Ubuntu. Windows behavior has not been verified. Find Sess uses Python 3; Changes' branch view uses Git; Live Progress tails logs with `tail`.

You need working Claude Code model access to use model-backed features. Installation and offline tests require neither a Claude subscription nor an API key.

## Recommended installation

In your shell:

```bash
claude plugin install starter-kit --marketplace sruthik27/claude-code-mods
```

Or in Claude Code:

```text
/plugin install starter-kit --marketplace sruthik27/claude-code-mods
```

The starter kit contains Lumen, Insight Pane, Changes, Goal Meter and Live Progress. `all-mods` contains all 11 mods. Each mod is also installable by its folder name:

```bash
claude plugin install aside --marketplace sruthik27/claude-code-mods
```

To add the catalog first and browse it:

```bash
claude plugin marketplace add sruthik27/claude-code-mods
claude plugin install lumen@claude-code-mods
claude plugin list
```

Run `/reload-plugins` in an open session or restart Claude Code. Open `/plugin` to check active mods. Try `/lumen demo`, `/intel`, `/changes`, or `/aside explain this session`.

## Compatibility

| Environment | Expected experience |
| --- | --- |
| Claude Code in a terminal | Primary target: commands, panes, progress bands and rendering |
| Claude Desktop, Code tab | Mod UI supported by Claude, with surface-specific limitations; not locally verified here |
| VS Code extension chat panel | Hooks can run, but mod panes and custom drawing do not appear |
| Headless `claude -p` / Agent SDK | Hooks can run; visual features do not draw |
| Organization-managed installs | Administrators can restrict or disable user mods |
| Windows / WSL | Not verified; Python/tail-dependent features may need platform work |

Official references: [mods and supported environments](https://code.claude.com/docs/en/plugins/mods), [plugin installation](https://code.claude.com/docs/en/plugins).

## Updates

```bash
claude plugin update starter-kit@claude-code-mods
claude plugin update lumen@claude-code-mods
```

Then reload plugins or restart. Custom-marketplace auto-update is off by default; opt in through Claude's marketplace settings if you want it. Each plugin is versioned independently. Bundles declare dependencies in the same marketplace.

## Disable or remove

```bash
claude plugin disable lumen@claude-code-mods
claude plugin uninstall lumen@claude-code-mods
```

Removing a kit is not the same as removing every plugin it installed. Inspect `/plugin`; uninstall unwanted mods individually. `claude plugin prune` can remove unused auto-installed dependencies; inspect its help before choosing what to prune. To remove the catalog itself, use `claude plugin marketplace remove claude-code-mods`.

## Migrating from the ZIP / legacy installer

Avoid loading the same mod twice. If you previously ran `install.sh`, remove only this collection's paths from `env.CLAUDE_CODE_PLUGIN_DIRS` in your Claude settings before switching to marketplace installation. Keep unrelated paths intact. Keep your old folders until you have verified the new install; plugin store identity changes may mean old session state is not automatically imported.

The legacy installer remains available for local development:

```bash
git clone https://github.com/sruthik27/claude-code-mods
cd claude-code-mods
./install.sh starter-kit
```

It copies selected mods and local bundle dependencies into `~/.claude/mods`, backs up replaced folders under `~/.claude/mods-backups`, backs up settings, and appends plugin paths. It preserves unrelated settings. `CLAUDE_MODS_CONFIG_DIR` selects an isolated directory for tests.

## Troubleshooting

- **No custom UI:** check `/plugin` and `claude --version`, then reload. Verify you're using a supported visual surface and that organization policy or `disableAllHooks` isn't blocking mods.
- **Two renderers or side-chat commands:** disable `prismantis@prismantis` or upstream `aside@aside` before enabling the corresponding fork here.
- **Model-backed feature fails:** confirm model access in a normal Claude turn. Extra completion calls use your configured provider and usage; offline test success does not verify account access.
- **Self-drive refuses tools after a limit:** use `/self-drive stop` when you are ready to release its gate.
- **A log says done too soon:** runner summaries are provisional. Live Progress continues checking for later packages until the idle timeout; it cannot infer process exit from a log alone.

If it still fails, [open a bug report](https://github.com/sruthik27/claude-code-mods/issues/new/choose) with the mod, Claude version, OS, terminal and a minimal reproduction. Remove credentials and private session content from logs.
