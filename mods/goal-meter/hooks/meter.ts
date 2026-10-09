import type { Estimate, Meter, Step, StepStatus } from '../types'
import { outsideCode, stripOutsideCode } from './metadata.js'

export const EMPTY: Meter = { steps: [], doneAtEstimate: 0, shown: 0 }

const TAG = /<progress\b([^>]*?)\/?>(?:<\/progress>)?/g

/** The last <progress .../> tag in a reply, if any. */
export function readEstimate(text: string): Estimate | undefined {
  let last: Estimate | undefined
  for (const m of outsideCode(text, TAG)) {
    const a: Record<string, string> = {}
    for (const p of (m[1] ?? '').matchAll(/([a-z]+)="([^"]*)"/g)) a[p[1] ?? ''] = p[2] ?? ''
    const pct = Number(a.pct)
    if (!Number.isFinite(pct)) continue
    const est: Estimate = { pct: Math.max(0, Math.min(100, Math.round(pct))) }
    if (a.goal) est.goal = a.goal.slice(0, 60)
    const ph = /^(\d+)\s*\/\s*(\d+)$/.exec(a.phase ?? '')
    if (ph) { est.phase = Number(ph[1]); est.phases = Number(ph[2]) }
    if (a.name) est.phaseName = a.name.slice(0, 40)
    last = est
  }
  return last
}

export function stripTags(text: string): string {
  return stripOutsideCode(text, TAG)
}

const done = (s: readonly Step[]) => s.filter(x => x.status === 'completed').length

/**
 * The bar's value. With an estimate: the estimate, plus credit for steps finished since it,
 * spread over the room left in the current phase (or the whole remainder). Without one:
 * the plain task ratio. Clamped below 100 until everything is done, and never below what
 * was last shown.
 */
export function percent(m: Meter): number {
  const total = m.steps.length
  const doneNow = done(m.steps)
  let raw: number
  if (m.estimate) {
    const e = m.estimate
    const ceiling = e.phase && e.phases ? Math.max(e.pct, (100 * e.phase) / e.phases) : 100
    const left = total - m.doneAtEstimate
    const gained = Math.max(0, doneNow - m.doneAtEstimate)
    raw = left > 0 ? e.pct + (ceiling - e.pct) * (gained / left) : e.pct
  } else {
    raw = total === 0 ? 0 : (100 * doneNow) / total
  }
  const allSteps = doneNow === total
  // done: every step finished and the estimate agrees, or Claude reports the goal complete
  const allDone = (total > 0 && allSteps && (!m.estimate || m.estimate.pct >= 95)) || (allSteps && (m.estimate?.pct ?? 0) >= 100)
  const v = allDone ? 100 : Math.min(raw, 99)
  return Math.round(Math.max(v, m.shown))
}

/** Turns without a report after which the band dims, and after which it hides. */
export const STALE_DIM = 2
export const STALE_HIDE = 4

const sameGoal = (a?: string, b?: string) =>
  !a || !b || a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Folds a new estimate in. A different goal name starts over (fresh bar, steps and timer); the
 * same goal keeps its steps, and a lower pct there is Claude saying the scope grew.
 */
export function withEstimate(m: Meter, e: Estimate, now: number = Date.now()): Meter {
  if (m.estimate && !sameGoal(m.estimate.goal, e.goal)) {
    return { steps: [], estimate: e, doneAtEstimate: 0, shown: 0, startedAt: now, quiet: 0 }
  }
  const keep = { ...m.estimate, ...e }
  return { ...m, estimate: keep, doneAtEstimate: done(m.steps), shown: Math.min(m.shown, e.pct), startedAt: m.startedAt ?? now, quiet: 0 }
}

/** One main turn passed with no report and no task change. */
export function quietTurn(m: Meter): Meter {
  return { ...m, quiet: (m.quiet ?? 0) + 1 }
}

/** What the band shows: 'live', 'stale' (dimmed, still there) or 'hidden'. */
export function freshness(m: Meter): 'live' | 'stale' | 'hidden' {
  const q = m.quiet ?? 0
  if (percent(m) >= 100) return q >= STALE_DIM ? 'hidden' : 'live'
  return q >= STALE_HIDE ? 'hidden' : q >= STALE_DIM ? 'stale' : 'live'
}

// ---- reading the task tools (observe only) ----

export function onTaskCreate(m: Meter, id: string, title: string, active?: string): Meter {
  if (m.steps.some(s => s.id === id)) return m
  return { ...m, steps: [...m.steps, { id, title, active, status: 'pending' }] }
}

export function onTaskUpdate(m: Meter, id: string, u: { status?: StepStatus | 'deleted'; subject?: string; activeForm?: string }): Meter {
  const status = u.status
  if (status === 'deleted') return { ...m, steps: m.steps.filter(s => s.id !== id) }
  return {
    ...m,
    steps: m.steps.map(s => s.id !== id ? s : {
      ...s,
      ...(status ? { status } : {}),
      ...(u.subject ? { title: u.subject } : {}),
      ...(u.activeForm ? { active: u.activeForm } : {}),
    }),
  }
}

export function onTodoWrite(m: Meter, todos: readonly { content: string; status: StepStatus; activeForm: string }[]): Meter {
  return { ...m, steps: todos.map((t, i) => ({ id: `todo-${i}`, title: t.content, active: t.activeForm, status: t.status })) }
}

// ---- drawing helpers ----

const FULL = '━'
/** Filled cells as runs of one colour each (a gradient), then a half-cell tip and the track. */
export function bar(pct: number, width: number): { runs: { text: string; color: string }[]; tip: string; rest: string } {
  const cells = Math.max(4, width)
  const exact = (pct / 100) * cells
  const n = Math.floor(exact)
  const tip = n < cells && exact - n >= 0.5 ? '╸' : ''
  const runs: { text: string; color: string }[] = []
  const SEG = Math.max(1, Math.ceil(cells / 16))
  for (let i = 0; i < n; i += SEG) {
    const len = Math.min(SEG, n - i)
    runs.push({ text: FULL.repeat(len), color: gradient((i + len / 2) / cells) })
  }
  return { runs, tip, rest: FULL.repeat(Math.max(0, cells - n - (tip ? 1 : 0))) }
}

/** Indigo -> cyan -> green across the bar, as truecolor hex. */
const STOPS: readonly [number, number, number][] = [[124, 92, 255], [56, 189, 248], [52, 211, 153]]
export function gradient(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (STOPS.length - 1)
  const i = Math.min(STOPS.length - 2, Math.floor(x))
  const f = x - i
  const a = STOPS[i]!, b = STOPS[i + 1]!
  const c = a.map((v, k) => Math.round(v + (b[k]! - v) * f))
  return '#' + c.map(v => v.toString(16).padStart(2, '0')).join('')
}

export function dots(steps: readonly Step[], max = 12): string {
  const icon = (s: Step) => s.status === 'completed' ? '●' : s.status === 'in_progress' ? '◐' : '○'
  if (steps.length <= max) return steps.map(icon).join(' ')
  const d = done(steps)
  return `${'●'.repeat(Math.min(d, max - 3))}… ${d}/${steps.length}`
}

export function elapsed(ms: number): string {
  const m = Math.floor(ms / 60000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
