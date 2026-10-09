import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Drive, Entry, EntryKind } from '../types'
import { CONTINUE, MAX_CONTINUES, MAX_IDLE, brief, busyAgents, ended, fmtDur, logged, parseArgs, report, riskOf, riskyTool } from './drive.js'

const PANE = 'self-drive'
const drive = atom({ plugin: 'self-drive', key: 'drive' } as const, null)
const LOG_TOOL = 'mcp__self-drive__self_drive_log'

const KIND_STYLE: Record<EntryKind, { icon: string; color: string }> = {
  decision: { icon: '◆', color: '#38bdf8' },
  'needs-you': { icon: '✋', color: '#fbbf24' },
  held: { icon: '⛔', color: '#f87171' },
  note: { icon: '·', color: '#a3a3a3' },
  finished: { icon: '✔', color: '#34d399' },
}

export const register: Register = on => {
  /** Tool calls and log entries in the turn now running; drives the idle counter. */
  let activity = 0
  let briefTimer: { cancel: () => void } | undefined

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await $.command.register({
      name: 'self-drive',
      description: 'Hand over a task and walk away: /self-drive [3h] <task> · /self-drive (dashboard) · /self-drive stop',
      argumentHint: '[duration] <task> | stop',
    })
    await $.tool.register({
      name: 'self_drive_log',
      description: 'Self-drive journal. Record a decision you made on the user\'s behalf (kind "decision": title, alternatives, why), something only the user can do (kind "needs-you"), a milestone (kind "note"), or that all work is done (kind "finished": detail = summary). Only use while self-drive mode is on.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['decision', 'needs-you', 'note', 'finished'] },
          title: { type: 'string', description: 'One line: what was decided / what the user must do / the milestone.' },
          alternatives: { type: 'string', description: 'decision: the options you did not pick.' },
          why: { type: 'string', description: 'decision: why this one.' },
          detail: { type: 'string', description: 'Anything else; for finished, the summary.' },
        },
        required: ['kind', 'title'],
      },
    })
    // Restore an interrupted drive on resume.
    const saved = (await $.store.get(`drive:${await $.session.id()}`)) as Drive | undefined
    if (saved && (await read($, drive)) === null) {
      await update($, drive, () => saved.status === 'driving' ? ended(saved, 'stopped', Date.now(), 'paused by restart') : saved)
      if (saved.status === 'driving') $.ui.status('▶ self-drive paused by restart · /self-drive to view')
    }
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (!['clear', 'resume', 'fork'].includes(e.source)) return r
    activity = 0
    briefTimer?.cancel(); briefTimer = undefined
    const saved = e.source === 'clear' ? undefined : await $.store.get(`drive:${await $.session.id()}`) as Drive | undefined
    await update($, drive, () => saved?.status === 'driving' ? ended(saved, 'stopped', Date.now(), 'paused by session switch') : saved ?? null)
    $.ui.status(undefined)
    return r
  })

  // ---- the command ----
  on('command.run', { command: 'self-drive' }, async ($, e) => {
    const args = e.args.trim()
    const now = await $.clock.now()
    const cur = await read($, drive)

    if (args === '' ) {
      if (!cur) return { text: 'Usage: /self-drive [30m|3h] <task>. Then walk away.' }
      await $.ui.open({ id: PANE, title: 'Self-drive', focus: true })
      return {}
    }
    if (args === 'stop') {
      briefTimer?.cancel(); briefTimer = undefined
      if (!cur || !['driving', 'limit'].includes(cur.status)) return { text: 'Self-drive is not running.' }
      const d = await update($, drive, x => ended(x, 'stopped', now, 'stopped by you'))
      if (d) await persist($, d, now)
      $.ui.status(undefined)
      return { text: 'Self-drive stopped. The dashboard keeps the log: /self-drive' }
    }

    // A slash command goes to command.run, never prompt.submit, so the drive starts here.
    const { ms, task } = parseArgs(args)
    if (!task) return { text: 'Give it a task: /self-drive 2h finish the upload feature' }
    const d: Drive = {
      task, startedAt: now, deadline: ms ? now + ms : undefined, status: 'driving',
      entries: [], continues: 0, idle: 0,
    }
    await update($, drive, () => d)
    await persist($, d, now)
    activity = 0
    void $.ui.open({ id: PANE, title: 'Self-drive' })
    $.ui.status(`▶ self-drive on${d.deadline ? ` · until ${new Date(d.deadline).toTimeString().slice(0, 5)}` : ''}`)
    // A command.run hook may not submit (the prompt would wait on the turn this hook holds),
    // so the brief goes out on a timer, once the command has finished.
    const text = brief(task, d.deadline, now)
    briefTimer?.cancel()
    briefTimer = $.clock.after(50, () => { briefTimer = undefined; void $.prompt.submit({ text, asUser: true }) })
    return { text: `▶ Self-drive started${d.deadline ? ` for ${fmtDur(d.deadline - now)}` : ''}: ${task}` }
  })

  // ---- the journal tool ----
  on('tool.call', { tool: LOG_TOOL }, async ($, e) => {
    const input = (e as unknown as { input?: Record<string, string> }).input ?? (e as unknown as Record<string, string>)
    const cur = await read($, drive)
    if (!cur || cur.status !== 'driving') return { result: 'Not logged: self-drive is not on.' }
    const now = await $.clock.now()
    const kind = (['decision', 'needs-you', 'note', 'finished'].includes(input.kind ?? '') ? input.kind : 'note') as EntryKind
    const entry: Entry = { at: now, kind, title: String(input.title ?? '').slice(0, 200) }
    if (input.alternatives) entry.alternatives = String(input.alternatives).slice(0, 400)
    if (input.why) entry.why = String(input.why).slice(0, 400)
    if (input.detail) entry.detail = String(input.detail).slice(0, 4000)
    activity += 1
    const expired = cur.deadline !== undefined && now >= cur.deadline
    const d = await update($, drive, x => x && {
      ...x, entries: [...x.entries, entry],
      ...(kind === 'finished' ? { status: expired ? 'limit' as const : 'finished' as const, endedAt: now, endReason: expired ? 'deadline reached' : 'work complete' } : {}),
    })
    if (d) await persist($, d, now)
    if (kind === 'finished') $.ui.status('✔ self-drive finished · /self-drive for the report')
    return { result: `Logged (${kind}).` }
  })

  // ---- guards while driving ----
  on('tool.call', { tool: ['AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode'] }, async ($, e, next) => {
    const cur = await read($, drive)
    if (cur?.status !== 'driving') return next(e)
    return { deny: 'Self-drive is on: the user is away and cannot answer. Decide it yourself, record the choice with self_drive_log (kind "decision"), and keep going.' }
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const cur = await read($, drive)
    if (await deadlineBlocks($, cur)) return { deny: 'Self-drive budget reached. Stop work and write the final report. Use /self-drive stop to release this gate.' }
    if (cur?.status !== 'driving') return next(e)
    activity += 1
    const why = riskOf(e.command)
    if (!why) {
      void update($, drive, x => x && { ...x, lastActivity: `$ ${e.command.split('\n')[0]?.slice(0, 80)}` })
      return next(e)
    }
    const now = await $.clock.now()
    const d = await update($, drive, x => logged(x, { at: now, kind: 'held', title: why, detail: '`' + e.command.slice(0, 300) + '`' }))
    if (d) await persist($, d, now)
    return { deny: `Held by self-drive (${why}): this is risky or outward-facing and the user is away. It has been added to the user's needs-you list automatically. Continue with everything else.` }
  })

  on('tool.call', async ($, e, next) => {
    const cur = await read($, drive)
    if (e.tool !== LOG_TOOL && await deadlineBlocks($, cur)) return { deny: 'Self-drive budget reached. Stop work and write the final report. Use /self-drive stop to release this gate.' }
    if (cur?.status !== 'driving' || e.tool === LOG_TOOL || e.tool === 'Bash') return next(e)
    activity += 1
    const why = riskyTool(e.tool)
    if (!why) {
      const t = e.tool
      void update($, drive, x => x && { ...x, lastActivity: t })
      return next(e)
    }
    const now = await $.clock.now()
    const d = await update($, drive, x => logged(x, { at: now, kind: 'held', title: why, detail: String(e.tool) }))
    if (d) await persist($, d, now)
    return { deny: `Held by self-drive (${why}): the user is away. Added to their needs-you list; continue with everything else.` }
  })

  // ---- keep going ----
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const cur = await read($, drive)
    if (!cur || cur.status !== 'driving') return r
    const now = await $.clock.now()
    if (e.isAborted) {
      // The person pressed Esc: they are back. Stop driving, keep the log.
      const d = await update($, drive, x => ended(x, 'stopped', now, 'interrupted by you'))
      if (d) await persist($, d, now)
      $.ui.status(undefined)
      return r
    }
    // Background agents still running: their completion wakes the main loop with a
    // notification turn, so don't count this turn as idle and don't push a "continue"
    // (it would queue behind them and could make Claude poll). Just wait for them.
    const busy = busyAgents(await $.agent.list())
    const waiting = busy.length > 0 && !(cur.deadline && now >= cur.deadline)
    if (waiting) {
      activity = 0
      const d = await update($, drive, x => x && { ...x, lastActivity: `waiting on ${busy.length} agent${busy.length > 1 ? 's' : ''}: ${busy.slice(0, 2).join(', ')}` })
      if (d) await persist($, d, now)
      return r
    }
    const idle = activity === 0 ? cur.idle + 1 : 0
    activity = 0
    const limit =
      cur.deadline && now >= cur.deadline ? 'deadline reached' :
      cur.continues >= MAX_CONTINUES ? `${MAX_CONTINUES} auto-continues used` :
      idle >= MAX_IDLE ? `${MAX_IDLE} turns in a row without progress` : undefined
    if (limit) {
      const d = await update($, drive, x => ended(x, 'limit', now, limit, { idle }))
      if (d) await persist($, d, now)
      $.ui.status(`■ self-drive stopped: ${limit} · /self-drive`)
      void $.prompt.submit({ text: `Self-drive has stopped (${limit}). Stop working now. Write the final report for me: what was done, the decisions to review, and the needs-you list.`, asUser: true })
      return r
    }
    const d = await update($, drive, x => x && { ...x, continues: x.continues + 1, idle })
    if (d) await persist($, d, now)
    void $.prompt.submit({ text: CONTINUE, asUser: true })
    return r
  })

  // ---- the dashboard ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Markdown } = $.ui.resolve(e)
    const d = await read($, drive)
    if (!d) return <Text dimColor>No self-drive yet. Start one with /self-drive 2h &lt;task&gt;</Text>
    const now = Date.now()
    const w = Math.max(20, e.props.bodyColumns - 2)
    const running = d.status === 'driving'
    const head = running ? { t: '▶ DRIVING', c: '#38bdf8' } : d.status === 'finished' ? { t: '✔ FINISHED', c: '#34d399' } : { t: '■ STOPPED', c: '#fbbf24' }
    const ran = fmtDur((d.endedAt ?? now) - d.startedAt)
    const budget = d.deadline ? ` of ${fmtDur(d.deadline - d.startedAt)}` : ''
    const decisions = d.entries.filter(x => x.kind === 'decision')
    const needs = d.entries.filter(x => x.kind === 'needs-you' || x.kind === 'held')
    const fin = d.entries.filter(x => x.kind === 'finished').at(-1)
    const notes = d.entries.filter(x => x.kind === 'note').slice(-3)

    const row = (x: Entry, i: number, n?: number) => (
      <Box key={`${x.kind}${i}`} flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Text color={KIND_STYLE[x.kind].color}>{n !== undefined ? `${n}.` : KIND_STYLE[x.kind].icon}</Text>
          <Text bold wrap="wrap">{x.title}</Text>
        </Box>
        {x.why && <Text dimColor wrap="wrap">   why: {x.why}</Text>}
        {x.alternatives && <Text dimColor wrap="wrap">   instead of: {x.alternatives}</Text>}
        {x.kind !== 'decision' && x.detail && <Text dimColor wrap="wrap">   {x.detail.slice(0, w * 2)}</Text>}
      </Box>
    )

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={2}>
            <Text color={head.c} bold>{head.t}</Text>
            <Text dimColor>⏱ {ran}{budget}</Text>
            <Text dimColor>↻ {d.continues}</Text>
          </Box>
          <Text wrap="wrap">{d.task}</Text>
          {d.endReason && !running && <Text dimColor>ended: {d.endReason}</Text>}
          {running && d.lastActivity && <Text dimColor>now: {d.lastActivity.slice(0, w)}</Text>}
        </Box>

        {fin?.detail && (
          <Box flexDirection="column">
            <Text color="#34d399" bold>Summary</Text>
            <Markdown text={fin.detail.slice(0, 3000)} />
          </Box>
        )}

        <Box flexDirection="column">
          <Text color="#38bdf8" bold>◆ Decisions made for you ({decisions.length})</Text>
          {decisions.length === 0 ? <Text dimColor>none yet</Text> : decisions.map((x, i) => row(x, i, i + 1))}
        </Box>

        <Box flexDirection="column">
          <Text color="#fbbf24" bold>✋ Needs you ({needs.length})</Text>
          {needs.length === 0 ? <Text dimColor>nothing so far</Text> : needs.map((x, i) => row(x, i))}
        </Box>

        {notes.length > 0 && (
          <Box flexDirection="column">
            <Text dimColor bold>Milestones</Text>
            {notes.map((x, i) => row(x, i))}
          </Box>
        )}

        {running && (
          <Button key="stop" label="Stop self-drive" onPress={async () => {
            const t = Date.now()
            const s = await update($, drive, x => ended(x, 'stopped', t, 'stopped by you'))
            if (s) await persist($, s, t)
            $.ui.status(undefined)
          }} />
        )}
      </Box>
    )
  })
}

/** Saves the drive for resume and writes the readable report next to the other notes. */
async function persist($: import('claude-code').EngineInterface, d: Drive, now: number): Promise<void> {
  const sid = await $.session.id()
  await $.store.set(`drive:${sid}`, d)
  try {
    const home = await $.env.get('HOME')
    if (home) {
      const day = new Date(d.startedAt).toISOString().slice(0, 10)
      await $.fs.write(`${home}/.claude/self-drive/${day}-${sid.slice(0, 8)}.md`, report(d, now))
    }
  } catch { /* the report file is a convenience */ }
}

/** A tool already running cannot be cancelled here; no new work starts after the budget. */
async function deadlineBlocks($: import('claude-code').EngineInterface, d: Drive | null): Promise<boolean> {
  return d?.status === 'limit' || !!(d?.status === 'driving' && d.deadline !== undefined && await $.clock.now() >= d.deadline)
}
