#!/usr/bin/env bash
# A Claude Code status line that shows the model model-router sent the
# session's last request to, when it is not the session's own:
#
#   Haiku 5.5 ← routed (Opus 5.5)
#
# Claude Code's status line JSON always names the session's model, so the
# router writes {"model", "display"} to
# <config dir>/model-router/sessions/<session id>.json and this reads it.
# Needs jq. Add to ~/.claude/settings.json:
#
#   "statusLine": { "type": "command", "command": "bash /path/to/statusline.sh" }

input=$(cat)
model=$(printf '%s' "$input" | jq -r '.model.display_name // empty')
model_id=$(printf '%s' "$input" | jq -r '.model.id // empty')
session_id=$(printf '%s' "$input" | jq -r '.session_id // empty')

routed=""
route_file="${CLAUDE_CONFIG_DIR:-$HOME/.claude}/model-router/sessions/$session_id.json"
if [ -n "$session_id" ] && [ -f "$route_file" ]; then
  # The same id cleanup as the router's baseOf, so "claude-opus-5-5[1m]" and
  # "us.anthropic.claude-opus-5-5" both count as Opus 5.5.
  routed=$(jq -r --arg session "$model_id" '
    def base: sub("\\[.*\\]$"; "") | sub("^[\\w-]+/"; "") | sub("^([a-z-]+\\.)?anthropic\\."; "")
      | sub("-v[0-9]+(:[0-9]+)?$"; "") | sub("[-@][0-9]{8}$"; "");
    select((.model | base) != ($session | base)) | .display' "$route_file" 2>/dev/null)
fi

if [ -n "$routed" ]; then
  printf '%s ← routed (%s)' "$routed" "$model"
else
  printf '%s' "$model"
fi
