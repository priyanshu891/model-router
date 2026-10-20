import type { ModelUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { DEFAULT_MODELS, displayOf, gate, tierOf, usdOf } from '../hooks/cost'

const usage = (u: Partial<ModelUsage>): ModelUsage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  ...u,
})

const near = (actual: number, expected: number) =>
  expect(Math.abs(actual - expected)).toBeLessThan(1e-9)

const models = DEFAULT_MODELS
const HAIKU_45 = { ...DEFAULT_MODELS, haiku: 'claude-haiku-4-5-20251001' }

describe('tierOf', () => {
  test('reads a configured id, a [1m] suffix ignored', () => {
    expect(tierOf('claude-opus-5-5[1m]', models)).toBe('opus')
    expect(tierOf('claude-haiku-5-5', models)).toBe('haiku')
  })

  test('reads the tier a configured id stands for', () => {
    expect(tierOf('claude-haiku-4-5-20251001', HAIKU_45)).toBe('haiku')
    expect(tierOf('claude-haiku-5-5', HAIKU_45)).toBeUndefined()
  })

  test('does not know other models', () => {
    expect(tierOf('claude-fable-5-1', models)).toBeUndefined()
  })
})

describe('usdOf', () => {
  test('prices Opus at list price', () => {
    near(usdOf('claude-opus-5-5', usage({ input_tokens: 1000, output_tokens: 1000 })), 0.024)
  })

  test('prices a Haiku 5.5 prompt over 100K at the long rate', () => {
    near(usdOf('claude-haiku-5-5', usage({ input_tokens: 200_000 })), 0.1)
  })

  test('prices Haiku 4.5 by its own table, a date or provider prefix ignored', () => {
    near(usdOf('claude-haiku-4-5-20251001', usage({ input_tokens: 1000, output_tokens: 1000 })), 0.006)
    near(usdOf('aws/claude-haiku-4-5', usage({ input_tokens: 1000, output_tokens: 1000 })), 0.006)
  })

  test('prices an unknown model at zero', () => {
    expect(usdOf('claude-fable-5-1', usage({ input_tokens: 1000 }))).toBe(0)
  })
})

describe('gate', () => {
  test('an upgrade always switches', () => {
    expect(gate({ warm: 'claude-sonnet-5-5', target: 'opus', models, contextTokens: 500_000, isCacheWarm: true })).toEqual({
      model: 'claude-opus-5-5',
    })
  })

  test('the same tier keeps the warm model as spelled', () => {
    expect(gate({ warm: 'claude-opus-5-5[1m]', target: 'opus', models, contextTokens: 0, isCacheWarm: true })).toEqual({
      model: 'claude-opus-5-5[1m]',
    })
  })

  test('a warm cache on a large context keeps the model', () => {
    expect(gate({ warm: 'claude-opus-5-5', target: 'sonnet', models, contextTokens: 200_000, isCacheWarm: true })).toEqual({
      model: 'claude-opus-5-5',
      kept: 'cache',
    })
  })

  test('a cold cache lets the same downgrade through', () => {
    expect(gate({ warm: 'claude-opus-5-5', target: 'sonnet', models, contextTokens: 200_000, isCacheWarm: false })).toEqual({
      model: 'claude-sonnet-5-5',
    })
  })

  test('a small context downgrades to haiku', () => {
    expect(gate({ warm: 'claude-opus-5-5', target: 'haiku', models, contextTokens: 20_000, isCacheWarm: true })).toEqual({
      model: 'claude-haiku-5-5',
    })
  })

  test('a 400K context stays on opus: Haiku bills it at the long rate', () => {
    expect(gate({ warm: 'claude-opus-5-5', target: 'haiku', models, contextTokens: 400_000, isCacheWarm: true })).toEqual({
      model: 'claude-opus-5-5',
      kept: 'cache',
    })
  })

  test('a context past the window keeps the model', () => {
    expect(gate({ warm: 'claude-opus-5-5', target: 'haiku', models, contextTokens: 1_200_000, isCacheWarm: false })).toEqual({
      model: 'claude-opus-5-5',
      kept: 'context',
    })
  })

  test("Haiku 4.5's 200K window keeps a 250K context", () => {
    expect(gate({ warm: 'claude-opus-5-5', target: 'haiku', models: HAIKU_45, contextTokens: 250_000, isCacheWarm: false })).toEqual({
      model: 'claude-opus-5-5',
      kept: 'context',
    })
  })

  test('a cold small context downgrades to the configured Haiku 4.5', () => {
    expect(gate({ warm: 'claude-opus-5-5', target: 'haiku', models: HAIKU_45, contextTokens: 20_000, isCacheWarm: false })).toEqual({
      model: 'claude-haiku-4-5-20251001',
    })
  })

  test('an unknown warm model is not routed from', () => {
    expect(gate({ warm: 'claude-fable-5-1', target: 'haiku', models, contextTokens: 0, isCacheWarm: false })).toEqual({
      model: 'claude-fable-5-1',
      kept: 'unknown',
    })
  })

  test('an unpriced target model is not routed to', () => {
    const odd = { ...DEFAULT_MODELS, haiku: 'some-gateway-model' }
    expect(gate({ warm: 'claude-opus-5-5', target: 'haiku', models: odd, contextTokens: 0, isCacheWarm: false })).toEqual({
      model: 'claude-opus-5-5',
      kept: 'unknown',
    })
  })
})

describe('displayOf', () => {
  test('names a model as the footer does', () => {
    expect(displayOf('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(displayOf('claude-opus-5-5[1m]')).toBe('Opus 5.5')
    expect(displayOf('aws/claude-sonnet-5-5')).toBe('Sonnet 5.5')
  })

  test('leaves an id of another shape as it is', () => {
    expect(displayOf('gpt-x')).toBe('gpt-x')
  })
})
