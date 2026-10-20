import { describe, expect, test } from 'claude-code/testing'

import type { RouteEntry } from '../types'
import { DEFAULT_MODELS } from '../hooks/cost'
import { dashboardView, gauge, money } from '../hooks/dashboard'
import { EMPTY_STATS } from '../hooks/stats'

const HAIKU_45 = 'claude-haiku-4-5-20251001'
const models = { ...DEFAULT_MODELS, haiku: HAIKU_45 }

const entry = (n: number, r: Partial<RouteEntry>): RouteEntry => ({
  turnId: `t${n}`,
  n,
  at: 0,
  prompt: 'what is x',
  tier: 'haiku',
  reason: 'lookup',
  model: HAIKU_45,
  usd: 0.004,
  ...r,
})

const base = {
  isEnabled: true,
  pin: null,
  sessionModel: 'claude-opus-5-5[1m]',
  models,
  stats: EMPTY_STATS,
  allTime: EMPTY_STATS,
  log: [],
}

describe('dashboardView', () => {
  test('marks each turn by where it went, held turns and unrouted ones apart', () => {
    const v = dashboardView({
      ...base,
      log: [
        entry(1, {}),
        entry(2, { tier: 'opus', reason: 'complex', model: 'claude-opus-5-5[1m]' }),
        entry(3, { model: 'claude-opus-5-5[1m]', kept: 'cache' }),
        entry(4, { tier: null, reason: 'router off', model: 'claude-opus-5-5[1m]' }),
      ],
    })

    expect(v.strip).toEqual(['haiku', 'opus', 'kept', 'none'])
    expect(v.counts).toEqual({ haiku: 1, sonnet: 0, opus: 1, kept: 1, none: 1 })
    expect(v.turns).toBe('4 turns')
  })

  test('lists the turns newest first, a held turn by the model it stayed on', () => {
    const v = dashboardView({ ...base, log: [entry(1, {}), entry(2, { model: 'claude-opus-5-5[1m]', kept: 'cache', prompt: 'where\n is  it' })] })

    expect(v.log.map(r => [r.tier, r.reason, r.prompt, r.cost])).toEqual([
      ['opus', 'kept: cache', 'where is it', '$0.0040'],
      ['haiku', 'lookup', 'what is x', '$0.0040'],
    ])
  })

  test('says how many turns the log dropped', () => {
    expect(dashboardView({ ...base, log: [entry(73, {})] }).turns).toBe('last 1 of 73 turns')
  })

  test('the saving against the session model, with the session model named', () => {
    const v = dashboardView({ ...base, stats: { ...EMPTY_STATS, usd: 0.38, baselineUsd: 0.52, classifierUsd: 0.001 } })

    expect(v.session).toBe('Opus 5.5')
    expect(v.saving.saved).toBe('$0.140 · 27%')
    expect(Math.round(v.saving.pct ?? 0)).toBe(27)
    expect(v.saving.isLoss).toBe(false)
  })

  test('a saving that went negative is a loss, its bar empty', () => {
    const v = dashboardView({ ...base, stats: { ...EMPTY_STATS, usd: 0.6, baselineUsd: 0.5 } })

    expect(v.saving.isLoss).toBe(true)
    expect(v.saving.pct).toBe(0)
  })

  test('names the models and their tiers', () => {
    const tally = { turns: 2, inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0.07 }
    const v = dashboardView({ ...base, stats: { ...EMPTY_STATS, byModel: { [HAIKU_45]: tally, 'gpt-x': tally } } })

    expect(v.models.map(m => [m.name, m.tier, m.prompt, m.cost])).toEqual([
      ['Haiku 4.5', 'haiku', '1.0k', '$0.070'],
      ['gpt-x', undefined, '1.0k', '$0.070'],
    ])
  })

  test('says the router is off, or what it is pinned to', () => {
    expect(dashboardView({ ...base, isEnabled: false }).state).toBe('OFF')
    expect(dashboardView({ ...base, pin: 'sonnet' }).state).toBe('PINNED SONNET')
  })
})

describe('gauge and money', () => {
  test('a gauge fills its share of cells', () => {
    expect(gauge(27, 10)).toEqual({ on: '▰▰▰', off: '▱▱▱▱▱▱▱' })
    expect(gauge(140, 4)).toEqual({ on: '▰▰▰▰', off: '' })
  })

  test('money is finer below a dollar', () => {
    expect([money(12.345), money(0.09), money(0.0004)]).toEqual(['$12.35', '$0.090', '$0.0004'])
  })
})
