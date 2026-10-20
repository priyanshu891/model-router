import type { ModelUsage } from 'claude-code'

import type { RouterTier } from '../types'

/** The model id each tier sends; a gateway may serve other ids (the plugin's settings). */
export type Models = Readonly<Record<RouterTier, string>>

export const DEFAULT_MODELS: Models = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

const TIERS = Object.keys(DEFAULT_MODELS) as RouterTier[]
const RANK: Record<RouterTier, number> = { haiku: 0, sonnet: 1, opus: 2 }

type Price = { input: number; output: number; cacheWrite: number; cacheRead: number }
type Card = Price & { window: number; long?: Price & { from: number } }

// US$ per million tokens, Claude API list prices (claude-api reference, cached
// 2026-10-06), and each model's context window. A cache write is the 5-minute
// TTL's 1.25x of input; a cache read not listed there is the general 0.1x.
// Haiku 5.5 bills a prompt over 100K tokens at its long rate.
const CARDS: Readonly<Record<string, Card>> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2, window: 1_000_000 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2, window: 1_000_000 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheWrite: 0.125,
    cacheRead: 0.01,
    window: 1_000_000,
    long: { input: 0.5, output: 2.5, cacheWrite: 0.625, cacheRead: 0.05, from: 100_000 },
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1, window: 200_000 },
}

export const CACHE_TTL_MS = 5 * 60 * 1000

// The turn the gate prices: this many requests and output tokens.
const STEPS = 3
const OUTPUT_TOKENS = 1_500

/**
 * A model id as priced: no `[1m]` suffix, no `aws/` or Bedrock `us.anthropic.`
 * prefix, no Bedrock `-v1:0` version, no `-20251001` or Vertex `@20251001` date.
 */
const baseOf = (model: string) =>
  model
    .replace(/\[.*\]$/, '')
    .replace(/^[\w-]+\//, '')
    .replace(/^(?:[a-z-]+\.)?anthropic\./, '')
    .replace(/-v\d+(?::\d+)?$/, '')
    .replace(/[-@]\d{8}$/, '')

const cardOf = (model: string): Card | undefined => CARDS[baseOf(model)]

/** Whether the table has a price for `model`. */
export const isPriced = (model: string) => cardOf(model) !== undefined

export const tierOf = (model: string, models: Models): RouterTier | undefined =>
  TIERS.find(tier => baseOf(models[tier]) === baseOf(model))

/** `claude-haiku-4-5-20251001` → `Haiku 4.5`; an id of another shape as it is. */
export const displayOf = (model: string) => {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?$/.exec(baseOf(model))
  if (m === null) return model
  const [, family = '', major, minor] = m

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}${minor === undefined ? '' : `.${minor}`}`
}

const priceOf = (card: Card, promptTokens: number): Price =>
  card.long !== undefined && promptTokens > card.long.from ? card.long : card

const promptTokensOf = (u: ModelUsage) =>
  u.input_tokens + u.cache_read_input_tokens + u.cache_creation_input_tokens

/** What the next request re-sends: this one's prompt plus its reply. */
export const contextOf = (u: ModelUsage) => promptTokensOf(u) + u.output_tokens

/** A request's list-price cost; 0 for a model outside the table. */
export const usdOf = (model: string, u: ModelUsage): number => {
  const card = cardOf(model)
  if (card === undefined) return 0
  const p = priceOf(card, promptTokensOf(u))

  return (
    (u.input_tokens * p.input +
      u.output_tokens * p.output +
      u.cache_creation_input_tokens * p.cacheWrite +
      u.cache_read_input_tokens * p.cacheRead) /
    1e6
  )
}

export type GateInput = {
  /** The model the last request went to: the one whose cache holds the context. */
  warm: string
  target: RouterTier
  models: Models
  contextTokens: number
  isCacheWarm: boolean
}

export type Gate = { model: string; kept?: 'cache' | 'context' | 'unknown' }

/** Upgrades always pass; a downgrade passes only when it is cheaper, re-caching included. */
export const gate = ({ warm, target, models, contextTokens: c, isCacheWarm }: GateInput): Gate => {
  const from = tierOf(warm, models)
  const to = models[target]
  const m = cardOf(warm)
  const t = cardOf(to)
  if (from === undefined || m === undefined || t === undefined) return { model: warm, kept: 'unknown' }
  if (target === from) return { model: warm }
  if (c > t.window) return { model: warm, kept: 'context' }
  if (RANK[target] > RANK[from]) return { model: to }

  const mp = priceOf(m, c)
  const tp = priceOf(t, c)
  const stay = c * (isCacheWarm ? mp.cacheRead : mp.cacheWrite) + (STEPS - 1) * c * mp.cacheRead + OUTPUT_TOKENS * mp.output
  const move = c * tp.cacheWrite + (STEPS - 1) * c * tp.cacheRead + OUTPUT_TOKENS * tp.output

  return move < stay ? { model: to } : { model: warm, kept: 'cache' }
}
