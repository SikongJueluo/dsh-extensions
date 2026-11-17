import { parseSync } from 'oxc-parser'

export function suppressionRules(file, source) {
  const parsed = parseSync(file, source)
  if (parsed.errors.length > 0) throw new Error(`${file}: ${parsed.errors[0].message}`)
  const found = []
  for (const comment of parsed.comments) {
    const text = comment.value.trim()
    const directive = text.match(
      /^(?:(?:oxlint|eslint)-disable(?:-next-line|-line)?|fallow-(?:ignore(?:-next-line|-file)?|disable(?:-next-line)?))(?=\s|$)([\s\S]*)$/u,
    )
    if (!directive) continue
    const ruleText = directive[1].split(/\s+--\s/u)[0].trim()
    const rules = ruleText ? ruleText.split(/[,\s]+/u).filter(Boolean) : ['*']
    const line = source.slice(0, comment.start).split('\n').length
    for (const rule of rules) found.push({ line, rule })
  }
  return found
}
