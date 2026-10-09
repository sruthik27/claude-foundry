import type { SkillsModel, Suggestion } from '../types'

export const EMPTY: SkillsModel = { turn: 0, pending: false, suggestions: [], loaded: [] }

export type Skill = { name: string; description: string }

/** Prompts worth suggesting for: typed by a person, with words in them. */
export function isRealPrompt(text: string): boolean {
  const t = text.trim()
  if (t.length < 12) return false
  if (/^</.test(t)) return false // notifications, command envelopes, system text
  if (/^\/\S+\s*$/.test(t)) return false // a bare slash command
  if (/^Self-drive is still on|^SELF-DRIVE MODE/.test(t)) return false
  return true
}

export function suggestPrompt(ask: string, skills: readonly Skill[]): string {
  const list = skills.map(s => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').slice(0, 220)}`).join('\n')
  return `Pick the skills an AI coding assistant should load for this request.

Request:
${ask.slice(0, 2000)}

Available skills:
${list}

Answer with up to 3 lines, most useful first, each exactly:
<skill name> | <why, under 12 words>
Only skills that clearly fit the request. If none fit, answer: NONE`
}

export function parseSuggestions(reply: string, known: ReadonlySet<string>): Suggestion[] {
  const out: Suggestion[] = []
  for (const line of reply.split('\n')) {
    const m = /^\s*[-*\d.)\s]*`?([A-Za-z0-9:_-]+)`?\s*\|\s*(.+)$/.exec(line)
    if (!m || !known.has(m[1]!) || out.some(s => s.name === m[1])) continue
    out.push({ name: m[1]!, why: m[2]!.trim().slice(0, 80) })
  }
  return out.slice(0, 3)
}

/** A skill was loaded: drop it from the picks, remember it for picks still on the way. */
export function markLoaded(m: SkillsModel, name: string): SkillsModel {
  return { ...m, suggestions: m.suggestions.filter(s => s.name !== name), loaded: [...m.loaded, name] }
}

/** The hint-row line: the picks Claude hasn't loaded, as slash commands, one row. */
export function hintLine(m: SkillsModel, width: number): string | undefined {
  if (m.pending) return '◇ picking skills…'
  if (m.suggestions.length === 0) return undefined
  const line = `◇ ${m.suggestions.map(s => `/${s.name}`).join(' · ')}`
  if (line.length <= width) return line
  const short = `◇ ${m.suggestions.map(s => `/${s.name.replace(/^[a-z-]+:/, '')}`).join(' · ')}`
  return short.length <= width ? short : short.slice(0, Math.max(10, width - 1)) + '…'
}
