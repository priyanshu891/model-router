import type { ModelUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { addClassifier, addStep, EMPTY_STATS, formatStats } from '../hooks/stats'

const STEP: ModelUsage = {
  input_tokens: 1000,
  output_tokens: 1000,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9)

describe('stats', () => {
  test('a step is tallied at its model and priced at the baseline too', () => {
    const s = addStep(EMPTY_STATS, 'claude-haiku-5-5', 'claude-opus-5-5', STEP, true)
    const haiku = s.byModel['claude-haiku-5-5']

    expect(haiku?.turns).toBe(1)
    expect(haiku?.inputTokens).toBe(1000)
    expect(haiku?.outputTokens).toBe(1000)
    near(s.usd, 0.0006)
    near(s.baselineUsd, 0.024)
  })

  test('a later step of the same turn adds tokens, not a turn', () => {
    const one = addStep(EMPTY_STATS, 'claude-haiku-5-5', 'claude-opus-5-5', STEP, true)
    const two = addStep(one, 'claude-haiku-5-5', 'claude-opus-5-5', STEP, false)

    expect(two.byModel['claude-haiku-5-5']?.turns).toBe(1)
    expect(two.byModel['claude-haiku-5-5']?.inputTokens).toBe(2000)
  })

  test('the classifier adds to the spend, not the baseline', () => {
    const s = addClassifier(EMPTY_STATS, STEP, 'claude-haiku-5-5')

    near(s.usd, 0.0006)
    near(s.classifierUsd, 0.0006)
    expect(s.baselineUsd).toBe(0)
  })

  test('the report names each model, the saving and its caveat', () => {
    const s = addStep(EMPTY_STATS, 'claude-haiku-5-5', 'claude-opus-5-5', STEP, true)
    const text = formatStats(s, s)

    expect(text).toContain('claude-haiku-5-5')
    expect(text).toContain('saved')
    expect(text).toContain('estimate')
  })
})
