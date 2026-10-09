export type Spec = { id: string; label: string; log: string; total?: number; done?: string; fail?: string; skip?: string; percent?: string; end?: string }
export type Progress = { done: number; fail: number; skip: number; total?: number; pct?: number; failures: string[]; last: string; finished: boolean; runner?: string; summary?: string }
export type Job = { generation: number; spec: Spec; p: Progress; offset: number; started: number; ended?: number; quietSince: number; idle: number; turnsDone: number; stopped?: string }

declare module 'claude-code' {
  interface PluginState {
    'live-progress': { jobs: Job[] }
  }
}
