import { expect, test } from 'claude-code/testing'
import type { Model } from '../types'
import { branchModel, parseDiff, parseLog } from '../hooks/branch.js'
import { EMPTY, rows } from '../hooks/model.js'

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1..2 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,4 @@
 export function a() {
-  return 1
+  return 2
+  // more
 }
diff --git a/src/new.ts b/src/new.ts
new file mode 100644
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,2 @@
+export const x = 1
+export const y = 2
diff --git a/old.ts b/old.ts
deleted file mode 100644
--- a/old.ts
+++ /dev/null
@@ -1 +0,0 @@
-gone
`

test('parses git diff into per-file hunks; deleted files have no new side', async () => {
  const f = parseDiff(DIFF)
  expect([...f.keys()]).toEqual(['src/a.ts', 'src/new.ts', 'old.ts'])
  expect(f.get('src/a.ts')![0]).toEqual({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 4, lines: [' export function a() {', '-  return 1', '+  return 2', '+  // more', ' }'] })
  expect(f.get('src/new.ts')![0]!.newLines).toBe(2)
  expect(f.get('old.ts')![0]!.lines).toEqual(['-gone'])
})

test('parses git log and groups files under the newest commit, wip and session first', async () => {
  const log = parseLog('\x1eabc1\x1ffix(drive): only running agents\nsrc/a.ts\n\x1edef2\x1ffeat: add x\nsrc/new.ts\nsrc/a.ts\n')
  expect(log).toEqual([{ sha: 'abc1', subject: 'fix(drive): only running agents', files: ['src/a.ts'] }, { sha: 'def2', subject: 'feat: add x', files: ['src/new.ts', 'src/a.ts'] }])
  const m = branchModel('/r', parseDiff(DIFF), log, new Set(), EMPTY, () => ['export function a() {', '  return 2'])
  const r = rows(m)
  expect(r.map(g => [g.title, g.kind, g.files.map(f => f.path)])).toEqual([
    ['Uncommitted work', 'feature', ['/r/old.ts']],
    ['only running agents', 'fix', ['/r/src/a.ts']],
    ['add x', 'feature', ['/r/src/new.ts']],
  ])
  // uncommitted wins; a session group carries over by file
  const session: Model = { ...EMPTY, groups: [{ id: 's1', kind: 'behaviour', title: 'Session concept', summary: '', turn: 1 }], edits: [{ id: 'e', turn: 1, path: '/r/src/new.ts', hunks: [], symbols: [], group: 's1' }] }
  const n = branchModel('/r', parseDiff(DIFF), log, new Set(['src/a.ts']), session, () => [])
  expect(rows(n).map(g => g.title).sort()).toEqual(['Session concept', 'Uncommitted work'])
})

// Captured verbatim from git 2.x on a scratch repo: feat/x (one commit "feat: add util") plus an uncommitted edit.
const REAL_DIFF = 'diff --git a/src/drive.ts b/src/drive.ts\nindex bf59d3f..b25bf1f 100644\n--- a/src/drive.ts\n+++ b/src/drive.ts\n@@ -1,5 +1,5 @@\n export function busyAgents(list) {\n-  return []\n+  return list.filter(a => a.status === "running")\n }\n \n export function other() {\ndiff --git a/src/util.ts b/src/util.ts\nnew file mode 100644\nindex 0000000..3b04e50\n--- /dev/null\n+++ b/src/util.ts\n@@ -0,0 +1,2 @@\n+// util\n+export const k = 1\n'
const REAL_LOG = '\x1e0d06897\x1ffeat: add util\n\nsrc/util.ts\n'

test('real git output: committed and uncommitted files land in the right groups', async () => {
  const files = parseDiff(REAL_DIFF)
  expect([...files.keys()].sort()).toEqual(['src/drive.ts', 'src/util.ts'])
  const m = branchModel('/r', files, parseLog(REAL_LOG), new Set(['src/drive.ts']), EMPTY, () => [])
  expect(rows(m).map(g => [g.title, g.files.map(f => f.path)])).toEqual([
    ['Uncommitted work', ['/r/src/drive.ts']],
    ['add util', ['/r/src/util.ts']],
  ])
})
