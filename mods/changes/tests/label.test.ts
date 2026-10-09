import { expect, test } from 'claude-code/testing'
import type { Edit, Model } from '../types'
import { describeEdits, labelPrompt, parseLabels } from '../hooks/label.js'
import { EMPTY, applyLabels, assign, record, rows } from '../hooks/model.js'

const rel = (p: string) => p.replace('/repo/', '')
const ed = (o: Partial<Edit>): Edit => ({ id: 'e', turn: 1, path: '/repo/a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: [' x', '+y'] }], symbols: [], ...o })

test('the prompt lists existing concepts and asks per file', async () => {
  const p = labelPrompt('add the triage gate', describeEdits([ed({ path: '/repo/gate.py', symbols: ['prepare'] })], rel),
    [{ id: 'gate', kind: 'feature', title: 'Dense-capture triage gate', summary: 'skip full prepare on dense pcaps', turn: 1 }])
  expect(p).toContain('id=gate [feature] Dense-capture triage gate')
  expect(p).toContain('- gate.py (+1 -0) in prepare')
  expect(p).toContain('<path> => <existing-id>')
})

test('parses existing and NEW answers; drops unknown ids and stray lines', async () => {
  const paths = ['/repo/gate.py', '/repo/tests/test_gate.py', '/repo/README.md', '/repo/x.py']
  const reply = [
    'gate.py => gate',
    '- `tests/test_gate.py` => gate',
    'README.md => NEW docs-gate | docs | Document the triage gate | Explains when the gate trips.',
    'x.py => made-up-id',
    'some chatter',
  ].join('\n')
  expect(parseLabels(reply, paths, new Set(['gate']), rel)).toEqual([
    { path: '/repo/gate.py', id: 'gate', isNew: false },
    { path: '/repo/tests/test_gate.py', id: 'gate', isNew: false },
    { path: '/repo/README.md', id: 'docs-gate', isNew: true, title: 'Document the triage gate', kind: 'docs', summary: 'Explains when the gate trips.' },
  ])
})

test('later turns join an existing concept instead of making one per turn', async () => {
  let m: Model = EMPTY
  // turn 1: new concept
  m = record(m, ed({ id: 'a', turn: 1, path: '/repo/gate.py' }))
  m = assign(m, 1, [])
  m = applyLabels(m, 1, [{ path: '/repo/gate.py', id: 'gate', isNew: true, title: 'Dense-capture triage gate', kind: 'feature', summary: '' }])
  // turns 2 and 3: more work on the same thing, filed under it
  for (const t of [2, 3]) {
    m = record(m, ed({ id: `b${t}`, turn: t, path: `/repo/f${t}.py` }))
    m = assign(m, t, [])
    m = applyLabels(m, t, [{ path: `/repo/f${t}.py`, id: 'gate', isNew: false }])
  }
  const r = rows(m)
  expect(r.map(g => g.title)).toEqual(['Dense-capture triage gate'])
  expect(r[0]!.files.length).toBe(3)
  // the fallback groups those turns made are gone
  expect(m.groups.some(g => g.title === 'Other changes')).toBe(false)
})

test('one turn can split across concepts', async () => {
  let m: Model = record(EMPTY, ed({ id: 'z', turn: 1, path: '/repo/gate.py' }))
  m = assign(m, 1, [{ id: 'gate', kind: 'feature', title: 'Gate', summary: '' }])
  m = record(m, ed({ id: 'a', turn: 2, path: '/repo/gate.py' }))
  m = record(m, ed({ id: 'b', turn: 2, path: '/repo/ci.yml' }))
  m = assign(m, 2, [])
  m = applyLabels(m, 2, [
    { path: '/repo/gate.py', id: 'gate', isNew: false },
    { path: '/repo/ci.yml', id: 'ci', isNew: true, title: 'CI timeout bump', kind: 'config', summary: '' },
  ])
  expect(rows(m).map(g => [g.title, g.files.map(f => f.path)])).toEqual([
    ['CI timeout bump', ['/repo/ci.yml']],
    ['Gate', ['/repo/gate.py']],
  ])
})
