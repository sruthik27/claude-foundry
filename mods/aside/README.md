# Aside

A read-only side chat about your Claude Code session, restyled to follow Lumen's theme. Fork of [JayDoubleu/aside](https://github.com/JayDoubleu/aside); the original MIT copyright is retained.

## Install

```bash
claude plugin install aside --marketplace sruthik27/claude-foundry
```

Requires Claude Code 2.1.296+. Disable upstream `aside@aside` first if you already have it installed, then reload plugins or restart. Lumen is optional; the pane has a native Markdown fallback.

## Use

- `/aside` opens the pane.
- `/aside what changed so far?` opens it and asks a question.
- Enter submits the pane's input; Esc returns focus to the main composer.
- The pane's Clear and Close buttons manage its local conversation.

Answers come from a tool-less fork of the completed session transcript. A question asked during a later turn sees the last completed snapshot. Side questions and answers are not appended to the main model's conversation.

## Options

Configure this plugin through Claude's plugin settings. Its settings identity is `aside@claude-code-mods`.

| Option | Default | Behavior |
| --- | --- | --- |
| `liveFallback` | `true` | Before a completed transcript snapshot exists, answer through a plain completion over bounded transcript text; off queues the question for the end of a turn |
| `liveModel` | `haiku` | Model for live fallback answers; forks use the session's model |
| `maxHistory` | `8` | Earlier side exchanges included with a question |

## Model usage and access

Questions make model calls and consume your own plan/API usage. Live fallback sends bounded transcript text as fresh input; forks can use the session prefix cache. Actual costs depend on model and provider.

The side-chat model cannot call tools or edit files. The mod itself reads Claude settings to match the theme and reads session messages for fallback answers. "Read-only" describes the side conversation, not an operating-system sandbox.

## Development

```bash
node --test mods/aside/tests/register.test.ts
claude plugin validate --strict mods/aside/.claude-plugin/plugin.json
```

The Node tests use a fake engine. This fork does not ship or claim a live-model eval suite. See [validation boundaries](../../docs/VALIDATION.md) and [installation guide](../../docs/INSTALL.md).

## Licence

[MIT](LICENSE). Original: JayDoubleu. Restyled fork maintained by [Sruthik Issac](https://github.com/sruthik27).
