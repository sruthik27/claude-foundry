# mcp-control

Provides list_mcp_servers, enable_mcp and reconnect_mcp. Enabling requires approval. Management commands run after the turn ends, with configuration and tool-availability checks before continuation. Only configured servers are available; this does not supply or authenticate servers.

## Install

```bash
claude plugin install mcp-control --marketplace sruthik27/claude-code-mods
```

Requires Claude Code 2.1.296+. Reload plugins or start a new session after installation.

## Try it

```text
List my configured MCP servers.
Enable the Jira server if I approve, then search for my issue.
```

## Details

- [Installation, compatibility and removal](../../docs/INSTALL.md)
- [Model usage, data and limitations](../../docs/BEHAVIOR.md)
- [Validation boundaries](../../docs/VALIDATION.md)
- [Report a bug](https://github.com/sruthik27/claude-code-mods/issues/new/choose)

MIT licensed. Maintained by [Sruthik Issac](https://github.com/sruthik27).
