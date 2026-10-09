export type Suggestion = { name: string; why: string }
export type SkillsModel = {
  /** The turn the picks are for; a newer prompt replaces them. */
  turn: number
  pending: boolean
  /** Picks Claude has not loaded yet: a loaded one is removed. */
  suggestions: Suggestion[]
  /** Skills loaded this turn, so a pick arriving after the load is not shown. */
  loaded: string[]
}

declare module 'claude-code' {
  interface PluginState {
    skills: { model: SkillsModel }
  }
}
