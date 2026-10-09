export type StepStatus = 'pending' | 'in_progress' | 'completed'
export type Step = { id: string; title: string; active?: string; status: StepStatus }
/** Claude's per-turn estimate for the whole goal. */
export type Estimate = { goal?: string; phase?: number; phases?: number; phaseName?: string; pct: number }
export type Meter = {
  steps: Step[]
  estimate?: Estimate
  /** Steps done when the last estimate arrived: the bar advances from there. */
  doneAtEstimate: number
  /** What the bar last showed: it never shows less unless Claude lowers its estimate. */
  shown: number
  startedAt?: number
  /** Main turns since the last progress report or task change; drives staleness. */
  quiet?: number
}

declare module 'claude-code' {
  interface PluginState {
    'goal-meter': { meter: Meter }
  }
}
