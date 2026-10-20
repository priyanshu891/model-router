export type RouterTier = 'haiku' | 'sonnet' | 'opus'

export type ModelTally = {
  turns: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  usd: number
}

export type RouterStats = {
  byModel: Record<string, ModelTally>
  usd: number
  baselineUsd: number
  classifierUsd: number
}

/** One main-loop turn as the dashboard lists it. */
export type RouteEntry = {
  turnId: string
  /** The turn's place in the session, from 1. */
  n: number
  /** When its first request went out, ms since the epoch. */
  at: number
  prompt: string
  /** The tier decided, or null when the turn had no decision. */
  tier: RouterTier | null
  reason: string
  /** The model the turn's requests went to. */
  model: string
  kept?: 'cache' | 'context' | 'unknown' | 'unavailable'
  usd: number
}

declare module 'claude-code' {
  interface PluginState {
    'model-router': {
      isEnabled: boolean
      pin: RouterTier | null
      stats: RouterStats
      log: RouteEntry[]
    }
  }
}
