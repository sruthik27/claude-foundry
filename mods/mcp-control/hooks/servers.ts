/** Pure helpers: which MCP servers exist, which are off in this project, what each one does. */

export type Server = { name: string; scope: 'user' | 'project' | 'mcp.json'; off: boolean; hint: string }
export type Catalog = Record<string, string[]>

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : {})
const list = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : [])

/** A short "what is it" from the server's own config: the command or URL, minus noise. */
function configHint(cfg: unknown): string {
  const c = obj(cfg)
  const raw = [c.url, c.command, ...list(c.args)].filter(Boolean).join(' ')
  return raw.replace(/\/Users\/[^/\s]+/g, '~').replace(/\s+/g, ' ').slice(0, 90)
}

/** Every server Claude Code would offer in `root`, and whether it is switched off there. */
export function serversFor(claudeJson: unknown, mcpJson: unknown, root: string): Server[] {
  const c = obj(claudeJson)
  const p = obj(obj(c.projects)[root])
  const off = new Set([...list(p.disabledMcpServers), ...list(p.disabledMcpjsonServers)])
  const out: Server[] = []
  const add = (servers: unknown, scope: Server['scope']) => {
    for (const [name, cfg] of Object.entries(obj(servers))) {
      if (out.some(s => s.name === name)) continue
      out.push({ name, scope, off: off.has(name), hint: configHint(cfg) })
    }
  }
  add(p.mcpServers, 'project')
  add(obj(mcpJson).mcpServers, 'mcp.json')
  add(c.mcpServers, 'user')
  return out.sort((a, b) => Number(b.off) - Number(a.off) || a.name.localeCompare(b.name))
}

/** The tool-name spelling of a server name: `mcp__<this>__tool`. */
export const toolKey = (name: string) => name.replace(/[^A-Za-z0-9_-]/g, '_')

/** Connected servers' tool names, from `$.tool.list()`, merged into what earlier sessions saw. */
export function learn(prev: Catalog, tools: readonly { name: string; mcp: boolean }[]): Catalog {
  const seen: Catalog = {}
  for (const t of tools) {
    const m = /^mcp__(.+?)__(.+)$/.exec(t.name)
    if (!t.mcp || !m) continue
    ;(seen[m[1]!] ??= []).push(m[2]!)
  }
  return { ...prev, ...seen }
}

/** One line per server: what it does, from the tools seen before, else its config. */
export function describe(s: Server, catalog: Catalog): string {
  const tools = catalog[toolKey(s.name)]
  const what = tools?.length
    ? `${tools.length} tools: ${tools.slice(0, 8).join(', ')}${tools.length > 8 ? ', …' : ''}`
    : s.hint || 'no description yet'
  return `${s.name} [${s.off ? 'OFF' : 'on'}] ${what}`
}

export function listText(servers: readonly Server[], catalog: Catalog): string {
  if (servers.length === 0) return 'No MCP servers are configured.'
  const off = servers.filter(s => s.off)
  return [
    `${servers.length} MCP servers configured, ${off.length} switched off in this project.`,
    ...servers.map(s => '- ' + describe(s, catalog)),
    off.length ? 'To use an OFF one, call enable_mcp with its name (the user approves with one click).' : '',
  ].filter(Boolean).join('\n')
}

/** enable_mcp's description: what it does, then every server that is OFF here and what it offers. */
export function enableText(off: readonly Server[], catalog: Catalog): string {
  const head = 'Turn ON an MCP server that is switched OFF in this project. The user approves with one click; it is enabled right after this turn ends and a follow-up message tells you when its tools work. It stays on for this project. Pass server and then (what to do with it).'
  if (off.length === 0) return `${head}\nEvery configured MCP server is already ON here.`
  return [head,
    'When a task needs a service you have no tools for (issue tracker, wiki, browser, logs, CI, code host…), check this list before saying you cannot: if one fits, call this tool.',
    'OFF in this project:',
    ...off.map(s => '- ' + describe(s, catalog).replace(' [OFF]', '')),
  ].join('\n')
}
