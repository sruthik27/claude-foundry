import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { EMPTY, feed, percent } from '../hooks/track.js'

const S = (extra = {}) => ({ id: '/l', label: 'x', log: '/l', ...extra })

test('pytest: collected total, PASSED/FAILED/SKIPPED, summary ends it', async () => {
  let p = feed(EMPTY, 'collected 4 items\n\ntests/a.py::t1 PASSED  [ 25%]\ntests/a.py::t2 FAILED  [ 50%]\n', S())
  expect(p.runner).toBe('pytest'); expect(p.total).toBe(4); expect([p.done, p.fail]).toEqual([1, 1])
  expect(p.failures).toEqual(['tests/a.py::t2'])
  expect(percent(p, S())).toBe(50)
  p = feed(p, 'tests/a.py::t3 SKIPPED\ntests/a.py::t4 PASSED\n===== 1 failed, 2 passed, 1 skipped in 0.42s =====\n', S())
  expect([p.done, p.fail, p.skip, p.finished]).toEqual([2, 1, 1, true])
  expect(p.summary).toBe('1 failed, 2 passed, 1 skipped in 0.42s')
  expect(percent(p, S())).toBe(100)
})

test('jest, go, node:test and colour codes are recognised', async () => {
  const j = feed(EMPTY, '\x1b[32m PASS \x1b[0m src/a.test.ts\n  ✓ adds (3 ms)\n  ✕ subtracts (2 ms)\nTests:       1 failed, 1 passed, 2 total\n', S())
  expect([j.runner, j.done, j.fail, j.finished]).toEqual(['jest', 1, 1, true])
  const g = feed(EMPTY, '=== RUN   TestA\n--- PASS: TestA (0.00s)\n=== RUN   TestB\n--- FAIL: TestB (0.01s)\nFAIL\texample.com/x\t0.02s\n', S())
  expect([g.runner, g.done, g.fail, g.failures[0]]).toEqual(['go', 1, 1, 'TestB'])
  const n = feed(EMPTY, '✔ one (1ms)\n✖ two (2ms)\nℹ pass 1\n', S())
  expect([n.runner, n.done, n.fail, n.finished]).toEqual(['node:test', 1, 1, false])
})

test('anything else: own regexes, a total, or a percentage capture', async () => {
  const spec = S({ done: 'row \\d+ ok', fail: 'row \\d+ error', total: 10 })
  const p = feed(EMPTY, 'row 1 ok\nrow 2 ok\nrow 3 error: bad date\nnoise\n', spec)
  expect([p.done, p.fail, p.runner]).toEqual([2, 1, undefined])
  expect(percent(p, spec)).toBe(30)
  const q = feed(EMPTY, 'Downloading… 17/250\nDownloading… 125/250\n', S({ percent: '(\\d+/\\d+)' }))
  expect(percent(q, S({ percent: '(\\d+/\\d+)' }))).toBe(50)
  expect(percent(feed(EMPTY, 'step a\n', S()), S())).toBeUndefined()
})

const world = (on: On, files: Record<string, string>, process?: () => Promise<unknown>) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('tool.register', async () => ({ value: { tool: 'x' } }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('fs.stat', async (_$, e) => { const f = files[(e as { path: string }).path]; return (f === undefined ? { error: 'nope' } : { value: { size: new TextEncoder().encode(f).length, kind: 'file' } }) as never })
  on('process.run', async (_$, e) => {
    if (process) return await process() as never
    const [, , from, path] = (e as { argv: string[] }).argv
    return { value: { stdout: (files[path!] ?? '').slice(Number(String(from).slice(1)) - 1), stderr: '', exitCode: 0 } } as never
  })
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('ui.render', async (_$, e) => { const { Text } = _$.ui.resolve(e); return Text({ children: ['engine'] }) })
  return clock
}
const BAND = { plugin: 'live-progress', surface: 'terminal' as const, component: 'AbovePrompt' as const, requestId: 'band', props: { bodyColumns: 100, hasSurvey: false } as never }
const END = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

test('watch → band updates as the log grows → finished band lingers 3 turns', async ($, on) => {
  const files: Record<string, string> = { '/tmp/t.log': 'collected 2 items\n' }
  const clock = world(on, files)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'mcp__live-progress__watch_progress', log: '/tmp/t.log', label: 'pytest' } as never)
  expect(String((r as { result?: unknown }).result)).toContain('Watching')
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'pytest' })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /of 2/ })).toBeDefined()
  files['/tmp/t.log'] += 'tests/a.py::x PASSED\ntests/a.py::y FAILED\n'
  await clock.advance(1000)
  await band.redraw()
  expect(await band.find({ type: 'Text', text: /✗ 1/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: /tests\/a\.py::y/ })).toBeDefined()
  files['/tmp/t.log'] += '==== 1 failed, 1 passed in 0.1s ====\n'
  await clock.advance(1000)
  await band.redraw()
  expect(await band.find({ type: 'Text', text: /100%/ })).toBeDefined()
  for (let i = 0; i < 3; i++) await $.turn.complete(END)
  await band.redraw()
  expect(await band.find({ type: 'Text', text: 'pytest' })).toBeUndefined()
})

test('bad input is refused; every prompt carries the one-line guide', async ($, on) => {
  world(on, {})
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  expect(String(((await $.tool.call({ tool: 'mcp__live-progress__watch_progress', log: 'rel.log', label: 'x' } as never)) as { result?: unknown }).result)).toContain('absolute')
  expect(String(((await $.tool.call({ tool: 'mcp__live-progress__watch_progress', log: '/a.log', label: 'x', done: '(' } as never)) as { result?: unknown }).result)).toContain('not a valid regex')
})

test('Node summary failures arrive after pass and only duration ends the run', async () => {
  let p = feed(EMPTY, '✔ one\nℹ pass 1\n', S())
  expect(p.finished).toBe(false)
  p = feed(p, 'ℹ fail 2\nℹ tests 3\nℹ duration_ms 12.3\n', S())
  expect([p.done, p.fail, p.total, p.finished]).toEqual([1, 2, 3, true])
})

test('later Go packages reopen progress and cargo binary totals accumulate', async () => {
  let p = feed(EMPTY, '=== RUN TestA\n--- PASS: TestA (0.01s)\nPASS\n', S())
  expect(p.finished).toBe(true)
  p = feed(p, '=== RUN TestB\n--- FAIL: TestB (0.01s)\n', S())
  expect([p.done, p.fail, p.finished]).toEqual([1, 1, false])
  p = feed(EMPTY, 'running 2 tests\ntest a ... ok\ntest b ... ok\ntest result: ok\n', S())
  p = feed(p, 'running 1 test\ntest c ... FAILED\n', S())
  expect([p.total, p.fail, p.finished]).toEqual([3, 1, false])
})

test('watcher continues after an early package summary and preserves downstream UI', async ($, on) => {
  const files = { '/tmp/multi.log': '=== RUN TestA\n--- PASS: TestA (0.00s)\nPASS\n' }
  const clock = world(on, files)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__live-progress__watch_progress', log: '/tmp/multi.log', label: 'multi-package' } as never)
  files['/tmp/multi.log'] += '=== RUN TestB\n--- FAIL: TestB (0.01s)\n'
  await clock.advance(1000)
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: /✗ 1/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'engine' })).toBeDefined()
})

test('removing a watched job during an in-flight read does not resurrect it', async ($, on) => {
  const files: Record<string, string> = { '/tmp/race.log': '' }
  let release: (() => void) | undefined
  let entered: (() => void) | undefined
  const started = new Promise<void>(r => { entered = r })
  const clock = world(on, files, async () => {
    entered!()
    await new Promise<void>(r => { release = r })
    return { value: { stdout: 'row ok\n', stderr: '', exitCode: 0 } } as never
  })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__live-progress__watch_progress', log: '/tmp/race.log', label: 'race' } as never)
  files['/tmp/race.log'] = 'row ok\n'
  const advancing = clock.advance(1000)
  await started
  await $.tool.call({ tool: 'mcp__live-progress__stop_progress', log: '/tmp/race.log' } as never)
  release!(); await advancing
  const band = await $.ui.mount(BAND)
  expect(await band.find({ type: 'Text', text: 'race' })).toBeUndefined()
})

for (const tier of ['prepend', 'append'] as const) {
  test(`live band composes with another progress band at ${tier}`, { plugins: [{ name: 'other-band', tier,
    register(on) {
      on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
        const { Box, Text } = $.ui.resolve(e)
        return Box({ flexDirection: 'column', children: [await next(e), Text({ children: ['Goal band'] })] })
      })
    },
  }] }, async ($, on) => {
    world(on, { '/tmp/compose.log': '' })
    await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'mcp__live-progress__watch_progress', log: '/tmp/compose.log', label: 'Live band' } as never)
    const band = await $.ui.mount(BAND)
    for (const text of ['Live band', 'Goal band', 'engine']) expect(await band.find({ type: 'Text', text })).toBeDefined()
  })
}
