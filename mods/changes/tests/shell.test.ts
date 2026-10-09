import { expect, test } from 'claude-code/testing'
import { candidates, diffHunks, normalize } from '../hooks/shell.js'

test('finds the files a command names, expanding simple variables, ~ and cd', async () => {
  const c = candidates(`D=~/.claude/mods/x; sed -i '' 's/a/b/' $D/hooks/reg.tsx && cat > \${D}/types/index.d.ts <<'EOF'\nx\nEOF\npython3 - "$D/tests/a.test.ts"`, '/w', '/Users/me')
  expect(c).toContain('/Users/me/.claude/mods/x/hooks/reg.tsx')
  expect(c).toContain('/Users/me/.claude/mods/x/types/index.d.ts')
  expect(c).toContain('/Users/me/.claude/mods/x/tests/a.test.ts')
  const r = candidates('cd src && sed -i "" s/x/y/ util.py', '/repo', '/h')
  expect(r).toContain('/repo/src/util.py')
  expect(r).toContain('/repo/util.py')
  // ignores urls, globs, binaries, node_modules and unresolved variables
  const n = candidates('curl https://x.io/a.json; ls *.ts; cp a.png b.png; cat node_modules/p/i.js $UNKNOWN/f.ts', '/w', '/h')
  expect(n.some(p => p.includes('x.io') || p.includes('*') || p.endsWith('.png') || p.includes('node_modules') || p.includes('UNKNOWN'))).toBe(false)
  expect(normalize('/a/./b/../c//d.ts')).toBe('/a/c/d.ts')
})

test('diffHunks: replace in the middle, with context and correct numbers', async () => {
  const before = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'].join('\n')
  const after = ['1', '2', '3', '4', 'five', '6', '7', '8', '9', '10'].join('\n')
  expect(diffHunks(before, after)).toEqual([{ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7, lines: [' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8'] }])
})

test('diffHunks: insertion, deletion, new file, separate hunks, no change', async () => {
  expect(diffHunks('a\nb', 'a\nx\nb')[0]).toEqual({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '+x', ' b'] })
  expect(diffHunks('a\nx\nb', 'a\nb')[0]!.lines).toEqual([' a', '-x', ' b'])
  expect(diffHunks('', 'one\ntwo')[0]).toEqual({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ['+one', '+two'] })
  const far = Array.from({ length: 30 }, (_, i) => `l${i}`)
  const changed = [...far]; changed[2] = 'X'; changed[25] = 'Y'
  expect(diffHunks(far.join('\n'), changed.join('\n')).length).toBe(2)
  expect(diffHunks('same', 'same')).toEqual([])
})
