/* Local extension: a Client surface module that plays an animated mermaid diagram. It walks a dot
   along each step's drawn path, lights the step's boxes and labels (bold; the rest keeps its theme colours), and shows the caption. It plays
   twice then rests on the last step; space pauses or replays, ←/→ step, r restarts, a click toggles. */
import type { ClientKeyEvent, ClientModule, ClientSurface, RenderElement } from 'claude-code'

export type AnimFrame = { path: [number, number][]; lit: [number, number][]; rects: { r: number; c: number; r2: number; c2: number }[]; caption: string }
export type AnimProps = { lines: string[]; colors: (string | null)[][]; frames: AnimFrame[]; accent: string; dim: string; text: string }
type State = { step: number; pos: number; hold: number; playing: boolean; loops: number; live: { p: AnimProps } }

const HOLD = 10
const LOOPS = 2

const advance = (s: State): State => {
  const f = s.live.p.frames[s.step]
  if (!f) return s
  const len = f.path.length
  const pace = Math.max(1, Math.ceil(len / 12))
  if (s.pos < len) return { ...s, pos: Math.min(len, s.pos + pace) }
  if (s.hold < HOLD) return { ...s, hold: s.hold + 1 }
  const last = s.step + 1 >= s.live.p.frames.length
  if (!last) return { ...s, step: s.step + 1, pos: 0, hold: 0 }
  const loops = s.loops + 1
  return loops >= LOOPS ? { ...s, playing: false, loops } : { ...s, step: 0, pos: 0, hold: 0, loops }
}

const onKey = (s: State, k: ClientKeyEvent): State | null => {
  const n = s.live.p.frames.length
  const at = (step: number): State => ({ ...s, step: (step + n) % n, pos: s.live.p.frames[(step + n) % n]?.path.length ?? 0, hold: HOLD, playing: false })
  if (k.key === ' ' || k.key === 'return') return s.playing ? { ...s, playing: false } : { ...s, playing: true, loops: 0, ...(s.loops >= LOOPS ? { step: 0, pos: 0, hold: 0 } : {}) }
  if (k.key === 'right' || k.key === 'l') return at(s.step + 1)
  if (k.key === 'left' || k.key === 'h') return at(s.step - 1)
  if (k.key === 'r') return { ...s, step: 0, pos: 0, hold: 0, playing: true, loops: 0 }
  return null
}

export const Anim: ClientModule<AnimProps, State> = (props, surface: ClientSurface<State>) => {
  const { Box, Text } = surface.elements
  let st = surface.state
  if (!st) {
    st = { step: 0, pos: 0, hold: 0, playing: true, loops: 0, live: { p: props } }
    surface.setState(st)
    surface.every(70, () => { const now = surface.state; if (now?.playing) surface.setState(advance(now)) })
    surface.onKey(k => { const now = surface.state; const next = now && onKey(now, k); if (next) surface.setState(next) })
    surface.onPointer(e => { const now = surface.state; if (now && e.type === 'down') { const next = onKey(now, { key: ' ' }); if (next) surface.setState(next) } })
  }
  st.live.p = props
  const f = props.frames[st.step]
  const hot = new Set<string>()
  const trail = new Set<string>()
  if (f) {
    f.path.slice(0, st.pos).forEach(([r, c]) => trail.add(`${r},${c}`))
    f.lit.forEach(([r, c]) => hot.add(`${r},${c}`))
    for (const x of f.rects) for (let r = x.r; r <= x.r2; r++) for (let c = x.c; c <= x.c2; c++) hot.add(`${r},${c}`)
  }
  const head = f && st.pos > 0 && st.pos < f.path.length ? f.path[st.pos - 1] : undefined
  const rows: RenderElement[] = props.lines.map((line, r) => {
    const chars = [...line]
    const parts: RenderElement[] = []
    let at = 0
    const look = (c: number) => {
      const k = `${r},${c}`
      if (head && head[0] === r && head[1] === c) return { ch: '●', color: props.accent, bold: true, dim: false }
      if (trail.has(k)) return { ch: chars[c]!, color: props.accent, bold: true, dim: false }
      if (hot.has(k)) return { ch: chars[c]!, color: props.colors[r]?.[c] ?? props.text, bold: true, dim: false }
      return { ch: chars[c]!, color: props.colors[r]?.[c] ?? props.text, bold: false, dim: false }
    }
    while (at < chars.length) {
      const a = look(at)
      let text = a.ch
      let end = at + 1
      for (; end < chars.length; end++) { const b = look(end); if (b.color !== a.color || b.bold !== a.bold || b.dim !== a.dim) break; text += b.ch }
      parts.push(<Text key={`p${at}`} color={a.color ?? undefined} bold={a.bold} dimColor={a.dim}>{text}</Text>)
      at = end
    }
    return <Text key={`r${r}`}>{parts.length ? parts : ' '}</Text>
  })
  const n = props.frames.length
  return (
    <Box flexDirection="column" paddingLeft={2}>
      {rows}
      <Box flexDirection="row" columnGap={2} marginTop={1}>
        <Text color={props.accent} bold>{`${st.playing ? '▶' : '❚❚'} ${st.step + 1}/${n}`}</Text>
        <Text color={props.text} wrap="wrap">{f?.caption ?? ''}</Text>
      </Box>
      <Text color={props.dim}>{st.playing ? 'click or space pauses · ←/→ step · r restart' : 'click or space plays · ←/→ step · r restart'}</Text>
    </Box>
  )
}
export default Anim
