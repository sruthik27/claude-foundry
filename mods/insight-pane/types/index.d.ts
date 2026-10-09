export type InsightKind = 'concept' | 'decision' | 'why' | 'gotcha' | 'fact' | 'risk'
/** One card. `id` is Claude's short slug; re-emitting it rewrites the card in place. */
/** weight: Claude's 1-5 importance; hits: how many times it was re-confirmed/refined. */
export type Insight = { id: string; turn: number; kind: InsightKind; text: string; revised?: boolean; weight?: number; hits?: number }
/** What one tag asks for: a new or rewritten card, or the removal of one. */
export type InsightOp = { op: 'set'; insight: Insight } | { op: 'drop'; id: string }

declare module 'claude-code' {
  interface PluginState {
    'insight-pane': { items: Insight[]; collapsed: InsightKind[] }
  }
}
