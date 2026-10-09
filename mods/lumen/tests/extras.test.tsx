import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { flowFrames, flowGraph, ganttRows, parseGantt, segText, seqFrames, sparkline, stateToFlow, stepSpecs } from '../hooks/extras'
import { renderMermaidAscii } from '../hooks/vendor/mermaid-text.js'

const engine = (on: On) => on('ui.render', ($, e) => { const { Text } = $.ui.resolve(e); return <Text>engine</Text> })
const art = (s: string) => renderMermaidAscii(s, { useAscii: false, colorMode: 'none', paddingX: 3, paddingY: 1 }).replace(/[ \t]+$/gm, '').trimEnd().replace(/▶/g, '►').replace(/◀/g, '◄')
const mount = ($: Parameters<Parameters<typeof test>[1]>[0], text: string, onScreen: unknown = { first: 0, last: 99 }) =>
  $.ui.mount({ plugin: 'lumen', surface: 'terminal', component: 'AssistantMessage', props: { text, isFirstOfReply: true, onScreen } as never, viewport: { columns: 120, rows: 60 } })

test('sparklines scale to the series and render inline as numbers', async ($, on) => {
  expect(sparkline([1, 2, 3, 4, 5, 6, 7, 8])).toBe('▁▂▃▄▅▆▇█')
  expect(sparkline([5, 5])).toBe('▄▄')
  engine(on)
  const ui = await mount($, 'latency {spark: 3 5 9 4 12} this week')
  expect(await ui.find({ type: 'Text', text: '▁▃▆▂█' })).toBeDefined()
  await ui.unmount()
})

test('gantt: dates, after-deps, durations, tags; drawn as bars with an axis', async ($, on) => {
  const src = 'gantt\n  title Release\n  section Build\n  Design :done, d1, 2026-10-01, 3d\n  Code :active, c1, after d1, 5d\n  section Ship\n  Review :crit, 2d\n  Go live :milestone, 2026-10-12, 0d'
  const g = parseGantt(src)!
  expect(g.tasks.map(t => t.label)).toEqual(['Design', 'Code', 'Review', 'Go live'])
  expect(g.tasks[1]!.start).toBe(g.tasks[0]!.end)
  const text = segText(ganttRows(src, 70, { palette: ['a'] })!)
  expect(text).toContain('Design  ███')
  expect(text).toContain('◆ Go live')
  expect(text).toContain('10-01')
  engine(on)
  const ui = await mount($, '```mermaid\n' + src + '\n```')
  expect(await ui.find({ type: 'Text', text: /^▌ Build$/ })).toBeDefined()
  await ui.unmount()
})

test('stateDiagram becomes a flowchart with start/end circles and labelled edges', async () => {
  const f = stateToFlow('stateDiagram-v2\n  [*] --> Idle\n  Idle --> Running : start\n  Running --> [*]')!
  expect(f).toContain('_start((start))')
  expect(f).toContain('Idle -->|start| Running')
  expect(art(f)).toContain('Running')
  expect(stateToFlow('stateDiagram-v2\n  state Busy {\n  }')).toBeNull()
})

test('flow steps: explicit, %% animate, and a drawn path between the right boxes', async () => {
  const src = 'flowchart LR\n  U[Client] --> G[Gateway] --> A[Auth]\n  G --> S[Service]\n  %% step U->G "request"\n  %% step G->S "forward"'
  expect(flowGraph(src).edges.map(e => `${e.from}>${e.to}`)).toEqual(['U>G', 'G>A', 'G>S'])
  expect(stepSpecs(src)!.map(s => s.caption)).toEqual(['request', 'forward'])
  expect(stepSpecs('flowchart LR\n  A --> B')).toBeNull()
  expect(stepSpecs('flowchart LR\n  %% animate\n  A[a] -->|go| B[b]')).toEqual([{ from: 'A', to: 'B', caption: 'go' }])
  const a = art(src)
  const frames = flowFrames(a, src, stepSpecs(src)!)
  expect(frames.every(f => f.path.length > 0 && f.rects.length === 2)).toBe(true)
  const g = a.split('\n').map(l => [...l])
  for (const [r, c] of frames[1]!.path) expect(g[r]![c]).not.toBe(' ')
})

test('sequence steps follow message rows in order', async () => {
  const src = 'sequenceDiagram\n  %% animate\n  C->>G: request\n  G->>A: verify\n  A-->>G: ok'
  const frames = seqFrames(art(src), stepSpecs(src)!)
  expect(frames.map(f => f.caption)).toEqual(['request', 'verify', 'ok'])
  const rows = frames.map(f => f.path[0]![0])
  expect(rows[0]! < rows[1]! && rows[1]! < rows[2]!).toBe(true)
})

test('an animated diagram plays in a Client on screen; off screen it is drawn still', async ($, on) => {
  engine(on)
  const text = '```mermaid\nflowchart LR\n  U[Client] --> G[Gateway]\n  %% step U->G "request"\n```'
  const live = await mount($, text)
  const client = await live.find({ type: 'Client' })
  expect(String(client?.props.module)).toMatch(/anim\.tsx$/)
  expect((client?.props.props as { frames: unknown[] }).frames.length).toBe(1)
  await live.unmount()
  const still = await mount($, text, null)
  expect(await still.find({ type: 'Client' })).toBeUndefined()
  expect(await still.find({ type: 'Text', text: /Gateway/ })).toBeDefined()
  await still.unmount()
})

test('a long code block folds to 12 lines with a button that opens it', async ($, on) => {
  engine(on)
  const body = Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')
  const ui = await mount($, '```text\n' + body + '\n```')
  expect(await ui.find({ type: 'Text', text: /line 11/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /line 30/ })).toBeUndefined()
  await ui.press({ key: 'fold0' })
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /line 30/ })).toBeDefined()
  await ui.unmount()
})

test('a sequence diagram too wide for the terminal becomes a numbered message list', async ($, on) => {
  engine(on)
  const names = ['You', 'Claude Code', 'skills', 'mcp-control', 'Haiku', 'Claude']
  const src = ['sequenceDiagram', ...names.map((n, i) => `  participant P${i} as ${n}`), '  P0->>P1: press Enter', '  P1->>P3: prompt.submit with a long label here', '  P4-->>P3: WAIT 1-2s, up to 8s'].join('\n')
  const ui = await $.ui.mount({ plugin: 'lumen', surface: 'terminal', component: 'AssistantMessage', props: { text: '```mermaid\n' + src + '\n```', isFirstOfReply: true } as never, viewport: { columns: 80, rows: 60 } })
  expect(await ui.find({ type: 'Text', text: /sequenceDiagram/ })).toBeUndefined()
  const all = (await ui.findAll({ type: 'Text' })).map(t => t.text)
  expect(all).toContain(' 3  ')
  expect(all.filter(t => t === ' ──▶ ').length).toBe(2)
  expect(all.filter(t => t === ' ╌╌▷ ').length).toBe(1)
  expect(await ui.find({ type: 'Text', text: /WAIT 1-2s, up to 8s/ })).toBeDefined()
  await ui.unmount()
})

test('the hint carries the terminal width remembered from the last reply drawn', async ($, on) => {
  engine(on)
  const seen: string[] = []
  on('prompt.submit', (_, e) => { seen.push((e.context ?? []).join(' ')); return { text: e.text, context: e.context } })
  mock.env(on, {})
  const ui = await $.ui.mount({ plugin: 'lumen', surface: 'terminal', component: 'AssistantMessage', props: { text: 'hi **there**', isFirstOfReply: true } as never, viewport: { columns: 93, rows: 40 } })
  await ui.unmount()
  await $.prompt.submit({ text: 'draw me something', wait: false, origin: { kind: 'composer' } })
  expect(seen.at(-1)).toContain('The terminal is 93 columns wide.')
})
