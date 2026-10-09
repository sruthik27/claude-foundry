import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Meter } from '../types'
import {
  EMPTY, bar, dots, elapsed, gradient, onTaskCreate, onTaskUpdate, onTodoWrite, percent,
  freshness, quietTurn, readEstimate, stripTags, withEstimate,
} from './meter.js'

/** Records what the bar now shows, so later changes never draw it lower. */
const settle = (m: Meter): Meter => ({ ...m, shown: percent(m) })

const meter = atom({ plugin: 'goal-meter', key: 'meter' } as const, EMPTY)

const GUIDE = `# Goal progress reporting (goal-meter mod: display only)
At the end of any turn where you are working toward a multi-step goal, emit one self-closing tag on its own line:
<progress goal="3-6 word name of the overall goal" phase="N/M" name="current phase name" pct="0-100"/>
pct is your honest estimate of how much of the WHOLE goal is complete, including phases you have not planned yet. phase/name are optional when there are no phases. Lower pct if the scope grew. Keep the same goal text while it is the same goal; a new goal text starts a fresh bar.
When the goal is finished or abandoned, emit it once more with pct="100" (finished) and then stop emitting. Omit the tag entirely for conversation with no goal; the bar fades on its own when you stop reporting.
This is reporting only: never change how you plan, split, track or sequence work because of it.`

export const register: Register = on => {

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    return { ...r, sections: [...r.sections, { id: 'goal-meter:guide', text: GUIDE, scope: 'session' }] }
  })

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    let saved = (await $.store.get(`meter:${await $.session.id()}`)) as Meter | undefined
    // A resume that came back under a new id: carry over the session it continued from.
    if (!saved) { const prev = await predecessorOf($, e.cwd); if (prev) saved = (await $.store.get(`meter:${prev}`)) as Meter | undefined }
    if (saved && (await read($, meter)).steps.length === 0) await update($, meter, () => saved)
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (!['clear', 'resume', 'fork'].includes(e.source)) return r
    let saved = e.source === 'clear' ? undefined : await $.store.get(`meter:${await $.session.id()}`) as Meter | undefined
    if (!saved && e.source !== 'clear' && e.cwd) { const prev = await predecessorOf($, e.cwd); if (prev) saved = await $.store.get(`meter:${prev}`) as Meter | undefined }
    await update($, meter, () => saved ?? EMPTY)
    return r
  })

  // ---- observe the task tools: read what they did, never change it ----
  on('tool.call', { tool: 'TaskCreate' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && r.result) {
      const m = await update($, meter, x => settle({ ...onTaskCreate(x, r.result.task.id, e.subject, e.activeForm), startedAt: x.startedAt ?? Date.now(), quiet: 0 }))
      await $.store.set(`meter:${await $.session.id()}`, m)
    }
    return r
  })
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError) {
      const m = await update($, meter, x => settle({ ...onTaskUpdate(x, e.taskId, e), quiet: 0 }))
      await $.store.set(`meter:${await $.session.id()}`, m)
    }
    return r
  })
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError) {
      const m = await update($, meter, x => settle({ ...onTodoWrite(x, e.todos), startedAt: x.startedAt ?? Date.now(), quiet: 0 }))
      await $.store.set(`meter:${await $.session.id()}`, m)
    }
    return r
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const est = readEstimate(e.answer)
    const m = est
      ? await update($, meter, x => settle(withEstimate(x, est)))
      : await update($, meter, x => (x.estimate || x.steps.length ? quietTurn(x) : x))
    await $.store.set(`meter:${await $.session.id()}`, m)
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.text.includes('<progress')) return next(e)
    return next({ ...e, props: { ...e.props, text: stripTags(e.props.text) } })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const m = await read($, meter)
    const fresh = freshness(m)
    if (e.props.hasSurvey || (m.steps.length === 0 && !m.estimate) || fresh === 'hidden') return next(e)
    const downstream = await next(e)
    const isStale = fresh === 'stale'

    const { Box, Text } = $.ui.resolve(e)
    const pct = percent(m)

    const cols = e.props.bodyColumns
    const est = m.estimate
    const goal = est?.goal ?? 'Goal'
    const isDone = pct >= 100
    const active = m.steps.find(s => s.status === 'in_progress')
    const doneN = m.steps.filter(s => s.status === 'completed').length
    const time = m.startedAt ? `⏱ ${elapsed(Date.now() - m.startedAt)}` : ''
    const pctText = isDone ? '✔ done' : isStale ? `${pct}% · paused` : `${pct}%`
    const accent = isStale ? '#6b7280' : gradient(pct / 100)

    // Narrow: one line.
    if (cols < 70) {
      const b = bar(pct, Math.max(8, cols - pctText.length - 6))
      return (
        <Box flexDirection="column">{downstream}<Box paddingX={1}>
          <Text color={accent} bold>◆ </Text>
          {b.runs.map((r, i) => <Text key={`r${i}`} color={isStale ? '#4b5563' : r.color}>{r.text}</Text>)}
          <Text color={accent}>{b.tip}</Text>
          <Text color="#3a3f4b">{b.rest}</Text>
          <Text color={accent} bold> {pctText}</Text>
        </Box></Box>
      )
    }

    const label = goal.slice(0, Math.max(12, Math.floor(cols * 0.32)))
    const barW = Math.max(10, cols - label.length - pctText.length - 8)
    const b = bar(pct, barW)
    const phase = est?.phase && est.phases ? `phase ${est.phase}/${est.phases}${est.phaseName ? ` · ${est.phaseName}` : ''}` : ''
    const step = m.steps.length > 0 ? `step ${Math.min(doneN + (active ? 1 : 0), m.steps.length)}/${m.steps.length}` : ''
    const doing = active ? ` · ${active.active ?? active.title}` : ''
    const detail = `${step}${doing}`.slice(0, Math.max(10, cols - phase.length - time.length - 30))

    return (
      <Box flexDirection="column" paddingX={1}>
        {downstream}
        <Box flexDirection="row">
          <Text color={accent} bold>{isDone ? '✔' : '◆'} </Text>
          <Text bold>{label}</Text>
          <Text>  </Text>
          {b.runs.map((r, i) => <Text key={`r${i}`} color={isStale ? '#4b5563' : r.color}>{r.text}</Text>)}
          <Text color={accent}>{b.tip}</Text>
          <Text color="#3a3f4b">{b.rest}</Text>
          <Text color={accent} bold>  {pctText}</Text>
        </Box>
        <Box flexDirection="row" justifyContent="space-between">
          <Box flexDirection="row" columnGap={2}>
            {phase !== '' && <Text color="#a78bfa">  {phase}</Text>}
            {m.steps.length > 0 && <Text color={accent}>{dots(m.steps)}</Text>}
            {detail !== '' && <Text dimColor>{detail}</Text>}
          </Box>
          {time !== '' && <Text dimColor>{time}</Text>}
        </Box>
      </Box>
    )
  })
}

/* A resumed session can come back under a new id with the old history copied in. This finds the
   session it continued from: the other transcript in the same project that holds the same first
   message. Mods key their saved state by session id, so they look there when their own is empty. */
async function predecessorOf($: import('claude-code').EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const dir = `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}`
    const sid = await $.session.id()
    const r = await $.process.run(['sh', '-c',
      'f="$1/$2.jsonl"; [ -f "$f" ] || exit 0; u=$(grep -m1 -o \'"uuid":"[^"]*"\' "$f") || exit 0; ' +
      'ls -t "$1"/*.jsonl 2>/dev/null | head -40 | grep -v "/$2.jsonl" | xargs grep -l -F "$u" 2>/dev/null | head -1',
      'prev', dir, sid], { timeoutMs: 20000 })
    const hit = r.stdout.trim().split('/').pop()?.replace(/\.jsonl$/, '')
    return hit && hit !== sid ? hit : undefined
  } catch {
    return undefined
  }
}
