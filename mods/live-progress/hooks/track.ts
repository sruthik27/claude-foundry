/* Pure: turn the new lines of a log into progress. Runners we recognise are counted for free;
   anything else is counted with the patterns Claude passes. */

import type { Progress, Spec } from '../types'
export type { Progress, Spec }
export const EMPTY: Progress = { done: 0, fail: 0, skip: 0, failures: [], last: '', finished: false }

type Runner = { name: string; test: RegExp; done?: RegExp; fail?: RegExp; skip?: RegExp; total?: RegExp; end?: RegExp; failName?: (m: RegExpExecArray) => string }
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '')

/** Line-level matchers for common runners; the first one whose `test` hits a line is kept. */
export const RUNNERS: Runner[] = [
  { name: 'pytest', test: /^(collected \d+ items?|=+ test session starts|\S+\.py::\S+ (PASSED|FAILED|SKIPPED|ERROR))/,
    total: /^collected (\d+) items?/, done: /::\S+ PASSED/, fail: /::\S+ (FAILED|ERROR)/, skip: /::\S+ (SKIPPED|XFAIL)/,
    end: /^=+ .*(passed|failed|error).* in [\d.]+s/, failName: m => m.input.split(' ')[0]! },
  { name: 'jest', test: /^\s*(PASS|FAIL)\s+\S+\.(t|j)sx?\b|^Tests:\s+\d+/, done: /^\s*✓ /, fail: /^\s*✕ /, skip: /^\s*○ /, end: /^Tests:\s+.*\d+ total/, failName: m => m.input.trim().slice(2) },
  { name: 'vitest', test: /^\s*(✓|×|↓) \S+\.(test|spec)\.|^\s*Test Files\s+\d+/, done: /^\s*✓ /, fail: /^\s*[×✗] /, skip: /^\s*↓ /, end: /^\s*Tests\s+\d+/, failName: m => m.input.trim().slice(2) },
  { name: 'go', test: /^(=== RUN|--- (PASS|FAIL|SKIP):|ok\s+\S+|FAIL\s+\S+)/, done: /^\s*--- PASS:/, fail: /^\s*--- FAIL:/, skip: /^\s*--- SKIP:/, end: /^(ok|FAIL)\s+\S+\s+[\d.]+s$|^PASS$/, failName: m => m.input.replace(/^\s*--- FAIL:\s*/, '').split(' ')[0]! },
  { name: 'node:test', test: /^\s*(ok|not ok) \d+ - |^[ℹ✔✖] /, done: /^\s*(ok \d+ - |✔ )/, fail: /^\s*(not ok \d+ - |✖ )/, end: /^(?:ℹ|#) duration_ms \d/, failName: m => m.input.replace(/^\s*(not ok \d+ - |✖ )/, '') },
  { name: 'cargo', test: /^test \S+ \.\.\. (ok|FAILED|ignored)|^running \d+ tests?/, total: /^running (\d+) tests?/, done: /^test \S+ \.\.\. ok/, fail: /^test \S+ \.\.\. FAILED/, skip: /^test \S+ \.\.\. ignored/, end: /^test result:/, failName: m => m.input.split(' ')[1]! },
  { name: 'claude-plugin-test', test: /^\((pass|fail)\) /, done: /^\(pass\) /, fail: /^\(fail\) /, end: /^Ran \d+ tests? across/, failName: m => m.input.replace(/^\(fail\) /, '').replace(/ \[[\d.]+ms\]$/, '') },
]

const rx = (s?: string) => { if (!s) return undefined; try { return new RegExp(s) } catch { return undefined } }

/** Folds new lines into the progress so far. `runner` sticks once one is recognised. */
export function feed(p: Progress, chunk: string, spec: Spec): Progress {
  const lines = strip(chunk).split('\n').filter(l => l.trim() !== '')
  if (lines.length === 0) return p
  const own = { done: rx(spec.done), fail: rx(spec.fail), skip: rx(spec.skip), pct: rx(spec.percent), end: rx(spec.end) }
  let runner = RUNNERS.find(r => r.name === p.runner)
  const out: Progress = { ...p, finished: false, summary: undefined, failures: [...p.failures] }
  for (const line of lines) {
    if (!runner && !own.done && !own.fail) { runner = RUNNERS.find(r => r.test.test(line)); if (runner) out.runner = runner.name }
    let m: RegExpExecArray | null
    if (own.pct && (m = own.pct.exec(line))) {
      const g = m[1] ?? m[0]
      const frac = /(\d+)\s*\/\s*(\d+)/.exec(g)
      out.pct = frac ? (Number(frac[1]) / Math.max(1, Number(frac[2]))) * 100 : parseFloat(g)
    }
    const total = runner?.total && (m = runner.total.exec(line)) ? Number(m[1]) : undefined
    if (total !== undefined) out.total = runner?.name === 'cargo' ? (out.total ?? 0) + total : total
    const isFail = (own.fail ?? runner?.fail)?.exec(line)
    if (isFail) {
      out.fail++
      const name = runner?.failName && !own.fail ? runner.failName(isFail) : line.trim()
      out.failures = [...out.failures.filter(f => f !== name), name.slice(0, 120)].slice(-5)
    } else if ((own.done ?? runner?.done)?.test(line)) out.done++
    else if ((own.skip ?? runner?.skip)?.test(line)) out.skip++
    if (runner?.name === 'node:test') {
      const summary = /^(?:ℹ|#) (tests|pass|fail|skipped) (\d+)/.exec(line)
      if (summary) {
        const n = Number(summary[2])
        if (summary[1] === 'tests') out.total = n
        if (summary[1] === 'pass') out.done = Math.max(out.done, n)
        if (summary[1] === 'fail') out.fail = Math.max(out.fail, n)
        if (summary[1] === 'skipped') out.skip = Math.max(out.skip, n)
      }
    }
    if ((own.end ?? runner?.end)?.test(line)) { out.finished = true; out.summary = line.trim().replace(/^=+\s*|\s*=+$/g, '').slice(0, 120) }
    out.last = line.trim().slice(0, 200)
  }
  return out
}

/** 0-100 when it can be known: the pattern's percentage, else counted / total. */
export function percent(p: Progress, spec: Spec): number | undefined {
  if (p.finished) return 100
  if (p.pct !== undefined && Number.isFinite(p.pct)) return Math.max(0, Math.min(100, p.pct))
  const total = spec.total ?? p.total
  if (!total) return undefined
  return Math.min(99, ((p.done + p.fail + p.skip) / total) * 100)
}

export const clock = (ms: number) => {
  const s = Math.floor(ms / 1000)
  return s >= 3600 ? `${Math.floor(s / 3600)}:${String(Math.floor(s / 60) % 60).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}` : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}
