import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { EMPTY, hintLine, isRealPrompt, markLoaded, parseSuggestions, suggestPrompt } from './suggest.js'
import type { Skill } from './suggest.js'

const model = atom({ plugin: 'skills', key: 'model' } as const, EMPTY)

/** Process state (not drawn): the prompt counter and the skill list, fetched once. */
const S: { turn: number; skills: Skill[] } = { turn: 0, skills: [] }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    S.turn = 0; S.skills = []
    await update($, model, () => EMPTY)
    return next(e)
  })

  // Shown live in the hint row under the prompt; a pick disappears once Claude (or you) loads it.
  on('ui.render', { component: 'PromptHint' }, async ($, e, next) => {
    const line = hintLine(await read($, model), Math.max(20, (e.viewport?.columns ?? 100) - 40))
    if (!line) return next(e)
    return next({ ...e, props: { ...e.props, tail: line } })
  })

  // Each real prompt: ask haiku for the top skills, in the background so the turn never waits.
  on('prompt.submit', async ($, e, next) => {
    const text = String(e.text ?? '')
    if (!isRealPrompt(text)) return next(e)
    const turn = ++S.turn
    await update($, model, () => ({ ...EMPTY, turn, pending: true }))
    void pick($, text, turn)
    return next(e)
  })

  // Claude loading a skill, or you running one by name, removes it from the picks.
  on('tool.call', { tool: 'Skill' }, async ($, e, next) => {
    const r = await next(e)
    if (r.deny === undefined && !r.isError && !e.agentId) await update($, model, m => markLoaded(m, e.skill))
    return r
  })
  on('command.run', async ($, e, next) => {
    const r = await next(e)
    if (S.skills.some(x => x.name === e.command)) await update($, model, m => markLoaded(m, e.command))
    return r
  })
}

async function pick($: import('claude-code').EngineInterface, text: string, turn: number): Promise<void> {
  try {
    if (S.skills.length === 0) {
      const list = await $.command.list()
      S.skills = list.filter(c => c.source === 'user' || c.source === 'plugin').map(c => ({ name: c.name, description: c.description }))
    }
    const reply = await $.model.complete({ model: 'haiku', effort: 'low', maxTokens: 200, timeoutMs: 30000, prompt: suggestPrompt(text, S.skills) })
    const picks = reply.isAnswered ? parseSuggestions(reply.text, new Set(S.skills.map(x => x.name))) : []
    await update($, model, m => (m.turn !== turn ? m : { ...m, pending: false, suggestions: picks.filter(p => !m.loaded.includes(p.name)) }))
  } catch {
    await update($, model, m => (m.turn !== turn ? m : { ...m, pending: false }))
  }
}
