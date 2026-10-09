/* The cheap-model fallback for concept names: when a turn edits files and Claude adds no
   <change-group> tag, one small call files the edits under the session's existing concepts,
   or names a new one. Existing concepts come first, so a session builds a few growing concepts
   rather than one per turn. */
import type { Edit, Group, GroupKind } from '../types'
import { KINDS, addedRemoved, slug } from './model.js'

export type Label = { path: string; id: string; isNew: boolean; title?: string; kind?: GroupKind; summary?: string }

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) + '…' : s)

/** A compact, bounded description of one turn's edits: path, symbols and a few changed lines. */
export function describeEdits(edits: readonly Edit[], rel: (p: string) => string): string {
  const byPath = new Map<string, Edit[]>()
  for (const e of edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e])
  const out: string[] = []
  for (const [p, es] of [...byPath].slice(0, 15)) {
    const hunks = es.flatMap(e => e.hunks)
    const { add, del } = addedRemoved(hunks)
    const syms = [...new Set(es.flatMap(e => e.symbols).filter(Boolean))].slice(0, 4)
    const sample = hunks.flatMap(h => h.lines.filter(l => l.startsWith('+') || l.startsWith('-'))).slice(0, 8).map(l => '    ' + clip(l, 110))
    out.push(`- ${rel(p)} (+${add} -${del})${syms.length ? ` in ${syms.join(', ')}` : ''}${es.some(e => e.created) ? ' [new file]' : ''}`, ...sample)
  }
  return out.join('\n').slice(0, 6000)
}

export function labelPrompt(ask: string, edits: string, groups: readonly Group[]): string {
  const existing = groups.length === 0
    ? '(none yet)'
    : groups.slice(-15).map(g => `- id=${g.id} [${g.kind}] ${g.title}${g.summary ? ` — ${clip(g.summary, 140)}` : ''}`).join('\n')
  return `You label a coding session's edits into a few CONCEPTS (features, fixes, behaviour changes) for a review pane.

Existing concepts in this session:
${existing}

What the user asked for this turn:
${clip(ask || '(not available)', 1200)}

This turn's edits:
${edits}

For EACH edited file, answer one line:
  <path> => <existing-id>
or, only if the work is genuinely new and fits no existing concept:
  <path> => NEW <short-id> | <kind> | <title, plain words, <= 8 words> | <one sentence: what it does now and why>
kind is one of: ${KINDS.join(', ')}.
Prefer an existing concept whenever the edit continues or supports it (tests, docs and config for a feature belong with that feature). Files that are part of the same new work share one NEW id; repeat the same title for them. Output only those lines.`
}

/** Reads the call's answer; unknown ids and malformed lines are dropped, never guessed. */
export function parseLabels(reply: string, paths: readonly string[], known: ReadonlySet<string>, rel: (p: string) => string): Label[] {
  const byRel = new Map(paths.map(p => [rel(p), p]))
  const out: Label[] = []
  for (const raw of reply.split('\n')) {
    const line = raw.trim().replace(/^[-*]\s+/, '').replace(/`/g, '')
    const m = /^(.+?)\s*=>\s*(.+)$/.exec(line)
    if (!m) continue
    const p = byRel.get(m[1]!.trim()) ?? paths.find(x => x.endsWith('/' + m[1]!.trim()) || x === m[1]!.trim())
    if (!p || out.some(o => o.path === p)) continue
    const rhs = m[2]!.trim()
    const n = /^NEW\s+([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|?\s*(.*)$/i.exec(rhs)
    if (n) {
      const kind = n[2]!.trim().toLowerCase()
      const title = n[3]!.trim().slice(0, 70)
      if (!title) continue
      out.push({ path: p, id: slug(n[1]!.trim()), isNew: true, title, kind: (KINDS as readonly string[]).includes(kind) ? (kind as GroupKind) : 'feature', summary: n[4]!.trim().slice(0, 300) })
      continue
    }
    const id = rhs.split(/\s/)[0]!.replace(/^id=/, '')
    if (known.has(id)) out.push({ path: p, id, isNew: false })
  }
  return out
}
