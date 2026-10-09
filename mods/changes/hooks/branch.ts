/* Branch scope: the changes since the base branch, read from git and shaped like the session's
   model (edits + groups), so the same pane and viewer show them. No model call: each commit's
   subject is its concept; a file goes under the newest commit that touched it. */
import type { Edit, Group, Hunk, Model } from '../types'
import { EMPTY, slug, symbolAt } from './model.js'

export const GIT_ENV = { LC_ALL: 'C', LANGUAGE: '' } as const
export const NOLOCK = '--no-optional-locks'

/** Parses `git diff -U3` output into per-file hunks (renames read as their new path). */
export function parseDiff(out: string): Map<string, Hunk[]> {
  const files = new Map<string, Hunk[]>()
  let path: string | null = null
  let h: Hunk | null = null
  let oldPath: string | null = null
  for (const line of out.split('\n')) {
    if (line.startsWith('diff --git ')) { h = null; path = null; oldPath = null; continue }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4).trim()
      path = p === '/dev/null' ? oldPath : p.replace(/^b\//, '')
      if (path && !files.has(path)) files.set(path, [])
      continue
    }
    if (line.startsWith('--- ')) { oldPath = line.slice(4).trim().replace(/^a\//, ''); continue }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
    if (m && path) {
      h = { oldStart: Number(m[1]), oldLines: m[2] === undefined ? 1 : Number(m[2]), newStart: Number(m[3]), newLines: m[4] === undefined ? 1 : Number(m[4]), lines: [] }
      files.get(path)!.push(h)
      continue
    }
    if (h && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) h.lines.push(line)
  }
  for (const [p, hs] of files) if (hs.length === 0) files.delete(p)
  return files
}

export type Commit = { sha: string; subject: string; files: string[] }

/** Parses `git log --name-only --format=%x1e%h%x1f%s` (newest first). */
export function parseLog(out: string): Commit[] {
  return out.split('\x1e').map(c => c.trim()).filter(Boolean).map(c => {
    const [head, ...rest] = c.split('\n')
    const [sha = '', subject = ''] = (head ?? '').split('\x1f')
    return { sha, subject, files: rest.map(f => f.trim()).filter(Boolean) }
  })
}

const KIND_OF = (s: string): Group['kind'] =>
  /^(fix|bug|hotfix)\b/i.test(s) ? 'fix'
  : /^(test|tests)\b/i.test(s) ? 'test'
  : /^(refactor|cleanup|chore)\b/i.test(s) ? 'refactor'
  : /^(docs?)\b/i.test(s) ? 'docs'
  : /^(ci|build|config|deps)\b/i.test(s) ? 'config'
  : /^(remove|delete|drop)\b/i.test(s) ? 'removal'
  : 'feature'

/**
 * The branch model: one group per commit (subject as title, conventional prefix as kind),
 * uncommitted work as its own group, and the session's group used instead for files this
 * session edited, so its concepts carry over.
 */
export function branchModel(
  root: string, diff: Map<string, Hunk[]>, log: readonly Commit[], uncommitted: ReadonlySet<string>,
  session: Model, read: (abs: string) => string[],
): Model {
  const owner = new Map<string, Commit | 'wip'>()
  for (const p of diff.keys()) if (uncommitted.has(p)) owner.set(p, 'wip')
  for (const c of log) for (const f of c.files) if (diff.has(f) && !owner.has(f)) owner.set(f, c)
  const sessionGroup = new Map<string, string>()
  for (const e of session.edits) if (e.group) sessionGroup.set(e.path, e.group)

  const groups: Group[] = []
  const add = (g: Group) => { if (!groups.some(x => x.id === g.id)) groups.push(g) }
  const edits: Edit[] = []
  let i = 0
  for (const [p, hunks] of diff) {
    const abs = `${root}/${p}`
    const sg = sessionGroup.get(abs)
    const own = owner.get(p)
    let gid: string
    if (sg) {
      const g = session.groups.find(x => x.id === sg)
      if (g) add({ ...g, turn: 0 })
      gid = sg
    } else if (own && own !== 'wip') {
      gid = `c-${own.sha}`
      add({ id: gid, kind: KIND_OF(own.subject), title: own.subject.replace(/^\w+(\([^)]*\))?!?:\s*/, '').slice(0, 70) || own.subject, summary: `commit ${own.sha}`, turn: 0 })
    } else {
      gid = 'wip'
      add({ id: gid, kind: 'feature', title: 'Uncommitted work', summary: 'Changes in the working tree that are not in a commit yet.', turn: 0 })
    }
    const lines = read(abs)
    edits.push({ id: `b${i++}`, turn: 0, path: abs, hunks, ...(hunks.some(h => h.newStart === 0 && h.newLines === 0) ? { deleted: true } : {}), symbols: hunks.map(h => symbolAt(lines, h.newStart)), group: gid })
  }
  // newest commit first, matching the session view (rows() reverses)
  const order = (g: Group) => g.id === 'wip' ? -1 : g.id.startsWith('c-') ? log.findIndex(c => `c-${c.sha}` === g.id) : -2
  groups.sort((a, b) => order(b) - order(a))
  return { ...EMPTY, edits, groups, threads: session.threads, reviewed: session.reviewed, nav: { ...session.nav, scope: 'branch' } }
}

export { slug }
