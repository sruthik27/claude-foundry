export type LumenMarkdownArgs<Surface> = {
  surface: Surface
  text: string
  columns: number
}

export type Lumen<Surface, Drawing> = {
  markdown: (args: LumenMarkdownArgs<Surface>) => Promise<Drawing | undefined>
}

declare module 'claude-code' {
  interface EngineInterface {
    lumen: Lumen<RenderSurface, RenderElement>
  }
}
