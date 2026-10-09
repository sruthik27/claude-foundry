import type { Register } from 'claude-code'

import { enableText, learn, listText, serversFor } from './servers.js'
import type { Catalog, Server } from './servers.js'

/**
 * One mod for MCP servers: Claude can list every configured server (on or off in this project),
 * ask you with one click to enable one, and reconnect a server after editing it. Enable and
 * reconnect run the built-in `/mcp enable|reconnect <server>` once the turn ends (a command can't
 * run mid-turn), then a follow-up prompt lets Claude carry on with the new tools.
 *
 * `/mcp enable` edits this project's `disabledMcpServers` in ~/.claude.json, so whatever was on
 * or off in the last conversation in a folder is how the next one starts.
 */
const P = 'mcp__mcp-control__'
type Job = { kind: 'enable' | 'reconnect'; server: string }
const S: { jobs: Job[]; then: string; catalog: Catalog; off: Server[]; timer?: { cancel: () => void }; epoch: number } = { jobs: [], then: '', catalog: {}, off: [], epoch: 0 }

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const r = await next(e)
    S.timer?.cancel(); S.timer = undefined; S.epoch++
    S.jobs = []; S.then = ''
    S.catalog = ((await $.store.get('catalog').catch(() => undefined)) as Catalog | undefined) ?? {}
    const tools = [
      { name: 'list_mcp_servers', description: 'List every MCP server configured for this project, whether it is ON or OFF here, and what each does (its tools). Use it when a task might need a service you have no tools for (Jira, Confluence, a browser, logs, GitHub…).', inputSchema: { type: 'object', properties: {} } },
      { name: 'enable_mcp', description: 'Turn ON an MCP server that is OFF in this project. The user approves with one click; it is then enabled right after this turn ends and you get a follow-up message, after which its tools work. It stays on for this project. Pass server (the name list_mcp_servers shows) and then (what to do with it).', inputSchema: { type: 'object', properties: { server: { type: 'string' }, then: { type: 'string', description: 'What to do once it is on, e.g. "search Jira for open PIQ bugs".' } }, required: ['server'] } },
      { name: 'reconnect_mcp', description: 'Restart and reconnect an MCP server so its latest code and tools load (use after editing an MCP server you are testing). Happens right after this turn ends; you then get a follow-up message. Pass server (as /mcp lists it, or "all").', inputSchema: { type: 'object', properties: { server: { type: 'string' }, then: { type: 'string' } }, required: ['server'] } },
    ]
    for (const t of tools) await $.tool.register(t as never)
    await remember($)
    // What is OFF is fixed for the session except for what enable_mcp turns on, so read it once here.
    try { S.off = (await servers($)).filter(s => s.off) } catch { S.off = [] }
    $.ui.invalidate('tool.describe')
    return r
  })

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (['clear', 'resume', 'fork'].includes(e.source)) {
      S.timer?.cancel(); S.timer = undefined; S.epoch++; S.jobs = []; S.then = ''
      S.off = (await servers($)).filter(s => s.off)
      $.ui.invalidate('tool.describe')
    }
    return r
  })

  on('tool.call', { tool: `${P}list_mcp_servers` }, async $ => ({ result: listText(await servers($), S.catalog) }))

  on('tool.call', { tool: `${P}enable_mcp` }, async ($, e) => {
    const input = e as unknown as { server?: string; then?: string }
    const name = String(input.server ?? '').trim()
    const all = await servers($)
    const s = all.find(x => x.name === name)
    if (!s) return { result: `No MCP server named "${name}". Known: ${all.map(x => x.name).join(', ')}` }
    if (!s.off) return { result: `"${name}" is already on in this project. If its tools are missing, call reconnect_mcp.` }
    let answer = ''
    try {
      answer = await $.ui.ask(`Enable the "${name}" MCP server for this project?${input.then ? ` Claude wants to: ${String(input.then).slice(0, 120)}` : ''}`,
        { header: 'MCP', options: ['Enable', 'Not now'] })
    } catch { answer = '' }
    if (answer !== 'Enable') return { result: `The user did not enable "${name}". Carry on without it, or say what it would be needed for.` }
    queue({ kind: 'enable', server: name }, String(input.then ?? ''))
    return { result: `Approved. "${name}" will be enabled as soon as this turn ends. End your turn now; a follow-up message will tell you when its tools are ready.` }
  })

  on('tool.call', { tool: `${P}reconnect_mcp` }, async ($, e) => {
    const input = e as unknown as { server?: string; then?: string }
    const server = String(input.server ?? '').trim()
    if (!server) return { result: 'Give the server name as /mcp lists it, or "all".' }
    queue({ kind: 'reconnect', server }, String(input.then ?? ''))
    return { result: `Reconnect of "${server}" is scheduled for when this turn ends. End your turn now; you will get a follow-up message once it has reconnected, and its new tools will be available then.` }
  })

  // The OFF servers ride in enable_mcp's own description, and the tool is pinned out of tool
  // search so Claude always sees it. No per-prompt call: Claude judges what a task needs. The text
  // is cached with the prompt and changes only when a server is enabled (ui.invalidate below).
  on('tool.describe', { tool: /^mcp__mcp-control__enable_mcp$/ }, async ($, e, next) => {
    const r = await next(e)
    return { ...r, description: enableText(S.off, S.catalog), isDeferred: false }
  })

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || S.jobs.length === 0) return r
    const jobs = S.jobs; const then = S.then; const epoch = S.epoch
    S.jobs = []; S.then = ''
    S.timer = $.clock.after(50, () => {
      S.timer = undefined
      void (async () => {
        const lines: string[] = []
        for (const j of jobs) {
          if (epoch !== S.epoch) return
          try {
            const out = (await $.command.run({ command: 'mcp', args: `${j.kind} ${j.server}` })).text ?? ''
            const state = await servers($)
            S.off = state.filter(s => s.off)
            $.ui.invalidate('tool.describe')
            const connected = (await $.tool.list()).some(t => t.name.startsWith(`mcp__${j.server}__`))
            const enabled = state.some(s => s.name === j.server && !s.off)
            const failed = /\b(error|failed|unknown|not found|cannot|unable)\b/i.test(out)
            lines.push(out.trim() || `Command completed for "${j.server}".`)
            if (failed || (j.kind === 'enable' && !enabled)) lines.push(`"${j.server}" was not verified enabled. Do not use its tools yet.`)
            else if (!connected) lines.push(`Tools for "${j.server}" are not verified available yet; check /mcp before continuing with them.`)
          } catch (err) { lines.push(`${j.kind} ${j.server} failed: ${String(err).slice(0, 200)}`) }
        }
        if (epoch !== S.epoch) return
        await remember($)
        try {
          await $.prompt.submit({ text: `MCP ${jobs.map(j => j.kind).join('/')} result: ${lines.join(' ')}${then ? `\nContinue: ${then}` : '\nContinue with the task.'}` })
        } catch { /* headless run already ended: nothing to continue */ }
      })()
    })
    return r
  })
}

function queue(job: Job, then: string): void {
  if (!S.jobs.some(j => j.kind === job.kind && j.server === job.server)) S.jobs.push(job)
  if (then) S.then = S.then ? `${S.then}; ${then}` : then
}

/** The servers Claude Code knows for this project, read fresh (they change as you toggle them). */
async function servers($: import('claude-code').EngineInterface): Promise<Server[]> {
  const home = (await $.env.get('HOME')) ?? ''
  const root = await $.session.root()
  const json = async (path: string) => { try { return JSON.parse(await $.fs.read(path)) } catch { return {} } }
  return serversFor(await json(`${home}/.claude.json`), await json(`${root}/.mcp.json`), root)
}

/** Record connected servers' tool names, so OFF servers can still be described later. */
async function remember($: import('claude-code').EngineInterface): Promise<void> {
  try {
    const next = learn(S.catalog, await $.tool.list())
    if (JSON.stringify(next) !== JSON.stringify(S.catalog)) { S.catalog = next; await $.store.set('catalog', next) }
  } catch { /* best effort */ }
}
