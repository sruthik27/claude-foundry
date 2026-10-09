export type Digest = { id: string; title: string; branch: string | null; date: string; prompts: string[]; edits: string[] }
export type Pick = { n: number; why: string }

export function pickPrompt(query: string, ds: readonly Digest[]): string {
  const list = ds.map((d, i) =>
    `[${i + 1}] ${d.title} | ${d.date}${d.branch ? ` | ${d.branch}` : ''}\n  asked: ${d.prompts.join(' / ')}${d.edits.length ? `\n  edited: ${d.edits.join(', ')}` : ''}`).join('\n')
  return `Find which past coding sessions match what the user remembers.

They remember: ${query}

Sessions (newest first):
${list}

Answer with up to 5 lines, best match first, each exactly:
<number> | <one short reason it matches>
Only include real matches. If none match, answer: NONE`
}

export function parsePicks(reply: string, count: number): Pick[] {
  const out: Pick[] = []
  for (const line of reply.split('\n')) {
    const m = /^\s*\[?(\d+)\]?\s*\|\s*(.+)$/.exec(line)
    const n = Number(m?.[1])
    if (!m || n < 1 || n > count || out.some(p => p.n === n)) continue
    out.push({ n, why: m[2]!.trim().slice(0, 120) })
  }
  return out.slice(0, 5)
}
