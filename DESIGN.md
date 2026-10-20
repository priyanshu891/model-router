# model-router — design

Route each main-loop turn of a Claude Code session to the cheapest Claude
model that can answer it correctly, without letting a model switch cost more
than it saves.

## Goals

- Pick Haiku / Sonnet / Opus per turn from the user's prompt.
- Never lower answer quality for hard queries: upgrades are unconditional.
- Never raise cost through a downgrade: a downgrade must beat staying put,
  prompt-cache effects included.
- Stay out of the way on failure: any error leaves the request on the
  session's own model.

## Non-goals

- Routing subagents (their model is chosen by their definition or the Agent
  call, deliberately).
- Changing `effort`.
- Exact savings accounting (the baseline is an estimate).

## Flow of one turn

1. `prompt.submit` — main loop, not `e.command`, not `e.isMeta`.
   Decision order, first match wins:
   1. Prefix `+opus` / `+sonnet` / `+haiku` (case-insensitive, followed by
      whitespace): tier forced, prefix stripped via `next({ ...e, text })`.
      Reason `forced`. Not `!`: a leading `!` puts Claude Code's prompt in
      shell mode, so the text never reaches `prompt.submit`.
   2. Router off → no decision.
   3. `/router pin <tier>` set → that tier. Reason `pinned`.
   4. Rules (`classify.ts`) → tier + reason, or `ambiguous`.
   5. `ambiguous` → Haiku classifier (`llm.ts`, `$.model.complete`,
      `timeoutMs: 3000`). A non-answer or unparseable reply → no decision.
   The decision is stored as the pending decision.
2. `turn.start` — main loop (`e.agentId === undefined`): bind the pending
   decision to `e.turnId`, clear pending. A turn with no pending decision
   (continuation, background prompt) gets none.
3. `turn.step` — main loop only; subagent steps (`e.agentId` set) pass
   through untouched. On `index === 0` the cost gate turns the tier into a
   concrete model (or "keep"); every step of that turn then sends that same
   model with `next({ ...e, model })`, so the cache stays warm inside the
   turn's tool loop. The status line is set when the gate decides. The hook
   adds each step's usage, priced, to stats under the model it went to (and
   at the session's model for the baseline), and keeps the time of the
   request and the context size for the next gate. The classifier's own
   calls are added to stats too.
4. `turn.complete` — main loop: drop the turn's bookkeeping.

## Rules (classify.ts, pure)

Input: prompt text. Output: `{ tier, reason }` or `{ tier: 'ambiguous' }`.

- Opus (`reason: 'complex'`): design / architecture / plan / refactor /
  debug / investigate / review / "why does…" / root cause / migrate / across
  files; or a prompt over 1,500 characters; or a pasted stack trace.
- Haiku (`reason: 'lookup'`): under 200 characters and a lookup shape —
  "what is/does", "where is", "which file", "list", "show me", "explain this
  command", rename / format / typo fixes.
- Sonnet (`reason: 'coding'`): implement / add / write / fix / update /
  test, with no Opus signal.
- Anything else, or conflicting signals → `ambiguous`.

## Classifier (llm.ts)

One `$.model.complete` call on Haiku, a fixed system prompt (cache-marked)
asking for exactly one word: `haiku`, `sonnet` or `opus`. Reason
`classified`. Anything else → no decision.

## Cost gate (cost.ts, pure)

Inputs: warm model `M` — the model the last main-loop request was actually
sent with, whose cache holds the context (the step's `e.model` before any
request; note `e.model` names the session's model even after a routed turn,
so it is not `M`) — target model `T`, context tokens `C` (last main-loop
step's input + cache_read + cache_creation + output; 0 before the first),
cache warm (`now − lastRequestAt < 5 min`). "Keep" sends `M`.

- `T` ranks at or above `M` → switch (upgrades always go through).
- `C > contextWindow(T)` → keep, reason `kept: context`.
- Otherwise estimate one turn of `S = 3` steps and `O = 1,500` output tokens:
  - stay   = `C·(warm ? read(M) : write(M)) + (S−1)·C·read(M) + O·out(M)`
  - switch = `C·write(T) + (S−1)·C·read(T) + O·out(T)`
  - switch if `switch < stay`, else keep with reason `kept: cache`.

Prices are list prices per million tokens (input, output, cache write 5m,
cache read) held in a table in `cost.ts`, sourced from the Claude API
reference. Unknown model ids are not routed from or to (keep).

Tier → model id comes from the plugin's settings (`haikuModel`, `sonnetModel`,
`opusModel`), defaulting to `claude-haiku-5-5`, `claude-sonnet-5-5`,
`claude-opus-5-5`, since a gateway may serve other ids. Prices and context
windows are keyed by the id with any `[1m]` suffix, `provider/` prefix,
Bedrock `<region>.anthropic.` prefix and `-v1:0` version, and `-<date>` or
Vertex `@<date>` removed; the table holds Opus 5.5, Sonnet 5.5, Haiku 5.5 and
Haiku 4.5 (200K window). A model outside it is not routed to or from, and the
first turn kept that way in a load says so in a toast, naming the model.

A routed request that fails without an interrupt (a gateway's 403, say) puts
its model on a session list the router no longer sends to, with a toast; a
classifier call answered 403/404 does the same for the classifier's model.

A turn with no decision (router off, classifier failed, a continuation) is
not rewritten: it runs on the session's model, as without the mod.

## Controls

- Status line: `router: <tier> · <reason>`, `router: <tier> (kept: cache)`,
  `router: off`.
- `/router on|off` — toggle (session state, also persisted to `$.store`).
- `/router pin <haiku|sonnet|opus>`, `/router unpin`.
- `/router stats` — per model: turns, tokens, cost; total cost; baseline cost
  (same usage priced at the session's model at session start); estimated
  saving. Session figures from `$.state`, all-time from `$.store`.
- `/router dashboard` — opens a pane in flightdeck's style, 66 columns docked
  (`dashboardView` in `dashboard.ts` builds what it shows, pure; the hook in
  `register.tsx` draws it). A header (`MODEL ROUTER · ON|OFF|PINNED <TIER> ·
  session <MODEL>`) and a legend, then four rounded cards in the theme's
  colours (haiku `success`, sonnet `suggestion`, opus `claude`, kept
  `warning`, unrouted `inactive`): ROUTING, a square per logged turn coloured
  by where it went, with counts; SAVINGS, a gauge, spent against the session
  model alone, the classifier, all time; MODELS, an aligned table; the turn
  log, newest first: local time, tier, reason (`kept: cache` in amber),
  prompt, cost. Seated inline above the prompt it is a three-line summary.
  It redraws as each step lands; the log keeps the session's last 50 turns.

## Footer model (status line file)

The session's own model is what Claude Code's status line JSON names, and a
mod cannot change it. So on the first step of each main-loop turn, when the
model sent differs from the one last written, the mod writes
`{ model, display }` (`displayOf`: `Haiku 4.5`) to
`<config dir>/model-router/sessions/<session id>.json`, the config dir being
`$CLAUDE_CONFIG_DIR`, else `$HOME/.claude` (`$USERPROFILE` on Windows); no file
without either. `examples/statusline.sh` reads it by `session_id` and, when its
base id differs from `model.id`'s, draws `Haiku 4.5 ← routed (Opus 5.5)`. A failed
write is ignored. Mods cannot delete files, so each session leaves its
~60-byte file behind.

## State (types/index.d.ts)

`PluginState['model-router']`: `isEnabled`, `pin` (tier | null), `stats`
(per model id: turns, input/output/cache tokens, usd; plus baselineUsd), `log`
(the dashboard's last 50 turns; session only, the prompt text never stored).
Turn-scoped bookkeeping (pending decision, turn → model, last context size,
last request time) lives in module variables: a reload mid-turn just leaves
that turn unrouted.

## Failure handling

No hook gates anything. A hook that throws is skipped by the engine and the
request goes out unchanged on the session's model. The classifier is
bounded by its timeout and always resolves.

## Tests

- `classify.test.ts`: each rule, ambiguity, length thresholds.
- `cost.test.ts`: upgrade always switches; cold cache downgrade switches;
  warm cache on a large context keeps; context window keeps; unknown id keeps;
  Bedrock and Vertex spellings priced and recognised.
- `router.test.ts` (`claude plugin test`): prefix stripped and model forced;
  `turn.step` rewritten for every step of a turn; subagent step untouched;
  router off leaves model; pin wins over rules; classifier failure (or a
  classifier that throws) leaves model; an unpriced session model is said
  once; the status line file follows `CLAUDE_CONFIG_DIR`; `/router stats`
  answers text.
