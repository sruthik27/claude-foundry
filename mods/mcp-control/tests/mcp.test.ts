import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import { describe, enableText, learn, listText, serversFor } from '../hooks/servers.js'

const CLAUDE = {
  mcpServers: { 'jira-dc': { command: 'node', args: ['/Users/me/jira/index.js'] }, exa: { url: 'https://mcp.exa.ai' } },
  projects: { '/r': { disabledMcpServers: ['jira-dc'], mcpServers: { local1: { command: 'uvx', args: ['thing'] } } } },
}

test('servers: user + project + .mcp.json, OFF per project, OFF listed first', async () => {
  const s = serversFor(CLAUDE, { mcpServers: { piq: { command: 'x' } } }, '/r')
  expect(s.map(x => `${x.name}:${x.off ? 'off' : 'on'}:${x.scope}`)).toEqual(['jira-dc:off:user', 'exa:on:user', 'local1:on:project', 'piq:on:mcp.json'])
  expect(s[0]!.hint).toBe('node ~/jira/index.js')
  expect(serversFor(CLAUDE, {}, '/elsewhere').every(x => !x.off)).toBe(true)
})

test('catalog learns tool names from connected servers and describes OFF ones with them', async () => {
  const cat = learn({}, [{ name: 'mcp__jira-dc__search', mcp: true }, { name: 'mcp__jira-dc__get_issue', mcp: true }, { name: 'Bash', mcp: false }])
  expect(cat).toEqual({ 'jira-dc': ['search', 'get_issue'] })
  const [jira] = serversFor(CLAUDE, {}, '/r')
  expect(describe(jira!, cat)).toBe('jira-dc [OFF] 2 tools: search, get_issue')
  expect(listText(serversFor(CLAUDE, {}, '/r'), cat)).toContain('1 switched off in this project')
  expect(enableText(serversFor(CLAUDE, {}, '/r').filter(x => x.off), cat)).toContain('- jira-dc 2 tools: search, get_issue')
  expect(enableText([], cat)).toContain('already ON')
})

const world = (on: On, answer: string, ran: string[], sent: string[], ctx: string[][] = [], match = 'NONE', fail = false) => {
  const clock = mock.clock(on, { now: 0 })
  const config = JSON.parse(JSON.stringify(CLAUDE))
  mock.store(on)
  on('env.get', async () => ({ value: '/home' }) as never)
  on('session.root', async () => ({ value: '/r' }) as never)
  on('fs.read', async (_$, e) => ((e as { path: string }).path === '/home/.claude.json' ? { value: JSON.stringify(config) } : { value: '{}' }) as never)
  on('tool.list', async () => ({ value: [] }) as never)
  on('tool.register', async () => ({ value: { tool: 'x' } }) as never)
  on('tool.call', { tool: 'AskUserQuestion' }, async (_$, e) => {
    const q = (e as { questions?: { question: string }[] }).questions?.[0]?.question ?? ''
    return { result: { questions: [], answers: { [q]: answer } } } as never
  })
  on('model.complete', async () => ({ value: { isAnswered: true, text: match, usage: {} } }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('command.run', async (_$, e) => { ran.push(`${e.command} ${e.args}`); if (fail) return { text: 'Error: server failed to enable' }; if (e.args === 'enable jira-dc') config.projects['/r'].disabledMcpServers = []; return { text: '' } })
  on('prompt.submit', async (_$, e) => { sent.push(e.text); ctx.push([...(e.context ?? [])]); return { text: e.text } as never })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  return clock
}
const END = { answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const

test('enable: one click, then /mcp enable at turn end and a follow-up to continue', async ($, on) => {
  const ran: string[] = []; const sent: string[] = []
  const clock = world(on, 'Enable', ran, sent)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'mcp__mcp-control__enable_mcp', server: 'jira-dc', then: 'find open bugs' } as never)
  expect(String((r as { result?: unknown }).result)).toContain('Approved')
  expect(ran).toEqual([])
  await $.turn.complete(END)
  await clock.advance(100)
  expect(ran).toEqual(['mcp enable jira-dc'])
  expect(sent.at(-1)).toContain('Continue: find open bugs')
})

test('enable declined, unknown or already on: nothing runs', async ($, on) => {
  const ran: string[] = []; const sent: string[] = []
  const clock = world(on, 'Not now', ran, sent)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  expect(String(((await $.tool.call({ tool: 'mcp__mcp-control__enable_mcp', server: 'jira-dc' } as never)) as { result?: unknown }).result)).toContain('did not enable')
  expect(String(((await $.tool.call({ tool: 'mcp__mcp-control__enable_mcp', server: 'exa' } as never)) as { result?: unknown }).result)).toContain('already on')
  expect(String(((await $.tool.call({ tool: 'mcp__mcp-control__enable_mcp', server: 'nope' } as never)) as { result?: unknown }).result)).toContain('No MCP server named')
  await $.turn.complete(END)
  await clock.advance(100)
  expect(ran).toEqual([])
})

test('reconnect still works; list shows ON/OFF', async ($, on) => {
  const ran: string[] = []; const sent: string[] = []
  const clock = world(on, '', ran, sent)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  expect(String(((await $.tool.call({ tool: 'mcp__mcp-control__list_mcp_servers' } as never)) as { result?: unknown }).result)).toContain('jira-dc [OFF]')
  await $.tool.call({ tool: 'mcp__mcp-control__reconnect_mcp', server: 'pcap', then: 'call list_tools' } as never)
  await $.turn.complete(END)
  await clock.advance(100)
  expect(ran).toEqual(['mcp reconnect pcap'])
  expect(sent.at(-1)).toContain('Continue: call list_tools')
})

test('enable_mcp is pinned with the OFF list in its description; enabling one refreshes it', async ($, on) => {
  const ran: string[] = []; const sent: string[] = []
  let refreshed = 0
  const clock = world(on, 'Enable', ran, sent)
  on('ui.invalidate', async (_$, e) => { if (e.event === 'tool.describe') refreshed++; return { value: undefined } as never })
  on('tool.describe', async (_$, e) => ({ description: 'core', isDeferred: true }) as never)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  const d = await $.tool.describe({ tool: 'mcp__mcp-control__enable_mcp', description: 'x', provider: {} } as never) as { description: string; isDeferred?: boolean }
  expect(d.isDeferred).toBe(false)
  expect(d.description).toContain('OFF in this project:')
  expect(d.description).toContain('- jira-dc')
  await $.tool.call({ tool: 'mcp__mcp-control__enable_mcp', server: 'jira-dc' } as never)
  await $.turn.complete(END)
  await clock.advance(100)
  const after = await $.tool.describe({ tool: 'mcp__mcp-control__enable_mcp', description: 'x', provider: {} } as never) as { description: string }
  expect(after.description).toContain('already ON')
  expect(refreshed).toBeGreaterThan(0)
  expect(sent.every(t => !t.includes('switched OFF in this project that this request'))).toBe(true)
})

test('a resolved command error cannot remove an OFF server or claim its tools are ready', async ($, on) => {
  const ran: string[] = []; const sent: string[] = []
  const clock = world(on, 'Enable', ran, sent, [], 'NONE', true)
  on('tool.describe', async () => ({ description: 'core', isDeferred: true }) as never)
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__mcp-control__enable_mcp', server: 'jira-dc' } as never)
  await $.turn.complete(END); await clock.advance(100)
  expect(sent.at(-1)).toContain('not verified enabled')
  const description = await $.tool.describe({ tool: 'mcp__mcp-control__enable_mcp', description: 'x', provider: {} } as never) as { description: string }
  expect(description.description).toContain('- jira-dc')
})

test('clear cancels queued MCP commands rather than applying them to the next session', async ($, on) => {
  const ran: string[] = []; const sent: string[] = []
  const clock = world(on, 'Enable', ran, sent)
  on('classic.SessionStart', async () => ({}))
  await $.session.start({ cwd: '/r', surface: 'terminal', isInteractive: true })
  await $.tool.call({ tool: 'mcp__mcp-control__enable_mcp', server: 'jira-dc' } as never)
  await $.turn.complete(END)
  await $.classic.SessionStart({ source: 'clear' })
  await clock.advance(100)
  expect(ran).toEqual([]); expect(sent).toEqual([])
})
