import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

declare module 'claude-code' {
  interface EngineInterface {
    lumen: { markdown: (args: { surface: RenderSurface; text: string; columns: number }) => Promise<RenderElement | undefined> }
  }
}

import type { Insight, InsightKind } from '../types'
import { PRESETS } from './presets.js'
import { CAP, cap, clipText, extract, extractPrompt, grouped, ledger, merge, strip, toMarkdown, worthExtracting } from './parse.js'

const PANE = 'insight-pane'
const TITLE = 'Intel'
const items = atom({ plugin: 'insight-pane', key: 'items' } as const, [])
/** Sections the person folded; kept across sessions in $.store. */
const collapsed = atom({ plugin: 'insight-pane', key: 'collapsed' } as const, [])

const ICON: Record<InsightKind, string> = {
  concept: '◇', decision: '◆', why: '?', gotcha: '!', fact: '·', risk: '▲',
}
const HEADING: Record<InsightKind, string> = {
  concept: 'Concepts', decision: 'Decisions', why: 'Root causes', gotcha: 'Gotchas', fact: 'Facts', risk: 'Risks',
}
/** Colours follow the lumen theme (settings.json), re-read on session start and /intel. */
type Palette = Record<string, string>
const T: { name: string; p: Palette } = { name: 'catppuccin-mocha', p: (PRESETS as Record<string, Palette>)['catppuccin-mocha']! }
/** Which theme token colours each section. */
const TOKEN: Record<InsightKind, string> = {
  concept: 'accent', decision: 'link', why: 'heading', gotcha: 'number', fact: 'quote', risk: 'codeFlag',
}
const hue = (k: InsightKind) => T.p[TOKEN[k]] ?? '#cdd6f4'

async function loadTheme($: import('claude-code').EngineInterface): Promise<void> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const cfg = JSON.parse(await $.fs.read(`${home}/.claude/settings.json`))
    const name = String((cfg?.pluginConfigs?.['lumen@claude-code-mods'] ?? cfg?.pluginConfigs?.['lumen@inline'] ?? cfg?.pluginConfigs?.['prismantis@prismantis'])?.options?.theme ?? 'catppuccin-mocha')
    const p = (PRESETS as Record<string, Palette>)[name]
    if (p) { T.name = name; T.p = p }
  } catch { /* keep the current theme */ }
}

/** A letter to fold each section from the keyboard (the pane holds the keys after a click or ctrl+x tab). */
const FOLD_KEY: Record<InsightKind, string> = { concept: 'c', decision: 'd', why: 'w', gotcha: 'g', fact: 'f', risk: 'r' }

/** Importance as five pips: ●●●●○ */
const pips = (w: number) => (w >= 5 ? '★ ' : '') + '●'.repeat(w) + '○'.repeat(5 - w)

const GUIDE = `# Insight reporting (insight-pane mod)
The user delegates most work to you and is at risk of losing track of what is happening in their own systems. While you work, surface what a strong senior engineer who did this by hand would know, so the user stays genuinely competent, not a passive shipper.

These tags are separate from, and never replace, any ★ Insight blocks your output style asks for: keep writing those as usual.

Emit a tag, on its own line, anywhere in your visible reply text:
<insight id="short-slug" kind="KIND" weight="1-5">one or two plain-English sentences, at most ~35 words (it must fit in 5 lines of a side pane)</insight>

The pane is a small, living summary, not a log. Keep it short and dense:
- To refine, extend or correct an existing card, re-emit its id with the improved full text (it is rewritten in place). Fold related new knowledge into the closest existing card rather than adding a near-duplicate.
- To remove a card that is superseded or wrong: <insight id="its-id" drop/>
- When you fix, mitigate or rule out something listed under Risks, drop that risk card in the same reply. A risk you resolved must not stay on the pane.
- New id only for genuinely new knowledge.

Ranking. Each section holds at most 10 cards; when full, the lowest-ranked card is evicted automatically. weight is importance to the user's competence:
5 = essential (they'd be lost or embarrassed without it; a core mechanism, a decision that shapes the system, a root cause)
4 = high (would come up in a review or incident)
3 = useful context
2 = minor, nice to know
1 = trivia (rejected outright, never shown)
Weight honestly: most cards are 3-4; reserve 5. Re-emitting a card (refining it) also boosts its rank, so update the card that keeps proving relevant instead of adding a new one. When a section is near full, prefer merging two related cards, or dropping a stale or superseded one, over adding a marginal new one.

KIND is one of:
- concept: a 1-2 sentence plain explanation of a tool, feature, mechanism, protocol or pattern you relied on that the user may not know (what it is and why it matters here). Emit this the first time the work depends on it, even if the user never asked, because by hand they would have had to learn it.
- decision: a choice you made where a real alternative existed, and what it traded away
- why: the root cause of a bug, or the reason something behaves as it does
- gotcha: a non-obvious behaviour of a tool, protocol, library or system that bit you or would bite them
- fact: a crucial fact about their codebase/system they should be able to state if asked
- risk: something you left fragile, skipped, assumed, or that could break later

Bar: is this knowledge the user would have built by doing the work manually, and would not knowing it make them look clueless in a code review, incident, or design discussion? If not, do not emit it. Never emit: file lists, step narration, formatting, boilerplate, things already said in an earlier insight. Most turns warrant 0-3; never more than 5. Never re-explain a concept already on the pane. Prefer the quiet defaults you picked without being asked; those are the ones the user would otherwise never learn.`

export const register: Register = on => {
  /** Tool calls in the running main turn: a turn that did real work is worth a fallback call. */
  let work = 0
  let ask = ''
  let turn = 0 // main-loop turns; reseeded from saved items after a reload

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    await loadTheme($)
    await $.command.register({ name: 'intel', description: 'Toggle the Intel pane' })
    // $.state lives only as long as this process; $.store survives exits. A resumed
    // session keeps its id, so its cards come back; a new or /clear'd one starts empty.
    let saved = (await $.store.get(`cards:${await $.session.id()}`)) as Insight[] | undefined
    // A resume that came back under a new id: merge in the session it continued from (this one's cards win).
    const prev = await predecessorOf($, e.cwd)
    if (prev) {
      const old = ((await $.store.get(`cards:${prev}`)) as Insight[] | undefined) ?? []
      const mine = saved ?? []
      saved = [...old.filter(o => !mine.some(x => x.id === o.id)), ...mine]
    }
    if (saved && saved.length > 0 && (await read($, items)).length < saved.length) {
      await update($, items, () => cap(saved.map(i => ({ ...i, text: clipText(i.text) }))))
      $.ui.status(`◆ ${saved.length} insights · /intel`)
    }
    // Folded sections are a preference: they apply to every session.
    const folds = (await $.store.get('collapsed')) as InsightKind[] | undefined
    if (folds?.length) await update($, collapsed, () => folds)
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (!['clear', 'resume', 'fork'].includes(e.source)) return r
    work = 0; ask = ''; turn = 0
    let saved = e.source === 'clear' ? [] : (await $.store.get(`cards:${await $.session.id()}`) as Insight[] | undefined) ?? []
    if (e.source !== 'clear' && e.cwd) {
      const prev = await predecessorOf($, e.cwd)
      if (prev) { const old = await $.store.get(`cards:${prev}`) as Insight[] | undefined; saved = [...(old ?? []).filter(o => !saved.some(x => x.id === o.id)), ...saved] }
    }
    const restored = cap(saved.map(i => ({ ...i, text: clipText(i.text) })))
    await update($, items, () => restored)
    turn = Math.max(0, ...restored.map(i => i.turn))
    $.ui.status(undefined)
    return r
  })

  on('command.run', { command: 'intel' }, async $ => {
    await loadTheme($)
    const open = (await $.ui.panes()).some(p => p.id === PANE)
    if (open) await $.ui.close({ id: PANE })
    else await $.ui.open({ id: PANE, title: TITLE })
    return {}
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const list = await read($, items)
    const text = list.length === 0 ? GUIDE : `${GUIDE}\n\nCards currently on the pane, best-first per section (id weight text):\n${ledger(list)}`
    return { ...r, sections: [...r.sections, { id: 'insight-pane:guide', text, scope: 'session' }] }
  })

  on('turn.start', async ($, e, next) => {
    if (!(e as { agentId?: string }).agentId) { work = 0; ask = String((e as { text?: string }).text ?? '').slice(0, 1500) }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (!e.agentId) work += 1
    return next(e)
  })

  // A short nudge with each prompt: Claude writes its own cards more often, so fewer fallback calls.
  on('prompt.submit', async ($, e, next) => {
    const nudge = 'Reminder from the insight pane: if this turn decides, explains, fixes or learns something worth knowing, add the <insight .../> tag(s) your system prompt describes, in addition to (never instead of) any ★ Insight blocks your output style asks for.'
    return next({ ...e, context: [...(e.context ?? []), nudge] })
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r // subagent turns: their summary reaches the main loop anyway
    if (turn === 0) turn = Math.max(0, ...(await read($, items)).map(i => i.turn))
    turn += 1
    let ops = extract(e.answer, turn)
    const risks = (await read($, items)).filter(i => i.kind === 'risk')
    const dropped = new Set(ops.filter(o => o.op === 'drop').map(o => (o as { id: string }).id))
    const openRisks = risks.filter(i => !dropped.has(i.id))
    // A working turn with no cards, or one that left risks standing: one small call writes the
    // cards Claude didn't and drops the risks this turn resolved.
    if ((ops.length === 0 || openRisks.length > 0) && worthExtracting(e.answer, work)) {
      try {
        const reply = await $.model.complete({
          model: 'haiku', effort: 'low', maxTokens: 700, timeoutMs: 30000,
          prompt: extractPrompt(ask, e.answer, ledger(await read($, items))),
        })
        if (reply.isAnswered) {
          const more = extract(reply.text, turn)
          const own = new Set(ops.map(o => (o.op === 'set' ? o.insight.id : o.id)))
          // Claude's own cards win; the fallback only adds what is missing and drops resolved risks.
          const keep = more.filter(o => o.op === 'drop' ? openRisks.some(i => i.id === o.id) : ops.length === 0 && !own.has(o.insight.id))
          ops = [...ops, ...keep]
        }
      } catch { /* nothing this turn */ }
    }
    work = 0
    if (ops.length === 0) return r

    const all = await update($, items, list => merge(list, ops))
    $.ui.status(`◆ ${all.length} insights · /intel`)

    const sid = await $.session.id()
    await $.store.set(`cards:${sid}`, all)
    // Keep the 40 most recent sessions' cards; insertion order is oldest first.
    const keys = (await $.store.keys()).filter(k => k.startsWith('cards:') && k !== `cards:${sid}`)
    for (const k of keys.slice(0, Math.max(0, keys.length - 39))) await $.store.delete(k)

    try {
      if (!(await $.ui.panes()).some(p => p.id === PANE)) void $.ui.open({ id: PANE, title: TITLE })
    } catch { /* no surface to open on (headless) */ }

    // Optional: mirror the cards as markdown into ~/learning/.insights/ for a notes pipeline.
    // Off unless that folder already exists, so nothing is created in a home directory uninvited.
    try {
      const home = await $.env.get('HOME')
      if (home && (await $.fs.exists(`${home}/learning/.insights`)) && !(await $.fs.exists(`${home}/learning/.paused`))) {
        await $.fs.write(`${home}/learning/.insights/${sid}.md`, toMarkdown(all))
      }
    } catch { /* sidecar is optional */ }
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.text.includes('<insight')) return next(e)
    return next({ ...e, props: { ...e.props, text: strip(e.props.text) } })
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, items)
    const folded = new Set(await read($, collapsed))
    const width = Math.max(16, e.props.bodyColumns - 2)
    const rows = Math.max(1, e.props.scroll?.bodyRows ?? 1)
    const ink = T.p.codeText ?? '#cdd6f4'
    const muted = T.p.codeComment ?? '#6c7086'
    const rule = T.p.rule ?? '#45475a'

    if (list.length === 0) {
      return (
        <Box flexDirection="column" paddingX={1} paddingY={1} borderStyle="round" borderColor={rule}>
          <Text color={T.p.heading} bold>Nothing yet</Text>
          <Text color={muted} italic wrap="wrap">Concepts, decisions, root causes, gotchas and risks collect here as Claude works.</Text>
        </Box>
      )
    }
    // Card text goes through lumen so code, paths and numbers are highlighted as in replies.
    const body = async (text: string, cols: number, top: boolean) => {
      try {
        const d = await $.lumen.markdown({ surface: e.surface, text, columns: cols })
        if (d) return d
      } catch { /* lumen absent */ }
      return <Text color={top ? T.p.strong : ink} bold={top} wrap="wrap">{text}</Text>
    }
    const groups = grouped(list)
    const total = list.length
    const textCols = Math.max(20, width - 4)
    const drawn = await Promise.all(groups.map(async g => folded.has(g.kind) ? [] :
      Promise.all(g.items.map(i => body(i.text, textCols, (i.weight ?? 3) >= 5)))))
    return (
      <Box flexDirection="column" gap={1} width={e.props.bodyColumns} minHeight={rows} paddingX={1} paddingY={1}>
        <Box flexDirection="row" columnGap={1} flexWrap="wrap">
          {groups.map(g => (
            <Text key={`c-${g.kind}`} color={hue(g.kind)} bold>{`${ICON[g.kind]} ${g.items.length}`}</Text>
          ))}
          <Text color={muted}>{`· ${total}`}</Text>
        </Box>
        {groups.map((g, gi) => {
          const label = ` ${ICON[g.kind]} ${HEADING[g.kind].toUpperCase()} `
          const count = folded.has(g.kind) ? `${g.items.length} hidden` : `${g.items.length}/${CAP}`
          const fill = Math.max(1, width - label.length - count.length - 9)
          return (
            <Box key={g.kind} flexDirection="column">
              <Box flexDirection="row">
                <Box flexShrink={0}><Text backgroundColor={hue(g.kind)} color="#11111b" bold>{label}</Text></Box>
                <Box flexShrink={1}><Text color={rule} wrap="truncate">{' ' + '─'.repeat(fill) + ' '}</Text></Box>
                <Box flexShrink={0}><Text color={muted}>{count + ' '}</Text></Box>
                <Button key={`fold-${g.kind}`} plain label={folded.has(g.kind) ? '▸' : '▾'} hotkey={FOLD_KEY[g.kind]}
                  onPress={async () => {
                    const next = await update($, collapsed, c => (c.includes(g.kind) ? c.filter(k => k !== g.kind) : [...c, g.kind]))
                    try { await $.store.set('collapsed', next) } catch { /* only this session then */ }
                  }} />
              </Box>
              {!folded.has(g.kind) && g.items.map((i, ii) => {
                const w = i.weight ?? 3
                const top = w >= 5
                return (
                  <Box key={i.id} flexDirection="row" width={width - 1} marginTop={1}>
                    <Text color={hue(g.kind)}>{'┃ '}</Text>
                    <Box flexDirection="column" flexShrink={1}>
                      {drawn[gi]![ii]}
                      <Box flexDirection="row" columnGap={1}>
                        <Text color={top ? hue(g.kind) : muted}>{pips(w)}</Text>
                        <Text color={muted} italic>{`turn ${i.turn}${i.revised ? ' · revised' : ''}`}</Text>
                      </Box>
                    </Box>
                  </Box>
                )
              })}
            </Box>
          )
        })}
      </Box>
    )
  })
}

/* A resumed session can come back under a new id with the old history copied in. This finds the
   session it continued from: the other transcript in the same project that holds the same first
   message. Mods key their saved state by session id, so they look there when their own is empty. */
async function predecessorOf($: import('claude-code').EngineInterface, cwd: string): Promise<string | undefined> {
  try {
    const home = (await $.env.get('HOME')) ?? ''
    const dir = `${home}/.claude/projects/${cwd.replace(/[^A-Za-z0-9]/g, '-')}`
    const sid = await $.session.id()
    const r = await $.process.run(['sh', '-c',
      'f="$1/$2.jsonl"; [ -f "$f" ] || exit 0; u=$(grep -m1 -o \'"uuid":"[^"]*"\' "$f") || exit 0; ' +
      'ls -t "$1"/*.jsonl 2>/dev/null | head -40 | grep -v "/$2.jsonl" | xargs grep -l -F "$u" 2>/dev/null | head -1',
      'prev', dir, sid], { timeoutMs: 20000 })
    const hit = r.stdout.trim().split('/').pop()?.replace(/\.jsonl$/, '')
    return hit && hit !== sid ? hit : undefined
  } catch {
    return undefined
  }
}
