export type GroupKind = 'feature' | 'behaviour' | 'fix' | 'refactor' | 'test' | 'config' | 'removal' | 'docs'

/** One hunk as the edit tools report it (structuredPatch). */
export type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

/** One edit Claude made: a file, the hunks, and what it was doing then. */
export type Edit = {
  id: string
  turn: number
  path: string
  hunks: Hunk[]
  /** The enclosing function/test/class per hunk, by a heuristic scan; '' when none. */
  symbols: string[]
  created?: boolean
  deleted?: boolean
  /** The concept group; set when the turn's tag (or the fallback) assigns it. */
  group?: string
  /** What Claude was on when it made the edit: the active task, if any. */
  task?: string
}

export type Group = { id: string; kind: GroupKind; title: string; summary: string; turn: number }

/** An ask or change request pointed at lines, and Claude's answer to it. */
export type Thread = {
  id: string
  path: string
  start: number
  end: number
  mode: 'ask' | 'change'
  text: string
  turn: number
  status: 'pending' | 'answered'
  answer?: string
}

/** Where the person is in the pane. */
export type Nav = {
  level: 'groups' | 'files' | 'code'
  group?: string
  file?: string
  scope: 'session' | 'branch'
}

export type Model = {
  edits: Edit[]
  groups: Group[]
  threads: Thread[]
  reviewed: string[]
  nav: Nav
  /** Bumped when a pointed change lands, so the viewer jumps to it. */
  focusSeq: number
}

declare module 'claude-code' {
  interface PluginState {
    changes: { model: Model }
  }
}
