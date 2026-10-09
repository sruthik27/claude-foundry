import { expect, mock, test } from 'claude-code/testing'
import { cap, extract, grouped, merge, strip, toMarkdown, worthExtracting } from '../hooks/parse.js'

test('reads set and drop tags; unknown kinds become fact; slug when no id', async () => {
  const reply = '<insight id="vlan1" kind="why">2920 VLAN 1 is a dead end.</insight>\n<insight id="old" drop/>\n<insight kind="bogus">Odd kind.</insight>'
  expect(extract(reply, 3)).toEqual([
    { op: 'set', insight: { id: 'vlan1', turn: 3, kind: 'why', text: '2920 VLAN 1 is a dead end.', weight: 3 } },
    { op: 'drop', id: 'old' },
    { op: 'set', insight: { id: 'odd-kind', turn: 3, kind: 'fact', text: 'Odd kind.', weight: 3 } },
  ])
  expect(extract('No tags here.', 1)).toEqual([])
})

test('same id rewrites in place, drop removes, new id appends', async () => {
  const a = { id: 'a', turn: 1, kind: 'decision' as const, text: 'Use mutex.' }
  const b = { id: 'b', turn: 1, kind: 'fact' as const, text: 'B.' }
  const out = merge([a, b], [
    { op: 'set', insight: { id: 'a', turn: 4, kind: 'decision', text: 'Use mutex, not channel: simpler under contention.' } },
    { op: 'drop', id: 'b' },
    { op: 'set', insight: { id: 'c', turn: 4, kind: 'concept', text: 'C.' } },
  ])
  expect(out.map(i => i.id).sort()).toEqual(['a', 'c'])
  expect(out.find(i => i.id === 'a')).toEqual({ id: 'a', turn: 4, kind: 'decision', text: 'Use mutex, not channel: simpler under contention.', revised: true, hits: 2 })
})

test('groups in fixed section order and strips tags', async () => {
  const list = [
    { id: 'g', turn: 1, kind: 'gotcha' as const, text: 'G.' },
    { id: 'c', turn: 1, kind: 'concept' as const, text: 'C.' },
  ]
  expect(grouped(cap(list)).map(g => g.kind)).toEqual(['concept', 'gotcha'])
  expect(toMarkdown(list)).toBe('CONCEPT\n- C.\n\nGOTCHA\n- G.\n')
  expect(strip('a\n<insight id="x" drop/>\nb')).toBe('a\n\nb')
})

test('turn.complete updates the pane in place and ignores subagents', async ($, on) => {
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  mock.env(on, {})
  mock.store(on)
  const done = (answer: string, agentId?: string) =>
    $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', ...(agentId ? { agentId } : {}) })
  await done('<insight id="lock" kind="decision">Picked a mutex.</insight>')
  await done('<insight id="lock" kind="decision">Picked a mutex over a channel.</insight>')
  await done('<insight id="sub" kind="fact">sub</insight>', 'a1')
  const ui = await $.ui.mount({ plugin: 'insight-pane', surface: 'terminal', component: 'Pane', requestId: 'insight-pane', props: { title: 'x', isFocused: false, bodyColumns: 50 } as never })
  expect(await ui.find({ type: 'Text', text: /DECISIONS/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '1/10' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /mutex over a channel/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^sub$/ })).toBeUndefined()
})

test('cards survive a turn even where no pane can open', async ($, on) => {
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  mock.env(on, {})
  mock.store(on)
  await $.turn.complete({ answer: '<insight id="k" kind="fact">Saved before exit.</insight>', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  const ui = await $.ui.mount({ plugin: 'insight-pane', surface: 'terminal', component: 'Pane', requestId: 'insight-pane', props: { title: 'x', isFocused: false, bodyColumns: 50 } as never })
  expect(await ui.find({ type: 'Text', text: /Saved before exit/ })).toBeDefined()
})

test('weight 1 is rejected outright', async () => {
  expect(extract('<insight id="t" kind="fact" weight="1">trivia</insight>', 1)).toEqual([])
})

test('a full section keeps its top 10 by rank, best first', async () => {
  const many = Array.from({ length: 12 }, (_, n) => ({ id: `f${n}`, turn: n, kind: 'fact' as const, text: `F${n}`, weight: n < 2 ? 2 : 4 }))
  const kept = cap(many)
  expect(kept.length).toBe(10)
  expect(kept.some(i => i.weight === 2)).toBe(false)
  // a weight-5 newcomer goes to the top and evicts the weakest remaining
  const after = merge(kept, [{ op: 'set', insight: { id: 'big', turn: 20, kind: 'fact', text: 'Core.', weight: 5 } }])
  expect(after.length).toBe(10)
  expect(after[0]?.id).toBe('big')
})

test('re-confirmed cards outrank equal-weight ones', async () => {
  const a = { id: 'a', turn: 1, kind: 'gotcha' as const, text: 'A', weight: 3, hits: 3 }
  const b = { id: 'b', turn: 9, kind: 'gotcha' as const, text: 'B', weight: 3 }
  expect(cap([b, a]).map(i => i.id)).toEqual(['a', 'b'])
})


test('fallback runs only for turns that did work', async () => {
  expect(worthExtracting('ok', 5)).toBe(false)
  expect(worthExtracting(Array(60).fill('word').join(' '), 3)).toBe(true)
  expect(worthExtracting(Array(60).fill('word').join(' '), 0)).toBe(false)
  expect(worthExtracting(Array(300).fill('word').join(' '), 0)).toBe(true)
})

test('a working turn with no cards gets them from one small call; tagged turns make none', async ($, on) => {
  let calls = 0
  mock.env(on, {})
  mock.store(on)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('turn.start', async (_$, e) => e as never)
  on('model.complete', async () => { calls++; return { value: { isAnswered: true, text: '<insight id="dense-gate" kind="decision" weight="4">Dense pcaps get a quick triage instead of the 8-minute prepare.</insight>', usage: {} } } as never })
  const long = Array(80).fill('analysis').join(' ')
  await $.turn.start({ text: 'handle dense captures', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.turn.complete({ answer: long, durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  expect(calls).toBe(1)
  const ui = await $.ui.mount({ plugin: 'insight-pane', surface: 'terminal', component: 'Pane', requestId: 'insight-pane', props: { title: 'x', isFocused: false, bodyColumns: 80 } as never })
  expect(await ui.find({ type: 'Text', text: /quick triage instead/ })).toBeDefined()
  await $.turn.start({ text: 'more', turnId: 't2' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await $.turn.complete({ answer: long + ' <insight id="x" kind="fact" weight="3">Tagged by Claude.</insight>', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(calls).toBe(1)
})

test('regression: tags named in prose or code are not cards, and cards are capped', async () => {
  const reply = 'No `<insight>` tags either. Lots of prose here.\nMore: `<insight id="ex" kind="fact">example</insight>`\n<insight id="real" kind="why" weight="4">The real card.</insight>'
  expect(extract(reply, 1).map(o => (o.op === 'set' ? o.insight.id : o.id))).toEqual(['real'])
  const long = 'Sentence one is here. ' + 'word '.repeat(120)
  const got = extract(`<insight id="l" kind="fact">${long}</insight>`, 1)[0]
  expect(got?.op === 'set' && got.insight.text.length <= 300).toBe(true)
})

test('regression: code inside a card is kept', async () => {
  const got = extract('<insight id="t" kind="decision" weight="4">Tools live in `tools/*.py` modules with `HANDLERS` and `ENUM`, not in `server.py`.</insight>', 1)[0]
  expect(got?.op === 'set' && got.insight.text).toBe('Tools live in `tools/*.py` modules with `HANDLERS` and `ENUM`, not in `server.py`.')
})

test('a risk resolved in a later turn is dropped by the small call', async ($, on) => {
  let replyText = '<insight id="no-retry" kind="risk" weight="4">Uploads have no retry; a network blip loses the file.</insight>'
  mock.env(on, {})
  mock.store(on)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: 'ok' }) as never)
  on('turn.start', async (_$, e) => e as never)
  on('model.complete', async () => ({ value: { isAnswered: true, text: replyText, usage: {} } }) as never)
  const long = Array(80).fill('work').join(' ')
  const turnOf = async (id: string) => {
    await $.turn.start({ text: 'go', turnId: id } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
    await $.turn.complete({ answer: long, durationMs: 1, isAborted: false, turnId: id, reason: 'answer' })
  }
  await turnOf('t1')
  const PANE = { plugin: 'insight-pane', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'insight-pane', props: { title: 'x', isFocused: false, bodyColumns: 80 } as never }
  let ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /no retry/ })).toBeDefined()
  await ui.unmount()
  replyText = '<insight id="no-retry" drop/>'
  await turnOf('t2')
  ui = await $.ui.mount(PANE)
  expect(await ui.find({ type: 'Text', text: /no retry/ })).toBeUndefined()
})

test('a section folds to its header and first line, and unfolds', async ($, on) => {
  mock.env(on, {})
  mock.store(on)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  const done = (answer: string) => $.turn.complete({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' })
  await done('<insight id="a" kind="risk" weight="4">First risk.</insight>\n<insight id="b" kind="risk" weight="3">Second risk.</insight>')
  const ui = await $.ui.mount({ plugin: 'insight-pane', surface: 'terminal', component: 'Pane', requestId: 'insight-pane', props: { title: 'x', isFocused: true, bodyColumns: 80 } as never })
  expect(await ui.find({ type: 'Text', text: 'Second risk.' })).toBeDefined()
  await ui.press({ key: 'fold-risk' })
  expect(await ui.find({ type: 'Text', text: 'Second risk.' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'First risk.' })).toBeUndefined() // nothing of a folded section shows
  expect(await ui.find({ type: 'Text', text: '2 hidden' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: '▸' })).toBeDefined()
  await ui.press({ key: 'fold-risk' })
  expect(await ui.find({ type: 'Text', text: 'Second risk.' })).toBeDefined()
})

test('regression: a card whose text contains < is read and stripped', async () => {
  const t = '<insight id="r" kind="gotcha" weight="5">move each `defs/<tool>.py` change into `server.py`.</insight>'
  const got = extract(t, 1)[0]
  expect(got?.op === 'set' && got.insight.text).toBe('move each `defs/<tool>.py` change into `server.py`.')
  expect(strip(t).trim()).toBe('')
})

test('quoted insight examples survive stripping and never become cards', async () => {
  for (const code of ['`<insight id="demo" kind="fact">example</insight>`', '``<insight id="demo">uses `code`</insight>``', '~~~xml\n<insight id="demo">example</insight>\n~~~']) {
    expect(strip(code)).toBe(code)
    expect(extract(code, 1)).toEqual([])
  }
  const text = '`<insight id="demo">example</insight>` <insight id="real">real</insight>'
  expect(strip(text)).toBe('`<insight id="demo">example</insight>` ')
  expect(extract(text, 1).length).toBe(1)
})

test('resume restores cards from the selected session; clear resets them', async ($, on) => {
  on('session.id', async () => ({ value: 'second' }) as never)
  on('store.get', async (_$, e) => ({ value: e.key === 'cards:second' ? [{ id: 'restored', kind: 'fact', text: 'Restored card', weight: 3, turn: 9 }] : undefined }) as never)
  on('classic.SessionStart', async () => ({}))
  on('ui.status', async () => ({ value: undefined }) as never)
  await $.classic.SessionStart({ source: 'resume' })
  const ui = await $.ui.mount({ plugin: 'insight-pane', surface: 'terminal', component: 'Pane', requestId: 'insight-pane', props: { title: 'x', isFocused: false, bodyColumns: 80 } as never })
  expect(await ui.find({ type: 'Text', text: /Restored card/ })).toBeDefined()
  await $.classic.SessionStart({ source: 'clear' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /Restored card/ })).toBeUndefined()
})
