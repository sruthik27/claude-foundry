import type { Drive, DriveStatus, Entry } from '../types'

export const MAX_CONTINUES = 40
export const MAX_IDLE = 3

/** "/self-drive 3h task..." -> duration in ms (optional) and the task. */
export function parseArgs(args: string): { ms?: number; task: string } {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?)\b[\s,;:.-]*/i.exec(args)
  if (!m) return { task: args.trim() }
  const n = Number(m[1])
  const ms = /^h/i.test(m[2] ?? '') ? n * 3600000 : n * 60000
  return { ms, task: args.slice(m[0].length).trim() }
}

export function brief(task: string, deadline: number | undefined, now: number): string {
  const until = deadline ? `You have about ${fmtDur(deadline - now)} (until ${new Date(deadline).toTimeString().slice(0, 5)} local).` : 'Work until the goal is fully done.'
  return `SELF-DRIVE MODE. I am stepping away and cannot answer anything until I return. ${until}

Goal: ${task}

How to work while I am away:
- Never ask me anything and never wait for my acknowledgement. Make the best decision a careful senior engineer would, and keep going.
- Every time you decide something you would normally have asked me about (a design choice, scope, a trade-off, an assumption, a default), record it with the self_drive_log tool, kind "decision": what you chose, the alternatives, and why. Be honest; these are what I will review first.
- Anything that truly needs me (credentials, approvals, merges, production or shared-system actions, purchases, messages to people) — log it with kind "needs-you" and work around it; leave those for the end.
- Risky, hard-to-undo or outward-facing actions are held by a guard while I am away. If one is refused, log it as needs-you and continue with everything else.
- Plan the work, then execute it fully: implement, test, fix, verify. Prefer reversible steps. Commit locally in small steps where the repo allows it; do not push.
- Use kind "note" sparingly for milestones.
- When everything you can do is done, call self_drive_log with kind "finished" and a summary of what was done. Then write the final report for me: what was done, the decisions to review, and the needs-you list.`
}

export const CONTINUE = `Self-drive is still on and I am still away. Continue with the next step toward the goal. If everything you can do is done, call self_drive_log with kind "finished" and write the final report.`

// ---- guard: actions held while away ----

const RISKY: readonly [RegExp, string][] = [
  [/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b)/, 'force push'],
  [/\bgit\s+push\b[^\n]*\b(main|master)\b/, 'push to main/master'],
  [/\bgit\s+push\b/, 'git push'],
  [/\bgit\s+(branch\s+-D|push\s+\S+\s+--delete|push\s+\S+\s+:)/, 'delete a branch'],
  [/\bgit\s+reset\s+--hard\b|\bgit\s+clean\s+-[a-z]*f/, 'discard work (reset --hard / clean -f)'],
  [/\bkubectl\b[^\n]*\b(delete|apply|replace|patch|scale|rollout\s+restart|drain|cordon)\b/, 'change a cluster (kubectl)'],
  [/\bhelm\s+(install|upgrade|uninstall|delete|rollback)\b/, 'change a cluster (helm)'],
  [/\bterraform\s+(apply|destroy)\b|\bpulumi\s+(up|destroy)\b/, 'apply infrastructure'],
  [/\bgh\s+(pr\s+(merge|close)|release\s+create|repo\s+delete)\b/, 'merge/close/release on GitHub'],
  [/\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b/, 'publish a package or image'],
  [/\brm\s+-[a-z]*r[a-z]*f?\s+(\/(?!tmp\b)|~|\$HOME)/, 'recursive delete outside the project'],
  [/\b(mgc|outlook)\b[^\n]*\b(send|reply|forward)\b|\bsendmail\b/, 'send email'],
]

/** The reason a Bash command is held, or undefined to let it run. */
export function riskOf(command: string): string | undefined {
  const token = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;&|]+)`
  const value = String.raw`(?:-C|-c|--git-dir|--work-tree|--namespace|--config-env)\s+${token}`
  const attached = String.raw`(?:-[Cc][^\s;&|]+|--(?:git-dir|work-tree|namespace|config-env)=${token}|--(?:no-pager|paginate|bare|no-optional-locks|literal-pathspecs|glob-pathspecs|noglob-pathspecs|icase-pathspecs))`
  const normalized = command.replace(new RegExp(String.raw`\bgit\s+(?:(?:${value}|${attached})\s+)+`, 'g'), 'git ')
  for (const [re, why] of RISKY) if (re.test(normalized)) return why
  return undefined
}

/** Tool names (MCP and skills) that reach people or shared systems. */
export function riskyTool(tool: string): string | undefined {
  if (/^mcp__.*(slack|teams|outlook|mail|send|post|jira.*(create|transition|comment|update)|confluence.*(create|update))/i.test(tool)) return 'post to a shared system or message people'
  return undefined
}

// ---- report ----

export function fmtDur(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000))
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}

const of = (d: Drive, k: Entry['kind']) => d.entries.filter(e => e.kind === k)

export function report(d: Drive, now: number): string {
  const end = d.endedAt ?? now
  const lines = [
    `# Self-drive report`,
    ``,
    `- Goal: ${d.task}`,
    `- Status: ${d.status}${d.endReason ? ` (${d.endReason})` : ''}`,
    `- Ran: ${fmtDur(end - d.startedAt)} · started ${new Date(d.startedAt).toLocaleString()}`,
    `- Auto-continues: ${d.continues}`,
  ]
  const fin = of(d, 'finished').at(-1)
  if (fin) lines.push('', '## Summary', '', fin.detail ?? fin.title)
  const dec = of(d, 'decision')
  lines.push('', `## Decisions made on your behalf (${dec.length})`, '')
  dec.forEach((e, i) => {
    lines.push(`${i + 1}. **${e.title}**`)
    if (e.why) lines.push(`   - Why: ${e.why}`)
    if (e.alternatives) lines.push(`   - Alternatives: ${e.alternatives}`)
    if (e.detail) lines.push(`   - ${e.detail}`)
  })
  const need = [...of(d, 'needs-you'), ...of(d, 'held')]
  lines.push('', `## Needs you (${need.length})`, '')
  need.forEach(e => lines.push(`- [ ] ${e.kind === 'held' ? '(held) ' : ''}${e.title}${e.detail ? ` — ${e.detail}` : ''}`))
  const notes = of(d, 'note')
  if (notes.length) { lines.push('', '## Milestones', ''); notes.forEach(e => lines.push(`- ${e.title}`)) }
  return lines.join('\n') + '\n'
}

/** Ends a drive (typed, so callers can't widen the status). */
export function ended(d: Drive | null, status: Exclude<DriveStatus, 'driving'>, at: number, reason: string, extra: Partial<Drive> = {}): Drive | null {
  return d && { ...d, ...extra, status, endedAt: at, endReason: reason }
}

/** Appends one journal entry. */
export function logged(d: Drive | null, e: Entry): Drive | null {
  return d && { ...d, entries: [...d.entries, e] }
}

/** Agents still doing work: their completion will wake the main loop by itself. */
export function busyAgents(list: readonly { status: string; description: string }[]): string[] {
  return list.filter(a => a.status === 'pending' || a.status === 'running' || a.status === 'waiting').map(a => a.description)
}
