import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { RouteEntry, RouterStats, RouterTier } from '../types'
import { classify } from './classify'
import { CACHE_TTL_MS, contextOf, DEFAULT_MODELS, displayOf, gate, isPriced, tierOf, usdOf } from './cost'
import type { Gate, Models } from './cost'
import { dashboardView, gauge } from './dashboard'
import type { Mark } from './dashboard'
import { askTier } from './llm'
import { addClassifier, addStep, EMPTY_STATS, formatStats } from './stats'

const isEnabled = atom({ plugin: 'model-router', key: 'isEnabled' } as const, true)
const pin = atom({ plugin: 'model-router', key: 'pin' } as const, null)
const stats = atom({ plugin: 'model-router', key: 'stats' } as const, EMPTY_STATS)
const log = atom({ plugin: 'model-router', key: 'log' } as const, [])

const STORED_ENABLED = 'isEnabled'
const STORED_STATS = 'allTimeStats'
// `+`, as a leading `!` puts Claude Code's prompt in shell mode.
const FORCE = /^\+(haiku|sonnet|opus)\s+/i
const TIERS: readonly string[] = ['haiku', 'sonnet', 'opus']
const USAGE = 'Usage: /router on | off | pin <haiku|sonnet|opus> | unpin | stats | dashboard'
const PANE = 'model-router'
// Flightdeck's width when docked beside the transcript; rows when seated inline above the prompt.
const PANE_COLUMNS = 66
const PANE_ROWS = 4
const LOG_TURNS = 50

// The person's theme colours, so the pane follows light, dark and colour-blind themes.
const COLOR = { kept: 'warning', none: 'inactive', faint: 'subtle', loss: 'error', savings: 'success' } as const
const MARK: Record<Mark, string> = { haiku: 'success', sonnet: 'suggestion', opus: 'claude', kept: COLOR.kept, none: COLOR.none }

type Decision = { tier: RouterTier; reason: string }

const label = (decision: Decision, g: Gate, models: Models) =>
  g.kept === undefined
    ? `router: ${decision.tier} · ${decision.reason}`
    : `router: ${tierOf(g.model, models) ?? g.model} (kept: ${g.kept})`

const idOr = (value: PluginOptions[string] | undefined, fallback: string) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback

const modelsOf = (options: PluginOptions): Models => ({
  haiku: idOr(options.haikuModel, DEFAULT_MODELS.haiku),
  sonnet: idOr(options.sonnetModel, DEFAULT_MODELS.sonnet),
  opus: idOr(options.opusModel, DEFAULT_MODELS.opus),
})

const allTimeOf = async ($: EngineInterface) =>
  ((await $.store.get(STORED_STATS)) as RouterStats | undefined) ?? EMPTY_STATS

/** Adds to this session's stats and the all-time ones alike. */
const record = async ($: EngineInterface, add: (s: RouterStats) => RouterStats) => {
  await update($, stats, add)
  await $.store.set(STORED_STATS, add(await allTimeOf($)))
}

/** Off, then a pin, then the rules, then the classifier; no decision leaves the session's model. */
const decide = async (
  $: EngineInterface,
  text: string,
  models: Models,
  refused: Set<string>,
): Promise<Decision | undefined> => {
  if (!(await read($, isEnabled))) return undefined
  const pinned = await read($, pin)
  if (pinned !== null) return { tier: pinned, reason: 'pinned' }
  const ruled = classify(text)
  if (ruled.tier !== 'ambiguous') return ruled
  if (refused.has(models.haiku)) return undefined

  const asked = await askTier(request => $.model.complete(request), text, models.haiku)
  if (asked.isRefused) refused.add(models.haiku)
  const { usage } = asked
  if (usage !== undefined) await record($, s => addClassifier(s, usage, models.haiku))

  return asked.tier === undefined ? undefined : { tier: asked.tier, reason: 'classified' }
}

const isSet = (value: string | undefined): value is string => value !== undefined && value !== ''

/** Claude Code's config folder: `$CLAUDE_CONFIG_DIR`, else `~/.claude`; none without a home. */
const configDirOf = async ($: EngineInterface) => {
  const dir = await $.env.get('CLAUDE_CONFIG_DIR')
  if (isSet(dir)) return dir
  const home = await $.env.get('HOME')
  const profile = isSet(home) ? home : await $.env.get('USERPROFILE')

  return isSet(profile) ? `${profile}/.claude` : undefined
}

/** `<config dir>/model-router/sessions/<id>.json`, read by the status line. */
const routeFileOf = async ($: EngineInterface, sessionId: string) => {
  const dir = await configDirOf($)

  return dir === undefined ? undefined : `${dir}/model-router/sessions/${sessionId}.json`
}

/** Tells the status line which model the session's last request went to; a failed write only leaves it stale. */
const writeRoute = async ($: EngineInterface, model: string) => {
  try {
    const path = await routeFileOf($, await $.session.id())
    if (path !== undefined) await $.fs.write(path, `${JSON.stringify({ model, display: displayOf(model) })}\n`)
  } catch {
    // the footer keeps the session's model
  }
}

export const register: Register = (on, options) => {
  const models = modelsOf(options)
  // Models whose requests failed this session: never routed to again until a reload.
  const refused = new Set<string>()
  // Turn bookkeeping, the module's own: a reload mid-turn leaves that turn unrouted.
  let pending: Decision | undefined
  const turns = new Map<string, { decision: Decision; model?: string }>()
  let warm: string | undefined
  let context = 0
  let lastRequestAt = Number.NEGATIVE_INFINITY
  // The dashboard's turn numbers, each turn's prompt, and the model last told to the status line.
  let turnCount = 0
  const prompts = new Map<string, string>()
  let routed: string | undefined
  // Whether this load has said that a model outside the price table keeps turns where they are.
  let isUnknownSaid = false

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'router',
      description: 'Route each turn to Haiku, Sonnet or Opus by what it asks',
      argumentHint: 'on | off | pin <haiku|sonnet|opus> | unpin | stats | dashboard',
    })
    const stored = await $.store.get(STORED_ENABLED)
    if (typeof stored === 'boolean') await update($, isEnabled, () => stored)
    if (stored === false) $.ui.status('router: off')

    return next(e)
  })

  on('command.run', { command: 'router' }, async ($, e) => {
    const [verb = '', arg = ''] = e.args.trim().toLowerCase().split(/\s+/)

    if (verb === 'on' || verb === 'off') {
      const isOn = verb === 'on'
      await update($, isEnabled, () => isOn)
      await $.store.set(STORED_ENABLED, isOn)
      $.ui.status(isOn ? undefined : 'router: off')
      return { text: `Model router ${verb}.` }
    }
    if (verb === 'pin') {
      if (!TIERS.includes(arg)) return { text: USAGE }
      const tier = arg as RouterTier
      await update($, pin, () => tier)
      return { text: `Every turn now goes to ${tier} until /router unpin.` }
    }
    if (verb === 'unpin') {
      await update($, pin, () => null)
      return { text: 'Pin cleared: routing by query again.' }
    }
    if (verb === '' || verb === 'stats') {
      return { text: formatStats(await read($, stats), await allTimeOf($)) }
    }
    if (verb === 'dashboard') {
      const opened = await $.ui.open({ id: PANE, title: 'Model router', columns: PANE_COLUMNS, rows: PANE_ROWS })
      return { text: opened.isPlaced ? 'Model router dashboard opened.' : 'Model router dashboard opens once there is room for it.' }
    }

    return { text: USAGE }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const v = dashboardView({
      isEnabled: await read($, isEnabled),
      pin: await read($, pin),
      sessionModel: await $.session.model(),
      models,
      stats: await read($, stats),
      allTime: await allTimeOf($),
      log: await read($, log),
    })
    const W = Math.max(40, e.props.bodyColumns)
    const inner = W - 4
    const stateColor = !v.isEnabled ? COLOR.loss : v.state === 'ON' ? MARK.haiku : COLOR.kept
    const strip = v.strip.slice(-inner)
    const square = (mark: Mark, i: number) => (
      <Text key={`sq-${i}`} color={MARK[mark]}>
        ■
      </Text>
    )
    const count = (mark: Mark, label: string) => (
      <Text key={`count-${mark}`}>
        <Text color={MARK[mark]}>■</Text>
        <Text dimColor>{` ${v.counts[mark]} ${label}  `}</Text>
      </Text>
    )
    const bar = v.saving.pct === null ? null : gauge(v.saving.pct, 10)

    const routing = (
      <Box flexDirection="column" borderStyle="round" borderColor={MARK.sonnet} paddingX={1} width={W}>
        <Box justifyContent="space-between">
          <Text color={MARK.sonnet} bold>
            ROUTING · this session
          </Text>
          <Text dimColor>{v.turns}</Text>
        </Box>
        <Box>{strip.length === 0 ? <Text color={COLOR.faint}>no turns yet</Text> : strip.map(square)}</Box>
        <Text wrap="truncate">
          {count('haiku', 'haiku')}
          {count('sonnet', 'sonnet')}
          {count('opus', 'opus')}
          {count('kept', 'kept')}
          {v.counts.none > 0 ? count('none', 'unrouted') : null}
        </Text>
      </Box>
    )

    const savings = (
      <Box flexDirection="column" borderStyle="round" borderColor={COLOR.savings} paddingX={1} width={W}>
        <Box justifyContent="space-between">
          <Text color={COLOR.savings} bold>
            SAVINGS
          </Text>
          <Text color={v.saving.isLoss ? COLOR.loss : COLOR.savings} bold>
            {v.saving.saved}
          </Text>
        </Box>
        {bar === null ? (
          <Text color={COLOR.faint}>no requests yet</Text>
        ) : (
          <Text wrap="truncate">
            <Text dimColor>{v.saving.isLoss ? 'cost  ' : 'saved '}</Text>
            <Text color={v.saving.isLoss ? COLOR.loss : COLOR.savings}>{bar.on}</Text>
            <Text color={COLOR.faint}>{bar.off}</Text>
          </Text>
        )}
        <Text wrap="truncate">
          <Text dimColor>spent </Text>
          <Text bold>{v.saving.spent}</Text>
          <Text dimColor>{` · ${v.session} alone ≈ ${v.saving.baseline} · classifier ${v.saving.classifier}`}</Text>
        </Text>
        <Text dimColor wrap="truncate">{`all time  ${v.saving.allTime}`}</Text>
      </Box>
    )

    const cell = (key: string, width: number, text: string) => (
      <Box key={key} width={width} flexShrink={0} justifyContent="flex-end">
        <Text dimColor>{text}</Text>
      </Box>
    )
    const modelTable = (
      <Box flexDirection="column" borderStyle="round" borderColor={COLOR.faint} paddingX={1} width={W}>
        <Box>
          <Box flexGrow={1}>
            <Text bold>MODELS</Text>
          </Box>
          {cell('h-turns', 7, 'turns')}
          {cell('h-prompt', 10, 'prompt')}
          {cell('h-output', 9, 'output')}
          {cell('h-cost', 10, 'cost')}
        </Box>
        {v.models.length === 0 ? <Text color={COLOR.faint}>no requests yet</Text> : null}
        {v.models.map(row => (
          <Box key={row.key}>
            <Box flexGrow={1}>
              <Text color={row.tier === undefined ? COLOR.none : MARK[row.tier]} bold wrap="truncate">
                {row.name}
              </Text>
            </Box>
            {cell(`${row.key}-turns`, 7, row.turns)}
            {cell(`${row.key}-prompt`, 10, row.prompt)}
            {cell(`${row.key}-output`, 9, row.output)}
            {cell(`${row.key}-cost`, 10, row.cost)}
          </Box>
        ))}
      </Box>
    )

    const turnLog = (
      <Box flexDirection="column" borderStyle="round" borderColor={COLOR.faint} paddingX={1} width={W}>
        <Text dimColor>turn log</Text>
        {v.log.length === 0 ? <Text color={COLOR.faint}>nothing yet</Text> : null}
        {v.log.map(row => (
          <Box key={row.key}>
            <Box width={10} flexShrink={0}>
              <Text color={COLOR.faint}>{row.time}</Text>
            </Box>
            <Box width={8} flexShrink={0}>
              <Text color={MARK[row.mark]} bold wrap="truncate">
                {row.tier}
              </Text>
            </Box>
            <Box width={13} flexShrink={0}>
              {row.mark === 'kept' ? (
                <Text color={COLOR.kept} wrap="truncate">
                  {row.reason}
                </Text>
              ) : (
                <Text dimColor wrap="truncate">
                  {row.reason}
                </Text>
              )}
            </Box>
            <Box flexGrow={1}>
              <Text wrap="truncate">{row.prompt}</Text>
            </Box>
            {cell(`${row.key}-cost`, 8, row.cost)}
          </Box>
        ))}
      </Box>
    )

    // Seated inline above the prompt, the pane is a summary of a few rows.
    if (e.props.placement === 'inline') {
      return (
        <Box flexDirection="column" width={W}>
          <Text wrap="truncate">
            <Text bold>MODEL ROUTER </Text>
            <Text color={stateColor} bold>
              {v.state}
            </Text>
            <Text dimColor>{`  ${v.turns} · saved ${v.saving.saved}`}</Text>
          </Text>
          <Box>{strip.map(square)}</Box>
          <Text wrap="truncate">
            {count('haiku', 'haiku')}
            {count('sonnet', 'sonnet')}
            {count('opus', 'opus')}
            {count('kept', 'kept')}
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" width={W}>
        <Box justifyContent="center">
          <Text bold wrap="truncate">
            <Text>MODEL ROUTER</Text>
            <Text color={COLOR.none}> · </Text>
            <Text color={stateColor}>{v.state}</Text>
            <Text color={COLOR.none}> · </Text>
            <Text dimColor>session </Text>
            <Text color={MARK.opus}>{v.session.toUpperCase()}</Text>
          </Text>
        </Box>
        <Box justifyContent="center" columnGap={2}>
          {(['haiku', 'sonnet', 'opus', 'kept'] as const).map(mark => (
            <Text key={`legend-${mark}`}>
              <Text color={MARK[mark]}>■</Text>
              <Text dimColor>{` ${mark}`}</Text>
            </Text>
          ))}
        </Box>
        {routing}
        {savings}
        {modelTable}
        {turnLog}
      </Box>
    )
  })

  on('prompt.submit', async ($, e, next) => {
    if (e.command !== undefined || e.isMeta) return next(e)

    const forced = FORCE.exec(e.text)
    if (forced !== null) {
      pending = { tier: forced[1]!.toLowerCase() as RouterTier, reason: 'forced' }
      return next({ ...e, text: e.text.slice(forced[0].length) })
    }

    pending = await decide($, e.text, models, refused)
    return next(e)
  })

  on('turn.start', ($, e, next) => {
    if (e.agentId !== undefined) return next(e)
    prompts.set(e.turnId, e.text)
    if (pending !== undefined) turns.set(e.turnId, { decision: pending })
    pending = undefined

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    const now = await $.clock.now()
    const turn = turns.get(e.turnId)
    let kept: RouteEntry['kept']
    if (turn !== undefined && turn.model === undefined && refused.has(models[turn.decision.tier])) {
      turn.model = e.model
      kept = 'unavailable'
      $.ui.status(`router: ${turn.decision.tier} unavailable`)
    } else if (turn !== undefined && turn.model === undefined) {
      const g = gate({
        warm: warm ?? e.model,
        target: turn.decision.tier,
        models,
        contextTokens: context,
        isCacheWarm: now - lastRequestAt < CACHE_TTL_MS,
      })
      turn.model = g.model
      kept = g.kept
      $.ui.status(label(turn.decision, g, models))
      if (g.kept === 'unknown' && !isUnknownSaid) {
        isUnknownSaid = true
        const from = warm ?? e.model
        const why =
          tierOf(from, models) === undefined
            ? `${from} is not one of its tiers (${models.haiku}, ${models.sonnet}, ${models.opus})`
            : `${isPriced(from) ? models[turn.decision.tier] : from} has no price in its table`
        $.ui.toast(`model-router: turns stay on ${from}, as ${why}.`)
      }
    } else if (turn === undefined && e.index === 0) {
      $.ui.status((await read($, isEnabled)) ? undefined : 'router: off')
    }

    const model = turn?.model ?? e.model
    if (e.index === 0) {
      const entry: RouteEntry = {
        turnId: e.turnId,
        n: ++turnCount,
        at: now,
        prompt: prompts.get(e.turnId) ?? '',
        tier: turn?.decision.tier ?? null,
        reason: turn?.decision.reason ?? ((await read($, isEnabled)) ? 'no decision' : 'router off'),
        model,
        ...(kept !== undefined && { kept }),
        usd: 0,
      }
      await update($, log, list => [...list, entry].slice(-LOG_TURNS))
      if (model !== routed) {
        routed = model
        await writeRoute($, model)
      }
    }
    lastRequestAt = now
    const result = yield* next(model === e.model ? e : { ...e, model })

    const { usage } = result
    if (usage !== null) {
      warm = model
      context = contextOf(usage)
      await record($, s => addStep(s, model, e.model, usage, e.index === 0))
      const usd = usdOf(model, usage)
      await update($, log, list => list.map(r => (r.turnId === e.turnId ? { ...r, usd: r.usd + usd } : r)))
    } else if (model !== e.model && result.stopReason === null && !next.signal.aborted) {
      refused.add(model)
      $.ui.toast(
        `model-router: the request to ${model} failed, so turns stay off it this session. If your API or gateway does not serve it, set another id in the model-router plugin settings.`,
      )
    }

    return result
  })

  on('turn.complete', ($, e, next) => {
    if (e.agentId === undefined) {
      turns.delete(e.turnId)
      prompts.delete(e.turnId)
    }

    return next(e)
  })
}
