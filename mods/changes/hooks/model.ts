import type { Edit, Group, GroupKind, Hunk, Model, Thread } from '../types'
import { outsideCode, stripOutsideCode } from './metadata.js'

export const EMPTY: Model = { edits: [], groups: [], threads: [], reviewed: [], nav: { level: 'groups', scope: 'session' }, focusSeq: 0 }
export const KINDS: readonly GroupKind[] = ['feature', 'behaviour', 'fix', 'refactor', 'test', 'config', 'removal', 'docs']
export const MAX_GROUPS = 24
export const MAX_EDITS = 600

// ---------------------------------------------------------------- symbols

const DEF: readonly RegExp[] = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/,
  /^\s*(?:export\s+)?(?:interface|type)\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/,
  /^\s*class\s+([A-Za-z_]\w*)\s*[:(]/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/,
  /^\s*(?:(?:public|private|protected|static|final|synchronized|abstract)\s+)+[\w<>\[\],.?]+\s+([a-z_]\w*)\s*\([^;]*\)\s*(?:throws [\w, .]+)?\s*\{?\s*$/,
  /^\s*(?:it|test|describe)\s*\(\s*(['"`])(.{1,60}?)\1/,
  /^\s*on\(\s*(['"])([\w.]+)\1/,
  /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/,
]
const NOT_NAMES = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'else', 'new', 'await', 'throw', 'case', 'typeof', 'delete', 'yield'])

/** The name a line defines, if any: "fnName", "test: does x", "on turn.complete". */
export function definedAt(line: string): string | undefined {
  for (const re of DEF) {
    const m = re.exec(line)
    if (!m) continue
    if (re.source.includes('it|test|describe')) return `${/^\s*describe/.test(line) ? 'describe' : 'test'}: ${m[2]}`
    if (re.source.startsWith('^\\s*on\\(')) return `on ${m[2]}`
    const name = m[1]
    if (name && !NOT_NAMES.has(name)) return name
  }
  return undefined
}

/**
 * The nearest definition at or above `line` (1-based) whose block plausibly holds it,
 * by indentation: a definition indented less than the line, or at the same depth when
 * the line is the definition itself.
 */
export function symbolAt(lines: readonly string[], line: number): string {
  const at = Math.max(1, Math.min(line, lines.length))
  const indent = (s: string) => (/^\s*/.exec(s)?.[0].length ?? 0)
  const own = lines[at - 1] ?? ''
  const here = definedAt(own)
  if (here) return here
  let depth = own.trim() === '' ? Infinity : indent(own)
  for (let i = at - 2; i >= 0 && at - i < 400; i--) {
    const l = lines[i] ?? ''
    if (l.trim() === '') continue
    const d = indent(l)
    if (d < depth) {
      const name = definedAt(l)
      if (name) return name
      depth = d
    }
  }
  return ''
}

// ---------------------------------------------------------------- recording

export function addedRemoved(hunks: readonly Hunk[]): { add: number; del: number } {
  let add = 0, del = 0
  for (const h of hunks) for (const l of h.lines) { if (l.startsWith('+')) add++; else if (l.startsWith('-')) del++ }
  return { add, del }
}

/** First changed new-side line of a hunk (skips leading context). */
export function firstChanged(h: Hunk): number {
  let n = h.newStart
  for (const l of h.lines) {
    if (l.startsWith('+') || l.startsWith('-')) return n
    n++
  }
  return h.newStart
}

export function record(m: Model, e: Edit): Model {
  return { ...m, edits: [...m.edits, e].slice(-MAX_EDITS) }
}

// ---------------------------------------------------------------- grouping

const GTAG = /<change-group\b([^>]*?)\/?>(?:<\/change-group>)?/g

export type GroupTag = { id: string; kind: GroupKind; title: string; summary: string }

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'group'
}

export function readGroupTags(text: string): GroupTag[] {
  const out: GroupTag[] = []
  for (const m of outsideCode(text, GTAG)) {
    const a: Record<string, string> = {}
    for (const p of (m[1] ?? '').matchAll(/([a-z]+)="([^"]*)"/g)) a[p[1] ?? ''] = p[2] ?? ''
    const title = (a.title ?? '').trim().slice(0, 70)
    if (!title && !a.id) continue
    const kind = (KINDS as readonly string[]).includes(a.kind ?? '') ? (a.kind as GroupKind) : 'feature'
    out.push({ id: a.id ? slug(a.id) : slug(title), kind, title: title || a.id || 'Changes', summary: (a.summary ?? '').trim().slice(0, 300) })
  }
  return out
}

export function stripGroupTags(text: string): string {
  return stripOutsideCode(text, GTAG)
}

/**
 * Assigns the turn's unassigned edits. With tags: an edit goes to the tag whose title or
 * summary names its file or symbol, else the first tag. Tags also create or refresh groups
 * (same id = same group). Without tags: one fallback group per turn, named after the task.
 */
export function assign(m: Model, turn: number, tags: readonly GroupTag[]): Model {
  const pending = m.edits.filter(e => e.turn === turn && !e.group)
  let groups = [...m.groups]
  const upsert = (g: Group) => {
    const at = groups.findIndex(x => x.id === g.id)
    if (at === -1) { groups.push(g); return }
    // a reused id moves to the end, so the cap evicts the least recently active concept
    const merged = { ...groups[at]!, kind: g.kind, title: g.title, summary: g.summary || groups[at]!.summary, turn: g.turn }
    groups = [...groups.slice(0, at), ...groups.slice(at + 1), merged]
  }
  for (const t of tags) upsert({ ...t, turn })
  if (pending.length === 0) return { ...m, groups: trimGroups(groups, m.edits) }

  let pick: (e: Edit) => string
  if (tags.length > 0) {
    pick = e => {
      const base = e.path.split('/').pop() ?? e.path
      const hit = tags.find(t => {
        const hay = `${t.title} ${t.summary}`.toLowerCase()
        return hay.includes(base.toLowerCase()) || e.symbols.some(s => s && hay.includes(s.toLowerCase().replace(/^(test|describe|on): /, '')))
      })
      return (hit ?? tags[0]!).id
    }
  } else {
    const task = pending.find(e => e.task)?.task
    const id = task ? `task-${slug(task)}` : `turn-${turn}`
    upsert({ id, kind: 'feature', title: task ?? 'Other changes', summary: '', turn })
    pick = () => id
  }
  const edits = m.edits.map(e => (e.turn === turn && !e.group ? { ...e, group: pick(e) } : e))
  return { ...m, edits, groups: trimGroups(groups, edits) }
}

/** Groups with no edits are dropped (a tag that named nothing); the cap keeps the newest. */
function trimGroups(groups: Group[], edits: readonly Edit[]): Group[] {
  const used = new Set(edits.map(e => e.group))
  return groups.filter(g => used.has(g.id)).slice(-MAX_GROUPS)
}

// ---------------------------------------------------------------- views

export type FileRow = { path: string; add: number; del: number; symbols: string[]; edits: Edit[]; created: boolean; deleted: boolean }
export type GroupRow = Group & { files: FileRow[]; add: number; del: number; reviewedFiles: number }

export function rows(m: Model): GroupRow[] {
  const out: GroupRow[] = []
  for (const g of [...m.groups].reverse()) {
    const edits = m.edits.filter(e => e.group === g.id)
    if (edits.length === 0) continue
    const byPath = new Map<string, Edit[]>()
    for (const e of edits) byPath.set(e.path, [...(byPath.get(e.path) ?? []), e])
    const files: FileRow[] = [...byPath].map(([path, es]) => {
      const { add, del } = addedRemoved(es.flatMap(e => e.hunks))
      const symbols = [...new Set(es.flatMap(e => e.symbols).filter(Boolean))]
      return { path, add, del, symbols, edits: es, created: es.some(e => e.created), deleted: es.at(-1)?.deleted === true }
    })
    const add = files.reduce((s, f) => s + f.add, 0)
    const del = files.reduce((s, f) => s + f.del, 0)
    const reviewedFiles = files.filter(f => m.reviewed.includes(`${g.id}|${f.path}`)).length
    out.push({ ...g, files, add, del, reviewedFiles })
  }
  return out
}

/**
 * The lines the viewer should mark, mapped onto the file as it is NOW: hunks from later
 * edits shift earlier ones. Returns 1-based new-side line numbers that were added or
 * changed, plus removal points (the line a removal sits above).
 */
export function marks(edits: readonly Edit[], allForFile: readonly Edit[]): { added: Set<number>; removedAt: Map<number, string[]> } {
  const added = new Set<number>()
  const removedAt = new Map<number, string[]>()
  // edits are recorded in the order they were applied; a stable sort by turn keeps that order
  const order = [...allForFile].sort((a, b) => a.turn - b.turn)
  const mine = new Set(edits.map(e => e.id))
  // map(line) after edit k: shift lines below each later hunk by its net growth
  const shift = (line: number, after: number): number => {
    let n = line
    for (const e of order.slice(after + 1)) {
      for (const h of e.hunks) {
        const oldEnd = h.oldStart + h.oldLines
        if (n >= oldEnd) n += h.newLines - h.oldLines
        else if (n >= h.oldStart) return -1 // rewritten by a later edit
      }
    }
    return n
  }
  order.forEach((e, k) => {
    if (!mine.has(e.id)) return
    for (const h of e.hunks) {
      let n = h.newStart
      let pendingDel: string[] = []
      for (const l of h.lines) {
        if (l.startsWith('-')) { pendingDel.push(l.slice(1)); continue }
        if (pendingDel.length) {
          const at = shift(n, k)
          if (at > 0) removedAt.set(at, [...(removedAt.get(at) ?? []), ...pendingDel])
          pendingDel = []
        }
        if (l.startsWith('+')) { const at = shift(n, k); if (at > 0) added.add(at) }
        n++
      }
      if (pendingDel.length) { const at = shift(n, k); if (at > 0) removedAt.set(at, [...(removedAt.get(at) ?? []), ...pendingDel]) }
    }
  })
  return { added, removedAt }
}

// ---------------------------------------------------------------- asks

export function threadPrompt(t: Thread, code: string, groupTitle?: string): { visible: string; context: string } {
  const where = `${t.path}:${t.start}${t.end !== t.start ? `-${t.end}` : ''}`
  const visible = `${t.mode === 'ask' ? '❓' : '✎'} ${where} — ${t.text}`
  const how = t.mode === 'ask'
    ? 'This is a QUESTION about the code. Explain only: do not edit any file (edits are blocked this turn). Answer concisely and concretely, pointing at the lines.'
    : 'This is a CHANGE REQUEST for exactly this code. Make the change (and any needed follow-ups such as tests), then say in one line what you changed.'
  const context = [
    `The user pointed at ${where} in the Changes pane${groupTitle ? ` (part of "${groupTitle}")` : ''} and wrote: ${t.text}`,
    how,
    `Selected code (${where}):`,
    '```',
    code.slice(0, 6000),
    '```',
  ].join('\n')
  return { visible, context }
}

export function answerOf(reply: string): string {
  return stripGroupTags(reply).replace(/<(insight|progress)\b[^>]*\/?>(?:[\s\S]*?<\/\1>)?/g, '').trim().slice(0, 3000)
}

/**
 * Re-files a turn's edits by the labeller's per-file answer: existing concepts gain them, NEW
 * ones are created (same new id = one concept). Fallback groups the turn made ("Other changes",
 * a task name) and that end up empty are dropped.
 */
export function applyLabels(m: Model, turn: number, labels: readonly { path: string; id: string; isNew: boolean; title?: string; kind?: GroupKind; summary?: string }[]): Model {
  if (labels.length === 0) return m
  let groups = [...m.groups]
  for (const l of labels) {
    if (!l.isNew || groups.some(g => g.id === l.id)) continue
    groups.push({ id: l.id, kind: l.kind ?? 'feature', title: l.title ?? l.id, summary: l.summary ?? '', turn })
  }
  const byPath = new Map(labels.map(l => [l.path, l.id]))
  const edits = m.edits.map(e => (e.turn === turn && byPath.has(e.path) ? { ...e, group: byPath.get(e.path)! } : e))
  // touched concepts move to the end, so the cap keeps what is active
  const touched = new Set(byPath.values())
  groups = [...groups.filter(g => !touched.has(g.id)), ...groups.filter(g => touched.has(g.id)).map(g => ({ ...g, turn }))]
  return { ...m, edits, groups: trimGroups(groups, edits) }
}

/** Whether a group was made by the fallback rather than named by Claude or the labeller. */
export const isFallback = (g: Group) => g.id.startsWith('turn-') || g.id.startsWith('task-')
