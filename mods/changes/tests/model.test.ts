import { expect, test } from 'claude-code/testing'
import type { Edit, Model } from '../types'
import { EMPTY, addedRemoved, answerOf, assign, definedAt, firstChanged, marks, readGroupTags, record, rows, stripGroupTags, symbolAt, threadPrompt } from '../hooks/model.js'

const edit = (over: Partial<Edit>): Edit => ({ id: 'e1', turn: 1, path: '/r/a.ts', hunks: [], symbols: [], ...over })

test('finds definitions across languages', async () => {
  expect(definedAt('export async function loadThing(a) {')).toBe('loadThing')
  expect(definedAt('  const busy = async (x) => {')).toBe('busy')
  expect(definedAt('class Pane extends X {')).toBe('Pane')
  expect(definedAt('def parse_args(argv):')).toBe('parse_args')
  expect(definedAt('func (s *Server) Handle(w http.ResponseWriter) {')).toBe('Handle')
  expect(definedAt("test('waits on running agents', async () => {")).toBe('test: waits on running agents')
  expect(definedAt("  on('turn.complete', async ($, e, next) => {")).toBe('on turn.complete')
  expect(definedAt('  if (x) {')).toBeUndefined()
  expect(definedAt('  return foo(x)')).toBeUndefined()
})

test('symbolAt walks up by indentation to the enclosing definition', async () => {
  const src = [
    'export function outer() {',  // 1
    '  const a = 1',              // 2
    '  if (a) {',                 // 3
    '    doIt()',                 // 4
    '  }',                        // 5
    '}',                          // 6
    '',                           // 7
    'function second() {',        // 8
    '  return 2',                 // 9
    '}',
  ]
  expect(symbolAt(src, 4)).toBe('outer')
  expect(symbolAt(src, 9)).toBe('second')
  expect(symbolAt(src, 8)).toBe('second')
})

test('counts and first changed line', async () => {
  const h = { oldStart: 10, oldLines: 3, newStart: 10, newLines: 4, lines: [' a', '-b', '+c', '+d', ' e'] }
  expect(addedRemoved([h])).toEqual({ add: 2, del: 1 })
  expect(firstChanged(h)).toBe(11)
})

test('group tags parse, default kind, and strip', async () => {
  const t = 'done\n<change-group id="Wait Agents" kind="behaviour" title="Self-drive waits for agents" summary="Idle turns skip while agents run."/>\n<change-group title="Odd" kind="nope"/>'
  expect(readGroupTags(t)).toEqual([
    { id: 'wait-agents', kind: 'behaviour', title: 'Self-drive waits for agents', summary: 'Idle turns skip while agents run.' },
    { id: 'odd', kind: 'feature', title: 'Odd', summary: '' },
  ])
  expect(stripGroupTags(t)).toBe('done\n\n')
})

test('assign: tags route edits by file/symbol, else first tag; refresh same id', async () => {
  let m: Model = EMPTY
  m = record(m, edit({ id: 'a', path: '/r/drive.ts', symbols: ['busyAgents'] }))
  m = record(m, edit({ id: 'b', path: '/r/register.tsx', symbols: ['on turn.complete'] }))
  m = record(m, edit({ id: 'c', path: '/r/README.md' }))
  m = assign(m, 1, [
    { id: 'wait', kind: 'behaviour', title: 'Wait for agents', summary: 'busyAgents() in drive.ts' },
    { id: 'docs', kind: 'docs', title: 'Docs', summary: 'README.md notes' },
  ])
  expect(m.edits.map(e => e.group)).toEqual(['wait', 'wait', 'docs'])
  m = record(m, edit({ id: 'd', turn: 2, path: '/r/drive.ts' }))
  m = assign(m, 2, [{ id: 'wait', kind: 'behaviour', title: 'Wait for agents (v2)', summary: '' }])
  expect(m.groups.find(g => g.id === 'wait')?.title).toBe('Wait for agents (v2)')
  expect(m.groups.find(g => g.id === 'wait')?.summary).toBe('busyAgents() in drive.ts') // kept when blank
})

test('assign without tags: one fallback group per turn, named after the task', async () => {
  let m = record(EMPTY, edit({ id: 'a', turn: 3, task: 'Writing tests' }))
  m = record(m, edit({ id: 'b', turn: 3 }))
  m = assign(m, 3, [])
  expect(m.groups).toEqual([{ id: 'task-writing-tests', kind: 'feature', title: 'Writing tests', summary: '', turn: 3 }])
  expect(new Set(m.edits.map(e => e.group))).toEqual(new Set(['task-writing-tests']))
  let n = record(EMPTY, edit({ id: 'z', turn: 4 }))
  n = assign(n, 4, [])
  expect(n.groups[0]?.title).toBe('Other changes')
})

test('rows: newest group first, files merged with counts and review state', async () => {
  const h = { oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+x', '+y'] }
  let m = record(EMPTY, edit({ id: 'a', path: '/r/a.ts', hunks: [h], symbols: ['f'] }))
  m = record(m, edit({ id: 'b', path: '/r/a.ts', hunks: [h], symbols: ['g'] }))
  m = assign(m, 1, [{ id: 'one', kind: 'fix', title: 'One', summary: '' }])
  m = record(m, edit({ id: 'c', turn: 2, path: '/r/b.ts', hunks: [h] }))
  m = assign(m, 2, [{ id: 'two', kind: 'feature', title: 'Two', summary: '' }])
  m = { ...m, reviewed: ['one|/r/a.ts'] }
  const r = rows(m)
  expect(r.map(g => g.id)).toEqual(['two', 'one'])
  expect(r[1]?.files[0]).toMatchObject({ path: '/r/a.ts', add: 4, del: 0, symbols: ['f', 'g'] })
  expect(r[1]?.reviewedFiles).toBe(1)
})

test('marks map edits onto the current file, shifting for later edits', async () => {
  // edit 1 adds lines 3-4; edit 2 later inserts 2 lines at the top
  const e1 = edit({ id: '1', turn: 1, hunks: [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 3, lines: [' keep', '+n1', '+n2'] }] })
  const e2 = edit({ id: '2', turn: 2, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+top1', '+top2'] }] })
  expect([...marks([e1], [e1, e2]).added].sort()).toEqual([5, 6])
  // a removal is anchored at the line that now follows it
  const e3 = edit({ id: '3', turn: 1, hunks: [{ oldStart: 5, oldLines: 2, newStart: 5, newLines: 1, lines: [' a', '-gone', ' b'] }] })
  expect(marks([e3], [e3]).removedAt.get(6)).toEqual(['gone'])
})

test('a pointed ask carries where, what and how; answers drop tags', async () => {
  const p = threadPrompt({ id: 't', path: 'hooks/a.ts', start: 4, end: 9, mode: 'ask', text: 'why poll?', turn: 1, status: 'pending' }, 'code here', 'Wait for agents')
  expect(p.visible).toBe('❓ hooks/a.ts:4-9 — why poll?')
  expect(p.context).toContain('do not edit any file')
  expect(p.context).toContain('part of "Wait for agents"')
  const c = threadPrompt({ id: 't', path: 'a.ts', start: 4, end: 4, mode: 'change', text: 'rename it', turn: 1, status: 'pending' }, 'x')
  expect(c.visible).toBe('✎ a.ts:4 — rename it')
  expect(answerOf('Because X.\n<insight id="a" kind="why">q</insight>\n<change-group title="x"/>')).toBe('Because X.')
})

test('regression: two edits to one file in the same turn shift in the order applied, whatever their ids', async () => {
  // X inserts 2 lines at the top first; Y then edits further down. Ids sort the other way round.
  const X = edit({ id: '1-zzzz', turn: 1, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 2, lines: ['+t1', '+t2'] }] })
  const Y = edit({ id: '1-aaaa', turn: 1, hunks: [{ oldStart: 10, oldLines: 1, newStart: 10, newLines: 1, lines: ['-old', '+new'] }] })
  // recorded X then Y: X's lines are 1-2 and nothing later shifts them
  expect([...marks([X], [X, Y]).added]).toEqual([1, 2])
  // and an earlier-turn edit below the insertion is shifted down by it
  const E = edit({ id: '0-mmmm', turn: 0, hunks: [{ oldStart: 5, oldLines: 0, newStart: 5, newLines: 1, lines: ['+early'] }] })
  expect([...marks([E], [E, X, Y]).added]).toEqual([7])
})

test('regression: a reused group id becomes most recent, so the cap keeps it', async () => {
  let m: Model = EMPTY
  for (let t = 1; t <= 60; t++) {
    m = record(m, edit({ id: `e${t}`, turn: t }))
    m = assign(m, t, [{ id: t % 2 === 0 ? 'hot' : `g${t}`, kind: 'feature', title: `T${t}`, summary: '' }])
  }
  expect(m.groups.length).toBeLessThanOrEqual(24)
  expect(m.groups.at(-1)?.id).toBe('hot')
  expect(m.groups.some(g => g.id === 'g1')).toBe(false)
})
