import { stripOutsideCode } from './metadata.js'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { parse } from './markdown'
import { boxArt, mermaidText, paint } from './mermaid'
import { flowFrames, ganttRows, isSequence, segText, seqFrames, seqRows, stateToFlow, stepSpecs } from './extras'
import type { Drawn } from './render'
import { remember, renderBlocks, renderExpandedShell, renderToolGroup, renderToolRow, renderTurnDuration, renderUserPrompt, width } from './render'
import { helpText, rtlShowcaseText, showcaseText } from './help'
import { PRESET_NAMES } from './presets'
import type { Style } from './theme'
import { resolveStyle } from './theme'
import type { Terminal } from './rtl'
import { TERMINALS, hasRtl } from './rtl'

const HINT = [
  'Replies in this session are drawn by the lumen mod, which runs inside Claude Code and is not a command or tool to call: when the user asks to show something with lumen, write it as markdown in the reply.',
  'Markdown tables, GitHub alerts (> [!WARNING], > [!NOTE]), fenced code with a language tag, and ```mermaid blocks render as colored terminal graphics:',
  'flowcharts, sequence diagrams and xychart-beta bar or line charts.',
  'When a reply carries a numeric series or a flow that is easier to see than read, add one small diagram or chart with short labels.',
  'Also drawn here: ```mermaid gantt (timelines), stateDiagram-v2, and {spark: 3 5 9 4} for an inline sparkline in text or table cells.',
  'To explain a flow step by step, animate it: add `%% step A->B "what happens"` lines to a flowchart (node ids, in order), or `%% animate` to a sequence diagram; the terminal plays it.',
  'Diagrams must fit the terminal width: a sequence diagram needs about 14 columns per participant plus its longest message, so keep to 4-5 participants with short labels, or it is shown as a numbered list.',
  'Skip diagrams for simple answers.',
  'Put any command or snippet the user may run or copy in a fenced block with a language tag, never inline code: fenced blocks get a copy button, inline code does not.',
].join(' ')

const detectTerminal = async ($: EngineInterface): Promise<Terminal | null> => {
  const program = await $.env.get('TERM_PROGRAM')
  const term = await $.env.get('TERM')
  if ((await $.env.get('KITTY_WINDOW_ID')) || term === 'xterm-kitty') return 'kitty'
  if (program === 'Apple_Terminal') return 'apple-terminal'
  if (program === 'WarpTerminal') return 'warp'
  if (program === 'ghostty') return 'ghostty'
  if (program === 'WezTerm') return 'wezterm'
  if (program === 'vscode') return 'vscode'
  if (program === 'iTerm.app') return 'iterm'
  if (term === 'alacritty' || (await $.env.get('ALACRITTY_WINDOW_ID'))) return 'alacritty'
  if (await $.env.get('WT_SESSION')) return 'windows-terminal'
  if (await $.env.get('VTE_VERSION')) return 'gnome'
  if (await $.env.get('KONSOLE_VERSION')) return 'konsole'
  return null
}

const applyRtl = async ($: EngineInterface, style: Style): Promise<Terminal | null> => {
  if (style.rtl === 'off') return null
  if (style.rtl !== 'auto') return style.rtl
  const terminal = await detectTerminal($)
  style.reorder = terminal !== null
  if (terminal) style.shape = TERMINALS[terminal]
  return terminal
}

const expandedCalls = new Set<string>()
/** local extension: prompt.submit carries no viewport, so the width is remembered from the last reply drawn. */
const seen = { columns: 0 }
/** local extension: long code blocks fold to FOLD_TO lines until expanded (keyed by their text). */
const unfolded = new Set<string>()
const FOLD_AT = 40
const FOLD_TO = 12

const drawMarkdown = ($: EngineInterface, el: ReturnType<EngineInterface['ui']['resolve']>, style: Style, blocks: ReturnType<typeof parse>, columns: number, reply?: string, live = false): RenderElement[] => {
  const { Button } = el
  const copy = (text: string | (() => string), key: string, label = '⧉ copy') =>
    style.copyButtons ? (
      <Button
        key={key}
        variant="primary"
        label={label}
        onPress={press => {
          $.ui.copy({ text: typeof text === 'function' ? text() : text, surface: press.surface })
            .then(r => $.ui.toast(r.isCopied ? 'Copied' : `Copy failed: ${r.reason}`))
            .catch(() => $.ui.toast('Copy failed'))
        }}
      />
    ) : null
  const drawn: Drawn = new Map()
  if (style.mermaid) {
    for (const [i, block] of blocks.entries()) {
      if (block.kind !== 'code' || block.lang.toLowerCase() !== 'mermaid') continue
      const fits = (a: string | null): a is string => a !== null && a.split('\n').every(l => width(l) <= columns - 2)
      const given = block.lines.join('\n')
      // local extension: gantt timelines drawn as bars
      const gantt = ganttRows(given, columns - 4, { heading: style.theme.heading, codeComment: style.theme.codeComment, codeFlag: style.theme.codeFlag, rule: style.theme.rule, palette: [style.theme.link, style.theme.number, style.theme.accent, style.theme.heading, style.theme.path].filter((c): c is string => !!c) })
      if (gantt) {
        drawn.set(i, { art: segText(gantt), element: (
          <el.Box key={`b${i}`} flexDirection="column" paddingLeft={2}>
            {gantt.map((row, r) => <el.Text key={`g${r}`}>{row.map((seg, k) => <el.Text key={`s${k}`} color={seg.color} bold={seg.bold} dimColor={seg.dim}>{seg.text}</el.Text>)}</el.Text>)}
          </el.Box>
        ) })
        continue
      }
      // local extension: stateDiagram drawn as a flowchart (the renderer draws states poorly)
      const src = stateToFlow(given) ?? given
      let art = mermaidText(src, style.mermaidAscii, columns)
      // local patch: a left-to-right flowchart too wide for the terminal is redrawn top-to-bottom
      if (!fits(art) && /^\s*(flowchart|graph)\s+(LR|RL)\b/m.test(src)) art = mermaidText(src.replace(/^(\s*(?:flowchart|graph)\s+)(LR|RL)\b/m, '$1TD'), style.mermaidAscii, columns)
      if (!fits(art)) {
        // local extension: a sequence diagram too wide to draw becomes a numbered message list
        const seq = seqRows(src)
        if (seq) {
          const t = style.theme
          const w = Math.max(...seq.map(r => r.from.length))
          const w2 = Math.max(...seq.map(r => r.to.length))
          drawn.set(i, { art: seq.map(r => `${r.n}. ${r.from} ${r.reply ? '⇠' : '→'} ${r.to}: ${r.text}`).join('\n'), element: (
            <el.Box key={`b${i}`} flexDirection="column" paddingLeft={2}>
              {seq.map(r => (
                <el.Box key={`q${r.n}`} flexDirection="row">
                  <el.Text color={t.codeComment}>{`${String(r.n).padStart(2)}  `}</el.Text>
                  <el.Text color={t.link} bold>{r.from.padEnd(w)}</el.Text>
                  <el.Text color={r.reply ? t.codeComment : t.accent}>{r.reply ? ' ╌╌▷ ' : ' ──▶ '}</el.Text>
                  <el.Text color={t.number} bold>{r.to.padEnd(w2)}</el.Text>
                  <el.Text color={t.diagramText ?? t.codeText}>{`  ${r.text}`}</el.Text>
                </el.Box>
              ))}
            </el.Box>
          ) })
        }
        continue
      }
      // local extension: `%% step` / `%% animate` play as an animation where a Client can run
      const steps = live && el.Client ? stepSpecs(src) : null
      const plain = art.replace(/[ \t]+$/gm, '')
      const frames = steps ? (isSequence(src) ? seqFrames(plain, steps) : flowFrames(plain, src, steps)) : []
      if (frames.length > 0 && frames.some(f => f.path.length > 0)) {
        const lines = plain.split('\n')
        const colors = paint(plain, style).map(row => row.map(c => c ?? null))
        const t = style.theme
        drawn.set(i, { art, element: <el.Client key={`b${i}`} module="./anim.tsx" props={{ lines, colors, frames, accent: t.accent ?? '#cba6f7', dim: t.codeComment ?? '#6c7086', text: t.diagramText ?? t.codeText ?? '#cdd6f4' }} /> })
      } else drawn.set(i, { element: boxArt(el, style, art, `b${i}`), art })
    }
  }
  // local extension: a long non-diagram code block is drawn folded, with a button to open it
  for (const [i, block] of blocks.entries()) {
    if (block.kind !== 'code' || drawn.has(i) || block.lines.length <= FOLD_AT || !el.Button) continue
    const body = block.lines.join('\n')
    const id = `${block.lang}:${block.lines.length}:${body.slice(0, 200)}:${body.slice(-200)}`
    if (unfolded.has(id)) continue
    const shown = { ...block, lines: block.lines.slice(0, FOLD_TO) }
    const [head] = renderBlocks(el, style, [shown], columns, new Map(), copy && ((_t, k, l) => copy(body, k, l)))
    drawn.set(i, { element: (
      <el.Box key={`b${i}`} flexDirection="column" alignSelf="flex-start">
        {head}
        <el.Box paddingLeft={2}>
          <el.Button key={`fold${i}`} plain label={`▸ ${block.lines.length - FOLD_TO} more lines`} onPress={() => { unfolded.add(id); $.ui.invalidate('ui.render') }} />
        </el.Box>
      </el.Box>
    ) })
  }
  const elements = renderBlocks(el, style, blocks, columns, drawn, copy)
  const button = reply === undefined ? null : copy(reply, 'reply', '⧉ copy reply')
  return button ? [...elements, <el.Box key="reply" alignSelf="flex-end">{button}</el.Box>] : elements
}

export const register: Register = (on, options) => {
  on('engine.create', async (_$, e, next) => ({ ...(await next(e)), lumen: { markdown: async () => undefined } }))
  if (options.enabled === false) return
  const style = resolveStyle(options)
  const parsed = new Map<string, ReturnType<typeof parse>>()
  const parseCached = (text: string, cache = parsed, limit?: number) => remember(cache, text, () => parse(text, { numbers: style.highlightNumbers, paths: style.highlightPaths }), limit)
  const shared = new Map<string, ReturnType<typeof parse>>()
  let terminal: Terminal | null = null
  const fit = (viewport?: { isFullscreen?: boolean }): Style => (terminal === 'apple-terminal' && viewport?.isFullscreen ? { ...style, shape: 'inverse' } : style)

  if (options.toolRows !== false) {
    on('ui.render', { component: 'ToolGroup' }, ($, e, next) => {
      if (e.props.isExpanded) {
        for (const call of e.props.calls) if (call.tool_use_id) expandedCalls.add(call.tool_use_id)
        return next(e)
      }
      return renderToolGroup($.ui.resolve(e), fit(e.viewport), e.props.calls, e.props.isActive, e.viewport?.columns)
    })
    on('ui.render', { component: 'ToolUse' }, ($, e, next) => {
      if (!expandedCalls.has(e.props.tool_use_id)) return renderToolRow($.ui.resolve(e), fit(e.viewport), e.props, e.viewport?.columns)
      return e.props.tool === 'Bash' || e.props.tool === 'PowerShell' ? renderExpandedShell($.ui.resolve(e), fit(e.viewport), e.props) : next(e)
    })
  }

  on('session.start', async ($, e, next) => {
    terminal = await applyRtl($, style)
    const started = await next(e)
    await $.command
      .register({ name: 'lumen', description: 'Switch the lumen theme, copy the last reply, or show the demo', argumentHint: '[theme <name> | copy [code] | demo]' })
      .catch(() => undefined)
    return started
  })

  on('command.run', { command: 'lumen' }, async ($, e) => {
    const [sub, name] = e.args.trim().split(/\s+/)
    if (sub === 'demo') return { text: showcaseText(PRESET_NAMES) }
    if (sub === 'copy') {
      const reply = (await $.session.messages()).findLast(m => m.role === 'assistant' && m.text.trim())
      if (!reply) return { text: 'Nothing to copy yet.' }
      const code = name === 'code' ? parseCached(reply.text).findLast(b => b.kind === 'code') : undefined
      if (name === 'code' && code?.kind !== 'code') return { text: 'The last reply has no code block.' }
      const result = await $.ui.copy({ text: code?.kind === 'code' ? code.lines.join('\n') : reply.text })
      return { text: result.isCopied ? `Copied the last ${code ? 'code block' : 'reply'}.` : `Copy failed: ${result.reason}` }
    }
    if (sub === 'demo-rtl') {
      await applyRtl($, style)
      return { text: rtlShowcaseText() }
    }
    if (sub !== 'theme' || !name) return { text: helpText(PRESET_NAMES) }
    if (!(PRESET_NAMES as readonly string[]).includes(name)) return { text: `Unknown theme "${name}". Themes: ${PRESET_NAMES.join(', ')}` }
    const result = await $.config.set({ key: `${$.plugin.name}.theme`, value: name })
    return { text: result.deny ? `Could not switch theme: ${result.deny}` : `Theme set to ${name}.` }
  })

  on('ui.render', { component: 'TurnDuration' }, ($, e) => renderTurnDuration($.ui.resolve(e), style, e.props.word, e.props.durationMs))

  on('prompt.submit', async ($, e, next) => {
    await applyRtl($, style)
    if (!style.diagramHints || (e.origin.kind !== 'composer' && e.origin.kind !== 'bridge')) return next(e)
    const cols = seen.columns
    return next({ ...e, context: [...(e.context ?? []), cols ? `${HINT} The terminal is ${cols} columns wide.` : HINT] })
  })

  on('ui.render', { component: 'CommandOutput' }, ($, e, next) => {
    if (e.props.isErrored) return next(e)
    const blocks = parseCached(e.props.text)
    if (blocks.length === 0) return next(e)
    const el = $.ui.resolve(e)
    const { Box } = el
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    return <Box flexDirection="column" rowGap={1} {...(style.reorder && hasRtl(e.props.text) ? { width: '100%' } : {})}>{drawMarkdown($, el, fit(e.viewport), blocks, columns)}</Box>
  })

  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const kind = e.props.origin.kind
    const own = kind === 'composer' || kind === 'bridge' || (kind === 'unclassified' && !e.props.from && !e.props.task)
    if (style.promptStyle === 'off' || !own) return next(e)
    return renderUserPrompt($.ui.resolve(e), fit(e.viewport), e.props.text, Math.max(20, (e.viewport?.columns ?? 100) - 4))
  })

  on('ui.render', { component: 'AssistantMessage' }, ($, e, next) => {
    e = { ...e, props: { ...e.props, text: stripOutsideCode(stripOutsideCode(stripOutsideCode(e.props.text,
      /<insight\s+[^>]*?(?:\/>|>[\s\S]{0,4000}?<\/insight>)/g),
      /<progress\b[^>]*?\/?>(?:<\/progress>)?/g), /<change-group\b[^>]*?\/>/g) } }

    if (e.surface === 'terminal' && e.viewport?.columns) seen.columns = e.viewport.columns
    const blocks = parseCached(e.props.text)
    if (blocks.length === 0) return next(e)
    const el = $.ui.resolve(e)
    const { Box, Text } = el
    const columns = Math.max(20, (e.viewport?.columns ?? 100) - 4)
    const narration = style.toolStyle === 'tree-bold' && blocks.length === 1 && blocks[0]!.kind === 'paragraph'
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text color={style.theme.accent}>{e.props.isFirstOfReply ? '●' : ' '}</Text>
        </Box>
        <Box flexDirection="column" rowGap={1} flexGrow={1}>
          {drawMarkdown($, el, narration ? { ...fit(e.viewport), narration } : fit(e.viewport), blocks, columns, blocks.length > 1 || hasRtl(e.props.text) ? e.props.text : undefined, e.surface === 'terminal' && e.props.onScreen !== null)}
        </Box>
      </Box>
    )
  })

  on('lumen.markdown', ($, e, next) => {
    const blocks = parseCached(e.text, shared, 20)
    if (blocks.length === 0) return next(e)
    const el = $.ui.resolve({ surface: e.surface, component: 'AssistantMessage' })
    const { Box } = el
    return { value: <Box flexDirection="column" rowGap={1} {...(style.reorder && hasRtl(e.text) ? { width: '100%' } : {})}>{drawMarkdown($, el, { ...style, copyButtons: false }, blocks, Math.max(20, e.columns || 0))}</Box> }
  })
}
