/* Local extensions to lumen (not upstream): inline sparklines, gantt timelines, state diagrams
   drawn as flowcharts, and animated steps over a drawn mermaid diagram. Pure: no engine, no JSX. */

// ── sparklines ────────────────────────────────────────────────────────────────
export const SPARK = /\{spark:\s*(-?\d+(?:\.\d+)?(?:[\s,]+-?\d+(?:\.\d+)?)*)\s*\}/g
const BARS = '▁▂▃▄▅▆▇█'
export const sparkline = (values: readonly number[]): string => {
  const v = values.slice(0, 200)
  if (v.length === 0) return ''
  const lo = Math.min(...v), hi = Math.max(...v)
  return v.map(x => BARS[hi === lo ? 3 : Math.round(((x - lo) / (hi - lo)) * 7)]).join('')
}
export const sparkValues = (body: string): number[] => body.split(/[\s,]+/).filter(Boolean).map(Number).filter(Number.isFinite)

// ── flowchart source: nodes, labels, edges ────────────────────────────────────
export type Edge = { from: string; to: string; label: string }
const NODE = /^([A-Za-z_][\w-]*)\s*(?:\(\(\s*(.*?)\s*\)\)|\(\[\s*(.*?)\s*\]\)|\[\[\s*(.*?)\s*\]\]|\[\(\s*(.*?)\s*\)\]|\[\s*(.*?)\s*\]|\(\s*(.*?)\s*\)|\{\{\s*(.*?)\s*\}\}|\{\s*(.*?)\s*\}|>\s*(.*?)\s*\])?/
const ARROW = /^\s*(?:<?(?:-{2,}|-\.+-|={2,})[->ox]?|--\s*([^-|]+?)\s*--[->]?)\s*(?:\|\s*([^|]*?)\s*\|)?\s*/
const SKIP = /^(subgraph|end|style|classDef|class|click|linkStyle|direction)\b/
const unquote = (s: string) => s.replace(/^"(.*)"$/, '$1')

export const flowGraph = (source: string): { labels: Map<string, string>; edges: Edge[] } => {
  const labels = new Map<string, string>()
  const edges: Edge[] = []
  for (const raw of source.split('\n').slice(1)) {
    const line = raw.replace(/%%.*$/, '').trim().replace(/;$/, '')
    if (!line || SKIP.test(line) || line.includes('&')) continue
    let rest = line
    const node = (): string | null => {
      const m = NODE.exec(rest)
      if (!m) return null
      const label = m.slice(2).find(x => x !== undefined)
      if (label !== undefined) labels.set(m[1]!, unquote(label))
      rest = rest.slice(m[0].length)
      return m[1]!
    }
    let prev = node()
    while (prev) {
      const a = ARROW.exec(rest)
      if (!a || a[0].trim() === '') break
      rest = rest.slice(a[0].length)
      const next = node()
      if (!next) break
      edges.push({ from: prev, to: next, label: unquote((a[2] ?? a[1] ?? '').trim()) })
      prev = next
    }
  }
  return { labels, edges }
}

// ── state diagrams → flowchart (the vendored renderer draws stateDiagram poorly) ─
export const stateToFlow = (source: string): string | null => {
  const lines = source.split('\n')
  if (!/^\s*stateDiagram(-v2)?\s*$/.test(lines[0] ?? '')) return null
  let dir = 'LR'
  const labels = new Map<string, string>()
  const order: string[] = []
  const edges: string[] = []
  const keep: string[] = []
  const id = (s: string, side: 'from' | 'to') => (s === '[*]' ? (side === 'from' ? '_start' : '_end') : s)
  const see = (s: string) => { if (!order.includes(s)) order.push(s) }
  for (const raw of lines.slice(1)) {
    const t = raw.trim()
    if (!t) continue
    if (t.startsWith('%%')) { keep.push(t.replace(/\[\*\]/g, '_start')); continue }
    let m: RegExpExecArray | null
    if ((m = /^direction\s+(LR|RL|TB|TD|BT)$/.exec(t))) { dir = m[1] === 'TB' ? 'TD' : m[1]!; continue }
    if ((m = /^state\s+"([^"]+)"\s+as\s+([\w-]+)$/.exec(t))) { labels.set(m[2]!, m[1]!); see(m[2]!); continue }
    if ((m = /^([\w-]+|\[\*\])\s*-->\s*([\w-]+|\[\*\])\s*(?::\s*(.+))?$/.exec(t))) {
      const a = id(m[1]!, 'from'), b = id(m[2]!, 'to')
      see(a); see(b)
      edges.push(m[3] ? `  ${a} -->|${m[3].trim().replace(/\|/g, '/')}| ${b}` : `  ${a} --> ${b}`)
      continue
    }
    if ((m = /^([\w-]+)\s*:\s*(.+)$/.exec(t))) { labels.set(m[1]!, m[2]!.trim()); see(m[1]!); continue }
    return null // notes, composite states, forks: leave it to the stock renderer
  }
  if (edges.length === 0) return null
  const decl = order.map(s => (s === '_start' ? '  _start((start))' : s === '_end' ? '  _end((end))' : `  ${s}[${(labels.get(s) ?? s).replace(/[[\]]/g, '')}]`))
  return [`flowchart ${dir}`, ...decl, ...edges, ...keep].join('\n')
}

// ── steps: what an animation walks through ────────────────────────────────────
export type StepSpec = { from: string; to: string; caption: string }
const STEP = /^\s*%%\s*step\s+([\w-]+)\s*-+>+\s*([\w-]+)\s*(?:"([^"]*)"|:\s*(.*?))?\s*$/
export const isSequence = (source: string) => /^\s*sequenceDiagram\b/.test(source)

/** `%% step` lines, or with `%% animate` every edge (flowchart) in source order; null: not animated. */
export const stepSpecs = (source: string): StepSpec[] | null => {
  const lines = source.split('\n')
  const explicit = lines.map(l => STEP.exec(l)).filter((m): m is RegExpExecArray => m !== null)
  const auto = lines.some(l => /^\s*%%\s*animate\b/.test(l))
  if (explicit.length === 0 && !auto) return null
  if (isSequence(source)) return seqMessages(source)
  if (explicit.length) return explicit.map(m => ({ from: m[1]!, to: m[2]!, caption: (m[3] ?? m[4] ?? '').trim() }))
  const g = flowGraph(source)
  return g.edges.map(e => ({ from: e.from, to: e.to, caption: e.label || `${g.labels.get(e.from) ?? e.from} → ${g.labels.get(e.to) ?? e.to}` }))
}

const seqMessages = (source: string): StepSpec[] =>
  source.split('\n').map(l => /^\s*([\w-]+)\s*(?:-{1,2}>>|-{1,2}>|-{1,2}[x)])\s*[+-]?\s*([\w-]+)\s*:\s*(.*)$/.exec(l))
    .filter((m): m is RegExpExecArray => m !== null)
    .map(m => ({ from: m[1]!, to: m[2]!, caption: m[3]!.trim() }))

// ── geometry of the drawn art ─────────────────────────────────────────────────
export type Cell = [number, number]
export type Rect = { r: number; c: number; r2: number; c2: number }
export type Frame = { path: Cell[]; lit: Cell[]; rects: Rect[]; caption: string }

const TL = '┌╭◯(', TR = '┐╮◯)', BL = '└╰◯(', BR = '┘╯◯)'
export const findRects = (g: string[][]): Rect[] => {
  const at = (r: number, c: number) => g[r]?.[c] ?? ''
  const out: Rect[] = []
  for (let r = 0; r < g.length; r++) for (let c = 0; c < (g[r]?.length ?? 0); c++) {
    if (!TL.includes(at(r, c)) || at(r, c) === '') continue
    let c2 = c + 1
    while (/[─┬┴┼▲▼]/.test(at(r, c2))) c2++
    if (c2 === c + 1 || !TR.includes(at(r, c2)) || at(r, c2) === '') continue
    let r2 = r + 1
    while (/[│├┤┼►◄]/.test(at(r2, c))) r2++
    if (r2 === r + 1 || !BL.includes(at(r2, c)) || at(r2, c) === '' || !BR.includes(at(r2, c2)) || at(r2, c2) === '') continue
    out.push({ r, c, r2, c2 })
  }
  return out
}
const inside = (x: Rect, r: number, c: number) => r >= x.r && r <= x.r2 && c >= x.c && c <= x.c2
const interior = (g: string[][], x: Rect) =>
  g.slice(x.r + 1, x.r2).map(row => row.slice(x.c + 1, x.c2).join('').trim()).filter(Boolean).join(' ')

const rectFor = (g: string[][], rects: Rect[], label: string): Rect | undefined => {
  const texts = rects.map(x => interior(g, x))
  const i = texts.findIndex(t => t === label)
  if (i >= 0) return rects[i]
  const j = texts.findIndex(t => t.includes(label) || (label.length > 8 && t.includes(label.slice(0, 8))))
  return j >= 0 ? rects[j] : undefined
}
const ring = (x: Rect): Cell[] => {
  const out: Cell[] = []
  for (let c = x.c; c <= x.c2; c++) out.push([x.r - 1, c], [x.r2 + 1, c])
  for (let r = x.r; r <= x.r2; r++) out.push([r, x.c - 1], [r, x.c2 + 1])
  return out
}

/** Shortest walk over drawn, non-box cells from beside box `a` to beside box `b`. */
export const pathBetween = (g: string[][], rects: Rect[], a: Rect, b: Rect): Cell[] => {
  const free = (r: number, c: number) => (g[r]?.[c] ?? ' ') !== ' ' && !rects.some(x => inside(x, r, c))
  const goal = new Set(ring(b).filter(([r, c]) => free(r, c)).map(([r, c]) => `${r},${c}`))
  const prev = new Map<string, string | null>()
  const queue: Cell[] = []
  for (const [r, c] of ring(a)) if (free(r, c) && !prev.has(`${r},${c}`)) { prev.set(`${r},${c}`, null); queue.push([r, c]) }
  for (let i = 0; i < queue.length; i++) {
    const [r, c] = queue[i]!
    const k = `${r},${c}`
    if (goal.has(k)) {
      const path: Cell[] = []
      for (let at: string | null | undefined = k; at; at = prev.get(at)) { const [y, x] = at.split(',').map(Number); path.push([y!, x!]) }
      return path.reverse()
    }
    for (const [dr, dc] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const n = `${r + dr},${c + dc}`
      if (!prev.has(n) && free(r + dr, c + dc)) { prev.set(n, k); queue.push([r + dr, c + dc]) }
    }
  }
  return []
}

/** The frames of an animated flowchart: each step's boxes and the drawn path between them. */
export const flowFrames = (art: string, source: string, steps: StepSpec[]): Frame[] => {
  const g = art.split('\n').map(l => [...l])
  const rects = findRects(g)
  const { labels } = flowGraph(source)
  return steps.map(s => {
    const a = rectFor(g, rects, labels.get(s.from) ?? s.from)
    const b = rectFor(g, rects, labels.get(s.to) ?? s.to)
    return { path: a && b && a !== b ? pathBetween(g, rects, a, b) : [], lit: [], rects: [a, b].filter((x): x is Rect => x !== undefined), caption: s.caption }
  })
}

/** The frames of an animated sequence diagram: each message's arrow row, tail to head, and its label. */
export const seqFrames = (art: string, steps: StepSpec[]): Frame[] => {
  const g = art.split('\n').map(l => [...l])
  const rects = findRects(g)
  const boxed = (r: number, c: number) => rects.some(x => inside(x, r, c))
  const rows: number[] = []
  for (let r = 0; r < g.length; r++) if (g[r]!.some((ch, c) => /[►◄]/.test(ch) && !boxed(r, c))) rows.push(r)
  const top = Math.max(-1, ...rects.filter(x => x.r === Math.min(...rects.map(y => y.r))).map(x => x.r2))
  return rows.slice(0, Math.max(steps.length, rows.length)).map((r, i) => {
    const row = g[r]!
    const head = row.findIndex((ch, c) => /[►◄]/.test(ch) && !boxed(r, c))
    const path: Cell[] = []
    const step = row[head] === '►' ? -1 : 1
    for (let c = head; c >= 0 && c < row.length && /[─╌►◄┘┐]/.test(row[c]!); c += step) path.push([r, c])
    path.reverse()
    const lit: Cell[] = []
    for (let y = (rows[i - 1] ?? top) + 1; y < r; y++) g[y]!.forEach((ch, c) => { if (/[^\s│├┤┬┴┼─┐┘╌]/.test(ch) && !boxed(y, c)) lit.push([y, c]) })
    return { path, lit, rects: [], caption: steps[i]?.caption ?? '' }
  })
}

// ── gantt timelines ───────────────────────────────────────────────────────────
export type Seg = { text: string; color?: string; dim?: boolean; bold?: boolean }
export type GanttTheme = { heading?: string; codeComment?: string; codeFlag?: string; rule?: string; palette: string[] }
type Task = { label: string; section: number; start: number; end: number; tags: Set<string>; id?: string }
const DAY = 86_400_000
const UNIT: Record<string, number> = { ms: 1, s: 1e3, m: 6e4, h: 3.6e6, d: DAY, w: 7 * DAY }
const DATE = /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/
const TAGS = new Set(['done', 'active', 'crit', 'milestone'])
const KEYWORDS = /^(title|dateFormat|axisFormat|tickInterval|excludes|includes|todayMarker|weekday|section)\b/

export const parseGantt = (source: string): { title: string; sections: string[]; tasks: Task[]; dated: boolean } | null => {
  const lines = source.split('\n')
  if (!/^\s*gantt\s*$/.test(lines[0] ?? '')) return null
  let title = ''
  let dated = false
  const sections: string[] = []
  const tasks: Task[] = []
  const byId = new Map<string, Task>()
  const time = (x: string, fallback: number): number => {
    const after = /^after\s+(.+)$/.exec(x)
    if (after) return Math.max(...after[1]!.split(/\s+/).map(id => byId.get(id)?.end ?? NaN))
    if (DATE.test(x)) { dated = true; return Date.parse(x.replace(' ', 'T') + (x.length > 10 ? 'Z' : 'T00:00Z')) }
    if (/^\d+(\.\d+)?$/.test(x)) return Number(x) * DAY
    return fallback
  }
  const endOf = (x: string, start: number): number => {
    const d = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)$/.exec(x)
    if (d) return start + Number(d[1]) * UNIT[d[2]!]!
    if (DATE.test(x)) { dated = true; return Date.parse(x.replace(' ', 'T') + (x.length > 10 ? 'Z' : 'T00:00Z')) }
    if (/^\d+(\.\d+)?$/.test(x)) return start + Number(x) * DAY
    return NaN
  }
  for (const raw of lines.slice(1)) {
    const t = raw.replace(/%%.*$/, '').trim()
    if (!t) continue
    let m: RegExpExecArray | null
    if ((m = /^title\s+(.+)$/.exec(t))) { title = m[1]!; continue }
    if ((m = /^section\s+(.+)$/.exec(t))) { sections.push(m[1]!); continue }
    if (KEYWORDS.test(t)) continue
    if (!(m = /^(.+?)\s*:\s*(.*)$/.exec(t))) continue
    const items = m[2]!.split(',').map(s => s.trim()).filter(Boolean)
    const tags = new Set<string>()
    while (items.length && TAGS.has(items[0]!)) tags.add(items.shift()!)
    const prevEnd = tasks.at(-1)?.end ?? 0
    let id: string | undefined, start: number, end: number
    if (items.length === 0) { start = prevEnd; end = start + DAY }
    else if (items.length === 1) { start = prevEnd; end = endOf(items[0]!, start) }
    else if (items.length === 2) { start = time(items[0]!, prevEnd); end = endOf(items[1]!, start) }
    else { id = items[0]; start = time(items[1]!, prevEnd); end = endOf(items[2]!, start) }
    if (tags.has('milestone')) end = start
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) continue
    const task: Task = { label: m[1]!.trim(), section: Math.max(0, sections.length - 1), start, end, tags, ...(id ? { id } : {}) }
    tasks.push(task)
    if (id) byId.set(id, task)
  }
  if (sections.length === 0) sections.push('')
  return tasks.length ? { title, sections, tasks, dated } : null
}

const human = (ms: number): string => {
  if (ms === 0) return ''
  for (const [u, n] of [['w', 7 * DAY], ['d', DAY], ['h', 3.6e6], ['m', 6e4], ['s', 1e3]] as const)
    if (ms >= n && ms % n === 0) return `${ms / n}${u}`
  return ms >= DAY ? `${Math.round(ms / DAY)}d` : `${Math.round(ms / 3.6e6)}h`
}
const stamp = (t: number, dated: boolean, span: number): string => {
  if (!dated) return `day ${Math.round(t / DAY)}`
  const iso = new Date(t).toISOString()
  return span < 2 * DAY ? iso.slice(11, 16) : iso.slice(5, 10)
}

/** Gantt rows as coloured segments, sized to `columns`; null when the source is not a gantt chart. */
export const ganttRows = (source: string, columns: number, th: GanttTheme): Seg[][] | null => {
  const g = parseGantt(source)
  if (!g) return null
  const t0 = Math.min(...g.tasks.map(t => t.start)), t1 = Math.max(...g.tasks.map(t => t.end))
  const span = Math.max(1, t1 - t0)
  const labelW = Math.max(6, Math.min(Math.max(...g.tasks.map(t => t.label.length)), Math.floor(columns * 0.35), 30))
  const barW = Math.max(10, columns - labelW - 10)
  const x = (t: number) => Math.round(((t - t0) / span) * barW)
  const rows: Seg[][] = []
  if (g.title) rows.push([{ text: g.title, color: th.heading, bold: true }])
  let section = -1
  for (const task of g.tasks) {
    const hue = th.palette[task.section % th.palette.length]
    if (task.section !== section && (g.sections.length > 1 || g.sections[0])) {
      section = task.section
      rows.push([{ text: `▌ ${g.sections[section]}`, color: hue, bold: true }])
    }
    const label = task.label.length > labelW ? task.label.slice(0, labelW - 1) + '…' : task.label.padEnd(labelW)
    const a = Math.min(barW - 1, x(task.start))
    const color = task.tags.has('crit') ? th.codeFlag : hue
    const dim = task.tags.has('done')
    if (task.tags.has('milestone')) {
      rows.push([{ text: label + ' ' }, { text: ' '.repeat(a) }, { text: '◆', color, bold: true }, { text: ' ' + label.trim(), color: th.codeComment }])
      continue
    }
    const b = Math.max(a + 1, Math.min(barW, x(task.end)))
    rows.push([
      { text: label + ' ' },
      { text: ' '.repeat(a) },
      { text: '█'.repeat(b - a), color, dim, bold: task.tags.has('active') },
      { text: ' ' + human(task.end - task.start) + (task.tags.has('done') ? ' ✓' : task.tags.has('active') ? ' ◂' : ''), color: th.codeComment },
    ])
  }
  const left = stamp(t0, g.dated, span), right = stamp(t1, g.dated, span)
  rows.push([{ text: ' '.repeat(labelW + 1) }, { text: '└' + '─'.repeat(barW - 1), color: th.rule }])
  rows.push([{ text: ' '.repeat(labelW + 1) }, { text: left + ' '.repeat(Math.max(1, barW - left.length - right.length)) + right, color: th.codeComment }])
  return rows
}
export const segText = (rows: Seg[][]): string => rows.map(r => r.map(s => s.text).join('').trimEnd()).join('\n')

// ── a sequence diagram too wide for the terminal, drawn as a numbered message list ─────────
export type SeqRow = { n: number; from: string; to: string; text: string; reply: boolean }
export const seqRows = (source: string): SeqRow[] | null => {
  if (!isSequence(source)) return null
  const names = new Map<string, string>()
  for (const l of source.split('\n')) { const m = /^\s*(?:participant|actor)\s+([\w-]+)(?:\s+as\s+(.+))?$/.exec(l); if (m) names.set(m[1]!, (m[2] ?? m[1]!).trim()) }
  const rows: SeqRow[] = []
  for (const l of source.split('\n')) {
    const m = /^\s*(\w+)\s*(--?)(>>|>|x|\))\s*[+-]?\s*(\w+)\s*:\s*(.*)$/.exec(l)
    if (m) rows.push({ n: rows.length + 1, from: names.get(m[1]!) ?? m[1]!, to: names.get(m[4]!) ?? m[4]!, text: m[5]!.trim(), reply: m[2] === '--' })
  }
  return rows.length ? rows : null
}
