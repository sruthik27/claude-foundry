import type { On, PluginOptions } from 'claude-code'
import { PRESETS } from './presets.ts'

declare module 'claude-code' {
  interface EngineInterface {
    lumen: { markdown: (args: { surface: RenderSurface; text: string; columns: number }) => Promise<RenderElement | undefined> }
  }
}

// Restyled fork of JayDoubleu/aside (MIT): colours follow the lumen theme.
const theme: Record<string, string> = { name: 'catppuccin-mocha', ...(PRESETS as Record<string, Record<string, string>>)['catppuccin-mocha'] }
async function loadTheme($: any): Promise<void> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const cfg = JSON.parse(await $.fs.read(`${home}/.claude/settings.json`))
    const name = String((cfg?.pluginConfigs?.['lumen@claude-code-mods'] ?? cfg?.pluginConfigs?.['lumen@inline'] ?? cfg?.pluginConfigs?.['prismantis@prismantis'])?.options?.theme ?? 'catppuccin-mocha')
    const p = (PRESETS as Record<string, Record<string, string>>)[name]
    if (p) Object.assign(theme, p, { name })
  } catch { /* keep current theme */ }
}
let spin = 0
// Input draws one line and cuts long text with "…"; it exposes no cursor or scroll, so the pane
// echoes the END of a long draft on one dim line under it (typing happens at the end).
let draft = ''
let tailFrom = 30
const SPIN = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'


/**
 * aside: a read-only side chat beside the transcript.
 *
 * `/aside [question]` opens the pane (focused when the composer is empty);
 * Tab puts the focus ring on the pane's input, Enter asks, Esc hands the keys
 * back to the composer, ctrl+x tab focuses the pane again.
 *
 * Each question is one `$.model.fork` over the session's own transcript as
 * of the last completed turn: tool-less, off the transcript, sharing the
 * main thread's prompt cache; it answers during a later turn too, without
 * seeing the turn in flight. A fork takes exactly one user message, so the
 * side chat's own history is rendered into each prompt.
 *
 * Until the session's first turn has completed there is no snapshot to fork
 * (`$.model.fork` resolves null at once). Then, with `liveFallback` on, the
 * question is answered by `$.model.complete` over the text of
 * `$.session.messages()`: immediate, uncached, without the session's system
 * prompt, and marked "live" in the pane. With it off, the question queues
 * and a fork answers it when the turn ends.
 *
 * What this module calls on `$` (the static listing `claude plugin validate`
 * prints): clock.now, command.register, model.complete, model.fork,
 * session.messages, ui.close, ui.invalidate, ui.open, ui.resolve. All reads
 * and drawing: no fs, process, http, store, tool or prompt verbs, so the mod
 * cannot reach the working tree, the network, or the main thread's prompt.
 */

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }

type Exchange = {
  q: string
  a: string | null
  askedAt: number
  ms?: number
  note?: string
  kind?: 'fork' | 'live'
  queued?: true
}

type Host = {
  fork: (prompt: string) => Promise<{ text: string; usage: Usage } | null>
  messages: () => Promise<readonly { role: 'user' | 'assistant'; text: string }[]>
  complete: (prompt: string) => Promise<string>
  invalidate: () => void
  open: () => Promise<void>
  close: () => Promise<void>
  now: () => number | Promise<number>
}

export const PANE_ID = 'aside'
export const DEFAULTS = { liveFallback: true, liveModel: 'haiku', maxHistory: 8 } as const
export const MAX_CHARS_PER_ANSWER = 1200
export const LIVE_TRANSCRIPT_CHARS = 60000
const LIVE_SYSTEM =
  'You answer read-only side questions about a Claude Code session from its transcript. No tools; do not continue the task; answer briefly in plain prose.'

const clip = (text: string): string =>
  text.length > MAX_CHARS_PER_ANSWER ? `${text.slice(0, MAX_CHARS_PER_ANSWER)}…` : text

export function register(on: On, options: PluginOptions = {}) {
  const liveFallback = typeof options.liveFallback === 'boolean' ? options.liveFallback : DEFAULTS.liveFallback
  const liveModel = typeof options.liveModel === 'string' && options.liveModel !== '' ? options.liveModel : DEFAULTS.liveModel
  const maxHistory =
    typeof options.maxHistory === 'number' && options.maxHistory >= 1 ? Math.floor(options.maxHistory) : DEFAULTS.maxHistory

  let host: Host | null = null
  let history: Exchange[] = []
  let queued: Exchange[] = []
  let inFlight = 0

  const promptOf = (question: string): string => {
    const prior = history
      .filter(x => x.a !== null && x.kind !== undefined)
      .slice(-maxHistory)
      .map(x => `Q: ${x.q}\nA: ${x.a}`)
      .join('\n\n')
    return [
      'This is a read-only side question about the conversation above. Answer from the transcript so far.',
      'Do not use tools, do not propose edits, do not continue the main task; answer briefly in plain prose.',
      prior === '' ? '' : `Earlier side questions and their answers:\n\n${prior}`,
      `Side question: ${question}`,
    ]
      .filter(part => part !== '')
      .join('\n\n')
  }

  async function answerLive(h: Host, entry: Exchange): Promise<void> {
    const messages = await h.messages()
    if (messages.length === 0) {
      entry.a = '(nothing to ask about yet: the transcript is empty)'
      return
    }
    let rendered = messages.map(m => `${m.role.toUpperCase()}: ${m.text}`).join('\n\n')
    if (rendered.length > LIVE_TRANSCRIPT_CHARS) rendered = `…${rendered.slice(-LIVE_TRANSCRIPT_CHARS)}`
    const text = await h.complete(`Transcript so far:\n\n${rendered}\n\n${promptOf(entry.q)}`)
    entry.a = clip(text)
    entry.kind = 'live'
    entry.note = `${rendered.length} chars of transcript sent uncached`
  }

  function run(h: Host, entry: Exchange): void {
    inFlight += 1
    void h
      .fork(promptOf(entry.q))
      .then(async r => {
        if (r !== null) {
          entry.a = clip(r.text)
          entry.kind = 'fork'
          entry.note = `read ${r.usage.cache_read_input_tokens} · new ${r.usage.input_tokens + r.usage.cache_creation_input_tokens} · out ${r.usage.output_tokens}`
          return
        }
        if (liveFallback) {
          await answerLive(h, entry)
          return
        }
        entry.queued = true
        queued.push(entry)
      })
      .catch((err: unknown) => {
        entry.a = `(no answer: ${err instanceof Error ? err.message : String(err)})`
      })
      .then(async () => {
        if (entry.a !== null) entry.ms = (await h.now()) - entry.askedAt
        inFlight -= 1
        h.invalidate()
      })
  }

  function ask(question: string): void {
    const h = host
    const q = question.trim()
    if (!h || q === '') return
    const entry: Exchange = { q, a: null, askedAt: 0 }
    void Promise.resolve(h.now()).then(t => { entry.askedAt = t })
    history = [...history, entry]
    h.invalidate()
    run(h, entry)
  }

  on('session.start', async ($, e, next) => {
    await loadTheme($)
    host = {
      // Current engine answers {isAnswered, text, usage | reason}; adapt to what aside expects.
      fork: async prompt => {
        const r = await $.model.fork({ prompt })
        if (r.isAnswered) return { text: r.text, usage: r.usage }
        if (r.reason === 'nothing-to-fork') return null
        throw new Error('error' in r ? String((r as { error: unknown }).error) : r.reason)
      },
      messages: () => $.session.messages(),
      complete: async prompt => {
        const r = await $.model.complete({ model: liveModel, maxTokens: 400, system: LIVE_SYSTEM, prompt })
        if (r.isAnswered) return r.text
        throw new Error('error' in r ? String((r as { error: unknown }).error) : r.reason)
      },
      invalidate: () => $.ui.invalidate('ui.render'),
      open: async () => { await $.ui.open({ id: PANE_ID, title: 'aside', focus: true }) },
      close: () => $.ui.close({ id: PANE_ID }),
      now: () => $.clock.now(),
    }
    await $.command.register({
      name: 'aside',
      description: 'Read-only side chat about this session (opens a pane; Tab focuses its input)',
      argumentHint: '[question]',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'aside' }, async ($, e, next) => {
    if (!host) return next(e)
    await loadTheme($)
    await host.open()
    ask(e.args)
    return {}
  })

  // Questions that found no snapshot (liveFallback off) are answered by a
  // fork as soon as the turn in flight ends.
  on('turn.complete', ($, e, next) => {
    const h = host
    const waiting = queued
    queued = []
    if (h) {
      for (const entry of waiting) {
        entry.queued = undefined
        run(h, entry)
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    if (e.requestId !== PANE_ID) return next(e)
    const ui = $.ui.resolve(e)
    if (!('Input' in ui)) return next(e)
    const { Box, Text, Input, Button } = ui
    const width = Math.max(24, e.props.bodyColumns - 1)
    const t = theme
    tailFrom = width - 14
    const shown = history.slice(-maxHistory)
    const body = async (text: string) => {
      try {
        const d = await $.lumen.markdown({ surface: e.surface, text, columns: width - 2 })
        if (d) return d
      } catch { /* lumen absent */ }
      return Text({ wrap: 'wrap', color: t.codeText, children: text })
    }
    const rows = await Promise.all(shown.map(async (x, i) => {
      const pending = x.a === null
      const meta = !pending && x.ms !== undefined
        ? `${x.kind ?? 'error'} · ${(x.ms / 1000).toFixed(1)}s${x.note ? ` · ${x.note}` : ''}` : null
      return Box({
        key: `x${i}`, flexDirection: 'column', marginTop: i === 0 ? 0 : 1, width,
        children: [
          Box({ justifyContent: 'flex-end', width, children: [
            Box({ borderStyle: 'round', borderColor: t.accent, paddingX: 1, flexShrink: 1, children: [
              Text({ wrap: 'wrap', color: t.strong, children: x.q }),
            ] }),
          ] }),
          Text({ color: t.accent, bold: true, children: '◇ aside' }),
          Box({ paddingLeft: 2, flexDirection: 'column', width, children: [
            pending
              ? Text({ color: t.codeComment, italic: true, children: `${SPIN[(spin++) % SPIN.length]} ${x.queued ? 'waiting for this turn to end…' : 'thinking…'}` })
              : await body(x.a as string),
            meta ? Text({ color: t.codeComment, children: meta }) : null,
          ] }),
        ],
      })
    }))
    const count = history.length === 0 ? 'read-only' : `${history.length} asked${inFlight ? ` · ${inFlight} pending` : ''}`
    return Box({
      flexDirection: 'column', width,
      children: [
        Box({ justifyContent: 'space-between', width, children: [
          Text({ color: t.heading, bold: true, children: '◆ aside' }),
          Text({ color: t.codeComment, children: `${count} · ${t.name}` }),
        ] }),
        Text({ color: t.rule, children: '─'.repeat(width) }),
        history.length === 0
          ? Text({ color: t.codeComment, wrap: 'wrap', children: 'Ask about the session so far. No tools, nothing goes into the main thread.' })
          : null,
        ...rows,
        Box({
          // Explicit width: an Input wraps only when its box is sized; a shrink-to-fit box truncates it.
          marginTop: 1, flexDirection: 'column', borderStyle: 'round', width,
          borderColor: e.props.isFocused ? t.accent : t.rule, paddingX: 1,
          children: [
            Input({
              key: 'q',
              placeholder: e.props.isFocused ? 'ask about this session…' : 'ctrl+x tab focuses the pane',
              submitLabel: 'ask', onSubmit: () => undefined,
            }),
            draft.length > tailFrom
              ? Text({ wrap: 'truncate-start', color: t.codeComment, children: `…${draft.slice(-(width - 6))}` })
              : null,
          ],
        }),
        Box({ flexDirection: 'row', gap: 1, justifyContent: 'space-between', width, children: [
          Box({ flexDirection: 'row', gap: 1, children: [
            Button({ key: 'clear', label: 'clear', onPress: () => undefined }),
            Button({ key: 'close', label: 'close', onPress: () => undefined }),
          ] }),
          Text({ color: t.codeComment, children: 'Esc to prompt' }),
        ] }),
      ],
    })
  })

  // The pane's events are answered here rather than in the element closures:
  // a closure handle belongs to one drawing, and a submit that lands during a
  // redraw is dropped by core ("no handler is held under handle N"), while the
  // hook still sees the event and its value.
  on('ui.input', { plugin: 'aside', element: 'q' }, ($, e, next) => {
    if (e.kind !== 'submit') {
      const long = draft.length > tailFrom || e.value.length > tailFrom
      draft = e.value
      if (long) host?.invalidate()
      return next(e)
    }
    draft = ''
    ask(e.value)
    return { element: e.element, value: e.value }
  })

  on('ui.press', { plugin: 'aside' }, ($, e, next) => {
    if (e.element === 'clear') {
      history = []
      host?.invalidate()
      return { element: e.element }
    }
    if (e.element === 'close') {
      void host?.close()
      return { element: e.element }
    }
    return next(e)
  })
}
