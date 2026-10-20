import type { RouterTier } from '../types'

export type Classified = { tier: RouterTier; reason: string } | { tier: 'ambiguous' }

const LONG = 1500
const SHORT = 200

const COMPLEX =
  /\b(design|architect\w*|plan|refactor\w*|debug\w*|investigat\w*|review|root cause|migrat\w*)\b|\bacross (the )?(files|codebase|repo)\b|\bwhy (does|is|do|did|are)\b/i
const TRACE = /Traceback \(most recent call last\)|^\s+at \S+ \(.+:\d+:\d+\)|Exception in thread|panicked at/m
const TRIVIAL = /\b(rename|typo|reformat|format)\b/i
const LOOKUP =
  /^(what (is|are|does|do)|where (is|are|do)|which (file|function|class|command)|list|show me|explain (this|the) command)\b/i
const CODING = /\b(implement|add|write|fix|update|test|create|change)\b/i

/** Free, instant routing of the obvious cases; the rest is `ambiguous`. */
export const classify = (text: string): Classified => {
  const t = text.trim()

  if (t.length > LONG || TRACE.test(t) || COMPLEX.test(t)) {
    return { tier: 'opus', reason: 'complex' }
  }

  const isShort = t.length < SHORT
  if (isShort && TRIVIAL.test(t)) {
    return { tier: 'haiku', reason: 'lookup' }
  }

  const isLookup = isShort && LOOKUP.test(t)
  const isCoding = CODING.test(t)
  if (isLookup && !isCoding) return { tier: 'haiku', reason: 'lookup' }
  if (isCoding && !isLookup) return { tier: 'sonnet', reason: 'coding' }

  return { tier: 'ambiguous' }
}
