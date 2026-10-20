import type { ModelCompleteRequest, ModelCompleteResult, ModelUsage } from 'claude-code'

import type { RouterTier } from '../types'

const SYSTEM = [
  'You route requests made to a coding assistant to the model tier that can answer them correctly at the lowest cost.',
  'Reply with exactly one word: haiku, sonnet or opus.',
  'haiku: a quick lookup, an explanation of one thing, a trivial edit.',
  'sonnet: an ordinary coding task: implement, fix, test or update code.',
  'opus: hard work: design, architecture, debugging an unclear failure, a multi-file refactor, a review or a plan.',
].join('\n')

const TIER = /\b(haiku|sonnet|opus)\b/i

// What an API or gateway answers for a model it does not serve to this key.
const REFUSED = new Set([403, 404])

/** `isRefused`: the model is not served here, so asking again is no use. */
export type Asked = { tier?: RouterTier; usage?: ModelUsage; isRefused: boolean }

/** Asks `model` for a tier; any answer but a tier's name is no decision. */
export const askTier = async (
  complete: (request: ModelCompleteRequest) => Promise<ModelCompleteResult>,
  text: string,
  model: string,
): Promise<Asked> => {
  const reply = await complete({
    model,
    system: SYSTEM,
    prompt: text,
    maxTokens: 512,
    effort: 'low',
    timeoutMs: 3000,
  })
  const word = reply.isAnswered ? TIER.exec(reply.text)?.[1] : undefined

  const isRefused = !reply.isAnswered && reply.reason === 'api-error' && REFUSED.has(reply.status ?? 0)

  return { tier: word?.toLowerCase() as RouterTier | undefined, usage: reply.usage, isRefused }
}
