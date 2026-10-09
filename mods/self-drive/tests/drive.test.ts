import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Drive } from '../types'
import { MAX_IDLE, busyAgents, parseArgs, report, riskOf, riskyTool } from '../hooks/drive.js'

test('parses an optional duration then the task', async () => {
  expect(parseArgs('3h finish upload')).toEqual({ ms: 3 * 3600000, task: 'finish upload' })
  expect(parseArgs('45m fix tests')).toEqual({ ms: 45 * 60000, task: 'fix tests' })
  expect(parseArgs('just do it')).toEqual({ task: 'just do it' })
  expect(parseArgs('2 hours, looks good get this done')).toEqual({ ms: 2 * 3600000, task: 'looks good get this done' })
})

test('holds risky actions, lets normal work through', async () => {
  expect(riskOf('git push --force origin feat')).toBe('force push')
  expect(riskOf('git push origin main')).toBe('push to main/master')
  expect(riskOf('git push -u origin feat/x')).toBe('git push')
  expect(riskOf('kubectl -n aqua delete pod x')).toBe('change a cluster (kubectl)')
  expect(riskOf('terraform apply -auto-approve')).toBe('apply infrastructure')
  expect(riskOf('rm -rf ~/dev')).toBe('recursive delete outside the project')
  for (const ok of ['git commit -m "x"', 'npm test', 'kubectl get pods', 'rm -rf ./build', 'rm -rf /tmp/x', 'git status'])
    expect(riskOf(ok)).toBeUndefined()
  expect(riskyTool('mcp__jira-dc__jira_createIssue')).toBeDefined()
  expect(riskyTool('mcp__jira-dc__jira_getIssue')).toBeUndefined()
})

test('report lists decisions with reasons and the needs-you list', async () => {
  const d: Drive = { task: 'T', startedAt: 0, status: 'finished', endedAt: 3600000, endReason: 'work complete', continues: 4, idle: 0, entries: [
    { at: 1, kind: 'decision', title: 'Used SQLite', why: 'no server needed', alternatives: 'Postgres' },
    { at: 2, kind: 'held', title: 'git push', detail: '`git push`' },
    { at: 3, kind: 'needs-you', title: 'Add the API key' },
    { at: 4, kind: 'finished', title: 'done', detail: 'All green.' },
  ] }
  const r = report(d, 0)
  expect(r).toContain('1. **Used SQLite**')
  expect(r).toContain('Why: no server needed')
  expect(r).toContain('## Needs you (2)')
  expect(r).toContain('- [ ] (held) git push')
  expect(r).toContain('All green.')
  expect(r).toContain('Ran: 1h 00m')
})

// ---- the engine ----
const world = (on: On, submitted: string[], agents: { status: string; description: string }[] = []) => {
  clock = mock.clock(on, { now: 1000 })
  on('agent.list', async () => ({ value: agents }) as never)
  mock.store(on)
  mock.env(on, {})
  on('session.id', async () => ({ value: 'sid-1' }) as never)
  on('command.register', async () => ({ value: {} }) as never)
  on('tool.register', async () => ({ value: { tool: 'mcp__self-drive__self_drive_log' } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$, e) => { submitted.push(e.text); return { text: e.text } as never })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('tool.call', async () => ({ result: 'ran' }) as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
}
let clock: ReturnType<typeof mock.clock>
/** /self-drive as the person types it at the prompt. */
const typed = (args: string) => ({ command: 'self-drive', args, origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 160 } })
/** Lets the deferred brief go out (the command schedules it on a timer). */
const settle = (_$: unknown) => clock.advance(100)
const turn = (isAborted = false) => ({ answer: '', durationMs: 1, isAborted, turnId: 't', reason: isAborted ? 'aborted' : 'answer' }) as const

test('a drive: brief sent, questions refused, risky held, logs, keeps going, finishes', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('2 hours, build the thing'))
  await settle($)
  expect(sent[0]).toContain('SELF-DRIVE MODE')
  expect(sent[0]).toContain('Goal: build the thing')
  expect(sent[0]).toContain('about 2h 00m')

  const ask = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect(String((ask as { deny?: string }).deny ?? (ask as { text?: string }).text)).toContain('Decide it yourself')

  const push = await $.tool.call({ tool: 'Bash', command: 'git push origin main' } as never)
  expect(String((push as { deny?: string }).deny ?? (push as { text?: string }).text)).toContain('Held by self-drive')

  await $.tool.call({ tool: 'mcp__self-drive__self_drive_log', kind: 'decision', title: 'Picked REST', why: 'simpler', alternatives: 'gRPC' } as never)
  await $.turn.complete(turn())
  expect(sent.at(-1)).toContain('Continue with the next step')

  await $.tool.call({ tool: 'mcp__self-drive__self_drive_log', kind: 'finished', title: 'done', detail: 'Built it.' } as never)
  const before = sent.length
  await $.turn.complete(turn())
  expect(sent.length).toBe(before) // finished: no more auto-continue

  const ui = await $.ui.mount({ plugin: 'self-drive', surface: 'terminal', component: 'Pane', requestId: 'self-drive', props: { title: 'x', isFocused: true, bodyColumns: 80 } as never })
  expect(await ui.find({ type: 'Text', text: /FINISHED/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Decisions made for you \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Needs you \(1\)/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Picked REST/ })).toBeDefined()
})

test('stops after idle turns and asks for the report', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('loop forever'))
  await settle($)
  for (let i = 0; i < MAX_IDLE; i++) await $.turn.complete(turn())
  expect(sent.at(-1)).toContain('Self-drive has stopped')
  await $.command.run(typed('stop'))
  // questions are allowed again once explicitly stopped
  const ask = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect((ask as { deny?: string }).deny).toBeUndefined()
})

test('without self-drive nothing is touched', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  const push = await $.tool.call({ tool: 'Bash', command: 'git push --force' } as never)
  expect((push as { deny?: string }).deny).toBeUndefined()
  await $.turn.complete(turn())
  expect(sent).toEqual([])
})

test('pressing Esc (an aborted turn) means you are back: driving stops, no more continues', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('do work'))
  await settle($)
  const n = sent.length
  await $.turn.complete(turn(true))
  expect(sent.length).toBe(n)
  const ask = await $.tool.call({ tool: 'AskUserQuestion', questions: [] } as never)
  expect((ask as { deny?: string }).deny).toBeUndefined()
})

test('busyAgents counts only agents still working', async () => {
  expect(busyAgents([
    { status: 'running', description: 'build api' }, { status: 'pending', description: 'tests' },
    { status: 'completed', description: 'done' }, { status: 'idle', description: 'teammate' },
  ])).toEqual(['build api', 'tests'])
})

test('waits on running background agents: no idle count, no continue, no early stop', async ($, on) => {
  const sent: string[] = []
  const agents = [{ status: 'running', description: 'build api' }]
  world(on, sent, agents)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('do work'))
  await settle($)
  const n = sent.length
  for (let i = 0; i < MAX_IDLE + 2; i++) await $.turn.complete(turn())
  expect(sent.length).toBe(n) // still driving, quietly waiting
  agents[0]!.status = 'completed' // the agent finished; its notification turn ends
  await $.turn.complete(turn())
  expect(sent.at(-1)).toContain('Continue with the next step')
  const ui = await $.ui.mount({ plugin: 'self-drive', surface: 'terminal', component: 'Pane', requestId: 'self-drive', props: { title: 'x', isFocused: true, bodyColumns: 80 } as never })
  expect(await ui.find({ type: 'Text', text: /DRIVING/ })).toBeDefined()
})

test('Git global flags and quoted option arguments cannot hide pushes or destructive resets', async () => {
  for (const cmd of ['git -C /repo push origin main', 'git -C "/a b" -c core.pager=cat push origin feature', 'git --git-dir=/r/.git --no-pager reset --hard', 'git -C/r clean -fd', 'git -c "alias.x=foo bar" push --force origin feat'])
    expect(riskOf(cmd)).toBeDefined()
  for (const cmd of ['git -C /repo status', 'git -c color.ui=always diff', 'git --no-pager log']) expect(riskOf(cmd)).toBeUndefined()
})

test('deadline gates new work before turn completion and remains held during the report', async ($, on) => {
  const sent: string[] = []; world(on, sent)
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('1m finish safely'))
  await clock.advance(60001)
  for (const tool of ['Bash', 'Edit', 'Read']) {
    const r = await $.tool.call({ tool, command: 'echo work' } as never)
    expect((r as { deny?: string }).deny).toContain('budget reached')
  }
  await $.turn.complete(turn())
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' } as never) as { deny?: string }).deny).toBeDefined()
  await $.command.run(typed('stop'))
  expect((await $.tool.call({ tool: 'Read', file_path: '/x' } as never) as { deny?: string }).deny).toBeUndefined()
})

test('finishing after the deadline cannot release the tool gate', async ($, on) => {
  world(on, [])
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('1m finish'))
  await clock.advance(60001)
  await $.tool.call({ tool: 'mcp__self-drive__self_drive_log', kind: 'finished', title: 'done' } as never)
  expect((await $.tool.call({ tool: 'Bash', command: 'git push' } as never) as { deny?: string }).deny).toBeDefined()
})

test('clear cancels the queued self-drive brief and resets the guard', async ($, on) => {
  const sent: string[] = []; world(on, sent)
  on('classic.SessionStart', async () => ({}))
  await $.session.start({ cwd: '/w', surface: 'terminal', isInteractive: true })
  await $.command.run(typed('1m finish'))
  await $.classic.SessionStart({ source: 'clear' })
  await clock.advance(100)
  expect(sent).toEqual([])
  expect((await $.tool.call({ tool: 'Read', file_path: '/x' } as never) as { deny?: string }).deny).toBeUndefined()
})
