# model-router

A Claude Code plugin that sends each turn to Haiku, Sonnet or Opus depending on
what you ask, and refuses any switch that would cost more than it saves.

- Quick lookups go to **Haiku**, ordinary coding to **Sonnet**, and design,
  debugging and reviews to **Opus**.
- Moving up a tier always happens. Moving down happens only when it's cheaper
  once the prompt cache is counted: a warm cache on a long conversation is
  often worth more than a cheaper model.
- If anything fails, the turn runs on your session's own model, exactly as it
  would without the plugin.

Subagents are never rerouted; their model comes from their own definition.

## Install

Type this at a Claude Code prompt:

```
/plugin install model-router --marketplace priyanshu891/model-router
```

Answer `y` to add the marketplace, then pick a scope. To install from a shell
instead:

```
claude plugin install model-router --marketplace priyanshu891/model-router
```

The plugin is built on Claude Code's function hooks (plugin "mods"), which are
in early access and may change between releases. Its tests pass on Claude Code
2.1.304.

## How a turn is routed

The first rule that matches decides:

1. **A prefix you type**: `+haiku`, `+sonnet` or `+opus` followed by a space
   forces that tier for one turn. The prefix is removed before the model sees
   the prompt. (It's `+` because a leading `!` puts Claude Code in shell mode.)
2. **`/router off`**: no routing.
3. **`/router pin <tier>`**: every turn goes to that tier.
4. **Rules**, free and instant:
   - Opus: "design", "architecture", "plan", "refactor", "debug",
     "investigate", "review", "migrate", "root cause", "why does…",
     "across the codebase", a pasted stack trace, or a prompt over 1,500
     characters.
   - Haiku: a short (under 200 characters) "what is…", "where is…",
     "which file…", "list…", "show me…", or a rename, typo or formatting fix.
   - Sonnet: "implement", "add", "write", "fix", "update", "test", "create",
     "change".
5. **Classifier**: a prompt no rule settles is sent to the Haiku-tier model,
   which answers with one word. That's one extra small request, and the prompt
   waits for it for at most 3 seconds. If it doesn't answer in time, the turn
   stays on the session's model.

Then the **cost gate** turns the tier into a model. An upgrade always goes
through. A downgrade goes through only if a three-request turn on the cheaper
model, re-caching the whole conversation, costs less than staying on the model
whose cache is warm. A conversation larger than the target's context window
also stays put. Every request in a turn goes to the same model, so the cache
stays warm through the turn's tool calls.

The status line shows each decision, e.g. `router: haiku · lookup` or
`router: opus (kept: cache)`.

## Commands

| Command | What it does |
| --- | --- |
| `/router` or `/router stats` | Turns, tokens and cost per model, what the same tokens would have cost on the session's model, and the estimated saving, for this session and all time |
| `/router dashboard` | Opens a live pane: where each turn went, savings, a per-model table and the last 50 turns |
| `/router on` / `/router off` | Turns routing on or off; remembered across sessions |
| `/router pin haiku\|sonnet\|opus` | Sends every turn to one tier until `/router unpin` or the session ends |
| `/router unpin` | Goes back to routing by query |

## Settings

The model id each tier sends. You're asked for them when you install; change
them later in `/config`, where each one is a row:

| Option | Default |
| --- | --- |
| `haikuModel` | `claude-haiku-5-5` (also runs the classifier) |
| `sonnetModel` | `claude-sonnet-5-5` |
| `opusModel` | `claude-opus-5-5` |

Set these when your API key or gateway serves other ids. The router only moves
between models it has prices for:

- Claude Opus 5.5, Sonnet 5.5, Haiku 5.5 and Haiku 4.5
- written any of these ways: `claude-haiku-4-5-20251001`,
  `claude-opus-5-5[1m]`, `aws/claude-sonnet-5-5`,
  `us.anthropic.claude-haiku-4-5-20251001-v1:0` (Bedrock),
  `claude-haiku-4-5@20251001` (Vertex)

If your session runs on any other model (for example Fable 5.1 or an Opus 4.x),
or a tier is set to an id it can't price, turns stay where they are. The
plugin tells you so once, in a toast that names the model.

When a request to a routed model fails (a gateway answering 403 because your
key can't use that model, say), the router stops sending turns there for the
rest of the session and shows a toast telling you which setting to change.

## Savings are estimates

Prices are Claude API list prices, hardcoded in `hooks/cost.ts` (current as of
October 2026). The "saved" figure compares what you spent with what the same
tokens would have cost on the session's model. It's an estimate: on that model
the cache would have been used differently, and Bedrock, Vertex or a gateway
may bill different rates.

## Show the routed model in your status line

Claude Code's status line always names the session's model. To show the model
a turn was actually sent to, like `Haiku 5.5 ← routed (Opus 5.5)`, use
[`examples/statusline.sh`](examples/statusline.sh), or copy its routed-model
lines into your own script. It needs `jq`.

The router writes one small file per session to
`~/.claude/model-router/sessions/` (or under `$CLAUDE_CONFIG_DIR`). Plugins
can't delete files, so these build up; you can delete the folder at any time.

## Privacy

Prompts and model calls go only where Claude Code already sends them. The
classifier is a request to your own configured Haiku-tier model. Across
sessions the plugin keeps only token counts and costs; the dashboard's turn
log, which shows prompt text, is kept for the current session only.

## Development

```
claude plugin validate .
claude plugin test .
```

To try changes, start an interactive session with `claude --plugin-dir .`; it
reloads the plugin as you edit. Once it has loaded the plugin, Claude Code
writes its API types to `.claude-plugin/types/` (which ignores itself in git),
and `npx tsc -p .` type-checks against them.

`DESIGN.md` explains how the plugin works.

## License

[MIT](LICENSE)
