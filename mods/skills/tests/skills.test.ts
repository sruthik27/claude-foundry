import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import { EMPTY, hintLine, isRealPrompt, markLoaded, parseSuggestions, suggestPrompt } from '../hooks/suggest.js'

test('only typed prompts count', async () => {
  expect(isRealPrompt('add a retry to the pcap upload please')).toBe(true)
  expect(isRealPrompt('/clear')).toBe(false)
  expect(isRealPrompt('<task-notification>x</task-notification>')).toBe(false)
  expect(isRealPrompt('Self-drive is still on and I am away')).toBe(false)
  expect(isRealPrompt('ok')).toBe(false)
})

test('prompt lists skills; parser keeps known names only, max 3', async () => {
  expect(suggestPrompt('debug it', [{ name: 'superpowers:systematic-debugging', description: 'Use for bugs' }])).toContain('- superpowers:systematic-debugging: Use for bugs')
  const known = new Set(['a', 'superpowers:tdd', 'c', 'd'])
  expect(parseSuggestions('1. `superpowers:tdd` | tests first\nmade-up | nope\na | fits\nc | x\nd | y', known))
    .toEqual([{ name: 'superpowers:tdd', why: 'tests first' }, { name: 'a', why: 'fits' }, { name: 'c', why: 'x' }])
  expect(parseSuggestions('NONE', known)).toEqual([])
})

test('hint line: unloaded picks as slash commands, shortened to fit, gone when empty', async () => {
  const m = { ...EMPTY, suggestions: [{ name: 'gravity-ui-dev', why: '' }, { name: 'superpowers:systematic-debugging', why: '' }] }
  expect(hintLine(m, 100)).toBe('◇ /gravity-ui-dev · /superpowers:systematic-debugging')
  expect(hintLine(m, 45)).toBe('◇ /gravity-ui-dev · /systematic-debugging')
  expect(hintLine(m, 20)!.length).toBeLessThanOrEqual(20)
  expect(hintLine(markLoaded(markLoaded(m, 'gravity-ui-dev'), 'superpowers:systematic-debugging'), 100)).toBeUndefined()
  expect(hintLine({ ...EMPTY, pending: true }, 100)).toBe('◇ picking skills…')
  expect(hintLine(EMPTY, 100)).toBeUndefined()
})

const SKILLS = [
  { name: 'superpowers:systematic-debugging', description: 'Use for bugs and test failures', source: 'plugin' },
  { name: 'gravity-ui-dev', description: 'Use for UI component work', source: 'user' },
  { name: 'clear', description: 'Clear the conversation', source: 'builtin' },
]
let clock: ReturnType<typeof mock.clock>
const world = (on: On, reply: string, registered: unknown[] = []) => {
  clock = mock.clock(on, { now: 0 })
  mock.store(on)
  on('session.id', async () => ({ value: 's1' }) as never)
  on('command.register', async (_$, e) => { registered.push(e); return { value: {} } as never })
  on('command.list', async () => ({ value: SKILLS }) as never)
  on('model.complete', async () => ({ value: { isAnswered: true, text: reply, usage: {} } }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  on('tool.call', async () => ({ result: 'loaded' }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
}
const HINT = { plugin: 'skills', surface: 'terminal' as const, component: 'PromptHint' as const, requestId: 'h', props: { isDraft: false, isWorking: false, hint: '? for shortcuts' } as never }

test('picks show live in the hint row and drop out once Claude loads one; no command', async ($, on) => {
  const registered: unknown[] = []
  world(on, 'superpowers:systematic-debugging | bug\ngravity-ui-dev | UI\nclear | nope', registered)
  on('ui.render', async (_$, e) => { const { Text } = _$.ui.resolve(e); return Text({ children: [String((e.props as { tail?: string }).tail ?? '')] }) })
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  expect(registered).toEqual([])
  await $.prompt.submit({ text: 'the results table renders badly, fix it' } as never)
  await clock.advance(0)
  const hint = await $.ui.mount(HINT)
  expect(await hint.find({ type: 'Text', text: '◇ /superpowers:systematic-debugging · /gravity-ui-dev' })).toBeDefined()
  await $.tool.call({ tool: 'Skill', skill: 'superpowers:systematic-debugging' } as never)
  await hint.redraw()
  expect(await hint.find({ type: 'Text', text: '◇ /gravity-ui-dev' })).toBeDefined()
})
