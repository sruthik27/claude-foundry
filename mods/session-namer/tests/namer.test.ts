import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import { askFor, parseReply, promptsOf } from '../hooks/name.js'

test('cleans model replies into hyphenated names', async () => {
  expect(parseReply('Insight Pane Mod', undefined)).toBe('insight-pane-mod')
  expect(parseReply('`router-vlan-debug`', undefined)).toBe('router-vlan-debug')
  expect(parseReply('KEEP', 'x-y')).toBe('keep')
  expect(parseReply('x-y', 'x-y')).toBe('keep')
  expect(parseReply('ok', undefined)).toBeUndefined()
  expect(parseReply('this is a very long sentence the model wrote instead', undefined)).toBeUndefined()
})

test('keeps only real user prompts', async () => {
  const got = promptsOf([
    { role: 'user', text: '<command-name>/clear</command-name>' },
    { role: 'user', text: 'fix the  pcap upload' },
    { role: 'assistant', text: 'ok' },
  ])
  expect(got).toEqual(['fix the pcap upload'])
  expect(askFor('repo', 'a-b', 's', 'r')).toContain('Current name: a-b')
})

const TWO = ['build a pane mod', 'add ranking to the pane']
const hooksBeneath = (on: On, reply: string, ran: string[], prompts: string[] = TWO) => {
  mock.store(on)
  on('session.id', async () => ({ value: 'sid-1' }) as never)
  on('session.messages', async () => ({ value: prompts.map(text => ({ role: 'user', text, toolUses: [] })) }) as never)
  on('session.cwd', async () => ({ value: '/Users/x/dev/insights' }) as never)
  on('session.root', async () => ({ value: '/Users/x/dev/insights' }) as never)
  on('session.model', async () => ({ value: 'opus' }) as never)
  on('model.complete', async () => ({ value: { isAnswered: true, text: reply, usage: {} } }) as never)
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('command.run', async (_$, e) => { ran.push(`${e.command} ${e.args}`); return {} })
  on('session.end', async (_$, e) => ({ sessionId: e.sessionId }))
}

const turn = { answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' } as const
const end = { reason: 'prompt_input_exit', sessionId: 'sid-1', resume: { id: 'sid-1' } } as never

test('a resumed session gets its waiting name at start', async ($, on) => {
  const ran: string[] = []
  hooksBeneath(on, 'insight-pane-mod', ran)
  on('classic.SessionStart', async () => ({}) as never)
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  const r = await $.classic.SessionStart({ source: 'resume' } as never)
  expect((r as { sessionTitle?: string }).sessionTitle).toBe('insight-pane-mod')
  const fresh = await $.classic.SessionStart({ source: 'startup' } as never)
  expect((fresh as { sessionTitle?: string }).sessionTitle).toBeUndefined()
})

test('KEEP leaves the name alone', async ($, on) => {
  const ran: string[] = []
  hooksBeneath(on, 'KEEP', ran)
  on('classic.UserPromptSubmit', async () => ({}) as never)
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  const r = await $.classic.UserPromptSubmit({ prompt: 'x' } as never)
  expect((r as { sessionTitle?: string }).sessionTitle).toBeUndefined()
})

test('a name the person typed is never overridden', async ($, on) => {
  const ran: string[] = []
  hooksBeneath(on, 'something-else', ran)
  on('classic.UserPromptSubmit', async () => ({}) as never)
  await $.command.run({ command: 'rename', args: 'my-own-name', origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: 120 } })
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  const r = await $.classic.UserPromptSubmit({ prompt: 'x' } as never)
  expect((r as { sessionTitle?: string }).sessionTitle).toBeUndefined()
})

test('regression: the picked name is applied as the session title on the next prompt, not at exit', async ($, on) => {
  const ran: string[] = []
  hooksBeneath(on, 'insight-pane-mod', ran)
  on('classic.UserPromptSubmit', async () => ({}) as never)
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  const r = await $.classic.UserPromptSubmit({ prompt: 'next thing' } as never)
  expect((r as { sessionTitle?: string }).sessionTitle).toBe('insight-pane-mod')
  // applied once: once the session shows it, the next prompt carries no title
  const again = await $.classic.UserPromptSubmit({ prompt: 'more', session_title: 'insight-pane-mod' } as never)
  expect((again as { sessionTitle?: string }).sessionTitle).toBeUndefined()
})

test('regression: a title set before the mod (or by hand) is kept, and marks the session human-named', async ($, on) => {
  const ran: string[] = []
  hooksBeneath(on, 'mod-picked-name', ran)
  on('classic.UserPromptSubmit', async () => ({}) as never)
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  const r = await $.classic.UserPromptSubmit({ prompt: 'x', session_title: 'tools-rewriter' } as never)
  expect((r as { sessionTitle?: string }).sessionTitle).toBeUndefined()
  // still left alone on later prompts, even with no title passed
  await $.turn.complete(turn)
  const again = await $.classic.UserPromptSubmit({ prompt: 'y' } as never)
  expect((again as { sessionTitle?: string }).sessionTitle).toBeUndefined()
})

test('the mod\'s own earlier title does not count as a human one', async ($, on) => {
  const ran: string[] = []
  hooksBeneath(on, 'first-name', ran)
  on('classic.UserPromptSubmit', async () => ({}) as never)
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  const r = await $.classic.UserPromptSubmit({ prompt: 'x' } as never)
  expect((r as { sessionTitle?: string }).sessionTitle).toBe('first-name')
  const r2 = await $.classic.UserPromptSubmit({ prompt: 'y', session_title: 'first-name' } as never)
  expect((r2 as { sessionTitle?: string }).sessionTitle).toBeUndefined()
})

test('regression: a title the session lost (resume) is re-asserted, and the /resume sidecar is written', async ($, on) => {
  const ran: string[] = []
  const written: Record<string, string> = {}
  hooksBeneath(on, 'my-session-name', ran)
  on('fs.write', async (_$, e) => { written[(e as { path: string }).path] = (e as { text: string }).text; return { value: undefined } as never })
  on('classic.UserPromptSubmit', async () => ({}) as never)
  await $.turn.complete(turn)
  await $.turn.complete(turn)
  const first = await $.classic.UserPromptSubmit({ prompt: 'x', transcript_path: '/p/proj/sid-1.jsonl' } as never)
  expect((first as { sessionTitle?: string }).sessionTitle).toBe('my-session-name')
  expect(written['/p/proj/sid-1/custom-title.json']).toBe('{"customTitle":"my-session-name"}')
  // the session shows the title: nothing to send
  const same = await $.classic.UserPromptSubmit({ prompt: 'y', session_title: 'my-session-name', transcript_path: '/p/proj/sid-1.jsonl' } as never)
  expect((same as { sessionTitle?: string }).sessionTitle).toBeUndefined()
  // a resumed process that lost it: re-asserted
  const lost = await $.classic.UserPromptSubmit({ prompt: 'z', transcript_path: '/p/proj/sid-1.jsonl' } as never)
  expect((lost as { sessionTitle?: string }).sessionTitle).toBe('my-session-name')
})

test('regression: a slash command with arguments counts as a prompt; notifications and meta do not', async () => {
  const got = promptsOf([
    { role: 'user', text: '<command-message>superpowers:using-superpowers</command-message>\n<command-name>/superpowers:using-superpowers</command-name>\n<command-args>check the dense-capture triage plan and think it through</command-args>' },
    { role: 'user', text: '<task-notification>\n<task-id>a2</task-id>\n<status>completed</status>\n</task-notification>' },
    { role: 'user', text: '<command-name>/clear</command-name>' },
    { role: 'user', text: '<local-command-stdout>ok</local-command-stdout>' },
  ])
  expect(got).toEqual(['/superpowers:using-superpowers check the dense-capture triage plan and think it through'])
})

test('regression: one substantial prompt is enough to name a session after its first turn', async ($, on) => {
  const ran: string[] = []
  hooksBeneath(on, 'dense-capture-triage-plan', ran, ['check the dense-capture triage and focused prepare plan, we need to think this through properly'])
  on('classic.UserPromptSubmit', async () => ({}) as never)
  await $.turn.complete(turn)
  const r = await $.classic.UserPromptSubmit({ prompt: 'next' } as never)
  expect((r as { sessionTitle?: string }).sessionTitle).toBe('dense-capture-triage-plan')
})

test('regression: the /resume sidecar is written as soon as a name is picked, before any next prompt', async ($, on) => {
  const ran: string[] = []
  const written: Record<string, string> = {}
  hooksBeneath(on, 'dense-capture-triage-plan', ran, ['check the dense-capture triage and focused prepare plan, we need to think this through properly'])
  on('fs.write', async (_$, e) => { written[(e as { path: string }).path] = (e as { text: string }).text; return { value: undefined } as never })
  on('classic.UserPromptSubmit', async () => ({}) as never)
  await $.classic.UserPromptSubmit({ prompt: 'first', transcript_path: '/p/proj/sid-1.jsonl' } as never)
  await $.turn.complete(turn)
  expect(written['/p/proj/sid-1/custom-title.json']).toBe('{"customTitle":"dense-capture-triage-plan"}')
})
