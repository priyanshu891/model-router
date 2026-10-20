import type { RouteEntry, RouterStats, RouterTier } from '../types'
import { displayOf, tierOf } from './cost'
import type { Models } from './cost'
import { thousands } from './stats'

/** What one turn's square in the strip says: the tier it went to, held by the cost gate, or not routed. */
export type Mark = RouterTier | 'kept' | 'none'

export type DashboardInput = {
  isEnabled: boolean
  pin: RouterTier | null
  sessionModel: string
  models: Models
  stats: RouterStats
  allTime: RouterStats
  log: readonly RouteEntry[]
}

export type LogRow = { key: string; time: string; mark: Mark; tier: string; reason: string; prompt: string; cost: string }
export type ModelRow = { key: string; name: string; tier?: RouterTier; turns: string; prompt: string; output: string; cost: string }

export type DashboardView = {
  /** `ON`, `OFF` or `PINNED SONNET`. */
  state: string
  isEnabled: boolean
  session: string
  /** Oldest first, one per logged turn. */
  strip: Mark[]
  counts: Record<Mark, number>
  /** `15 turns`, or `last 50 of 73 turns` once the log has dropped some. */
  turns: string
  saving: {
    /** 0 to 100, or null before any request; negative savings show as 0. */
    pct: number | null
    isLoss: boolean
    saved: string
    spent: string
    baseline: string
    classifier: string
    allTime: string
  }
  models: ModelRow[]
  /** Newest first. */
  log: LogRow[]
}

/** Dollars as the pane draws them: cents once over a dollar, finer below. */
export const money = (n: number) => `$${n.toFixed(Math.abs(n) >= 1 ? 2 : Math.abs(n) >= 0.01 ? 3 : 4)}`

/** A filled bar of `width` cells for `pct` percent. */
export const gauge = (pct: number, width: number) => {
  const full = Math.max(0, Math.min(width, Math.round((pct / 100) * width)))

  return { on: '▰'.repeat(full), off: '▱'.repeat(width - full) }
}

/** Local wall-clock time, `16:20:11`. */
export const clockOf = (ms: number) => new Date(ms).toTimeString().slice(0, 8)

/** The prompt on one line. */
const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

export const markOf = (r: RouteEntry, models: Models): Mark =>
  r.tier === null ? 'none' : r.kept !== undefined ? 'kept' : (tierOf(r.model, models) ?? 'none')

const savedOf = (s: RouterStats) => {
  const saved = s.baselineUsd - s.usd

  return { saved, pct: s.baselineUsd > 0 ? (saved / s.baselineUsd) * 100 : null }
}

export const dashboardView = (d: DashboardInput): DashboardView => {
  const counts: Record<Mark, number> = { haiku: 0, sonnet: 0, opus: 0, kept: 0, none: 0 }
  const strip = d.log.map(r => markOf(r, d.models))
  for (const mark of strip) counts[mark] += 1
  const total = d.log.at(-1)?.n ?? 0
  const now = savedOf(d.stats)
  const all = savedOf(d.allTime)

  return {
    state: !d.isEnabled ? 'OFF' : d.pin === null ? 'ON' : `PINNED ${d.pin.toUpperCase()}`,
    isEnabled: d.isEnabled,
    session: displayOf(d.sessionModel),
    strip,
    counts,
    turns: total > d.log.length ? `last ${d.log.length} of ${total} turns` : `${total} turn${total === 1 ? '' : 's'}`,
    saving: {
      pct: now.pct === null ? null : Math.max(0, Math.min(100, now.pct)),
      isLoss: now.saved < 0,
      saved: `${money(now.saved)}${now.pct === null ? '' : ` · ${Math.round(now.pct)}%`}`,
      spent: money(d.stats.usd),
      baseline: money(d.stats.baselineUsd),
      classifier: money(d.stats.classifierUsd),
      allTime: `saved ${money(all.saved)} of ${money(d.allTime.baselineUsd)}${all.pct === null ? '' : ` (${Math.round(all.pct)}%)`}`,
    },
    models: Object.entries(d.stats.byModel).map(([model, t]) => ({
      key: model,
      name: displayOf(model),
      tier: tierOf(model, d.models),
      turns: String(t.turns),
      prompt: thousands(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens),
      output: thousands(t.outputTokens),
      cost: money(t.usd),
    })),
    log: [...d.log].reverse().map(r => ({
      key: r.turnId,
      time: clockOf(r.at),
      mark: markOf(r, d.models),
      tier: r.tier === null ? '—' : (tierOf(r.model, d.models) ?? r.model),
      reason: r.kept !== undefined ? (r.kept === 'unavailable' ? 'unavailable' : `kept: ${r.kept}`) : r.reason,
      prompt: oneLine(r.prompt),
      cost: money(r.usd),
    })),
  }
}
