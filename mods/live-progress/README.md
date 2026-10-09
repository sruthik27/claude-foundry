# live-progress

Ask Claude to use watch_progress with an absolute log path and short label. Known test runners are counted automatically; custom done/fail/percent/end regexes are supported. stop_progress removes a band. Runner summaries are provisional until the log is quiet; polling cannot prove process exit.

## Install

```bash
claude plugin install live-progress --marketplace sruthik27/claude-code-mods
```

Requires Claude Code 2.1.296+. Reload plugins or start a new session after installation.

## Try it

```text
Run tests in the background, write their output to /tmp/tests.log, and watch that log.
```

## Details

- [Installation, compatibility and removal](../../docs/INSTALL.md)
- [Model usage, data and limitations](../../docs/BEHAVIOR.md)
- [Validation boundaries](../../docs/VALIDATION.md)
- [Report a bug](https://github.com/sruthik27/claude-code-mods/issues/new/choose)

MIT licensed. Maintained by [Sruthik Issac](https://github.com/sruthik27).
