import type { ModelCompleteRequest, ModelCompleteResult, ModelUsage } from 'claude-code'
import { describe, expect, test } from 'claude-code/testing'

import { askTier } from '../hooks/llm'

const USAGE: ModelUsage = {
  input_tokens: 120,
  output_tokens: 4,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
}

const replying = (text: string) => async (): Promise<ModelCompleteResult> => ({
  isAnswered: true,
  text,
  usage: USAGE,
})

const HAIKU = 'claude-haiku-5-5'

describe('askTier', () => {
  test('reads the tier the model names', async () => {
    expect(await askTier(replying('opus'), 'refactor?', HAIKU)).toEqual({ tier: 'opus', usage: USAGE, isRefused: false })
  })

  test('reads a tier inside a looser reply', async () => {
    expect((await askTier(replying('Sonnet.'), 'x', HAIKU)).tier).toBe('sonnet')
  })

  test('a reply naming no tier is no decision', async () => {
    expect((await askTier(replying('maybe'), 'x', HAIKU)).tier).toBeUndefined()
  })

  test('an unanswered call is no decision, its usage kept', async () => {
    const complete = async (): Promise<ModelCompleteResult> => ({
      isAnswered: false,
      reason: 'aborted',
      usage: USAGE,
    })
    expect(await askTier(complete, 'x', HAIKU)).toEqual({ tier: undefined, usage: USAGE, isRefused: false })
  })

  test('a 403 says the model is refused', async () => {
    const complete = async (): Promise<ModelCompleteResult> => ({
      isAnswered: false,
      reason: 'api-error',
      status: 403,
      error: 'authentication_failed',
      usage: USAGE,
    })
    expect((await askTier(complete, 'x', HAIKU)).isRefused).toBe(true)
  })

  test('asks the given model, bounded by a 3 s timeout', async () => {
    let asked: ModelCompleteRequest | undefined
    await askTier(
      async request => {
        asked = request
        return replying('haiku')()
      },
      'what is x',
      'claude-haiku-4-5-20251001',
    )

    expect(asked?.model).toBe('claude-haiku-4-5-20251001')
    expect(asked?.timeoutMs).toBe(3000)
    expect(asked?.prompt).toBe('what is x')
  })
})
