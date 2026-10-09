import { expect, mock, test } from 'claude-code/testing'
import type { Meter } from '../types'
import { EMPTY, bar, freshness, gradient, quietTurn, onTaskCreate, onTaskUpdate, onTodoWrite, percent, readEstimate, stripTags, withEstimate } from '../hooks/meter.js'

const steps = (n: number, done: number): Meter =>
  ({ ...EMPTY, steps: Array.from({ length: n }, (_, i) => ({ id: `${i}`, title: `S${i}`, status: i < done ? 'completed' : 'pending' })) })

test('reads the last progress tag and strips them all', async () => {
  const t = 'a\n<progress goal="Ship the mod" phase="2/4" name="Build" pct="41.6"/>\nb <progress pct="45"/>'
  expect(readEstimate(t)).toEqual({ pct: 45 })
  expect(readEstimate('<progress goal="G" phase="2/4" name="Build" pct="40"/>')).toEqual({ goal: 'G', phase: 2, phases: 4, phaseName: 'Build', pct: 40 })
  expect(readEstimate('no tag')).toBeUndefined()
  expect(stripTags('a\n<progress pct="5"/>\nb')).toBe('a\n\nb')
})

test('task ratio alone when there is no estimate; 100 only when all done', async () => {
  expect(percent(steps(4, 1))).toBe(25)
  expect(percent(steps(4, 4))).toBe(100)
  expect(percent(steps(3, 3) as Meter)).toBe(100)
})

test('blends: steps after an estimate move within the phase ceiling', async () => {
  // estimate 40% in phase 2/4 (ceiling 50%), 2 of 6 steps done at that moment
  let m = withEstimate(steps(6, 2), { pct: 40, phase: 2, phases: 4 })
  expect(percent(m)).toBe(40)
  m = onTaskUpdate(m, '2', { status: 'completed' })
  m = onTaskUpdate(m, '3', { status: 'completed' })
  expect(percent(m)).toBe(45) // half the remaining steps -> half way to 50
  // all steps done but the goal estimate is only 40%: never shows 100
  m = steps(6, 6); m = withEstimate(m, { pct: 40 })
  expect(percent(m)).toBe(40)
})

test('never goes backwards, except when Claude lowers the estimate', async () => {
  let m: Meter = { ...withEstimate(steps(4, 2), { pct: 60 }), shown: 60 }
  m = onTodoWrite(m, [{ content: 'a', status: 'pending', activeForm: 'A' }]) // plan rewritten
  expect(percent(m)).toBeGreaterThanOrEqual(60)
  m = withEstimate({ ...m, shown: 60 }, { pct: 35 }) // scope grew
  expect(percent(m)).toBe(35)
})

test('task tools: create, delete, todo replace', async () => {
  let m = onTaskCreate(EMPTY, '1', 'Write tests', 'Writing tests')
  m = onTaskCreate(m, '1', 'dup')
  expect(m.steps.length).toBe(1)
  m = onTaskUpdate(m, '1', { status: 'deleted' })
  expect(m.steps.length).toBe(0)
})

test('bar fills proportionally with a gradient', async () => {
  const b = bar(50, 20)
  expect(b.runs.map(r => r.text).join('').length + b.tip.length + b.rest.length).toBe(20)
  expect(b.runs.map(r => r.text).join('').length).toBe(10)
  expect(gradient(0)).toBe('#7c5cff')
  expect(gradient(1)).toBe('#34d399')
})

const BAND = (cols: number) => ({ plugin: 'goal-meter', surface: 'terminal' as const, component: 'AbovePrompt' as const,
  props: { hasSurvey: false, isWorking: true, maxRows: 6, bodyColumns: cols } as never })

test('draws nothing without a plan, then the bar after a turn reports progress', async ($, on) => {
  mock.store(on)
  on('session.id', async () => ({ value: 's1' }) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.render', async ($, e) => { const { Text } = $.ui.resolve(e); return Text({ children: ['(engine band)'] }) })
  const empty = await $.ui.mount(BAND(120))
  expect(await empty.find({ type: 'Text', text: /%/ })).toBeUndefined()
  await empty.unmount()

  await $.turn.complete({ answer: 'ok <progress goal="Goal meter mod" phase="3/4" name="Tests" pct="62"/>', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  for (const cols of [120, 50]) {
    const ui = await $.ui.mount(BAND(cols))
    expect(await ui.find({ type: 'Text', text: '62%' })).toBeDefined()
    if (cols === 120) expect(await ui.find({ type: 'Text', text: /phase 3\/4 · Tests/ })).toBeDefined()
    await ui.unmount()
  }
})


test('a new goal name starts a fresh bar and timer; the same goal keeps its progress', async () => {
  const a = withEstimate({ ...EMPTY }, { goal: 'Changes mod', pct: 88 }, 1000)
  expect(a.startedAt).toBe(1000)
  const same = withEstimate({ ...a, shown: 88 }, { goal: 'changes mod', pct: 90 }, 5000)
  expect(same.startedAt).toBe(1000)
  const b = withEstimate({ ...a, shown: 88, steps: [{ id: '1', title: 'x', status: 'completed' }] }, { goal: 'Fix namer', pct: 10 }, 9000)
  expect([b.startedAt, b.steps.length, b.shown, percent(b)]).toEqual([9000, 0, 0, 10])
})

test('turns without a report dim the band, then hide it; a finished goal hides sooner', async () => {
  let m = withEstimate({ ...EMPTY }, { goal: 'G', pct: 60 })
  expect(freshness(m)).toBe('live')
  m = quietTurn(quietTurn(m))
  expect(freshness(m)).toBe('stale')
  m = quietTurn(quietTurn(m))
  expect(freshness(m)).toBe('hidden')
  // a fresh report brings it back
  expect(freshness(withEstimate(m, { goal: 'G', pct: 70 }))).toBe('live')
  // done: shown for one quiet turn, gone after two
  const d = withEstimate({ ...EMPTY }, { goal: 'G', pct: 100 })
  expect(freshness(quietTurn(d))).toBe('live')
  expect(freshness(quietTurn(quietTurn(d)))).toBe('hidden')
})

test('the band fades after quiet turns in the real hooks', async ($, on) => {
  mock.store(on)
  on('session.id', async () => ({ value: 's1' }) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.render', async ($, e) => { const { Text } = $.ui.resolve(e); return Text({ children: ['(engine band)'] }) })
  const done = (answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await done('<progress goal="Old goal" pct="88"/>')
  await done('just chatting')
  await done('more chatting')
  let ui = await $.ui.mount(BAND(120))
  expect(await ui.find({ type: 'Text', text: /paused/ })).toBeDefined()
  await ui.unmount()
  await done('x'); await done('y')
  ui = await $.ui.mount(BAND(120))
  expect(await ui.find({ type: 'Text', text: /%/ })).toBeUndefined()
})

test('quoted progress tags are examples and both band widths preserve the engine UI', async ($, on) => {
  const example = '`<progress pct="99"/>`'
  expect(stripTags(example)).toBe(example); expect(readEstimate(example)).toBeUndefined()
  mock.store(on)
  on('session.id', async () => ({ value: 's' }) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.render', async ($, e) => $.ui.resolve(e).Text({ children: ['downstream'] }))
  await $.turn.complete({ answer: '<progress pct="42"/>', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  for (const columns of [50, 120]) {
    const band = await $.ui.mount(BAND(columns))
    expect(await band.find({ type: 'Text', text: 'downstream' })).toBeDefined()
    expect(await band.find({ type: 'Text', text: '42%' })).toBeDefined()
    await band.unmount()
  }
})

test('resume restores the selected session, while clear discards its meter', async ($, on) => {
  let id = 'first'
  const saved = { ...EMPTY, estimate: { goal: 'Restored session', pct: 73 } }
  on('session.id', async () => ({ value: id }) as never)
  on('store.get', async (_$, e) => ({ value: e.key === 'meter:second' ? saved : undefined }) as never)
  on('classic.SessionStart', async () => ({}))
  on('ui.render', async ($, e) => $.ui.resolve(e).Text({ children: ['engine'] }))
  id = 'second'
  await $.classic.SessionStart({ source: 'resume' })
  const band = await $.ui.mount(BAND(120))
  expect(await band.find({ type: 'Text', text: '73%' })).toBeDefined()
  await $.classic.SessionStart({ source: 'clear' })
  await band.redraw()
  expect(await band.find({ type: 'Text', text: '73%' })).toBeUndefined()
})
