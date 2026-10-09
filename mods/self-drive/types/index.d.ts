export type EntryKind = 'decision' | 'needs-you' | 'held' | 'note' | 'finished'
export type Entry = { at: number; kind: EntryKind; title: string; detail?: string; alternatives?: string; why?: string }
export type DriveStatus = 'driving' | 'finished' | 'stopped' | 'limit'
export type Drive = {
  task: string
  startedAt: number
  deadline?: number
  status: DriveStatus
  endedAt?: number
  endReason?: string
  entries: Entry[]
  continues: number
  /** Consecutive auto-continued turns with no tool call and no log entry. */
  idle: number
  lastActivity?: string
}

declare module 'claude-code' {
  interface PluginState {
    'self-drive': { drive: Drive | null }
  }
}
