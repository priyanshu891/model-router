import type { ModelUsage } from 'claude-code'

import type { ModelTally, RouterStats } from '../types'
import { usdOf } from './cost'

export const EMPTY_STATS: RouterStats = { byModel: {}, usd: 0, baselineUsd: 0, classifierUsd: 0 }

const EMPTY_TALLY: ModelTally = {
  turns: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  usd: 0,
}

/** One model request: tallied at the model it went to, and priced at the session's model for the baseline. */
export const addStep = (
  s: RouterStats,
  sent: string,
  baseline: string,
  u: ModelUsage,
  isNewTurn: boolean,
): RouterStats => {
  const t = s.byModel[sent] ?? EMPTY_TALLY
  const usd = usdOf(sent, u)

  return {
    ...s,
    byModel: {
      ...s.byModel,
      [sent]: {
        turns: t.turns + (isNewTurn ? 1 : 0),
        inputTokens: t.inputTokens + u.input_tokens,
        outputTokens: t.outputTokens + u.output_tokens,
        cacheReadTokens: t.cacheReadTokens + u.cache_read_input_tokens,
        cacheWriteTokens: t.cacheWriteTokens + u.cache_creation_input_tokens,
        usd: t.usd + usd,
      },
    },
    usd: s.usd + usd,
    baselineUsd: s.baselineUsd + usdOf(baseline, u),
  }
}

/** A classifier call: the router's own spend, with no baseline counterpart. */
export const addClassifier = (s: RouterStats, u: ModelUsage, model: string): RouterStats => {
  const usd = usdOf(model, u)

  return { ...s, usd: s.usd + usd, classifierUsd: s.classifierUsd + usd }
}

export const dollars = (n: number) => `$${n.toFixed(4)}`
export const thousands = (n: number) => `${(n / 1000).toFixed(1)}k`

export const totals = (s: RouterStats) => {
  const saved = s.baselineUsd - s.usd
  const share = s.baselineUsd > 0 ? ` (${Math.round((saved / s.baselineUsd) * 100)}%)` : ''

  return `spent ${dollars(s.usd)} · on the session's model ≈ ${dollars(s.baselineUsd)} · saved ≈ ${dollars(saved)}${share}`
}

export const formatStats = (session: RouterStats, allTime: RouterStats): string => {
  const rows = Object.entries(session.byModel).map(([model, t]) => {
    const prompt = t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens

    return `  ${model.padEnd(20)} ${String(t.turns).padStart(4)} turns  ${thousands(prompt).padStart(8)} in  ${thousands(t.outputTokens).padStart(7)} out  ${dollars(t.usd)}`
  })

  return [
    'Model router — this session',
    ...(rows.length > 0 ? rows : ['  no routed requests yet']),
    `  ${'classifier'.padEnd(20)} ${dollars(session.classifierUsd)}`,
    `  ${totals(session)}`,
    `All time: ${totals(allTime)}`,
    'The baseline prices the same tokens at the session’s model; its cache use would have differed, so the saving is an estimate.',
  ].join('\n')
}
