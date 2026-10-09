/** Reporting tags inside Markdown code are examples. Preserve them verbatim. */
export function codeSpans(text: string): readonly (readonly [number, number])[] {
  const spans: [number, number][] = []
  const re = /(`+|~{3,})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const marker = m[0]
    if (marker[0] === '~' && text.slice(text.lastIndexOf('\n', m.index) + 1, m.index).trim()) continue
    const end = text.indexOf(marker, re.lastIndex)
    // An unfinished code span/fence is still code while a reply streams.
    const stop = end < 0 ? text.length : end + marker.length
    spans.push([m.index, stop]); re.lastIndex = stop
  }
  return spans
}
export function outsideCode(text: string, tag: RegExp): RegExpMatchArray[] {
  const spans = codeSpans(text)
  return [...text.matchAll(tag)].filter(m => !spans.some(([a, b]) => m.index! >= a && m.index! < b))
}
export function stripOutsideCode(text: string, tag: RegExp): string {
  for (const m of outsideCode(text, tag).reverse()) text = text.slice(0, m.index!) + text.slice(m.index! + m[0].length)
  return text.replace(/\n{3,}/g, '\n\n')
}
