#!/bin/bash
# Claude Code Statusline. Liest die Status-JSON von stdin und rendert eine
# Single-Line-Anzeige fuer dir, topic, model, ctx-usage, rate-limits.
# Nutzt python statt jq (jq ist auf diesem Host nicht installiert).

input=$(cat)

# Single Python call extrahiert alle benoetigten Felder als pipe-separated string
parsed=$(printf '%s' "$input" | "$(command -v python3 || command -v python)" -c "
import sys, json
try:
    d = json.load(sys.stdin)
    cwd = d.get('workspace',{}).get('current_dir') or d.get('cwd') or '?'
    model = d.get('model',{}).get('display_name') or '?'
    used = d.get('context_window',{}).get('used_percentage')
    five_h = d.get('rate_limits',{}).get('five_hour',{}).get('used_percentage')
    week = d.get('rate_limits',{}).get('seven_day',{}).get('used_percentage')
    sess = d.get('session_id') or d.get('session',{}).get('id') or ''
    week_resets = d.get('rate_limits',{}).get('seven_day',{}).get('resets_at')
    print('{}|{}|{}|{}|{}|{}|{}'.format(
        cwd, model,
        '' if used is None else used,
        '' if five_h is None else five_h,
        '' if week is None else week,
        sess,
        '' if week_resets is None else week_resets
    ))
except Exception:
    print('?|?||||||')
" 2>/dev/null)

IFS='|' read -r cwd model used five_h week sessId weekResets <<< "$parsed"

# Directory: show last two path components
dir=$(echo "$cwd" | awk -F'/' '{if(NF>=2) print $(NF-1)"/"$NF; else print $NF}' | sed 's|\\|/|g')

# Topic: resolve via session-id -> sessions/{pid}.json -> topic-{pid}.txt
[ -z "$sessId" ] && sessId="${CLAUDE_SESSION_ID:-}"

topic=""
if [ -n "$sessId" ]; then
  for sf in "$HOME/.claude/sessions/"*.json; do
    [ -f "$sf" ] || continue
    if grep -q "\"sessionId\":\"$sessId\"" "$sf" 2>/dev/null; then
      pid=$(basename "$sf" .json)
      tf="$HOME/.claude/session-kickoff/topic-$pid.txt"
      if [ -f "$tf" ]; then
        topic=$(awk -F'|' '{print $2}' "$tf" 2>/dev/null | tr -d '\n\r')
      fi
      break
    fi
  done
fi

topicSeg=""
if [ -n "$topic" ]; then
  topicSeg=" | topic: $topic"
fi

# Context usage
ctx=""
if [ -n "$used" ]; then
  ctx=" | ctx:$(printf '%.0f' "$used")%"
fi

# Rate limits
limits=""
if [ -n "$five_h" ]; then
  limits=" | 5h:$(printf '%.0f' "$five_h")%"
fi
if [ -n "$week" ]; then
  limits="${limits} 7d:$(printf '%.0f' "$week")%"
fi

# Usage watcher (issue #748). The recorder evaluates and remembers; this script only hands it the
# weekly window, detached, and only when the pair changed since the recorder last wrote it.
# The recorder writes last-input at its end, so a run that Claude Code cancelled is redone later.
usageHome="${CLAUDE_HOME:-$HOME/.claude}"
if [ -n "$week" ] && [ -n "$weekResets" ] && [ -f "$usageHome/hooks/usage-record.mts" ]; then
  if [ "$(cat "$usageHome/.cache/usage-watch/last-input" 2>/dev/null)" != "$week|$weekResets" ]; then
    node "$usageHome/hooks/usage-record.mts" --used "$week" --resets-at "$weekResets" \
      </dev/null >/dev/null 2>&1 &
  fi
fi

# Maestro badge: deterministic indicator that the orchestration stack is active.
# Scope comes from the configured workspace, never a product-named path segment.
# ROUTING.md presence mirrors the banner's "routing loaded" claim - no model involved.
maestroSeg=""
configuredWorkspace=${KHEREP_WORKSPACE:-"$HOME/Kherep"}
cwdNorm=$(printf '%s' "$cwd" | tr '\\' '/' | tr 'A-Z' 'a-z' | sed 's|/*$||')
workspaceNorm=$(printf '%s' "$configuredWorkspace" | tr '\\' '/' | tr 'A-Z' 'a-z' | sed 's|/*$||')
case "$cwdNorm" in
  "$workspaceNorm"|"$workspaceNorm"/*)
    if [ -f "$HOME/.claude/teams/kherep/ROUTING.md" ]; then
      maestroSeg=" | Maestro: on"
    else
      maestroSeg=" | Maestro: no-routing"
    fi
    ;;
esac

printf "%s%s%s | %s%s%s" "$dir" "$topicSeg" "$maestroSeg" "$model" "$ctx" "$limits"
