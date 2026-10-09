/* A Client surface module: the pointable code viewer. Runs on the drawing thread with no $;
   keys and the mouse move a cursor and selection, and actions are posted to the hooks module. */
import type { ClientKeyEvent, ClientModule, ClientPointerEvent, ClientSurface, RenderElement } from 'claude-code'

export type ViewerLine = { n: number; text: string; mark?: 'add' | 'mod'; removed?: string[] }
export type ViewerThread = { start: number; end: number; mode: 'ask' | 'change'; text: string; answer?: string; pending: boolean }
export type ViewerProps = {
  path: string
  lines: ViewerLine[]
  /** 1-based line to put the cursor on whenever `jump` changes. */
  cursor: number
  jump: number
  symbols: { name: string; start: number; end: number }[]
  threads: ViewerThread[]
  height: number
  reviewed: boolean
}
export type View = { cur: number; anchor: number | null; top: number; jump: number; showRemoved: boolean; open: number | null }
/** The listeners outlive one draw: they read the newest props and size through this. */
type State = View & { live: { p: ViewerProps; h: number } }

const C = {
  add: '#34d399', addBg: '#0f2e24', del: '#f87171', delBg: '#2e1215', sel: '#2b3350', cur: '#3b4470',
  gutter: '#5b6170', ask: '#60a5fa', change: '#fbbf24', dim: '#7c8191', thread: '#a78bfa',
}

const indexOf = (p: ViewerProps, n: number): number => {
  const f = p.lines.findIndex(l => l.n >= n)
  return f === -1 ? Math.max(0, p.lines.length - 1) : f
}
const isMarked = (l: ViewerLine | undefined) => !!(l && (l.mark || l.removed))
const symbolAt = (p: ViewerProps, n: number) =>
  [...p.symbols].filter(y => y.start <= n && n <= y.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]

/** One key: the next view, or a message for the hooks module. Pure, so it is easy to reason about. */
export function act(v: View, p: ViewerProps, h: number, k: ClientKeyEvent): { view?: View; post?: Record<string, unknown> } {
  const last = Math.max(0, p.lines.length - 1)
  const lo = Math.min(v.cur, v.anchor ?? v.cur), hi = Math.max(v.cur, v.anchor ?? v.cur)
  const move = (to: number, keep: boolean): View => {
    const cur = Math.max(0, Math.min(last, to))
    const top = cur < v.top ? cur : cur >= v.top + h ? cur - h + 1 : v.top
    return { ...v, cur, top, anchor: keep ? (v.anchor ?? v.cur) : null }
  }
  const sel = { start: p.lines[lo]?.n ?? 1, end: p.lines[hi]?.n ?? 1 }
  const extend = !!k.shift || v.anchor !== null
  switch (k.key) {
    case 'up': case 'k': return { view: move(v.cur - 1, extend) }
    case 'down': case 'j': return { view: move(v.cur + 1, extend) }
    case 'pageup': return { view: move(v.cur - h + 2, extend) }
    case 'pagedown': case ' ': return { view: move(v.cur + h - 2, extend) }
    case 'home': case 'g': return { view: move(0, false) }
    case 'end': case 'G': return { view: move(last, false) }
    case 'v': return { view: { ...v, anchor: v.anchor === null ? v.cur : null } }
    case 'n': {
      for (let i = v.cur + 1; i <= last; i++) if (isMarked(p.lines[i]) && !isMarked(p.lines[i - 1])) return { view: move(i, false) }
      return {}
    }
    case 'p': case 'N': {
      for (let i = v.cur - 1; i >= 0; i--) if (isMarked(p.lines[i]) && !isMarked(p.lines[i - 1])) return { view: move(i, false) }
      return {}
    }
    case 'f': {
      const sym = symbolAt(p, p.lines[v.cur]?.n ?? 1)
      if (!sym) return {}
      const a = indexOf(p, sym.start), b = indexOf(p, sym.end)
      return { view: { ...v, anchor: a, cur: b, top: Math.min(a, Math.max(v.top, b - h + 1)) } }
    }
    case 'x': return { view: { ...v, showRemoved: !v.showRemoved } }
    case 't': case 'return': {
      const n = p.lines[v.cur]?.n ?? 0
      const i = p.threads.findIndex(t => t.start <= n && n <= t.end)
      if (i === -1) return {}
      return { view: { ...v, open: v.open === i ? null : i } }
    }
    case 'a': return { post: { type: 'ask', mode: 'ask', ...sel }, view: { ...v, anchor: null } }
    case 'c': return { post: { type: 'ask', mode: 'change', ...sel }, view: { ...v, anchor: null } }
    case 'r': return { post: { type: 'reviewed' } }
    case 'left': case 'h': case 'backspace': return { post: { type: 'back' } }
    case ']': return { post: { type: 'file', step: 1 } }
    case '[': return { post: { type: 'file', step: -1 } }
  }
  return {}
}

export function pointer(v: View, p: ViewerProps, e: ClientPointerEvent): View | undefined {
  const i = Math.max(0, Math.min(p.lines.length - 1, v.top + e.y))
  if (e.type === 'down') return { ...v, cur: i, anchor: i }
  if (e.type === 'move' && v.anchor !== null) return { ...v, cur: i }
  if (e.type === 'up' && v.anchor === i && v.cur === i) return { ...v, anchor: null }
  return undefined
}

export const Viewer: ClientModule<ViewerProps, State> = (props, s: ClientSurface<State>) => {
  const { Box, Text } = s.elements
  const height = Math.max(4, Math.min(props.height, s.rows || props.height))
  let st = s.state
  const live = st?.live ?? { p: props, h: height }
  live.p = props
  live.h = height

  if (!st) {
    const cur = indexOf(props, props.cursor)
    st = { cur, anchor: null, top: Math.max(0, cur - Math.floor(height / 3)), jump: props.jump, showRemoved: true, open: null, live }
    s.setState(st)
    s.onKey(k => {
      const now = s.state
      if (!now) return
      const r = act(now, now.live.p, now.live.h, k)
      if (r.view) s.setState({ ...r.view, live: now.live })
      if (r.post) s.post(r.post as never)
    })
    s.onPointer(e => {
      const now = s.state
      if (!now) return
      const v = pointer(now, now.live.p, e)
      if (v) s.setState({ ...v, live: now.live })
    })
  } else if (st.jump !== props.jump) {
    // a file switch or a landed change: put the cursor where the hooks module says
    const cur = indexOf(props, props.cursor)
    st = { ...st, cur, anchor: null, top: Math.max(0, cur - Math.floor(height / 3)), jump: props.jump, open: null }
    s.setState(st)
  }

  const v = st
  const lo = Math.min(v.cur, v.anchor ?? v.cur), hi = Math.max(v.cur, v.anchor ?? v.cur)
  const width = Math.max(20, s.columns || 80)
  const gw = String(props.lines.at(-1)?.n ?? 1).length
  const codeW = Math.max(8, width - gw - 5)
  const out: RenderElement[] = []
  let used = 0
  for (let i = v.top; i < props.lines.length && used < height; i++) {
    const l = props.lines[i]!
    if (v.showRemoved && l.removed?.length) {
      for (const r of l.removed.slice(0, 4)) {
        if (used >= height) break
        out.push(
          <Box key={`d${i}-${used}`} flexDirection="row">
            <Text color={C.del}>{`${' '.repeat(gw + 1)}−│ `}</Text>
            <Text color={C.del} backgroundColor={C.delBg} wrap="truncate-end">{r.replace(/\t/g, '  ').slice(0, codeW)}</Text>
          </Box>,
        )
        used++
      }
      if (l.removed.length > 4 && used < height) {
        out.push(<Text key={`dm${i}`} color={C.del} dimColor>{`${' '.repeat(gw + 4)}… ${l.removed.length - 4} more removed`}</Text>)
        used++
      }
    }
    if (used >= height) break
    const inSel = i >= lo && i <= hi && v.anchor !== null
    const isCur = i === v.cur
    const bg = isCur ? C.cur : inSel ? C.sel : l.mark ? C.addBg : undefined
    const ti = props.threads.findIndex(t => t.end === l.n)
    out.push(
      <Box key={`l${i}`} flexDirection="row">
        <Text color={inSel || isCur ? C.change : C.gutter}>{`${inSel || isCur ? '▌' : ' '}${String(l.n).padStart(gw)}`}</Text>
        <Text color={l.mark ? C.add : C.gutter} bold={!!l.mark}>{`${l.mark ? '+' : ' '}│ `}</Text>
        <Text backgroundColor={bg} wrap="truncate-end">{(l.text.replace(/\t/g, '  ') || ' ').slice(0, codeW)}</Text>
        {ti !== -1 && <Text color={props.threads[ti]!.mode === 'ask' ? C.ask : C.change}>{props.threads[ti]!.pending ? ' ⧗' : ' ●'}</Text>}
      </Box>,
    )
    used++
    if (ti !== -1 && (v.open === ti || props.threads[ti]!.pending) && used < height) {
      const t = props.threads[ti]!
      const color = t.mode === 'ask' ? C.ask : C.change
      const wrapW = Math.max(10, width - gw - 8)
      const body = (t.pending ? [`${t.mode === 'ask' ? 'Asking' : 'Changing'}…`] : (t.answer ?? '').split('\n'))
        .flatMap(x => (x === '' ? [''] : x.match(new RegExp(`.{1,${wrapW}}`, 'g')) ?? ['']))
      const room = Math.max(1, Math.min(10, height - used - 3))
      out.push(
        <Box key={`t${i}`} flexDirection="column" borderStyle="round" borderColor={color} marginLeft={gw + 2}>
          <Text color={color} bold wrap="truncate-end">{`${t.mode === 'ask' ? '❓' : '✎'} ${t.text}`}</Text>
          {body.slice(0, room).map((x, j) => <Text key={`tb${j}`} wrap="truncate-end">{x}</Text>)}
          {body.length > room && <Text dimColor>{`… ${body.length - room} more lines in the transcript`}</Text>}
        </Box>,
      )
      used += Math.min(body.length, room) + 3
    }
  }
  const selN = hi - lo + 1
  const curLine = props.lines[v.cur]?.n ?? 0
  const sym = symbolAt(props, curLine)
  const onThread = props.threads.some(t => t.start <= curLine && curLine <= t.end)
  return (
    <Box flexDirection="column">
      {out}
      <Box flexDirection="row" columnGap={2}>
        <Text color={v.anchor !== null ? C.change : C.dim}>{v.anchor !== null ? `▌ ${selN} line${selN > 1 ? 's' : ''} selected · a ask · c change` : `line ${curLine}/${props.lines.at(-1)?.n ?? 0}`}</Text>
        {sym && <Text color={C.thread}>{`ƒ ${sym.name}`}</Text>}
        {onThread && v.anchor === null && <Text color={C.ask}>t note</Text>}
        {props.reviewed && <Text color={C.add}>✔ reviewed</Text>}
      </Box>
    </Box>
  )
}

export default Viewer
