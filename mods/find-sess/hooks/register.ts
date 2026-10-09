import type { Register } from 'claude-code'
import type { Digest } from './pick.js'
import { parsePicks, pickPrompt } from './pick.js'

/** The last search's matches, so `/find-sess 2` can resume the second. */
let found: Digest[] = []
let generation = 0

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    found = []; generation++
    await $.command.register({ name: 'find-sess', description: 'Find a past session in this repo: /find-sess <what you remember> · /find-sess <n> resumes match n', argumentHint: '<what you remember> | <n>' })
    return r
  })

  on('classic.SessionStart', async (_$, e, next) => { found = []; generation++; return next(e) })

  on('command.run', { command: 'find-sess' }, async ($, e) => {
    const q = e.args.trim()
    if (!q) return { text: 'Usage: /find-sess <what you remember>, then /find-sess <n> to open a match.' }

    if (/^[1-5]$/.test(q)) {
      const d = found[Number(q) - 1]
      if (!d) return { text: 'No such match. Search first: /find-sess <what you remember>' }
      // A command hook can't run another command while it runs; queue it for when it's done.
      $.clock.after(50, () => { void $.command.run({ command: 'resume', args: d.id }).catch(() => undefined) })
      return { text: `Opening "${d.title}"… If it doesn't switch: claude --resume ${d.id}` }
    }

    found = []
    const search = ++generation
    const home = (await $.env.get('HOME')) ?? ''
    const dir = `${home}/.claude/projects/${(await $.session.cwd()).replace(/[^A-Za-z0-9]/g, '-')}`
    const run = await $.process.run(['python3', `${$.plugin.root}/hooks/digest.py`, dir, await $.session.id(), '100', q], { timeoutMs: 180000 })
    let ds: Digest[] = []
    try { ds = JSON.parse(run.stdout) as Digest[] } catch { /* below */ }
    if (ds.length === 0) return { text: `No past sessions found for this repo (${dir}).` }

    const reply = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 400, timeoutMs: 60000, prompt: pickPrompt(q, ds) })
    const picks = reply.isAnswered ? parsePicks(reply.text, ds.length) : []
    if (picks.length === 0) return { text: `No match in the last ${ds.length} sessions for "${q}".` }
    if (search !== generation) return { text: 'Search superseded by a newer search or session switch.' }
    found = picks.map(p => ds[p.n - 1]!)
    const lines = picks.map((p, i) => { const d = ds[p.n - 1]!; return `  ${i + 1}. ${d.title}  (${d.date}${d.branch ? ` · ${d.branch}` : ''})\n     ${p.why}` })
    return { text: `Matches in the last ${ds.length} sessions:\n${lines.join('\n')}\n\nOpen one: /find-sess <number>` }
  })
}
