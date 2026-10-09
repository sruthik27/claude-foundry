# Behavior, model usage and data

This collection adds function hooks to Claude Code. Mods execute with your user's permissions; they are not isolated applications. Review the source and `claude plugin validate mods/<name>` output before installing.

## Model calls

| Mod | Additional model work |
| --- | --- |
| Insight Pane | Haiku fallback when a substantial reply did not supply insight tags |
| Changes | Haiku fallback labels for ungrouped edits; calls are awaited |
| Skills | Model-backed selection from installed skills |
| Session Namer | Periodic session-title generation, using the session's model |
| Find Sess | Haiku ranks digests of local session history |
| Aside | Tool-less fork of the session transcript; optional completion fallback before a snapshot exists |
| Lumen, Goal Meter, Live Progress | No direct auxiliary completion calls; reporting instructions can add prompt tokens |
| Self-drive | Submits continued work, which consumes normal Claude usage; explicit command required |
| MCP Control | Invokes configured MCP management commands; the connected server's own behavior applies |

Model-backed features send the relevant session content or local digests through Claude Code's configured model provider. Some handlers await their completion and can delay a command or turn. There is no promised fixed token cost.

## Local data

Insight Pane, Changes, Goal Meter, Session Namer, Self-drive and MCP Control use Claude's plugin store for their respective state or metadata. Insight Pane can mirror cards to `~/learning/.insights/` only when that directory already exists. Self-drive attempts to write readable reports under `~/.claude/self-drive/`. Find Sess reads local Claude session transcripts in the current project to create search digests. Changes reads files and Git diffs; Live Progress reads the log path supplied to its tool. Theme-aware panes read Claude settings. No separate collection-owned analytics endpoint is configured in the source; Claude and connected providers have their own data practices.

## Self-drive limits

Self-drive is experimental. Its guard recognizes listed command patterns and selected tool names. Global Git options are normalized, but this is not a full shell interpreter, authorization system or security sandbox. Indirect scripts, aliases or unusual syntax may escape pattern detection; some harmless calls may be held conservatively.

A deadline prevents new tool calls. It cannot kill a running subprocess, model request or background agent. Limit reports keep tools gated until `/self-drive stop` or a new drive/session transition. Restored drives are paused. Review the decision journal and held actions before acting on the result.

## Progress is an estimate

Goal Meter reflects tasks and Claude's progress estimates. Live Progress counts recognized log lines and summaries, not the runner's process status. Package summaries can precede more packages; the watcher keeps reading until the idle timeout. Large log jumps are capped to keep polling bounded, so counts can be incomplete for very high-volume output.
