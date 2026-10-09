import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const FILE = '/repo/src/drive.ts'
const SRC_AFTER = ['export function busyAgents(list) {', '  return list.filter(a => a.status === "running")', '}', '', 'export function other() {', '  return 1', '}'].join('\n')

/** The engine beneath the plugin, with a tiny file system and a prompt log. */
const world = (on: On, sent: string[], files: Record<string, string> = { [FILE]: SRC_AFTER }, bash?: () => void) => {
  mock.store(on)
  mock.env(on, {})
  on('session.id', async () => ({ value: 'sid-1' }) as never)
  on('fs.read', async (_$, e) => ((e as { path: string }).path in files ? { value: files[(e as { path: string }).path] } : { deny: 'missing' }) as never)
  on('command.register', async () => ({ value: {} }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', async () => ({ value: [] }) as never)
  on('ui.toast', async () => ({ value: undefined }) as never)
  on('prompt.submit', async (_$, e) => { sent.push(e.text); return { text: e.text } as never })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('turn.start', async (_$, e) => e as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash' && bash) { bash(); return { result: 'removed' } as never }
    if (e.tool === 'Edit') return { result: { filePath: FILE, oldString: '', newString: '', originalFile: '', userModified: false, replaceAll: false,
      structuredPatch: [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' export function busyAgents(list) {', '-  return []', '+  return list.filter(a => a.status === "running")', '+}'] }] } } as never
    return { result: 'ok' } as never
  })
}
const turnDone = (answer: string) => ({ answer, durationMs: 1, isAborted: false, turnId: 't', reason: 'answer' }) as const
const PANE = (cols = 100) => ({ plugin: 'changes', surface: 'terminal' as const, component: 'Pane' as const, requestId: 'changes',
  props: { title: 'Changes', isFocused: true, bodyColumns: cols, placement: 'dock', scroll: { bodyRows: 30 } } as never })

async function oneEditTurn($: Engine, tag: string) {
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(turnDone(`Done.\n${tag}`))
}

test('an edit is recorded, grouped by the turn tag, and drawn at each level', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await oneEditTurn($, '<change-group id="wait" kind="behaviour" title="Wait for agents" summary="busyAgents() in drive.ts filters running ones."/>')

  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Text', text: /What changed/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Wait for agents' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /busyAgents\(\) in drive\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()

  await ui.press({ key: 'open-wait' })
  expect(await ui.find({ type: 'Button', text: /src\/drive\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ƒ busyAgents/ })).toBeDefined()

  await ui.press({ key: 'file-0' })
  expect(await ui.find({ type: 'Text', text: /return list\.filter/, in: 'viewer' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /return \[\]/, in: 'viewer' })).toBeDefined() // the removed line is shown
  expect(await ui.find({ type: 'Text', text: /ƒ busyAgents/, in: 'viewer' })).toBeDefined()
  await ui.unmount()
})

test('select lines, ask a question: prompt carries the code, edits are blocked, answer lands on the lines', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await oneEditTurn($, '<change-group id="wait" kind="behaviour" title="Wait for agents"/>')
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'open-wait' })
  await ui.press({ key: 'file-0' })
  // cursor starts on the first change (line 2); extend to line 3 and ask
  await ui.key({ key: 'v', in: 'viewer' } as never)
  await ui.key({ key: 'down', in: 'viewer' } as never)
  await ui.key({ key: 'a', in: 'viewer' } as never)
  expect(await ui.find({ type: 'Text', text: /Ask about src\/drive\.ts:2-3/ })).toBeDefined()
  await ui.input({ key: 'ask-input', text: 'why only running?' })
  expect(sent.at(-1)).toContain('❓ src/drive.ts:2-3 — why only running?')
  expect(sent.at(-1)).toContain('return list.filter')
  expect(sent.at(-1)).toContain('do not edit any file')

  const tried = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' } as never)
  expect(String((tried as { deny?: string; text?: string }).deny ?? (tried as { text?: string }).text)).toContain('explain only')

  await $.turn.complete(turnDone('Because pending agents have not started work yet.'))
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /pending agents have not started/, in: 'viewer' })).toBeUndefined() // folded until opened
  await ui.key({ key: 't', in: 'viewer' } as never)
  expect(await ui.find({ type: 'Text', text: /pending agents have not started/, in: 'viewer' })).toBeDefined()
  // and edits work again after the ask turn
  const ok = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' } as never)
  expect((ok as { deny?: string }).deny).toBeUndefined()
})

test('a change request edits, and the pane reopens on the change', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await oneEditTurn($, '<change-group id="wait" kind="behaviour" title="Wait for agents"/>')
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'open-wait' })
  await ui.press({ key: 'file-0' })
  await ui.key({ key: 'c', in: 'viewer' } as never)
  await ui.input({ key: 'ask-input', text: 'include waiting too' })
  expect(sent.at(-1)).toContain('✎ src/drive.ts:2 — include waiting too')
  expect(sent.at(-1)).toContain('CHANGE REQUEST')
  // Claude edits during that turn, then the turn ends: back to groups first to prove it jumps
  await ui.press({ key: 'back-files' })
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(turnDone('Now includes waiting.\n<change-group id="wait" kind="behaviour" title="Wait for agents"/>'))
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /return list\.filter/, in: 'viewer' })).toBeDefined()
})

test('turns without a tag fall back to one group; review marks count', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await oneEditTurn($, '')
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Button', text: 'Other changes' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /0\/1 files reviewed/ })).toBeDefined()
  await ui.press({ key: 'open-turn-1' })
  await ui.press({ key: 'file-0' })
  await ui.key({ key: 'r', in: 'viewer' } as never)
  await ui.key({ key: 'h', in: 'viewer' } as never)
  await ui.press({ key: 'back' })
  expect(await ui.find({ type: 'Text', text: /1\/1 files reviewed/ })).toBeDefined()
})

test('empty session shows a friendly note; the change-group tag is hidden from the transcript', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  on('ui.render', async (_$, e) => { const { Text } = _$.ui.resolve(e); return Text({ children: [String((e.props as { text?: string }).text ?? '')] }) })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Text', text: /No edits yet/ })).toBeDefined()
  const msg = await $.ui.mount({ plugin: 'changes', surface: 'terminal', component: 'AssistantMessage', requestId: 'm1', props: { text: 'Hi\n<change-group title="x"/>', isFirstOfReply: true } as never })
  expect(await msg.find({ type: 'Text', text: /change-group/ })).toBeUndefined()
})

test('regression: a subagent turn between does not orphan the main turn\'s edits', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' } as never)
  await $.turn.start({ text: 'sub', turnId: 't1', agentId: 'a1' } as never)
  await $.turn.complete({ ...turnDone('sub done'), agentId: 'a1' } as never)
  await $.turn.complete(turnDone('<change-group id="main" kind="fix" title="Main work"/>'))
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Button', text: 'Main work' })).toBeDefined()
})

test('regression: a new session clears a pending ask, so edits are not refused forever', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await oneEditTurn($, '<change-group id="wait" kind="behaviour" title="Wait for agents"/>')
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'open-wait' })
  await ui.press({ key: 'file-0' })
  await ui.key({ key: 'a', in: 'viewer' } as never)
  await ui.input({ key: 'ask-input', text: 'why?' })
  // the ask turn never completes; the session is resumed in the same process
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  const r = await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' } as never)
  expect((r as { deny?: string }).deny).toBeUndefined()
})

test('a Bash command that edits a file is recorded like an Edit: grouped, counted, drawn', async ($, on) => {
  const sent: string[] = []
  const files: Record<string, string> = { '/repo/src/drive.ts': 'export function a() {\n  return 1\n}\n' }
  mock.store(on)
  mock.env(on, { HOME: '/home/me' })
  on('session.id', async () => ({ value: 'sid-1' }) as never)
  on('fs.read', async (_$, e) => ((e as { path: string }).path in files ? { value: files[(e as { path: string }).path] } : { deny: 'missing' }) as never)
  on('command.register', async () => ({ value: {} }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.panes', async () => ({ value: [] }) as never)
  on('prompt.submit', async (_$, e) => { sent.push(e.text); return { text: e.text } as never })
  on('turn.complete', async (_$, e) => ({ text: e.answer }))
  on('turn.start', async (_$, e) => e as never)
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  // the "shell": running the command changes one file and creates another
  on('tool.call', async (_$, e) => {
    if (e.tool === 'Bash') {
      files['/repo/src/drive.ts'] = 'export function a() {\n  return 2\n}\n'
      files['/repo/src/new.ts'] = 'export const x = 1\n'
      return { result: { stdout: '', stderr: '', interrupted: false } } as never
    }
    return { result: 'ok' } as never
  })
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/1/2/' src/drive.ts && echo 'export const x = 1' > src/new.ts" } as never)
  await $.turn.complete(turnDone('<change-group id="ret" kind="fix" title="Return two" summary="drive.ts a() returns 2; new.ts adds x"/>'))
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Button', text: 'Return two' })).toBeDefined()
  await ui.press({ key: 'open-ret' })
  expect(await ui.find({ type: 'Button', text: /src\/drive\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: /src\/new\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /ƒ a/ })).toBeDefined()
  await ui.press({ key: 'file-0' })
  expect(await ui.find({ type: 'Text', text: /return 1/, in: 'viewer' })).toBeDefined() // the old line, shown removed
  expect(await ui.find({ type: 'Text', text: /return 2/, in: 'viewer' })).toBeDefined()
})

test('a read-only Bash command records nothing', async ($, on) => {
  const sent: string[] = []
  world(on, sent)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'go', turnId: 't1' } as never)
  await $.tool.call({ tool: 'Bash', command: 'cat src/drive.ts && grep -n x src/drive.ts' } as never)
  await $.turn.complete(turnDone(''))
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Text', text: /No edits yet/ })).toBeDefined()
})

test('untagged turns are labelled by a small call, and later turns join that concept', async ($, on) => {
  const sent: string[] = []
  const asked: string[] = []
  let reply = 'src/drive.ts => NEW wait-agents | behaviour | Wait for running agents | busyAgents filters to running ones.'
  world(on, sent)
  on('model.complete', async (_$, e) => { asked.push((e as { prompt: string }).prompt); return { value: { isAnswered: true, text: reply, usage: {} } } as never })
  await oneEditTurn($, '')
  let ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Button', text: 'Wait for running agents' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Other changes' })).toBeUndefined()
  await ui.unmount()
  // a second untagged turn on the same work: the call sees the concept and joins it
  reply = 'src/drive.ts => wait-agents'
  await $.turn.start({ text: 'also handle waiting', turnId: 't2' } as never)
  await $.tool.call({ tool: 'Edit', file_path: FILE, old_string: 'a', new_string: 'b' } as never)
  await $.turn.complete(turnDone('Done.'))
  expect(asked.at(-1)).toContain('id=wait-agents [behaviour] Wait for running agents')
  expect(asked.at(-1)).toContain('also handle waiting')
  ui = await $.ui.mount(PANE())
  expect(await ui.findAll({ type: 'Button', text: /Wait for running agents|Other changes/ })).toHaveLength(1)
})

test('a tagged turn makes no labelling call', async ($, on) => {
  const sent: string[] = []
  let calls = 0
  world(on, sent)
  on('model.complete', async () => { calls++; return { value: { isAnswered: true, text: '', usage: {} } } as never })
  await oneEditTurn($, '<change-group id="wait" kind="behaviour" title="Wait for agents"/>')
  expect(calls).toBe(0)
})

test('older "Other changes" groups are relabelled a couple per turn', async ($, on) => {
  const sent: string[] = []
  let labelling = false
  world(on, sent)
  on('model.complete', async () => ({ value: labelling
    ? { isAnswered: true, text: 'src/drive.ts => NEW old-work | fix | Earlier drive fix | Fixed earlier.', usage: {} }
    : { isAnswered: false, reason: 'empty-reply', usage: {} } }) as never)
  await oneEditTurn($, '') // labelling off: stays "Other changes"
  let ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Button', text: 'Other changes' })).toBeDefined()
  await ui.unmount()
  labelling = true
  await $.turn.start({ text: 'just a question', turnId: 't2' } as never)
  await $.turn.complete(turnDone('An answer with no edits.'))
  ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Button', text: 'Earlier drive fix' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'Other changes' })).toBeUndefined()
})

test('shell deletion retains removed content in the review viewer', async ($, on) => {
  const files: Record<string, string> = { [FILE]: 'export const gone = 1\n' }
  world(on, [], files, () => { delete files[FILE] })
  on('fs.exists', async (_$, e) => ({ value: (e as { path: string }).path in files }) as never)
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'remove obsolete file', turnId: 't' } as never)
  await $.tool.call({ tool: 'Bash', command: 'rm src/drive.ts' } as never)
  await $.turn.complete(turnDone('<change-group id="remove" kind="removal" title="Remove obsolete code"/>'))
  const ui = await $.ui.mount(PANE())
  await ui.press({ key: 'open-remove' })
  expect(await ui.find({ type: 'Text', text: 'deleted' })).toBeDefined()
  await ui.press({ key: 'file-0' })
  expect(await ui.find({ type: 'Text', text: /export const gone = 1/, in: 'viewer' })).toBeDefined()
})

test('clear resets changes and resume restores the selected session groups', async ($, on) => {
  world(on, [])
  on('classic.SessionStart', async () => ({}))
  await oneEditTurn($, '<change-group id="keep" kind="fix" title="Saved change"/>')
  await $.classic.SessionStart({ source: 'clear', cwd: '/repo' } as never)
  const ui = await $.ui.mount(PANE())
  expect(await ui.find({ type: 'Button', text: 'Saved change' })).toBeUndefined()
  await $.classic.SessionStart({ source: 'resume', cwd: '/repo' } as never)
  await ui.redraw()
  expect(await ui.find({ type: 'Button', text: 'Saved change' })).toBeDefined()
})
