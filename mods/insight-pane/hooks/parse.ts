import type { Insight, InsightKind, InsightOp } from '../types'
import { outsideCode, stripOutsideCode } from './metadata.js'

/** Most cards a section may hold; the lowest-ranked beyond it are evicted. */
export const CAP = 10
export const MIN_WEIGHT = 2

export const KINDS: readonly InsightKind[] = ['concept', 'decision', 'why', 'gotcha', 'fact', 'risk']
// A real tag carries attributes (`<insight id=… kind=…>`); a bare `<insight>` is prose about the tag.
const TAG = /<insight\s+([^>]*?)(?:\/>|>([\s\S]{0,4000}?)<\/insight>)/g
/** The most a card may hold: about five lines of the pane. */
export const MAX_TEXT = 300

/** Cuts a card to MAX_TEXT, at a sentence or word end where possible. */
export function clipText(t: string): string {
  if (t.length <= MAX_TEXT) return t
  const head = t.slice(0, MAX_TEXT)
  const stop = Math.max(head.lastIndexOf('. '), head.lastIndexOf('; '))
  if (stop > MAX_TEXT * 0.6) return head.slice(0, stop + 1)
  return head.slice(0, head.lastIndexOf(' ') > 0 ? head.lastIndexOf(' ') : MAX_TEXT).replace(/[,;:]$/, '') + '…'
}
const ATTR = /([a-z]+)(?:="([^"]*)")?/g

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(ATTR)) out[m[1] ?? ''] = m[2] ?? ''
  return out
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'x'
}

/** Reads every <insight> tag in a reply as an operation on the card list. */
export function extract(text: string, turn: number): InsightOp[] {
  const out: InsightOp[] = []
  for (const m of outsideCode(text, TAG)) {
    const a = attrs(m[1] ?? '')
    if (!a.id && !a.kind && !('drop' in a)) continue
    if ('drop' in a && a.id) { out.push({ op: 'drop', id: a.id }); continue }
    const body = clipText((m[2] ?? '').replace(/\s+/g, ' ').trim())
    if (!body) continue
    const kind = (KINDS as readonly string[]).includes(a.kind ?? '') ? (a.kind as InsightKind) : 'fact'
    const w = Math.round(Number(a.weight))
    const weight = w >= 1 && w <= 5 ? w : 3
    if (weight < MIN_WEIGHT) continue // below the bar: rejected outright
    out.push({ op: 'set', insight: { id: a.id || slug(body), turn, kind, text: body, weight } })
  }
  return out
}

/** Applies operations: same id rewrites in place (keeps its slot), drop removes. */
export function merge(list: readonly Insight[], ops: readonly InsightOp[]): Insight[] {
  let next = list.map(i => (i.id ? i : { ...i, id: slug(i.text) })) // cards saved before ids existed
  for (const o of ops) {
    if (o.op === 'drop') { next = next.filter(i => i.id !== o.id); continue }
    const at = next.findIndex(i => i.id === o.insight.id)
    if (at === -1) next.push(o.insight)
    else {
      const prev = next[at]!
      next[at] = { ...o.insight, revised: true, hits: (prev.hits ?? 1) + 1 }
    }
  }
  return cap(next)
}

/**
 * Rank: importance dominates; each re-confirmation adds a point (capped), so knowledge
 * that keeps proving relevant rises; recency only breaks ties.
 */
export function score(i: Insight): number {
  return (i.weight ?? 3) * 10 + Math.min((i.hits ?? 1) - 1, 5) * 3 + i.turn / 1000
}

/** Keeps the top CAP per section by score; returns each section best-first. */
export function cap(list: readonly Insight[]): Insight[] {
  return KINDS.flatMap(k =>
    list.filter(i => i.kind === k).sort((a, b) => score(b) - score(a)).slice(0, CAP),
  )
}

export function strip(text: string): string {
  return stripOutsideCode(text, TAG)
}

/** Sections in a fixed order, empty ones left out. */
export function grouped(list: readonly Insight[]): { kind: InsightKind; items: Insight[] }[] {
  return KINDS.map(kind => ({ kind, items: list.filter(i => i.kind === kind) })).filter(g => g.items.length > 0)
}

/** Current cards, compact, for the system prompt so Claude can merge into them. */
export function ledger(list: readonly Insight[]): string {
  return KINDS.map(k => {
    const g = list.filter(i => i.kind === k)
    return g.length === 0 ? '' : `${k} (${g.length}/${CAP}):\n` + g.map(i => `- ${i.id} w${i.weight ?? 3} ${i.text}`).join('\n')
  }).filter(Boolean).join('\n')
}

/** The sidecar learning-capture.sh folds into its digest: the current state, by section. */
export function toMarkdown(list: readonly Insight[]): string {
  return grouped(list).map(g => `${g.kind.toUpperCase()}\n` + g.items.map(i => `- ${i.text}`).join('\n')).join('\n\n') + '\n'
}

/** A turn is worth a fallback call when it did work (tools) or said something substantial. */
export function worthExtracting(answer: string, toolCalls: number): boolean {
  const words = answer.trim().split(/\s+/).filter(Boolean).length
  return (toolCalls >= 2 && words >= 40) || words >= 250
}

/** The fallback: read one turn's reply and write the cards Claude did not. */
export function extractPrompt(ask: string, answer: string, current: string): string {
  return `You maintain a developer's "What you should know" pane: a small, ranked set of cards with the knowledge they would have built doing the work by hand. Read one turn of an AI coding session and output only cards worth keeping.

The user asked:
${ask.slice(0, 1500) || '(not available)'}

The assistant's reply:
${answer.slice(0, 12000)}

Cards already on the pane (id [kind] weight text) — re-use an id to refine one instead of repeating it:
${current || '(none)'}

Output 0-3 lines, each exactly:
<insight id="short-slug" kind="concept|decision|why|gotcha|fact|risk" weight="1-5">one or two plain sentences, <= 35 words</insight>
concept = what a tool/mechanism is and why it matters here; decision = a choice with a real alternative and what it traded; why = a root cause; gotcha = non-obvious behaviour that bites; fact = a crucial fact about their system; risk = something left fragile or assumed.
Weight 5 essential, 4 high, 3 useful, 2 minor. Skip narration, file lists, formatting and anything already on the pane.

Then check every card on the pane whose kind is [risk]: if this turn fixed it, mitigated it, or showed it does not apply, output a line to remove it:
<insight id="<that risk's id>" drop/>
Only drop a risk the reply clearly resolves; keep any risk that is still open. If nothing qualifies, output nothing.`
}
