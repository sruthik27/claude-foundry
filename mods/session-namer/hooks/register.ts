import type { Register } from 'claude-code'
import { askFor, enoughToName, parseReply, promptsOf } from './name.js'

/**
 * The name is worked out while the session runs (after a turn, throttled: a model call is too
 * slow for session.end). It is applied through the classic hooks' `sessionTitle` field, which
 * Claude Code saves as the session's title: on the next prompt (UserPromptSubmit), and on a
 * resume (SessionStart). An earlier version applied it with `$.command.run('rename')` from
 * session.end, which never ran: a queued command waits for an idle session the exit never gives.
 * Per session the store remembers the name applied, whether the person named it themselves
 * (then it is left alone), and the candidate waiting to be applied.
 */
type Memo = { applied?: string; human?: boolean; pending?: string; checkedAt?: number }

const EVERY = 6

/**
 * The /resume list reads a title only from the transcript's last 64 KB, then from this sidecar
 * (`<dir>/<session id>/custom-title.json`). A long session buries the title record past 64 KB, so
 * the list falls back to the last prompt; the sidecar keeps the name findable at any size.
 */
function sidecarOf(transcript: string, sid: string): string {
  return `${transcript.slice(0, transcript.lastIndexOf('/'))}/${sid}/custom-title.json`
} // re-judge the name after this many more turns

export const register: Register = on => {
  let turns = 0
  /** The transcript path, seen on every prompt: where the /resume sidecar goes. */
  let transcript = ''
  let busy = false

  on('command.run', { command: 'rename' }, async ($, e, next) => {
    // The person renamed it: theirs wins from now on. Our own /rename runs as origin plugin.
    const o = e.origin as { kind?: string; name?: string } | undefined
    if (!(o?.kind === 'plugin' && o.name === 'session-namer')) {
      const k = `memo:${await $.session.id()}`
      const memo = ((await $.store.get(k)) ?? {}) as Memo
      await $.store.set(k, { ...memo, human: true, pending: undefined })
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || busy) return r
    turns += 1
    const k = `memo:${await $.session.id()}`
    const memo = ((await $.store.get(k)) ?? {}) as Memo
    if (memo.human) return r
    const due = turns >= 1 && (memo.checkedAt === undefined || turns - memo.checkedAt >= EVERY || turns < memo.checkedAt)
    if (!due) return r

    busy = true
    try {
      const prompts = promptsOf((await $.session.messages()) as { role: string; text: string }[])
      if (!enoughToName(prompts)) return r
      const start = prompts.slice(0, 3).join(' | ').slice(0, 1200)
      const recent = prompts.slice(-4).join(' | ').slice(-1200)
      const cwd = await $.session.cwd()
      const repo = (await $.session.root().catch(() => cwd)).split('/').pop() ?? cwd
      const current = memo.pending ?? memo.applied
      const reply = await $.model.complete({
        model: await $.session.model(), effort: 'low', maxTokens: 40, timeoutMs: 30000,
        prompt: askFor(repo, current, start, recent),
      })
      const verdict = reply.isAnswered ? parseReply(reply.text, current) : undefined
      const next_: Memo = { ...memo, checkedAt: turns }
      if (verdict && verdict !== 'keep') {
        next_.pending = verdict
        // Write the /resume sidecar now: a session closed right after this turn is still named
        // in the list. The transcript title follows on the next prompt (or on resume).
        if (transcript) {
          const sid = await $.session.id()
          try { await $.fs.write(sidecarOf(transcript, sid), JSON.stringify({ customTitle: verdict })) } catch { /* next prompt */ }
        }
      }
      await $.store.set(k, next_)
    } finally {
      busy = false
    }
    return r
  })

  // Applies a waiting name as the session's title on the next prompt; re-asserts an applied one the
  // session has lost (a resume that did not find it), and keeps the /resume sidecar written.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    if (e.transcript_path) transcript = e.transcript_path
    const r = await next(e)
    try {
      const sid = await $.session.id()
      const k = `memo:${sid}`
      const memo = ((await $.store.get(k)) ?? {}) as Memo
      const existing = e.session_title
      // A title the mod did not set (named by hand, or before the mod existed) is the person's.
      if (!memo.human && existing && existing !== memo.applied) {
        await $.store.set(k, { ...memo, human: true, pending: undefined })
        return r
      }
      if (memo.human || r.sessionTitle) return r
      const want = memo.pending && memo.pending !== memo.applied ? memo.pending : memo.applied
      if (!want) return r
      if (want !== memo.applied || memo.pending) await $.store.set(k, { ...memo, applied: want, pending: undefined })
      if (e.transcript_path) {
        try { await $.fs.write(sidecarOf(e.transcript_path, sid), JSON.stringify({ customTitle: want })) } catch { /* list falls back to the tail */ }
      }
      return existing === want ? r : { ...r, sessionTitle: want }
    } catch {
      return r
    }
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    turns = 0 // a resumed session counts afresh, so the name is re-judged after 2 turns
    const k = `memo:${await $.session.id()}`
    const memo = (await $.store.get(k)) as Memo | undefined
    if (memo && !memo.human) await $.store.set(k, { ...memo, checkedAt: undefined })
    return r
  })

  // A resumed session gets its name at once: a waiting one, or the applied one it lost.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source !== 'resume' || r.sessionTitle) return r
    try {
      const sid = await $.session.id()
      const k = `memo:${sid}`
      const memo = ((await $.store.get(k)) ?? {}) as Memo
      const existing = e.session_title
      if (!memo.human && existing && existing !== memo.applied) {
        await $.store.set(k, { ...memo, human: true, pending: undefined })
        return r
      }
      if (memo.human) return r
      const want = memo.pending && memo.pending !== memo.applied ? memo.pending : memo.applied
      if (!want) return r
      await $.store.set(k, { ...memo, applied: want, pending: undefined })
      if (e.transcript_path) {
        try { await $.fs.write(sidecarOf(e.transcript_path, sid), JSON.stringify({ customTitle: want })) } catch { /* tail only */ }
      }
      return existing === want ? r : { ...r, sessionTitle: want }
    } catch {
      return r
    }
  })
}
