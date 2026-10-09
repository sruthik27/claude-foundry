# find-sess

Searches digests of recent local sessions for the current project, using Python 3 and Haiku ranking. A numbered result resumes the chosen session. A later unsuccessful search clears previous matches. Search is bounded and may miss older history.

## Install

```bash
claude plugin install find-sess --marketplace sruthik27/claude-foundry
```

Requires Claude Code 2.1.296+. Reload plugins or start a new session after installation.

## Try it

```text
/find-sess the session about upload retries
/find-sess 2
```

## Details

- [Installation, compatibility and removal](../../docs/INSTALL.md)
- [Model usage, data and limitations](../../docs/BEHAVIOR.md)
- [Validation boundaries](../../docs/VALIDATION.md)
- [Report a bug](https://github.com/sruthik27/claude-foundry/issues/new/choose)

MIT licensed. Maintained by [Sruthik Issac](https://github.com/sruthik27).
