#!/usr/bin/env bash
# Live ~/.claude  ->  repo claude/. Initial populate AND ongoing edit-capture.
# Secrets and runtime are NEVER captured here (see secrets tasks for SOPS).
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
kherep_validate_shell_path CLAUDE_HOME "$CLAUDE_HOME" || exit $?

# A Mac live settings file is the merge of shared settings and host-only state
# (plugins, hooks, marketplaces, paths). Copying it wholesale back into the
# shared source would contaminate the Windows profile. Mac capture therefore
# requires an explicit settings skip; shared settings changes need a reviewed
# source edit until profile overlays exist.
SKIP_SETTINGS="$(kherep_env CAPTURE_SKIP_SETTINGS 0)"
if [[ "$KHEREP_PROFILE" = "mac" ]] && [[ "$SKIP_SETTINGS" != "1" ]]; then
  echo "FATAL: Mac settings capture is merge-unsafe. Re-run with KHEREP_CAPTURE_SKIP_SETTINGS=1 to capture managed files without settings; review shared settings edits separately." >&2
  exit 2
fi

mkdir -p "$CLAUDE_SRC" "$CLAUDE_SRC/_deprecated"

# 1. In-scope files (settings.json + CLAUDE.md handled specially in step 2)
while read -r rel; do
  [[ -z "$rel" ]] && continue
  case "$rel" in settings.json|CLAUDE.md) continue;; esac
  copy_entry "$rel" "$CLAUDE_HOME" "$CLAUDE_SRC"
done < "$REPO_ROOT/bootstrap/manifest/files.txt"

# 2. settings + CLAUDE.md get repo-side names; portable-path the settings copy
if [[ "$SKIP_SETTINGS" = "1" ]]; then
  echo "capture: settings skipped (host-merged state is not safe for the shared source)"
else
  cp -a "$CLAUDE_HOME/settings.json" "$CLAUDE_SRC/settings.user.json"; portable_paths "$CLAUDE_SRC/settings.user.json"
fi
cp -a "$CLAUDE_HOME/CLAUDE.md"     "$CLAUDE_SRC/CLAUDE.user.md"
# Issue #436. Both name this host's intercom command; the source keeps the placeholders.
portable_intercom "$CLAUDE_SRC/CLAUDE.user.md"
portable_intercom "$CLAUDE_SRC/teams/kherep/ROUTING.md"
# Issue #737. Installed agents carry the resolved model policy; the source keeps
# the model and effort placeholders. Overrides belong in model-policy.user.json.
node "$REPO_ROOT/bootstrap/model-policy-render.mts" portable "$CLAUDE_SRC/agents"
# project-scoped settings + CLAUDE live in the Work workspace
WS="$(kherep_shell_path "$(kherep_env WORKSPACE "$(kherep_default_workspace)")")"
kherep_validate_shell_path KHEREP_WORKSPACE "$WS" || exit $?
if [[ "$SKIP_SETTINGS" != "1" ]]; then
  cp -a "$WS/.claude/settings.local.json" "$CLAUDE_SRC/settings.project.json"; portable_paths "$CLAUDE_SRC/settings.project.json"
fi
# OP-1425. Only the marked Kherep block is captured; the operator text around it
# never enters the shared template. No block (exit 3) is a hard stop, not a copy.
node "$REPO_ROOT/bootstrap/project-rules-block.mts" capture "$WS/CLAUDE.md" "$CLAUDE_SRC/CLAUDE.project.md" || {
  echo "FATAL: $WS/CLAUDE.md has no complete kherep-project-rules block to capture" >&2; exit 1;
}

# 3. Deprecated -> parked, never installed
while read -r rel; do
  [[ -z "$rel" ]] && continue
  copy_entry "$rel" "$CLAUDE_HOME" "$CLAUDE_SRC/_deprecated"
done < "$REPO_ROOT/bootstrap/manifest/deprecated.txt"

# 4. team config: blank the hardcoded cwd (portability fix)
if [[ -f "$CLAUDE_SRC/teams/kherep/config.json" ]]; then
  node -e 'const f=process.argv[1],fs=require("fs");const j=JSON.parse(fs.readFileSync(f));if(j.members)j.members.forEach(m=>{if(m.cwd!==undefined)m.cwd="";});fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n");' \
    "$CLAUDE_SRC/teams/kherep/config.json"
fi

# 5. statusline: prefer python3 (Linux-pod portability)
python_fallback "$CLAUDE_SRC/statusline-command.sh"

echo "capture done -> $CLAUDE_SRC"
