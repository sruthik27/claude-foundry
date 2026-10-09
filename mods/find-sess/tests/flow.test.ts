import { expect, mock, test } from 'claude-code/testing'

test('an unsuccessful later search clears the old numbered matches', async ($, on) => {
  mock.clock(on, { now: 0 }); mock.env(on, { HOME: '/h' })
  on('session.cwd', async () => ({ value: '/r' }) as never)
  on('session.id', async () => ({ value: 'current' }) as never)
  let hasSessions = true
  on('process.run', async () => ({ value: { stdout: hasSessions ? JSON.stringify([{ id: 'old', title: 'Old result', date: 'today', prompts: ['x'], edits: [] }]) : '[]', stderr: '', exitCode: 0 } }) as never)
  on('model.complete', async () => ({ value: { isAnswered: true, text: '1 | good match', usage: {} } }) as never)
  const first = await $.command.run({ command: 'find-sess', args: 'old result' })
  expect(first.text).toContain('Old result')
  hasSessions = false
  await $.command.run({ command: 'find-sess', args: 'no result' })
  const pick = await $.command.run({ command: 'find-sess', args: '1' })
  expect(pick.text).toContain('No such match')
})
