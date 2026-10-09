# self-drive

Experimental. Starts autonomous continuation only when invoked. Decisions and held actions are journaled. Recognized risky commands and messaging tools are held. Deadlines gate new tool calls; they cannot terminate running commands or agents. After a limit, stop releases the gate. Pattern checks are not a security sandbox.

## Install

```bash
claude plugin install self-drive --marketplace sruthik27/claude-foundry
```

Requires Claude Code 2.1.296+. Reload plugins or start a new session after installation.

## Try it

```text
/self-drive 30m finish the test suite
/self-drive
/self-drive stop
```

## Details

- [Installation, compatibility and removal](../../docs/INSTALL.md)
- [Model usage, data and limitations](../../docs/BEHAVIOR.md)
- [Validation boundaries](../../docs/VALIDATION.md)
- [Report a bug](https://github.com/sruthik27/claude-foundry/issues/new/choose)

MIT licensed. Maintained by [Sruthik Issac](https://github.com/sruthik27).
