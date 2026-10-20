import { describe, expect, test } from 'claude-code/testing'

import { classify } from '../hooks/classify'

describe('classify', () => {
  test('design work goes to opus', () => {
    expect(classify('design a caching layer for the API')).toEqual({ tier: 'opus', reason: 'complex' })
  })

  test('a why question goes to opus', () => {
    expect(classify('why does the build fail on CI?')).toEqual({ tier: 'opus', reason: 'complex' })
  })

  test('a long prompt goes to opus', () => {
    expect(classify('a'.repeat(1600))).toEqual({ tier: 'opus', reason: 'complex' })
  })

  test('a pasted stack trace goes to opus', () => {
    const text = 'it crashed:\nTraceback (most recent call last):\n  File "x.py", line 1'
    expect(classify(text)).toEqual({ tier: 'opus', reason: 'complex' })
  })

  test('a short lookup goes to haiku', () => {
    expect(classify('what does resolve_trust_remote_code do?')).toEqual({ tier: 'haiku', reason: 'lookup' })
  })

  test('a trivial edit goes to haiku even though it says fix', () => {
    expect(classify('fix the typo in README')).toEqual({ tier: 'haiku', reason: 'lookup' })
  })

  test('an ordinary coding task goes to sonnet', () => {
    expect(classify('add a --dry-run flag to main.py')).toEqual({ tier: 'sonnet', reason: 'coding' })
  })

  test('lookup and coding signals together are ambiguous', () => {
    expect(classify('where is the bug? fix it')).toEqual({ tier: 'ambiguous' })
  })

  test('no signal is ambiguous', () => {
    expect(classify('hmm')).toEqual({ tier: 'ambiguous' })
  })
})
