import { expect, test } from 'claude-code/testing'
import { parsePicks, pickPrompt } from '../hooks/pick.js'

test('prompt lists sessions; parser keeps valid, unique, in-range picks', async () => {
  const p = pickPrompt('dense capture triage', [{ id: 'a', title: 'tools-rewriter', branch: 'main', date: '2026-10-05', prompts: ['rewrite tools'], edits: ['server.py'] }])
  expect(p).toContain('[1] tools-rewriter | 2026-10-05 | main')
  expect(p).toContain('edited: server.py')
  expect(parsePicks('2 | planned the gate\n[1] | edited prepare.py\n2 | dup\n9 | out of range\nchatter', 3))
    .toEqual([{ n: 2, why: 'planned the gate' }, { n: 1, why: 'edited prepare.py' }])
  expect(parsePicks('NONE', 3)).toEqual([])
})

test('parser ignores chatter around the answer lines', async () => {
  const reply = 'Looking through the sessions...\n\nFound it:\n\n48 | moved devices between accounts\n\n49 | mentions assign/move devices'
  expect(parsePicks(reply, 60)).toEqual([{ n: 48, why: 'moved devices between accounts' }, { n: 49, why: 'mentions assign/move devices' }])
})
