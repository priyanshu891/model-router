# model-router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Claude Code mod that routes each main-loop turn to Haiku 5.5, Sonnet 5.5 or Opus 5.5 by query difficulty, without letting a downgrade cost more than it saves.

**Architecture:** Pure modules (`classify.ts`, `cost.ts`, `stats.ts`) hold every decision and are unit-tested alone; `llm.ts` wraps the one Haiku call behind an injected `complete` function; `register.ts` only wires engine events (`prompt.submit` → decision, `turn.start` → bind to turn, `turn.step` → gate + rewrite `model`, `turn.complete` → cleanup) and the `/router` command. Spec: `DESIGN.md`.

**Tech Stack:** Claude Code function-hook mod (TypeScript, `claude-code` + `claude-code/testing`), `claude plugin validate`, `claude plugin test`, `tsc -p`.

## Global Constraints

- Mod folder: `~/.claude/dev-mods/f56e8779-1102-4bf5-abd6-d239fe872758/model-router/` (no git: no commit steps).
- Model ids exactly `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`; a `[…]` suffix (`[1m]`) is ignored when recognising an id.
- Prices US$/MTok (input / output / 5-min cache write / cache read): Opus 4 / 20 / 5 / 0.20; Sonnet 2 / 10 / 2.5 / 0.20; Haiku 0.10 / 0.50 / 0.125 / 0.01, and over 100K prompt tokens 0.50 / 2.50 / 0.625 / 0.05. Context window 1M for all three.
- Gate turn shape: 3 requests, 1,500 output tokens; cache TTL 5 minutes.
- Subagent requests (`e.agentId` set) are never rewritten.
- No hook refuses anything; a failing hook is skipped and the request goes out on the session's model.

## File structure

| File | Responsibility |
| --- | --- |
| `.claude-plugin/plugin.json` | manifest, names the contract |
| `hooks/hooks.json` | names `./register.ts` |
| `types/index.d.ts` | `RouterTier`, `ModelTally`, `RouterStats`; `PluginState['model-router']` |
| `hooks/classify.ts` | `classify(text): Classified` — rules only |
| `hooks/cost.ts` | `MODEL_OF`, `tierOf`, `usdOf`, `contextOf`, `gate`, `CACHE_TTL_MS` |
| `hooks/stats.ts` | `EMPTY_STATS`, `addStep`, `addClassifier`, `formatStats` |
| `hooks/llm.ts` | `askTier(complete, text): Promise<Asked>` |
| `hooks/register.ts` | event wiring, `/router` command |
| `tests/*.test.ts` | one file per module above |

### Task 1: Scaffold, contract and rules

**Files:** Create `.claude-plugin/plugin.json`, `hooks/hooks.json`, `types/index.d.ts`, `hooks/classify.ts`; Test `tests/classify.test.ts`.

**Interfaces — Produces:**
- `type RouterTier = 'haiku' | 'sonnet' | 'opus'`
- `type Classified = { tier: RouterTier; reason: string } | { tier: 'ambiguous' }`
- `classify(text: string): Classified`

- [ ] Write `tests/classify.test.ts` with these cases, run `claude plugin test`, see them fail:
  - `'design a caching layer for the API'` → `{ tier: 'opus', reason: 'complex' }`
  - `'why does the build fail on CI?'` → opus / complex
  - 1,600 × `'a'` → opus / complex
  - a text holding `Traceback (most recent call last):` → opus / complex
  - `'what does resolve_trust_remote_code do?'` → `{ tier: 'haiku', reason: 'lookup' }`
  - `'fix the typo in README'` → haiku / lookup (trivial edit beats coding)
  - `'add a --dry-run flag to main.py'` → `{ tier: 'sonnet', reason: 'coding' }`
  - `'where is the bug? fix it'` (lookup and coding) → `{ tier: 'ambiguous' }`
  - `'hmm'` → ambiguous
- [ ] Implement `classify.ts`: order complex → short trivial edit → lookup-xor-coding → ambiguous.
- [ ] Run `claude plugin test`: classify cases pass.

### Task 2: Cost model and gate

**Files:** Create `hooks/cost.ts`; Test `tests/cost.test.ts`.

**Interfaces — Produces:**
- `MODEL_OF: Record<RouterTier, string>`, `CACHE_TTL_MS = 300_000`
- `tierOf(model: string): RouterTier | undefined`
- `contextOf(u: ModelUsage): number` (input + cache read + cache write + output)
- `usdOf(model: string, u: ModelUsage): number` (0 for an unknown id)
- `type Gate = { model: string; kept?: 'cache' | 'context' | 'unknown' }`
- `gate({ warm, target, contextTokens, isCacheWarm }: { warm: string; target: RouterTier; contextTokens: number; isCacheWarm: boolean }): Gate`

- [ ] Write `tests/cost.test.ts`, run, see it fail:
  - `tierOf('claude-opus-5-5[1m]')` → `'opus'`; `tierOf('claude-fable-5-1')` → `undefined`
  - `usdOf('claude-opus-5-5', {in 1000, out 1000, 0, 0})` ≈ 0.024; Haiku with 200,000 uncached input ≈ 0.1 (long rate)
  - upgrade: warm sonnet, target opus → `{ model: 'claude-opus-5-5' }`
  - same tier: warm `'claude-opus-5-5[1m]'`, target opus → model kept as `'claude-opus-5-5[1m]'`
  - warm cache, 200K context, opus → sonnet → `kept: 'cache'` (stay ≈ $0.15 < move ≈ $0.595)
  - cold cache, same → switches to sonnet (stay ≈ $1.11)
  - 20K context, warm, opus → haiku → switches
  - 400K context, warm, opus → haiku → `kept: 'cache'` (Haiku long rate)
  - 1.2M context, opus → haiku → `kept: 'context'`
  - warm `'claude-fable-5-1'` → `kept: 'unknown'`, model unchanged
- [ ] Implement `cost.ts` with the constants in Global Constraints.
- [ ] Run tests: pass.

### Task 3: Stats

**Files:** Create `hooks/stats.ts`; Test `tests/stats.test.ts`.

**Interfaces — Consumes:** `usdOf`, `MODEL_OF`. **Produces:**
- `EMPTY_STATS: RouterStats`
- `addStep(s, sent: string, baseline: string, u: ModelUsage, isNewTurn: boolean): RouterStats`
- `addClassifier(s, u: ModelUsage): RouterStats`
- `formatStats(session: RouterStats, allTime: RouterStats): string`

- [ ] Write tests: one Haiku step with Opus baseline adds a Haiku tally (turns 1, tokens, usd) and `baselineUsd` priced at Opus; a second step with `isNewTurn: false` leaves `turns` at 1; `addClassifier` adds to `usd` and `classifierUsd`; `formatStats` lists the model id, `saved`, and the estimate caveat.
- [ ] Implement, run: pass.

### Task 4: Haiku classifier

**Files:** Create `hooks/llm.ts`; Test `tests/llm.test.ts`.

**Interfaces — Produces:** `type Asked = { tier?: RouterTier; usage?: ModelUsage }`; `askTier(complete: (r: ModelCompleteRequest) => Promise<ModelCompleteResult>, text: string): Promise<Asked>`. Request: model `claude-haiku-5-5`, fixed system prompt, `maxTokens: 512`, `effort: 'low'`, `timeoutMs: 3000`.

- [ ] Write tests with a fake `complete`: reply `'opus'` → tier opus; reply `'Sonnet.'` → sonnet; reply `'maybe'` → no tier; `isAnswered: false` → no tier, usage kept; the request names Haiku and a 3,000 ms timeout.
- [ ] Implement, run: pass.

### Task 5: Wiring and `/router`

**Files:** Create `hooks/register.ts`; Test `tests/router.test.ts`.

**Interfaces — Consumes:** everything above; `atom`, `read`, `update` from `claude-code`.

- [ ] Write engine tests (`mock.clock`, `mock.store`, test-owned bottoms for `prompt.submit`, `turn.start`, `turn.step`, `turn.complete`, `model.complete`, plus whatever else the kit reports unanswered), session model `claude-opus-5-5` unless stated:
  - `'!haiku what is x'` → bottom `prompt.submit` sees `'what is x'`; the turn's step sends `claude-haiku-5-5`
  - session sonnet, `'design a caching layer'` → all 3 steps of the turn send `claude-opus-5-5`
  - subagent step (`agentId` set) after a routed prompt → sends the session model
  - `/router off` then `'what is x'` → session model; `/router on` restores routing
  - `/router pin haiku` then `'design …'` → haiku
  - ambiguous prompt, classifier unanswered → session model; classifier says `'sonnet'` → sonnet
  - a first turn whose step reports 400K cache-read tokens, then `'what is x'` → stays `claude-opus-5-5` (gate)
  - `/router stats` text lists `claude-haiku-5-5` after a Haiku turn
- [ ] Implement `register.ts`.
- [ ] Run `claude plugin test`: all pass.

### Task 6: Verify

- [ ] `claude plugin validate <mod>`: no refusals; note the gating-hook lines (expected: `prompt.submit`, `command.run`).
- [ ] `tsc -p <mod>`: no errors.
- [ ] `claude plugin test <mod>`: all pass.
