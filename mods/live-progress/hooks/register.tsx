import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { EMPTY, clock, feed, percent } from './track.js'
import type { Spec } from './track.js'
import type { Job } from '../types'

/**
 * Live progress bands above the prompt. Claude starts a long job with its output going to a log
 * and calls `watch_progress`; the mod reads only the log's new bytes once a second (`tail -c`),
 * counts done / failed / skipped (known runners for free, or Claude's own patterns) and redraws.
 * A run that finishes, or a log that stops growing for `idle` seconds, stays shown for 3 turns.
 */
const jobs = atom({ plugin: 'live-progress', key: 'jobs' } as const, [])
const S: { tick: { cancel: () => void } | null } = { tick: null }
let generation = 0
let polling: Promise<void> = Promise.resolve()

const GUIDE = 'To show the user a live progress indicator for anything long-running (tests, builds, deploys, scripts, data jobs, log tails), run it in the background with output to a log file (e.g. `cmd > /tmp/x.log 2>&1`) and call watch_progress with that path; a band above the prompt then updates every second while you keep working. Test runners (pytest, jest, vitest, go, node:test, cargo) are counted automatically; for anything else pass regex `done`/`fail` (lines that count) and `total`, or `percent` (a capture of N% or N/M).'

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    stopTicking()
    await update($, jobs, () => [])
    await $.tool.register({
      name: 'watch_progress',
      description: 'Show the user a live progress band above the prompt for a long-running background job, read from its log file every second. Auto-counts pytest/jest/vitest/go/node:test/cargo output; otherwise give regexes. Use for tests, builds, scripts, migrations, batch jobs, or any log you want the user to watch live. Returns at once; keep working.',
      inputSchema: { type: 'object', required: ['log', 'label'], properties: {
        log: { type: 'string', description: 'Absolute path of the log file the job writes (stdout+stderr).' },
        label: { type: 'string', description: 'Short name shown on the band, e.g. "pytest tests/" or "migrate 2.4M rows".' },
        total: { type: 'number', description: 'How many items to expect, when known (makes a percentage).' },
        done: { type: 'string', description: 'Regex: a line that counts one item done.' },
        fail: { type: 'string', description: 'Regex: a line that counts one item failed (its text is listed).' },
        skip: { type: 'string', description: 'Regex: a line that counts one item skipped.' },
        percent: { type: 'string', description: 'Regex with one capture group holding "42" (percent) or "17/250".' },
        end: { type: 'string', description: 'Regex: a line that means the job finished.' },
        idle: { type: 'number', description: 'Seconds without new output after which the job counts as stopped (default 120).' },
      } },
    } as never)
    await $.tool.register({
      name: 'stop_progress',
      description: 'Stop showing a progress band (pass its log path, or "all").',
      inputSchema: { type: 'object', required: ['log'], properties: { log: { type: 'string' } } },
    } as never)
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (['clear', 'resume', 'fork'].includes(e.source)) { stopTicking(); await update($, jobs, () => []) }
    return r
  })

  on('prompt.submit', async ($, e, next) => next({ ...e, context: [...(e.context ?? []), GUIDE] }))

  on('tool.call', { tool: /^mcp__live-progress__watch_progress$/ }, async ($, e) => {
    const a = e as unknown as Spec & { idle?: number }
    if (!a.log || !a.log.startsWith('/')) return { result: 'Give the absolute path of the log file.' }
    const now = await $.clock.now()
    const spec: Spec = { id: a.log, label: String(a.label || a.log.split('/').pop()).slice(0, 60), log: a.log,
      ...(a.total ? { total: Number(a.total) } : {}), ...pick(a, ['done', 'fail', 'skip', 'percent', 'end']) }
    for (const k of ['done', 'fail', 'skip', 'percent', 'end'] as const) {
      if (spec[k]) try { new RegExp(spec[k]!) } catch { return { result: `"${k}" is not a valid regex: ${spec[k]}` } }
    }
    await update($, jobs, js => [...js.filter(j => j.spec.id !== spec.id), { generation: ++generation, spec, p: EMPTY, offset: 0, started: now, quietSince: now, idle: Math.max(10, Number(a.idle ?? 120)), turnsDone: 0 }])
    await poll($)
    if (!S.tick) S.tick = $.clock.every(1000, () => { void poll($).catch(() => undefined) }) as never
    return { result: `Watching ${spec.log} as "${spec.label}"; the user sees a live band above the prompt. Keep working; call stop_progress when you no longer want it shown.` }
  })

  on('tool.call', { tool: /^mcp__live-progress__stop_progress$/ }, async ($, e) => {
    const log = String((e as unknown as { log?: string }).log ?? '')
    await update($, jobs, js => (log === 'all' ? [] : js.filter(j => j.spec.id !== log)))
    $.ui.invalidate('ui.render')
    return { result: 'Stopped.' }
  })

  // Finished bands linger for 3 of the person's turns, then go.
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const js = await update($, jobs, list => list.map(j => (j.ended ? { ...j, turnsDone: j.turnsDone + 1 } : j)).filter(j => j.turnsDone < 3))
    if (js.length === 0) stopTicking()
    $.ui.invalidate('ui.render')
    return r
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const js = await read($, jobs)
    if (e.props.hasSurvey || js.length === 0) return next(e)
    const { Box, Text } = $.ui.resolve(e)
    const cols = Math.max(30, e.props.bodyColumns - 2)
    const now = Date.now()
    const rows = js.slice(-3).map((j, i) => {
      const pct = percent(j.p, j.spec)
      const state = j.stopped && !j.p.finished ? 'stopped' : j.p.finished ? (j.p.fail > 0 ? 'failed' : 'done') : 'running'
      const hue = state === 'failed' || (state === 'running' && j.p.fail > 0) ? '#f38ba8' : state === 'done' ? '#a6e3a1' : state === 'stopped' ? '#6c7086' : '#89b4fa'
      const icon = state === 'done' ? '✔' : state === 'failed' ? '✗' : state === 'stopped' ? '◼' : SPIN[Math.floor(now / 120) % SPIN.length]!
      const counts = [
        j.p.done ? { t: `✓ ${j.p.done}`, c: '#a6e3a1' } : null,
        j.p.fail ? { t: `✗ ${j.p.fail}`, c: '#f38ba8' } : null,
        j.p.skip ? { t: `⊘ ${j.p.skip}`, c: '#f9e2af' } : null,
        (j.spec.total ?? j.p.total) ? { t: `of ${j.spec.total ?? j.p.total}`, c: '#6c7086' } : null,
      ].filter((x): x is { t: string; c: string } => x !== null)
      const time = clock((j.ended ?? now) - j.started)
      const label = j.spec.label.slice(0, Math.max(10, Math.floor(cols * 0.28)))
      const right = `${pct === undefined ? '' : `${Math.round(pct)}%  `}${counts.map(c => c.t).join('  ')}  ${time}`
      const barW = Math.max(8, cols - label.length - right.length - 6)
      const fill = pct === undefined ? -1 : Math.round((pct / 100) * barW)
      const indet = pct === undefined && state === 'running'
      const pos = Math.floor(now / 90) % (barW + 6) - 6
      const barCells = Array.from({ length: barW }, (_, k) => (fill >= 0 ? k < fill : indet ? k >= pos && k < pos + 6 : state !== 'stopped'))
      const detail = j.p.failures.length ? `✗ ${j.p.failures.slice(-2).join('   ✗ ')}` : j.p.finished ? (j.p.summary ?? '') : j.p.last
      return (
        <Box key={`j${i}`} flexDirection="column">
          <Box flexDirection="row">
            <Text color={hue} bold>{`${icon} `}</Text>
            <Text bold>{label}</Text>
            <Text>{'  '}</Text>
            <Text color={hue}>{barCells.map(x => (x ? '█' : '')).join('')}</Text>
            <Text color="#45475a">{barCells.map(x => (x ? '' : '░')).join('')}</Text>
            <Text color={hue} bold>{pct === undefined ? '  ' : `  ${Math.round(pct)}%  `}</Text>
            {counts.map((c, k) => <Text key={`c${k}`} color={c.c}>{`${c.t}  `}</Text>)}
            <Text color="#6c7086">{time}</Text>
          </Box>
          {detail ? <Text color={j.p.failures.length ? '#f38ba8' : '#6c7086'} wrap="truncate-end">{`  ${detail}`}</Text> : null}
        </Box>
      )
    })
    return <Box flexDirection="column" paddingX={1}>{await next(e)}{rows}</Box>
  })
}

const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
const pick = <T extends object>(o: T, keys: string[]) => Object.fromEntries(keys.filter(k => (o as Record<string, unknown>)[k]).map(k => [k, String((o as Record<string, unknown>)[k])]))

function stopTicking(): void { S.tick?.cancel(); S.tick = null }

/** Read each running job's new bytes, fold them in, and redraw. */
function poll($: import('claude-code').EngineInterface): Promise<void> {
  const run = polling.then(() => pollOnce($))
  polling = run.catch(() => undefined)
  return run
}
async function pollOnce($: import('claude-code').EngineInterface): Promise<void> {
  const js = await read($, jobs)
  const live = js.filter(j => !j.stopped)
  if (live.length === 0) { stopTicking(); $.ui.invalidate('ui.render'); return }
  const now = await $.clock.now()
  const next: Job[] = []
  for (const j of js) {
    if (j.stopped) { next.push(j); continue }
    let size = j.offset
    try { size = (await $.fs.stat(j.spec.log)).size } catch { /* not created yet */ }
    let chunk = ''
    const truncated = size < j.offset
    const offset = truncated ? 0 : j.offset
    if (size > offset) {
      // only the new bytes, at most 256 KB a second, so a huge log never stalls the band
      const from = Math.max(offset, size - 262_144)
      try { chunk = (await $.process.run(['tail', '-c', `+${from + 1}`, j.spec.log], { timeoutMs: 3000 })).stdout } catch { chunk = '' }
      // keep a partial last line for the next read
      const cut = chunk.lastIndexOf('\n')
      const used = cut >= 0 ? chunk.slice(0, cut + 1) : ''
      chunk = used
      size = from + new TextEncoder().encode(used).length
    }
    const p = chunk ? feed(truncated ? EMPTY : j.p, chunk, j.spec) : truncated ? EMPTY : j.p
    const quietSince = chunk ? now : j.quietSince
    const stalled = now - quietSince > j.idle * 1000
    next.push({ ...j, p, offset: size, quietSince, ended: p.finished || stalled ? (chunk ? now : j.ended ?? now) : undefined, turnsDone: chunk ? 0 : j.turnsDone, ...(stalled ? { stopped: p.finished ? 'complete' : 'no output' } : {}) })
  }
  await update($, jobs, current => current.map(j => {
    const snapshot = js.find(x => x.generation === j.generation)
    const result = next.find(x => x.generation === j.generation)
    return snapshot && result ? { ...result, turnsDone: result.turnsDone === 0 ? 0 : j.turnsDone } : j
  }))
  $.ui.invalidate('ui.render')
}
