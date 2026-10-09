import { expect, test } from 'claude-code/testing'
import { act, pointer, type View, type ViewerProps } from '../hooks/viewer.js'

const P: ViewerProps = {
  path: 'a.ts', cursor: 1, jump: 0, height: 5, reviewed: false, threads: [{ start: 6, end: 7, mode: 'ask', text: 'why', answer: 'because', pending: false }],
  symbols: [{ name: 'outer', start: 1, end: 9 }, { name: 'inner', start: 3, end: 5 }],
  lines: Array.from({ length: 10 }, (_, i) => ({ n: i + 1, text: `line ${i + 1}`, ...(i === 3 || i === 4 || i === 7 ? { mark: 'add' as const } : {}) })),
}
const V: View = { cur: 0, anchor: null, top: 0, jump: 0, showRemoved: true, open: null }

test('moves and scrolls the window with the cursor', async () => {
  let v = V
  for (let i = 0; i < 6; i++) v = act(v, P, 5, { key: 'j' }).view!
  expect(v.cur).toBe(6)
  expect(v.top).toBe(2)
  expect(act(v, P, 5, { key: 'G' }).view!.cur).toBe(9)
  expect(act(v, P, 5, { key: 'g' }).view!.top).toBe(0)
})

test('n/p jump between change blocks, not every changed line', async () => {
  const a = act(V, P, 5, { key: 'n' }).view!
  expect(a.cur).toBe(3)
  const b = act(a, P, 5, { key: 'n' }).view!
  expect(b.cur).toBe(7) // skips 4, which continues the same block
  expect(act(b, P, 5, { key: 'p' }).view!.cur).toBe(3)
})

test('v / shift extend a selection; a and c post it as a range', async () => {
  let v = act({ ...V, cur: 2 }, P, 5, { key: 'v' }).view!
  v = act(v, P, 5, { key: 'down' }).view!
  v = act(v, P, 5, { key: 'down' }).view!
  expect(act(v, P, 5, { key: 'a' }).post).toEqual({ type: 'ask', mode: 'ask', start: 3, end: 5 })
  const s = act({ ...V, cur: 2 }, P, 5, { key: 'down', shift: true }).view!
  expect(act(s, P, 5, { key: 'c' }).post).toEqual({ type: 'ask', mode: 'change', start: 3, end: 4 })
  // with no selection, the cursor line alone
  expect(act({ ...V, cur: 1 }, P, 5, { key: 'a' }).post).toEqual({ type: 'ask', mode: 'ask', start: 2, end: 2 })
})

test('f selects the innermost enclosing function', async () => {
  const v = act({ ...V, cur: 3 }, P, 5, { key: 'f' }).view!
  expect([v.anchor, v.cur]).toEqual([2, 4])
  const w = act({ ...V, cur: 7 }, P, 5, { key: 'f' }).view!
  expect([w.anchor, w.cur]).toEqual([0, 8])
})

test('t opens the note of the thread under the cursor; navigation posts', async () => {
  expect(act({ ...V, cur: 5 }, P, 5, { key: 't' }).view!.open).toBe(0)
  expect(act({ ...V, cur: 0 }, P, 5, { key: 't' })).toEqual({})
  expect(act(V, P, 5, { key: 'h' }).post).toEqual({ type: 'back' })
  expect(act(V, P, 5, { key: ']' }).post).toEqual({ type: 'file', step: 1 })
  expect(act(V, P, 5, { key: 'r' }).post).toEqual({ type: 'reviewed' })
})

test('mouse: click places the cursor, drag selects, click again clears', async () => {
  let v = pointer({ ...V, top: 2 }, P, { type: 'down', x: 5, y: 1 })!
  expect([v.cur, v.anchor]).toEqual([3, 3])
  v = pointer(v, P, { type: 'move', x: 5, y: 3 })!
  expect([v.anchor, v.cur]).toEqual([3, 5])
  const c = pointer(pointer({ ...V }, P, { type: 'down', x: 1, y: 2 })!, P, { type: 'up', x: 1, y: 2 })!
  expect(c.anchor).toBeNull()
})
