/* Shell edits: Bash calls that change files (sed -i, heredocs, scripts) give no structured patch,
   so the files a command names are read before and after it runs and the difference is diffed here. */
import type { Hunk } from '../types'

export const MAX_FILES = 40
export const MAX_BYTES = 512 * 1024

const SKIP_DIR = /(^|\/)(\.git|node_modules|\.venv|venv|__pycache__|dist|build|\.next|target)(\/|$)/
const BINARY_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|tar|jar|class|so|dylib|o|a|bin|pcap|pcapng|mp4|mov|woff2?|ttf|lock)$/i

/**
 * The files a shell command may touch, as absolute paths: path-like words in it, with simple
 * `NAME=value` assignments and `$NAME`/`${NAME}`/`~` expanded, resolved against the session's
 * directory and any directory the command `cd`s into.
 */
export function candidates(command: string, cwd: string, home: string): string[] {
  const vars = new Map<string, string>([['HOME', home]])
  for (const m of command.matchAll(/(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=("([^"]*)"|'([^']*)'|([^\s;&|)]+))/g)) {
    vars.set(m[1]!, m[3] ?? m[4] ?? m[5] ?? '')
  }
  const expand = (s: string) => {
    let out = s
    for (let i = 0; i < 3; i++) {
      out = out.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (all, a, b) => vars.get(a ?? b) ?? all)
    }
    return out.replace(/^~(?=\/|$)/, home)
  }
  const bases = [cwd]
  for (const m of command.matchAll(/(?:^|[;&|(]\s*)cd\s+("([^"]+)"|'([^']+)'|([^\s;&|)]+))/g)) {
    const d = expand(m[2] ?? m[3] ?? m[4] ?? '')
    if (d && !d.includes('$')) bases.push(d.startsWith('/') ? d : `${cwd}/${d}`)
  }
  const out = new Set<string>()
  // words that look like file paths: contain a slash or end in an extension
  for (const m of command.matchAll(/(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|~|\.{1,2}|\/)?[A-Za-z0-9_@%+=:,.\/{}$~-]*[A-Za-z0-9_-]\.[A-Za-z0-9]{1,8}\b|(?:\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|~)\/[A-Za-z0-9_@%+=:,.\/{}$-]+/g)) {
    const raw = expand(m[0].replace(/[,:]+$/, ''))
    if (raw.includes('$') || raw.includes('*') || /^[a-z]+:\/\//i.test(raw) || raw.length > 400) continue
    if (BINARY_EXT.test(raw)) continue
    const tries = raw.startsWith('/') ? [raw] : bases.map(b => `${b}/${raw}`)
    for (const t of tries) {
      const p = normalize(t)
      if (SKIP_DIR.test(p) || p === '/' ) continue
      out.add(p)
    }
    if (out.size >= MAX_FILES * 2) break
  }
  return [...out]
}

export function normalize(p: string): string {
  const parts: string[] = []
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return '/' + parts.join('/')
}

/**
 * Unified-diff hunks (3 lines of context) between two texts. Common prefix and suffix are trimmed,
 * then the middle is diffed line by line (LCS); a middle too large to diff cheaply becomes one
 * replace hunk, which is still correct, just coarser.
 */
export function diffHunks(before: string, after: string, context = 3): Hunk[] {
  if (before === after) return []
  const a = before === '' ? [] : before.split('\n'), b = after === '' ? [] : after.split('\n')
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf), bm = b.slice(pre, b.length - suf)

  // ops over the middle: ' ' keep, '-' delete, '+' insert
  type Op = { t: ' ' | '-' | '+'; s: string }
  let ops: Op[]
  if (am.length * bm.length > 4_000_000) {
    ops = [...am.map(s => ({ t: '-' as const, s })), ...bm.map(s => ({ t: '+' as const, s }))]
  } else {
    const n = am.length, m = bm.length
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i]![j] = am[i] === bm[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!)
    ops = []
    let i = 0, j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) { ops.push({ t: ' ', s: am[i]! }); i++; j++ }
      else if (L[i + 1]![j]! >= L[i]![j + 1]!) ops.push({ t: '-', s: am[i++]! })
      else ops.push({ t: '+', s: bm[j++]! })
    }
    while (i < n) ops.push({ t: '-', s: am[i++]! })
    while (j < m) ops.push({ t: '+', s: bm[j++]! })
  }
  // the whole file as ops, then cut into hunks around the changes
  const all: Op[] = [...a.slice(0, pre).map(s => ({ t: ' ' as const, s })), ...ops, ...a.slice(a.length - suf).map(s => ({ t: ' ' as const, s }))]
  const changed = all.map((o, k) => (o.t !== ' ' ? k : -1)).filter(k => k >= 0)
  const hunks: Hunk[] = []
  let k = 0
  while (k < changed.length) {
    let start = Math.max(0, changed[k]! - context)
    let end = Math.min(all.length - 1, changed[k]! + context)
    while (k + 1 < changed.length && changed[k + 1]! - context <= end + 1) { k++; end = Math.min(all.length - 1, changed[k]! + context) }
    k++
    // line numbers at `start`
    let oldStart = 1, newStart = 1
    for (let x = 0; x < start; x++) { if (all[x]!.t !== '+') oldStart++; if (all[x]!.t !== '-') newStart++ }
    const slice = all.slice(start, end + 1)
    const oldLines = slice.filter(o => o.t !== '+').length
    const newLines = slice.filter(o => o.t !== '-').length
    hunks.push({ oldStart: oldLines === 0 ? oldStart - 1 : oldStart, oldLines, newStart: newLines === 0 ? newStart - 1 : newStart, newLines, lines: slice.map(o => o.t + o.s) })
  }
  return hunks.slice(0, 40)
}
