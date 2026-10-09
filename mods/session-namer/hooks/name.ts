/** Pure helpers: the prompt, and cleaning what the model replies. */

export function askFor(repo: string, current: string | undefined, start: string, recent: string): string {
  return `Name a Claude Code session so its owner can find it later by skimming a resume list.
Rules: 2-5 lowercase words joined by hyphens, max 40 chars. Name the concrete subject (system, feature, bug, device, repo area), not the activity. No dates, no filler words (session, work, stuff, misc, task).
Repo/dir: ${repo}
Current name: ${current ?? '<none>'}
What the user asked, from the start: ${start}
What the user asked, most recently: ${recent}

If a current name exists and still names the session's main subject well, reply exactly: KEEP
Otherwise reply with only the new name, nothing else.`
}

/** 'keep', a cleaned name, or undefined when the reply is unusable. */
export function parseReply(reply: string, current: string | undefined): 'keep' | string | undefined {
  const line = reply.trim().split('\n').pop()?.trim() ?? ''
  if (/^keep\.?$/i.test(line)) return 'keep'
  const name = line.toLowerCase().replace(/[`"'*]/g, '').replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40).replace(/-$/, '')
  if (name.length < 3 || name.split('-').length > 6) return undefined
  return name === current ? 'keep' : name
}

/**
 * What the person actually asked, one entry per prompt. A slash command counts by its name and
 * arguments (`/skill do x` is a real request); a bare command, its output, task notifications
 * and other machine-made messages do not.
 */
export function promptsOf(messages: readonly { role: string; text: string }[]): string[] {
  const out: string[] = []
  for (const m of messages) {
    if (m.role !== 'user') continue
    const t = m.text.trim()
    if (!t) continue
    if (/^<(task-notification|local-command|system-reminder|bash-|user-memory)/.test(t)) continue
    if (/^<command-(name|message)>/.test(t)) {
      const name = /<command-name>([^<]*)<\/command-name>/.exec(t)?.[1]?.trim() ?? ''
      const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(t)?.[1]?.trim() ?? ''
      if (args) out.push(`${name} ${args}`.replace(/\s+/g, ' ').trim())
      continue
    }
    const clean = t.replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    if (clean) out.push(clean)
  }
  return out
}

/** Enough to name a session: two prompts, or one that says something (>= 8 words). */
export function enoughToName(prompts: readonly string[]): boolean {
  return prompts.length >= 2 || (prompts[0]?.split(/\s+/).length ?? 0) >= 8
}
