import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Edit, GroupKind, Hunk, Model, Thread } from '../types'
import {
  EMPTY, answerOf, applyLabels, assign, isFallback, firstChanged, marks, readGroupTags, record, rows, stripGroupTags, symbolAt, threadPrompt,
} from './model.js'
import type { ViewerLine, ViewerProps } from './viewer.js'
import { GIT_ENV, NOLOCK, branchModel, parseDiff, parseLog } from './branch.js'
import { MAX_BYTES, MAX_FILES, candidates, diffHunks } from './shell.js'
import { describeEdits, labelPrompt, parseLabels } from './label.js'

const PANE = 'changes'
const TITLE = 'Changes'
const model = atom({ plugin: 'changes', key: 'model' } as const, EMPTY)

const KIND: Record<GroupKind, { icon: string; color: string; label: string }> = {
  feature: { icon: '✦', color: '#a78bfa', label: 'new' },
  behaviour: { icon: '◆', color: '#38bdf8', label: 'behaviour' },
  fix: { icon: '✚', color: '#34d399', label: 'fix' },
  refactor: { icon: '↻', color: '#f472b6', label: 'refactor' },
  test: { icon: '✓', color: '#facc15', label: 'tests' },
  config: { icon: '⚙', color: '#94a3b8', label: 'config' },
  removal: { icon: '−', color: '#f87171', label: 'removal' },
  docs: { icon: '¶', color: '#c4b5fd', label: 'docs' },
}

const GUIDE = `# Change grouping (changes mod: display only)
At the end of every turn in which you edited files, add one self-closing tag per concept you worked on, on its own line:
<change-group id="short-stable-slug" kind="feature|behaviour|fix|refactor|test|config|removal|docs" title="what changed, in plain words (<= 8 words)" summary="1-2 sentences: what it does now and why, for a reader who did not watch you"/>
Reuse an existing id (listed below) when the edits continue that concept, so related work stays together; mention the file or function names in the summary so edits can be matched. This only labels your work for the user's review pane: never change how you work because of it.`

/** Per-process session state the hooks share (not drawn, so not in $.state). */
const S: {
  turn: number
  task: string | undefined
  /** The thread the running turn is answering, and whether it is ask-only. */
  live: { id: string; mode: 'ask' | 'change' } | null
  queue: string[]
  draft: { mode: 'ask' | 'change'; path: string; start: number; end: number } | null
  cwd: string
  home: string
  /** The prompt that started the running turn: what the labeller reads as intent. */
  ask: string
  /** The branch view, built on demand (git), and why it could not be when it could not. */
  branch: { model: Model; base: string; root: string } | null
  branchNote: string
} = { turn: 0, task: undefined, live: null, queue: [], draft: null, cwd: '', home: '', ask: '', branch: null, branchNote: '' }

const rel = (p: string) => (S.cwd && p.startsWith(S.cwd + '/') ? p.slice(S.cwd.length + 1) : p)

export const register: Register = on => {
  S.turn = 0; S.task = undefined; S.live = null; S.queue = []; S.draft = null; S.branch = null; S.branchNote = ''

  on('session.start', async ($, e, next) => {
    // per session: a resume or /clear in the same process must not inherit a pending ask (which
    // would keep refusing edits), a queue, a draft or another session's branch view
    S.turn = 0; S.task = undefined; S.live = null; S.queue = []; S.draft = null; S.branch = null; S.branchNote = ''
    const r = await next(e)
    S.cwd = e.cwd
    S.home = (await $.env.get('HOME')) ?? ''
    await $.command.register({ name: 'changes', description: 'Review this session\'s changes by concept; point at code to ask or change', argumentHint: '[branch]' })
    let saved = (await $.store.get(`model:${await $.session.id()}`)) as Model | undefined
    // A resume that came back under a new id: carry over the session it continued from.
    if (!saved) { const prev = await predecessorOf($, e.cwd); if (prev) saved = (await $.store.get(`model:${prev}`)) as Model | undefined }
    if (saved && (await read($, model)).edits.length === 0) {
      await update($, model, () => ({ ...saved, nav: { ...saved.nav, level: 'groups' as const } }))
      S.turn = Math.max(0, ...saved.edits.map(x => x.turn), ...saved.threads.map(x => x.turn))
    }
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (!['clear', 'resume', 'fork'].includes(e.source)) return r
    S.turn = 0; S.task = undefined; S.live = null; S.queue = []; S.draft = null; S.branch = null; S.branchNote = ''; S.ask = ''
    S.cwd = e.cwd ?? S.cwd
    let saved = e.source === 'clear' ? undefined : await $.store.get(`model:${await $.session.id()}`) as Model | undefined
    if (!saved && e.source !== 'clear') { const prev = await predecessorOf($, S.cwd); if (prev) saved = await $.store.get(`model:${prev}`) as Model | undefined }
    await update($, model, () => saved ? { ...saved, nav: { ...EMPTY.nav } } : EMPTY)
    if (saved) S.turn = Math.max(0, ...saved.edits.map(x => x.turn), ...saved.threads.map(x => x.turn))
    return r
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const m = await read($, model)
    const ids = m.groups.slice(-12).map(g => `- ${g.id}: ${g.title}`).join('\n')
    const text = ids ? `${GUIDE}\n\nExisting groups (id: title):\n${ids}` : GUIDE
    return { ...r, sections: [...r.sections, { id: 'changes:guide', text, scope: 'session' }] }
  })

  on('turn.start', async ($, e, next) => {
    // a subagent's turns are not the main loop's: counting them would orphan the main turn's edits
    if (!(e as { agentId?: string }).agentId) { S.turn += 1; S.ask = String((e as { text?: string }).text ?? '').slice(0, 2000) }
    return next(e)
  })

  // A short nudge with each prompt: Claude labels its own work more often, so fewer fallback calls.
  on('prompt.submit', async ($, e, next) => {
    const nudge = 'Reminder from the changes mod: if this turn edits files, end your reply with the <change-group .../> tag(s) your system prompt describes (reuse an existing id when the work continues it).'
    return next({ ...e, context: [...(e.context ?? []), nudge] })
  })

  // ---- observe the task tools for the fallback group name ----
  on('tool.call', { tool: 'TaskUpdate' }, async ($, e, next) => {
    const r = await next(e)
    if (e.status === 'in_progress' && (e.activeForm || e.subject)) S.task = e.activeForm ?? e.subject
    return r
  })
  on('tool.call', { tool: 'TodoWrite' }, async ($, e, next) => {
    const r = await next(e)
    const t = e.todos.find(x => x.status === 'in_progress')
    if (t) S.task = t.content
    return r
  })

  // ---- record every edit (read-only; ask turns refuse them) ----
  on('tool.call', { tool: ['Edit', 'Write'] }, async ($, e, next) => {
    if (S.live?.mode === 'ask' && !e.agentId) {
      return { deny: 'This turn answers a question from the Changes pane: explain only, do not edit files. If a change is needed, say so and the user can ask for it.' }
    }
    const r = await next(e)
    if (r.deny !== undefined || r.isError || !r.result) return r
    const res = r.result as { filePath: string; structuredPatch: Hunk[]; type?: string; originalFile?: string | null; content?: string }
    const hunks = (res.structuredPatch ?? []).slice(0, 40)
    const created = res.type === 'create'
    if (hunks.length === 0 && !created) return r
    let lines: string[] = []
    try { lines = (await $.fs.read(res.filePath)).split('\n') } catch { /* gone again */ }
    const effective = created && hunks.length === 0 && res.content !== undefined
      ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: res.content.split('\n').length, lines: res.content.split('\n').slice(0, 400).map(l => '+' + l) }]
      : hunks
    const edit: Edit = {
      id: `${S.turn}-${Math.random().toString(36).slice(2, 8)}`,
      turn: S.turn, path: res.filePath, hunks: effective,
      symbols: effective.map(h => symbolAt(lines, firstChanged(h))),
      ...(created ? { created: true } : {}),
      ...(S.task ? { task: S.task } : {}),
          }
    await update($, model, m => record(m, edit))
    return r
  })

  // ---- shell edits: a Bash call has no patch, so the files it names are compared before/after ----
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const paths = candidates(e.command, S.cwd, S.home).slice(0, MAX_FILES * 2)
    const before = new Map<string, string | null>()
    for (const p of paths) {
      if (before.size >= MAX_FILES) break
      before.set(p, await readSmall($, p))
    }
    const r = await next(e)
    if (r.deny !== undefined || before.size === 0) return r
    const made: Edit[] = []
    for (const [p, was] of before) {
      const now = await readSmall($, p)
      const deleted = now === null && was !== null && !(await $.fs.exists(p))
      if ((now === null && !deleted) || now === was) continue
      const hunks = diffHunks(was ?? '', now ?? '')
      if (hunks.length === 0) continue
      const lines = (now ?? was ?? '').split('\n')
      made.push({
        id: `${S.turn}-${Math.random().toString(36).slice(2, 8)}`,
        turn: S.turn, path: p, hunks,
        symbols: hunks.map(h => symbolAt(lines, firstChanged(h))),
        ...(was === null ? { created: true } : {}),
        ...(deleted ? { deleted: true } : {}),
        ...(S.task ? { task: S.task } : {}),
      })
    }
    if (made.length > 0) await update($, model, m => made.reduce(record, m))
    return r
  })

  // ---- end of turn: group, answer threads, follow the next ask ----
  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const tags = readGroupTags(e.answer)
    const was = S.live
    S.live = null
    const m = await update($, model, cur => {
      let x = assign(cur, S.turn, tags)
      if (was) {
        x = {
          ...x,
          threads: x.threads.map(t => (t.id === was.id ? { ...t, status: 'answered', answer: answerOf(e.answer) || (e.isAborted ? '(interrupted)' : '(no answer)') } : t)),
        }
        if (was.mode === 'change') {
          // the change lands where it was asked: the viewer follows it
          const t = x.threads.find(y => y.id === was.id)
          const made = x.edits.filter(y => y.turn === S.turn)
          const same = made.find(y => t && y.path.endsWith(t.path))
          const target = same ?? made[0]
          if (target) {
            const g = target.group ?? x.edits.find(y => y.path === target.path)?.group
            x = { ...x, nav: { ...x.nav, level: 'code' as const, group: g, file: target.path }, focusSeq: x.focusSeq + 1 }
          }
        }
      }
      return x
    })
    let saved = m
    // Edits still in fallback groups ("Other changes"): this turn's first, then up to two older
    // turns (sessions from before the labeller), one small call per turn, oldest first.
    const unlabelled = [...new Set(m.edits.filter(x => m.groups.some(g => g.id === x.group && isFallback(g))).map(x => x.turn))]
    const todo = [...(unlabelled.includes(S.turn) && tags.length === 0 ? [S.turn] : []), ...unlabelled.filter(t => t !== S.turn).sort((a, b) => a - b).slice(0, 2)]
    for (const t of todo) {
      try {
        const cur = await read($, model)
        const turnEdits = cur.edits.filter(x => x.turn === t)
        const known = cur.groups.filter(g => !isFallback(g))
        const reply = await $.model.complete({
          model: 'haiku', effort: 'low', maxTokens: 600, timeoutMs: 30000,
          prompt: labelPrompt(t === S.turn ? S.ask : '', describeEdits(turnEdits, rel), known),
        })
        if (reply.isAnswered) {
          const labels = parseLabels(reply.text, [...new Set(turnEdits.map(x => x.path))], new Set(known.map(g => g.id)), rel)
          if (labels.length > 0) saved = await update($, model, x => applyLabels(x, t, labels))
        }
      } catch { /* the fallback group stays: still shown, just unnamed */ }
    }
    await persist($, saved)
    if (was) {
      const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
      if (!isOpen) void $.ui.open({ id: PANE, title: TITLE })
      if (was.mode === 'change') $.ui.toast('Changes: the edit is open in the pane')
    }
    const nextId = S.queue.shift()
    if (nextId) void sendThread($, nextId)
    return r
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    if (!e.props.text.includes('<change-group')) return next(e)
    return next({ ...e, props: { ...e.props, text: stripGroupTags(e.props.text) } })
  })

  // ---- the command ----
  on('command.run', { command: 'changes' }, async ($, e) => {
    const arg = e.args.trim()
    const open = (await $.ui.panes()).some(p => p.id === PANE)
    if (open && arg === '') { await $.ui.close({ id: PANE }); return {} }
    if (arg === 'branch') await loadBranch($)
    if (arg === 'session') await update($, model, m => ({ ...m, nav: { ...m.nav, scope: 'session' as const, level: 'groups' as const } }))
    await $.ui.open({ id: PANE, title: TITLE, focus: true, closeOnEscape: true })
    return {}
  })

  // ---- the viewer's posts ----
  on('ui.message', { requestId: PANE }, async ($, e) => {
    const d = e.data as { type: string; mode?: 'ask' | 'change'; start?: number; end?: number; step?: number }
    const sm = await read($, model)
    const m: Model = sm.nav.scope === 'branch' && S.branch ? { ...S.branch.model, nav: sm.nav, reviewed: sm.reviewed, threads: sm.threads } : sm
    if (d.type === 'back') { await update($, model, x => ({ ...x, nav: { ...x.nav, level: 'files' as const } })); return {} }
    if (d.type === 'reviewed' && m.nav.group && m.nav.file) {
      const k = `${m.nav.group}|${m.nav.file}`
      const n = await update($, model, x => ({ ...x, reviewed: x.reviewed.includes(k) ? x.reviewed.filter(y => y !== k) : [...x.reviewed, k] }))
      await persist($, n)
      return {}
    }
    if (d.type === 'file' && m.nav.group) {
      const files = rows(m).find(g => g.id === m.nav.group)?.files ?? []
      const i = files.findIndex(f => f.path === m.nav.file)
      const f = files[(i + (d.step ?? 1) + files.length) % files.length]
      if (f) await update($, model, x => ({ ...x, nav: { ...x.nav, file: f.path }, focusSeq: x.focusSeq + 1 }))
      return {}
    }
    if (d.type === 'ask' && m.nav.file && d.mode) {
      S.draft = { mode: d.mode, path: m.nav.file, start: d.start ?? 1, end: d.end ?? d.start ?? 1 }
      void $.ui.invalidate('ui.render')
      return {}
    }
    return {}
  })

  // ---- drawing ----
  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e, next) => {
    if (e.surface !== 'terminal' && e.surface !== 'desktop') return next(e)
    const { Box, Text, Button, Input, Client } = $.ui.resolve(e)
    const sm = await read($, model)
    const isBranch = sm.nav.scope === 'branch' && S.branch !== null
    const m: Model = isBranch ? { ...S.branch!.model, nav: sm.nav, focusSeq: sm.focusSeq, threads: sm.threads, reviewed: sm.reviewed } : sm
    const w = Math.max(30, e.props.bodyColumns - 1)
    const groups = rows(m)
    const toggleScope = async () => {
      if (isBranch) await update($, model, x => ({ ...x, nav: { ...x.nav, scope: 'session' as const, level: 'groups' as const } }))
      else await loadBranch($)
    }
    const pending = m.threads.filter(t => t.status === 'pending').length

    const header = (
      <Box flexDirection="row" justifyContent="space-between">
        <Text bold color="#e5e7eb">{isBranch ? 'Branch changes' : 'What changed'}
          <Text dimColor>{`  · ${isBranch ? `since ${S.branch!.base}` : 'this session'} · ${groups.length} concept${groups.length === 1 ? '' : 's'}`}</Text>
        </Text>
        <Box flexDirection="row" columnGap={2}>
          {pending > 0 && <Text color="#fbbf24">{`⧗ ${pending} queued`}</Text>}
          <Button key="scope" label={isBranch ? 'session' : 'branch'} plain hotkey="s" onPress={toggleScope} />
        </Box>
      </Box>
    )

    if (groups.length === 0) {
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          <Text dimColor wrap="wrap">{isBranch ? 'No changes against the base branch.' : 'No edits yet this session. As Claude changes files, they appear here grouped by what they are for. Press s for the whole branch.'}</Text>
          {S.branchNote !== '' && <Text color="#fbbf24" wrap="wrap">{S.branchNote}</Text>}
        </Box>
      )
    }

    // ---------- level 1: concepts ----------
    if (m.nav.level === 'groups' || !m.nav.group) {
      const total = groups.reduce((s, g) => s + g.files.length, 0)
      const done = groups.reduce((s, g) => s + g.reviewedFiles, 0)
      return (
        <Box flexDirection="column" gap={1}>
          {header}
          {groups.map((g, i) => {
            const k = KIND[g.kind]
            const allDone = g.reviewedFiles === g.files.length
            return (
              <Box key={`g-${g.id}`} flexDirection="column">
                <Box flexDirection="row" columnGap={1}>
                  <Text color={k.color} bold>{k.icon}</Text>
                  <Button key={`open-${g.id}`} label={g.title.slice(0, Math.max(12, w - 26))} plain {...(i < 9 ? { hotkey: String(i + 1) } : {})} {...(i === 0 ? { autoFocus: true as const } : {})}
                    onPress={() => update($, model, x => ({ ...x, nav: { ...x.nav, level: 'files' as const, group: g.id } }))} />
                </Box>
                <Box flexDirection="row" columnGap={1} marginLeft={2}>
                  <Text color={k.color} dimColor>{k.label}</Text>
                  <Text dimColor>· {g.files.length} file{g.files.length === 1 ? '' : 's'}</Text>
                  <Text color="#34d399">+{g.add}</Text>
                  {g.del > 0 && <Text color="#f87171">−{g.del}</Text>}
                  {allDone ? <Text color="#34d399">✔</Text> : g.reviewedFiles > 0 ? <Text dimColor>{g.reviewedFiles}/{g.files.length} reviewed</Text> : null}
                </Box>
                {g.summary !== '' && <Box marginLeft={2}><Text dimColor wrap="wrap">{g.summary}</Text></Box>}
              </Box>
            )
          })}
          {S.branchNote !== '' && <Text color="#fbbf24" wrap="wrap">{S.branchNote}</Text>}
          <Text dimColor>{`${done}/${total} files reviewed · 1-9 or Enter open · s ${isBranch ? 'session' : 'branch'} · Esc closes`}</Text>
        </Box>
      )
    }

    const g = groups.find(x => x.id === m.nav.group) ?? groups[0]!
    const k = KIND[g.kind]
    const back = (to: 'groups' | 'files') => update($, model, x => ({ ...x, nav: { ...x.nav, level: to } } as Model))

    // ---------- level 2: files of a concept ----------
    if (m.nav.level === 'files' || !m.nav.file) {
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" columnGap={1}>
            <Button key="back" label="‹ All changes" plain hotkey="b" onPress={() => back('groups')} />
          </Box>
          <Box flexDirection="column">
            <Text color={k.color} bold>{k.icon} {g.title}</Text>
            {g.summary !== '' && <Text wrap="wrap">{g.summary}</Text>}
          </Box>
          {g.files.map((f, i) => {
            const done = m.reviewed.includes(`${g.id}|${f.path}`)
            return (
              <Box key={`f-${f.path}`} flexDirection="column">
                <Box flexDirection="row" columnGap={1}>
                  <Text color={done ? '#34d399' : '#5b6170'}>{done ? '✔' : '○'}</Text>
                  <Button key={`file-${i}`} label={rel(f.path).slice(-Math.max(12, w - 22))} plain {...(i < 9 ? { hotkey: String(i + 1) } : {})} {...(i === 0 ? { autoFocus: true as const } : {})}
                    onPress={() => update($, model, x => ({ ...x, nav: { ...x.nav, level: 'code' as const, file: f.path }, focusSeq: x.focusSeq + 1 }))} />
                  <Text color="#34d399">+{f.add}</Text>
                  {f.del > 0 && <Text color="#f87171">−{f.del}</Text>}
                  {f.deleted && <Text color="#f38ba8">deleted</Text>}
                  {f.created && !f.deleted && <Text color="#a78bfa">new</Text>}
                </Box>
                {f.symbols.length > 0 && (
                  <Box marginLeft={2}><Text color="#a78bfa" dimColor wrap="truncate-end">ƒ {f.symbols.slice(0, 4).join(' · ')}{f.symbols.length > 4 ? ` +${f.symbols.length - 4}` : ''}</Text></Box>
                )}
              </Box>
            )
          })}
        </Box>
      )
    }

    // ---------- level 3: the pointable code ----------
    const path = m.nav.file
    const file = g.files.find(f => f.path === path)
    let text = ''
    try { text = await $.fs.read(path) } catch { text = '' }
    const src = text.split('\n')
    const allForFile = m.edits.filter(x => x.path === path)
    const mk = marks(file?.edits ?? [], allForFile)
    const lines: ViewerLine[] = src.map((t, i) => ({
      n: i + 1, text: t,
      ...(mk.added.has(i + 1) ? { mark: 'add' as const } : {}),
      ...(mk.removedAt.has(i + 1) ? { removed: mk.removedAt.get(i + 1)! } : {}),
    }))
    const latest = allForFile.at(-1)
    if (latest?.deleted) {
      const removed = latest.hunks.flatMap(h => h.lines.filter(l => l.startsWith('-')).map(l => l.slice(1)))
      lines.splice(0, lines.length, { n: 1, text: '', removed })
    }
    // keep the viewer light: the marked regions with generous context, whole small files
    const keep = new Set<number>()
    const ctx = 12
    if (src.length <= 400) src.forEach((_, i) => keep.add(i))
    else for (const l of lines) if (l.mark || l.removed) for (let j = l.n - 1 - ctx; j <= l.n - 1 + ctx; j++) if (j >= 0 && j < src.length) keep.add(j)
    const shown = lines.filter((_, i) => keep.has(i)).slice(0, 1200)
    const firstMark = shown.find(l => l.mark || l.removed)?.n ?? 1
    const symbols = symbolsOf(src)
    const threads = m.threads.filter(t => t.path === rel(path))
    const viewerProps: ViewerProps = {
      path: rel(path), lines: shown, cursor: firstMark, jump: m.focusSeq, symbols,
      threads: threads.map(t => ({ start: t.start, end: t.end, mode: t.mode, text: t.text, ...(t.answer ? { answer: t.answer } : {}), pending: t.status === 'pending' })),
      height: Math.max(6, (e.props.scroll?.bodyRows ?? 30) - (S.draft ? 7 : 5)),
      reviewed: m.reviewed.includes(`${g.id}|${path}`),
    }
    const fileIdx = g.files.findIndex(f => f.path === path)

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={1}>
          <Button key="back-files" label="‹" plain hotkey="b" onPress={() => back('files')} />
          <Text color={k.color}>{k.icon}</Text>
          <Text bold wrap="truncate-end">{rel(path)}</Text>
          <Text dimColor>{`${fileIdx + 1}/${g.files.length}`}</Text>
        </Box>
        <Client key="viewer" module="./viewer.tsx" props={viewerProps} flexGrow={1} />
        {S.draft ? (
          <Box flexDirection="column" borderStyle="round" borderColor={S.draft.mode === 'ask' ? '#60a5fa' : '#fbbf24'}>
            <Text color={S.draft.mode === 'ask' ? '#60a5fa' : '#fbbf24'} bold>
              {`${S.draft.mode === 'ask' ? '❓ Ask about' : '✎ Change'} ${rel(S.draft.path)}:${S.draft.start}${S.draft.end !== S.draft.start ? `-${S.draft.end}` : ''}`}
              <Text dimColor>  (Enter sends · Esc cancels)</Text>
            </Text>
            <Input key="ask-input" placeholder={S.draft.mode === 'ask' ? 'What do you want to know about these lines?' : 'What should change here?'} value="" autoFocus
              onSubmit={async (v: string) => {
                const d = S.draft
                S.draft = null
                if (!d || !v.trim()) { void $.ui.invalidate('ui.render'); return }
                const t: Thread = { id: Math.random().toString(36).slice(2, 9), path: rel(d.path), start: d.start, end: d.end, mode: d.mode, text: v.trim(), turn: S.turn, status: 'pending' }
                await update($, model, x => ({ ...x, threads: [...x.threads, t].slice(-200) }))
                if (S.live) { S.queue.push(t.id); $.ui.toast('Queued: it runs after the current turn') }
                else void sendThread($, t.id)
              }} />
          </Box>
        ) : (
          <Text dimColor wrap="truncate-end">↑↓/jk move · v select · f function · a ask · c change · n/p next change · [ ] file · r reviewed · t note · x removed · ‹ b back</Text>
        )}
      </Box>
    )
  })

  // Esc in the prompt bar cancels the draft rather than leaving the pane.
  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (S.draft && e.origin.kind === 'person') { S.draft = null; void $.ui.invalidate('ui.render'); return { deny: 'cancelled the ask' } }
    return next(e)
  })

}

/** A text file's contents, or null when it is missing, too big, binary or unreadable. */
async function readSmall($: import('claude-code').EngineInterface, path: string): Promise<string | null> {
  try {
    const t = await $.fs.read(path)
    if (t.length > MAX_BYTES || t.includes('\u0000')) return null
    return t
  } catch {
    return null
  }
}

/** Reads the branch's changes with git and switches the pane to them. */
async function loadBranch($: import('claude-code').EngineInterface): Promise<void> {
  const git = (args: string[]) => $.process.run(['git', NOLOCK, ...args], { cwd: S.cwd, env: { ...GIT_ENV }, timeoutMs: 15000 })
  S.branchNote = ''
  const top = await git(['rev-parse', '--show-toplevel'])
  if (top.exitCode !== 0) { S.branchNote = 'Not a git repository: branch view needs git.'; void $.ui.invalidate('ui.render'); return }
  const root = top.stdout.trim()
  let base = ''
  const sym = await git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
  const named = sym.exitCode === 0 ? sym.stdout.trim() : ''
  for (const cand of [named, 'origin/main', 'origin/master', 'main', 'master'].filter(Boolean)) {
    if ((await git(['rev-parse', '--verify', '--quiet', cand])).exitCode === 0) { base = cand; break }
  }
  if (!base) { S.branchNote = 'No base branch found (origin/HEAD, main or master).'; void $.ui.invalidate('ui.render'); return }
  const mb = await git(['merge-base', 'HEAD', base])
  const from = mb.exitCode === 0 ? mb.stdout.trim() : base
  const diff = await git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--no-textconv', '-U3', from])
  const log = await git(['log', '--name-only', '--format=%x1e%h%x1f%s', `${from}..HEAD`])
  const wip = await git(['-c', 'core.quotePath=false', 'diff', '--no-ext-diff', '--name-only', 'HEAD'])
  const files = parseDiff(diff.stdout)
  const cache = new Map<string, string[]>()
  for (const p of [...files.keys()].slice(0, 200)) {
    try { cache.set(`${root}/${p}`, (await $.fs.read(`${root}/${p}`)).split('\n')) } catch { cache.set(`${root}/${p}`, []) }
  }
  const session = await read($, model)
  S.branch = { model: branchModel(root, files, parseLog(log.stdout), new Set(wip.stdout.split('\n').filter(Boolean)), session, a => cache.get(a) ?? []), base: base.replace(/^origin\//, ''), root }
  if (diff.isStdoutTruncated) S.branchNote = 'The branch diff is very large; it was cut.'
  await update($, model, x => ({ ...x, nav: { ...x.nav, scope: 'branch' as const, level: 'groups' as const } }))
}

/** Sends one thread to Claude as a visible prompt with the code attached. */
async function sendThread($: import('claude-code').EngineInterface, id: string): Promise<void> {
  const m = await read($, model)
  const t = m.threads.find(x => x.id === id)
  if (!t) return
  const abs = t.path.startsWith('/') ? t.path : `${S.cwd}/${t.path}`
  let code = ''
  try { code = (await $.fs.read(abs)).split('\n').slice(t.start - 1, t.end).map((l, i) => `${t.start + i}  ${l}`).join('\n') } catch { /* file gone */ }
  const g = m.groups.find(x => x.id === m.nav.group)
  const p = threadPrompt(t, code, g?.title)
  S.live = { id: t.id, mode: t.mode }
  void $.prompt.submit({ text: `${p.visible}\n\n${p.context}`, asUser: true })
}

/** Definition spans for the viewer's `f` key: each definition runs to the line before the next at the same or lower indent. */
function symbolsOf(src: readonly string[]): { name: string; start: number; end: number }[] {
  const out: { name: string; start: number; end: number; indent: number }[] = []
  const ind = (s: string) => (/^\s*/.exec(s)?.[0].length ?? 0)
  src.forEach((l, i) => {
    const name = definedAtLine(l)
    if (name) out.push({ name, start: i + 1, end: src.length, indent: ind(l) })
  })
  for (const s of out) {
    for (let j = s.start; j < src.length; j++) {
      const l = src[j] ?? ''
      if (l.trim() === '') continue
      if (ind(l) <= s.indent && !/^\s*[)}\]]/.test(l)) { s.end = j; break }
      if (ind(l) <= s.indent && /^\s*[)}\]]/.test(l)) { s.end = j + 1; break }
    }
  }
  return out.map(({ name, start, end }) => ({ name, start, end }))
}

import { definedAt as definedAtLine } from './model.js'

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

/**
 * Saves the session's model within the store's budget. The store is one file for every session
 * (4 MB cap), so: diffs are trimmed to their first lines, and the oldest other sessions are
 * dropped until the whole store fits. A save that still fails never breaks the turn.
 */
async function persist($: import('claude-code').EngineInterface, m: Model): Promise<void> {
  const LINES = 60
  const slim: Model = {
    ...m,
    edits: m.edits.slice(-300).map(e => ({ ...e, hunks: e.hunks.slice(0, 12).map(h => ({ ...h, lines: h.lines.slice(0, LINES) })) })),
    threads: m.threads.slice(-60),
  }
  const key = `model:${await $.session.id()}`
  try {
    const keys = (await $.store.keys()).filter(k => k.startsWith('model:') && k !== key)
    // keep at most 6 other sessions, oldest first out
    for (const k of keys.slice(0, Math.max(0, keys.length - 6))) await $.store.delete(k)
    await $.store.set(key, slim)
  } catch {
    try {
      for (const k of (await $.store.keys()).filter(k => k.startsWith('model:') && k !== key)) await $.store.delete(k)
      await $.store.set(key, slim)
    } catch { /* still too big: this session's pane lives in memory only */ }
  }
}
