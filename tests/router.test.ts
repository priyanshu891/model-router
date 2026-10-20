import type { HookStream, ModelCompleteResult, ModelUsage, On, TurnStepResult } from 'claude-code'
import type { Engine } from 'claude-code/testing'
import { describe, expect, mock, test } from 'claude-code/testing'

const OPUS = 'claude-opus-5-5'
const SONNET = 'claude-sonnet-5-5'
const HAIKU = 'claude-haiku-5-5'
const HAIKU_45 = 'claude-haiku-4-5-20251001'

const SMALL: ModelUsage = {
  input_tokens: 200,
  output_tokens: 100,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 2000,
}

type World = {
  /** The model each step was sent with, in order. */
  sent: string[]
  /** The prompt texts that reached the bottom of `prompt.submit`. */
  submitted: string[]
  /** What the next step reports as its usage. */
  usage: ModelUsage
  /** Models whose requests fail, as a gateway refusing them does. */
  refused: string[]
  /** How many times the classifier was asked. */
  classified: number
  /** Each file the plugin wrote, in order. */
  written: { path: string; text: string }[]
  /** Each toast the plugin raised, in order. */
  toasts: string[]
}

/** The engine beneath the plugin, answered by the test. */
const world = (
  on: On,
  classifier: ModelCompleteResult | 'throws' = { isAnswered: false, reason: 'aborted', usage: SMALL },
  env: Record<string, string> = { HOME: '/home/u' },
) => {
  const w: World = { sent: [], submitted: [], usage: SMALL, refused: [], classified: 0, written: [], toasts: [] }
  mock.clock(on)
  mock.store(on)
  mock.env(on, env)
  on('prompt.submit', ($, e) => {
    w.submitted.push(e.text)
    return { text: e.text }
  })
  on('model.complete', () => {
    w.classified += 1
    if (classifier === 'throws') throw new Error('the classifier failed')
    return { value: classifier }
  })
  on('ui.status', () => ({ value: undefined }))
  on('ui.toast', ($, e) => {
    w.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.model', () => ({ value: OPUS }))
  on('fs.write', ($, e) => {
    w.written.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.step', async function* ($, e): AsyncGenerator<never, TurnStepResult> {
    w.sent.push(e.model)
    const isRefused = w.refused.includes(e.model)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: '',
      toolUses: [],
      stopReason: isRefused ? null : 'end_turn',
      usage: isRefused ? null : { ...w.usage, model: e.model },
    }
  })
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))

  return w
}

const drain = async <C, R>(stream: HookStream<C, R>): Promise<R> => {
  for await (const _ of stream) {
    // the chunks are not this test's business
  }
  return stream.result
}

let turnCount = 0

/** Submits a prompt, then runs one main-loop turn of `steps` requests. */
const turn = async ($: Engine, text: string, session = OPUS, steps = 1) => {
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })
  const turnId = `t${++turnCount}`
  await $.turn.start({ text, turnId })
  for (let index = 0; index < steps; index++) {
    await drain($.turn.step({ turnId, index, model: session, messageCount: 1 + index }))
  }
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer' })
}

const router = ($: Engine, args: string) =>
  $.command.run({
    command: 'router',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 120 },
  })

describe('model-router', () => {
  test('a +haiku prefix forces haiku and is stripped', async ($, on) => {
    const w = world(on)
    await turn($, '+haiku what is x')

    expect(w.submitted).toEqual(['what is x'])
    expect(w.sent).toEqual([HAIKU])
  })

  test('every step of a turn goes to the routed model', async ($, on) => {
    const w = world(on)
    await turn($, 'design a caching layer for the API', SONNET, 3)

    expect(w.sent).toEqual([OPUS, OPUS, OPUS])
  })

  test("a subagent's step is left alone", async ($, on) => {
    const w = world(on)
    await $.prompt.submit({ text: 'design a cache', wait: false, origin: { kind: 'composer' } })
    await $.turn.start({ text: 'look around', turnId: 'sub', agentId: 'a1' })
    await drain($.turn.step({ turnId: 'sub', index: 0, model: SONNET, messageCount: 1, agentId: 'a1' }))

    expect(w.sent).toEqual([SONNET])
  })

  test('/router off leaves the session model, /router on routes again', async ($, on) => {
    const w = world(on)
    await router($, 'off')
    await turn($, 'what is x')
    await router($, 'on')
    await turn($, 'what is x')

    expect(w.sent).toEqual([OPUS, HAIKU])
  })

  test('a pin wins over the rules', async ($, on) => {
    const w = world(on)
    await router($, 'pin haiku')
    await turn($, 'design a caching layer for the API')
    await router($, 'unpin')
    await turn($, 'design a caching layer for the API')

    expect(w.sent).toEqual([HAIKU, OPUS])
  })

  test('an ambiguous prompt the classifier cannot judge stays on the session model', async ($, on) => {
    const w = world(on)
    await turn($, 'hmm')

    expect(w.sent).toEqual([OPUS])
  })

  test('an ambiguous prompt goes where the classifier says', async ($, on) => {
    const w = world(on, { isAnswered: true, text: 'sonnet', usage: SMALL })
    await turn($, 'hmm')

    expect(w.sent).toEqual([SONNET])
  })

  test('a warm 400K context is not moved to haiku', async ($, on) => {
    const w = world(on)
    w.usage = { ...SMALL, cache_read_input_tokens: 400_000 }
    await turn($, 'design a caching layer for the API')
    await turn($, 'what is x')

    expect(w.sent).toEqual([OPUS, OPUS])
  })

  test('the configured haiku model is the one a lookup goes to', { options: { haikuModel: HAIKU_45 } }, async ($, on) => {
    const w = world(on)
    await turn($, '+haiku what is x')

    expect(w.sent).toEqual([HAIKU_45])
  })

  test('a model whose request fails is not routed to again this session', async ($, on) => {
    const w = world(on)
    w.refused = [HAIKU]
    await turn($, 'what is x')
    await turn($, 'where is the config?')

    expect(w.sent).toEqual([HAIKU, OPUS])
  })

  test('a classifier model the gateway refuses is not asked again', async ($, on) => {
    const w = world(on, { isAnswered: false, reason: 'api-error', status: 403, error: 'authentication_failed', usage: SMALL })
    await turn($, 'hmm')
    await turn($, 'hmm')

    expect(w.classified).toBe(1)
    expect(w.sent).toEqual([OPUS, OPUS])
  })

  test('the status line file names the model each turn went to, written when it changes', async ($, on) => {
    const w = world(on)
    await turn($, 'what is x')
    await turn($, 'where is the config?')
    await turn($, 'design a caching layer for the API')

    expect(w.written.map(f => f.path)).toEqual([
      '/home/u/.claude/model-router/sessions/session-1.json',
      '/home/u/.claude/model-router/sessions/session-1.json',
    ])
    expect(w.written.map(f => JSON.parse(f.text))).toEqual([
      { model: HAIKU, display: 'Haiku 5.5' },
      { model: OPUS, display: 'Opus 5.5' },
    ])
  })

  test('the status line file follows CLAUDE_CONFIG_DIR', async ($, on) => {
    const w = world(on, undefined, { HOME: '/home/u', CLAUDE_CONFIG_DIR: '/cfg' })
    await turn($, 'what is x')

    expect(w.written.map(f => f.path)).toEqual(['/cfg/model-router/sessions/session-1.json'])
  })

  test('a session model outside the price table is said once, not routed', async ($, on) => {
    const w = world(on)
    await turn($, 'what is x', 'claude-fable-5-1')
    await turn($, 'where is the config?', 'claude-fable-5-1')

    expect(w.sent).toEqual(['claude-fable-5-1', 'claude-fable-5-1'])
    expect(w.toasts).toHaveLength(1)
    expect(w.toasts[0]).toContain('claude-fable-5-1')
  })

  test('a classifier that throws leaves the prompt and the session model alone', async ($, on) => {
    const w = world(on, 'throws')
    await turn($, 'hmm')

    expect(w.submitted).toEqual(['hmm'])
    expect(w.sent).toEqual([OPUS])
  })

  test('/router dashboard opens a pane listing each turn, newest first', async ($, on) => {
    world(on)
    await turn($, 'what is x')
    await turn($, 'hmm')

    expect(JSON.stringify(await router($, 'dashboard'))).toContain('dashboard opened')
    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'model-router',
        surface,
        component: 'Pane',
        requestId: 'model-router',
        props: {
          title: 'Model router',
          isFocused: false,
          bodyColumns: 120,
          placement: 'dock',
          scroll: { offset: 0, bodyRows: 30 },
          view: {},
        },
      })
      const lines = (await ui.findAll({ type: 'Text' })).map(found => found.text ?? '')
      const second = lines.indexOf('hmm')
      const first = lines.indexOf('what is x')

      expect(lines.some(line => line.includes('MODEL ROUTER'))).toBe(true)
      expect(lines).toContain('no decision')
      expect(lines).toContain('lookup')
      expect(second).toBeGreaterThan(-1)
      expect(first).toBeGreaterThan(second)
      await ui.unmount()
    }
  })

  test('seated inline, the dashboard is a short summary', async ($, on) => {
    world(on)
    await turn($, 'what is x')

    for (const surface of ['terminal', 'desktop'] as const) {
      const ui = await $.ui.mount({
        plugin: 'model-router',
        surface,
        component: 'Pane',
        requestId: 'model-router',
        props: {
          title: 'Model router',
          isFocused: false,
          bodyColumns: 80,
          placement: 'inline',
          scroll: { offset: 0, bodyRows: 4 },
          view: {},
        },
      })
      const lines = (await ui.findAll({ type: 'Text' })).map(found => found.text ?? '')

      expect(lines.some(line => line.includes('MODEL ROUTER'))).toBe(true)
      expect(lines).not.toContain('what is x')
      await ui.unmount()
    }
  })

  test('/router stats reports the routed model', async ($, on) => {
    world(on)
    await turn($, 'what is x')
    const answer = await router($, 'stats')

    expect(JSON.stringify(answer)).toContain(HAIKU)
  })
})
