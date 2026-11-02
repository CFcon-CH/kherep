#!/usr/bin/env bash
# Repo claude/ -> live ~/.claude. Idempotent. Requires: bash (Git Bash on WIN), node, npm.
# Optional secrets need an externally supplied encrypted bundle and key.
set -Eeuo pipefail
umask 077
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
source "$(dirname "${BASH_SOURCE[0]}")/profile.sh"
source "$(dirname "${BASH_SOURCE[0]}")/install-lock.sh"
source "$(dirname "${BASH_SOURCE[0]}")/install-retired.sh"
WS="$(kherep_shell_path "$(kherep_env WORKSPACE "$(kherep_default_workspace)")")"
CREDENTIALS_ROOT="$(kherep_env CREDENTIALS_ROOT "$(kherep_default_credentials_root)")"
SECRETS_BUNDLE="${KHEREP_SECRETS_BUNDLE:-}"
AGE_KEY="${SOPS_AGE_KEY_FILE:-}"
SKIP_SECRETS="${SKIP_SECRETS:-1}"
SKIP_DEPS="${SKIP_DEPS:-0}"
INSTALL_ATLASSIAN_TOOLS="${KHEREP_INSTALL_ATLASSIAN_TOOLS:-0}"
PREFLIGHT_DIR=""
INSTALL_BACKUP=""
CLAUDE_PROBE_PAUSED=0

kherep_validate_shell_path CLAUDE_HOME "$CLAUDE_HOME" || exit $?
kherep_validate_shell_path KHEREP_WORKSPACE "$WS" || exit $?
kherep_validate_shell_path KHEREP_CREDENTIALS_ROOT "$CREDENTIALS_ROOT" || exit $?
kherep_validate_workspace_command_path "$WS" || exit $?

bootstrap_cleanup_preflight() {
  [ -n "$PREFLIGHT_DIR" ] || return 0
  case "$PREFLIGHT_DIR" in
    "$CLAUDE_HOME"/backups/bootstrap/preflight-*) rm -rf -- "$PREFLIGHT_DIR" ;;
    *) echo "ERROR: refusing to remove unexpected preflight path: $PREFLIGHT_DIR" >&2; return 1 ;;
  esac
  PREFLIGHT_DIR=""
}

bootstrap_on_err() {
  local rc="$1" line="$2"
  [ -n "$TX_FAILURE_REASON" ] || TX_FAILURE_REASON="command failed with exit $rc at install.sh:$line"
  return 0
}

bootstrap_on_signal() {
  local name="$1" rc="$2"
  TX_FAILURE_REASON="received $name"
  exit "$rc"
}

# Issue #403: removes the Kherep node's Claude probe lock (pause in section C).
claude_probe_resume() {
  node "$REPO_ROOT/bootstrap/claude-readiness-check.mts" resume "$$" && CLAUDE_PROBE_PAUSED=0 ||
    echo "install: WARNING Kherep node Claude probe lock not removed; the daemon ignores it after 30 minutes" >&2
}

bootstrap_on_exit() {
  local rc="$1" rollback_rc=0
  trap - ERR INT TERM EXIT
  if [ "$TX_ACTIVE" = 1 ]; then
    if transaction_commit_is_durable; then
      transaction_accept_durable_commit || rollback_rc=1
      echo "install: durable commit retained after interrupted finalization -> $INSTALL_BACKUP" >&2
    else
      if [ "$rc" = 0 ]; then
        rc=1
        TX_FAILURE_REASON="unexpected exit before transaction commit"
      fi
      transaction_rollback "${TX_FAILURE_REASON:-install failed with exit $rc}" || rollback_rc=1
      echo "install: managed files and secrets rolled back -> $INSTALL_BACKUP" >&2
    fi
  fi
  bootstrap_cleanup_preflight || rollback_rc=1
  [ "$CLAUDE_PROBE_PAUSED" != 1 ] || claude_probe_resume
  bootstrap_lock_release || rollback_rc=1
  [ "$rollback_rc" = 0 ] || rc=1
  exit "$rc"
}

trap 'bootstrap_on_err $? $LINENO' ERR
trap 'bootstrap_on_signal SIGINT 130' INT
trap 'bootstrap_on_signal SIGTERM 143' TERM
trap 'bootstrap_on_exit $?' EXIT

command -v node >/dev/null || { echo "FATAL: node required"; exit 1; }
echo "install: profile=$KHEREP_PROFILE workspace=$WS"
if [ "$SKIP_SECRETS" = "0" ]; then
  command -v sops >/dev/null || { echo "FATAL: sops required (or SKIP_SECRETS=1)"; exit 1; }
  [ -n "$SECRETS_BUNDLE" ] || { echo "FATAL: KHEREP_SECRETS_BUNDLE is required when SKIP_SECRETS=0"; exit 1; }
  [ -f "$SECRETS_BUNDLE" ] || { echo "FATAL: external secrets bundle not found"; exit 1; }
  [ -n "$AGE_KEY" ] || { echo "FATAL: SOPS_AGE_KEY_FILE is required when SKIP_SECRETS=0"; exit 1; }
  [ -f "$AGE_KEY" ] || { echo "FATAL: external age key not found"; exit 1; }
  kherep_validate_shell_path KHEREP_SECRETS_BUNDLE "$SECRETS_BUNDLE" || exit $?
  kherep_validate_shell_path SOPS_AGE_KEY_FILE "$AGE_KEY" || exit $?
fi

# Fail before the first managed mutation if the source contract or a merged
# host profile cannot be rendered. Rendered settings are later installed via
# the same atomic path swap as every other managed file.
while IFS= read -r rel || [ -n "$rel" ]; do
  [ -z "$rel" ] && continue
  kherep_validate_manifest_relative_path "bootstrap manifest entry" "$rel" || exit $?
  case "$rel" in settings.json|CLAUDE.md) continue;; esac
  [ -e "$CLAUDE_SRC/$rel" ] || { echo "FATAL: managed source missing: claude/$rel"; exit 1; }
done < "$REPO_ROOT/bootstrap/manifest/files.txt"
for required in \
  "$CLAUDE_SRC/CLAUDE.user.md" "$CLAUDE_SRC/CLAUDE.project.md" "$CLAUDE_SRC/AGENTS.project.md" \
  "$CLAUDE_SRC/settings.user.json" "$CLAUDE_SRC/settings.project.json" \
  "$REPO_ROOT/modules/local-inference/runner.mts" \
  "$REPO_ROOT/modules/local-inference/lib" "$REPO_ROOT/bootstrap/manifest/local-inference.json" \
  "$REPO_ROOT/modules/twg/runtime"; do
  [ -e "$required" ] || { echo "FATAL: managed source missing: $required"; exit 1; }
done
# OP-1432. The Confluence brokers and exactly the modules they import ship with
# the observation agent, so they are installed by default, not behind the switch.
CONFLUENCE_TOOLS="atlassian-credentials.mts atlassian-cli-args.mts confluence-contract.mts confluence-content.mts confluence-session.mts confluence-related.mts confluence-text-search.mts confluence-semantic.mts confluence-neighbours.mts confluence-neighbour-cli.mts confluence-topic-query.mts confluence-candidates.mts confluence-stitch.mts confluence-list-cli.mts confluence-runtime-label.mts confluence-label-cli.mts confluence-pagination.mts confluence-drainage-rules.mts confluence-drainage-snapshot.mts confluence-drainage-scan.mts confluence-drainage-cli.mts confluence-evidence.mts confluence-evidence-report.mts confluence-evidence-io.mts confluence-evidence-cli.mts confluence-claim-text.mts confluence-revision-staleness.mts confluence-revision-staleness-git.mts atl-confluence.mts atl-confluence-ccoder.mts"
for tool in $CONFLUENCE_TOOLS; do
  [ -e "$REPO_ROOT/modules/atl-jira-brokers/$tool" ] || { echo "FATAL: managed source missing: modules/atl-jira-brokers/$tool"; exit 1; }
done
if [ "$INSTALL_ATLASSIAN_TOOLS" = "1" ]; then
  [ -e "$REPO_ROOT/modules/atl-jira-brokers" ] || { echo "FATAL: optional Atlassian source missing"; exit 1; }
fi

GITHUB_BROKER_FILES="$(node "$REPO_ROOT/lib/github-broker-projection.mts" "$REPO_ROOT")"

# Validate every managed destination before creating bootstrap state. Target
# leaves may themselves be symlinks (the atomic swap replaces them), but no
# ancestor below an explicitly configured root may redirect the operation.
while IFS= read -r rel || [ -n "$rel" ]; do
  [ -z "$rel" ] && continue
  kherep_validate_manifest_relative_path "bootstrap manifest entry" "$rel" || exit $?
  case "$rel" in
    settings.json) target="$CLAUDE_HOME/settings.json" ;;
    CLAUDE.md) target="$CLAUDE_HOME/CLAUDE.md" ;;
    *) target="$CLAUDE_HOME/$rel" ;;
  esac
  transaction_validate_path_under_root "managed target $rel" "$target" "$CLAUDE_HOME" 0 || exit $?
done < "$REPO_ROOT/bootstrap/manifest/files.txt"
transaction_validate_path_under_root "project CLAUDE.md" "$WS/CLAUDE.md" "$WS" 0 || exit $?
transaction_validate_path_under_root "project settings" "$WS/.claude/settings.local.json" "$WS" 0 || exit $?
for target in $CONFLUENCE_TOOLS; do
  transaction_validate_path_under_root "Confluence broker" "$WS/tools/$target" "$WS" 0 || exit $?
done
if [ "$INSTALL_ATLASSIAN_TOOLS" = "1" ]; then
  for target in atl-jira.mts atl-jira-ccoder.mts jira-adf.mts jira-adf-text.mts jira-attach.mts jira-download.mts jira-config.mts jira-transition-guard.mts jira-fields.mts jira-links.mts jira-search.mts jira-discovery.mts; do
    transaction_validate_path_under_root "optional Atlassian tool" "$WS/tools/$target" "$WS" 0 || exit $?
  done
fi
for target in $GITHUB_BROKER_FILES; do
  transaction_validate_path_under_root "GitHub broker" "$WS/tools/github-broker/$target" "$WS" 0 || exit $?
done
transaction_validate_path_under_root "local-inference runner" "$CLAUDE_HOME/kherep/local-inference/runner.mts" "$CLAUDE_HOME" 0 || exit $?
transaction_validate_path_under_root "local-inference lib" "$CLAUDE_HOME/kherep/local-inference/lib" "$CLAUDE_HOME" 0 || exit $?
transaction_validate_path_under_root "local-inference config" "$CLAUDE_HOME/kherep/local-inference/config.json" "$CLAUDE_HOME" 0 || exit $?
transaction_validate_path_under_root "TWG runtime" "$CLAUDE_HOME/kherep/twg" "$CLAUDE_HOME" 0 || exit $?
transaction_validate_path_under_root "commit policy" "$CLAUDE_HOME/kherep/githooks/commit-policy" "$CLAUDE_HOME" 0 || exit $?
transaction_validate_path_under_root "Confluence configuration" "$CLAUDE_HOME/kherep/confluence.json" "$CLAUDE_HOME" 0 || exit $?
transaction_validate_path_under_root "control-plane pointer" "$CLAUDE_HOME/kherep/control-plane/source.json" "$CLAUDE_HOME" 0 || exit $?
if [ "$SKIP_SECRETS" = "0" ]; then
  for target in \
    "$CLAUDE_HOME/.mcp.json"; do
    transaction_validate_path_under_root "secret target" "$target" "$CLAUDE_HOME" 0 || exit $?
  done
fi
transaction_validate_path_under_root "bootstrap state" \
  "$CLAUDE_HOME/backups/bootstrap/.path-preflight" "$CLAUDE_HOME" 0 || exit $?
mkdir -p "$CLAUDE_HOME/backups/bootstrap"
chmod 700 "$CLAUDE_HOME/backups" "$CLAUDE_HOME/backups/bootstrap" 2>/dev/null || true
bootstrap_lock_acquire "$CLAUDE_HOME/backups/bootstrap/.install.lock"
PREFLIGHT_DIR="$(mktemp -d "$CLAUDE_HOME/backups/bootstrap/preflight-XXXXXX")"
chmod 700 "$PREFLIGHT_DIR" 2>/dev/null || true
EXISTING_USER_SETTINGS="$(kherep_env EXISTING_USER_SETTINGS "$CLAUDE_HOME/settings.json")"
EXISTING_PROJECT_SETTINGS="$(kherep_env EXISTING_PROJECT_SETTINGS "$WS/.claude/settings.local.json")"
node "$REPO_ROOT/bootstrap/render-profile.mts" settings \
  "$KHEREP_PROFILE" "$WS" "$CREDENTIALS_ROOT" "$CLAUDE_HOME" \
  "$CLAUDE_SRC/settings.user.json" "$CLAUDE_SRC/settings.project.json" \
  "$EXISTING_USER_SETTINGS" "$EXISTING_PROJECT_SETTINGS" \
  "$PREFLIGHT_DIR/settings.json" "$PREFLIGHT_DIR/settings.local.json"
node "$REPO_ROOT/bootstrap/render-profile.mts" local-inference "$KHEREP_PROFILE" \
  "$REPO_ROOT/bootstrap/manifest/local-inference.json" \
  "$CLAUDE_HOME/kherep/local-inference/config.json" "$PREFLIGHT_DIR/local-inference.json"
# OP-1426. The commit-msg hook reads this file when KHEREP_* is absent, so the
# work-item rule binds every runtime. Rendered here so an invalid value stops
# the run before the first live mutation; precedence in bootstrap/commit-policy.mts.
node "$REPO_ROOT/bootstrap/commit-policy.mts" render "$WS" \
  "$CLAUDE_HOME/kherep/githooks/commit-policy" "$PREFLIGHT_DIR/commit-policy"
# Issue #13. The broker command claude-obs runs, from the values the permission
# rules above are rendered from. Rendered on EVERY install and apart from the
# credential and space steps (C2/C3), so an upgrade whose space step is skipped
# or fails still names this workspace. Merged into a copy of the live file, so
# only `broker` changes; an unreadable live file stops the run here.
[ ! -f "$CLAUDE_HOME/kherep/confluence.json" ] ||
  cp "$CLAUDE_HOME/kherep/confluence.json" "$PREFLIGHT_DIR/confluence.json"
node "$REPO_ROOT/bootstrap/confluence-space.mts" --broker-only --runtime claude \
  --profile "$KHEREP_PROFILE" --workspace "$WS" --out "$PREFLIGHT_DIR/confluence.json" >/dev/null
# OP-1425. $WS/CLAUDE.md and $WS/AGENTS.md belong to the operator; Kherep renders
# only its marked block into them. Rendered here so a refused merge (one marker
# without the other) stops the run before the first live mutation.
for rules in CLAUDE AGENTS; do
  node "$REPO_ROOT/bootstrap/project-rules-block.mts" render \
    "$CLAUDE_SRC/$rules.project.md" "$WS/$rules.md" "$PREFLIGHT_DIR/project-$rules.md"
done
# Issue #436. CLAUDE.md and ROUTING.md name this host's intercom command, the
# stable launcher under the Control Plane config directory (render-intercom.mts).
# Rendered here so a config root no shell can quote stops the run before the
# first live mutation.
# Issue #592. The control-plane hook commands name the stable entry point under
# CLAUDE_HOME (a manifest file); this record names the source it runs, this
# installer's root, and goes live in the same transaction as settings.json.
node "$REPO_ROOT/bootstrap/control-plane-pointer.mts" render "$REPO_ROOT" "$PREFLIGHT_DIR/control-plane-source.json"
node "$REPO_ROOT/bootstrap/render-profile.mts" intercom "$CLAUDE_SRC/CLAUDE.user.md" "$PREFLIGHT_DIR/CLAUDE.md"
node "$REPO_ROOT/bootstrap/render-profile.mts" intercom \
  "$CLAUDE_SRC/teams/kherep/ROUTING.md" "$PREFLIGHT_DIR/teams/kherep/ROUTING.md"

# Decrypt and validate the complete bundle before the first live mutation.
# Decrypted YAML stays in the sops->node pipe; decoded staging files are mode
# 0600/0700 inside the mode-0700 preflight directory.
if [ "$SKIP_SECRETS" = "0" ]; then
  SOPS_AGE_KEY_FILE="$AGE_KEY" sops -d "$SECRETS_BUNDLE" | \
    node "$REPO_ROOT/bootstrap/prepare-secrets.mts" "$PREFLIGHT_DIR/secrets"
fi

INSTALL_BACKUP="$(mktemp -d "$CLAUDE_HOME/backups/bootstrap/install-$(date -u +%Y%m%dT%H%M%SZ)-XXXXXX")"
chmod 700 "$INSTALL_BACKUP" 2>/dev/null || true
transaction_begin "$INSTALL_BACKUP" "$CLAUDE_HOME" "$WS"

# ---- A. files (claude/ -> ~/.claude) ----
while IFS= read -r rel || [ -n "$rel" ]; do
  [ -z "$rel" ] && continue
  case "$rel" in settings.json|CLAUDE.md) continue;; esac
  # Issue #436. Rendered in the preflight, installed from there.
  if [ "$rel" = "teams/kherep/ROUTING.md" ]; then
    install_entry "$rel" "$PREFLIGHT_DIR" "$CLAUDE_HOME" "$INSTALL_BACKUP"
    continue
  fi
  install_entry "$rel" "$CLAUDE_SRC" "$CLAUDE_HOME" "$INSTALL_BACKUP"
done < "$REPO_ROOT/bootstrap/manifest/files.txt"
install_path "kherep/githooks/commit-policy" "$PREFLIGHT_DIR/commit-policy" \
  "$CLAUDE_HOME/kherep/githooks/commit-policy" "$INSTALL_BACKUP/kherep/githooks/commit-policy"
echo "install: commit policy -> $(grep '^work_item_required=' "$PREFLIGHT_DIR/commit-policy") ($CLAUDE_HOME/kherep/githooks/commit-policy)"
install_path "kherep/confluence.json" "$PREFLIGHT_DIR/confluence.json" \
  "$CLAUDE_HOME/kherep/confluence.json" "$INSTALL_BACKUP/kherep/confluence.json"
echo "install: Confluence broker command -> $CLAUDE_HOME/kherep/confluence.json"
install_path "kherep/control-plane/source.json" "$PREFLIGHT_DIR/control-plane-source.json" \
  "$CLAUDE_HOME/kherep/control-plane/source.json" "$INSTALL_BACKUP/kherep/control-plane/source.json"
echo "install: control-plane hooks run from -> $REPO_ROOT ($CLAUDE_HOME/kherep/control-plane/source.json)"
install_path "CLAUDE.md" "$PREFLIGHT_DIR/CLAUDE.md" "$CLAUDE_HOME/CLAUDE.md" "$INSTALL_BACKUP/CLAUDE.md"
install_path "project/CLAUDE.md" "$PREFLIGHT_DIR/project-CLAUDE.md" "$WS/CLAUDE.md" "$INSTALL_BACKUP/project/CLAUDE.md"
# AGENTS.md is what binds the Codex runtime. It existed live since months with no
# versioned source at all (OP-686): not in the manifest, never installed, and
# therefore invisible to drift-check. It had drifted seven rules behind CLAUDE.md,
# including the work-item rule itself.
install_path "project/AGENTS.md" "$PREFLIGHT_DIR/project-AGENTS.md" "$WS/AGENTS.md" "$INSTALL_BACKUP/project/AGENTS.md"
# Both brokers import these modules. Install shared dependencies first so a
# successful transaction never leaves a broker pointing at a missing import.
#
# OP-1124 renamed the six files from .mjs to .mts. install_path installs by
# name and this script has no remove primitive - the transaction only stages,
# copies and rolls back - so the retired .mjs copies stay behind on a box that
# ran an older install. The Codex installer moves those copies into its backup
# through RETIRED_WORKSPACE_TARGETS. A Bootstrap-only rollout must also move the
# six old files into a dated backup; it must never delete them in place.
# OP-1432. The Confluence set ships with the observation agent and is installed
# on every run; the Jira brokers below import atlassian-credentials.mts from it.
# OP-1405. CONFLUENCE_TOOLS lists the shared modules BEFORE the two CLIs, as in
# the Jira set below, so a partially applied run never leaves a broker whose
# imports are missing.
for tool in $CONFLUENCE_TOOLS; do
  install_path "project/tools/$tool" \
    "$REPO_ROOT/modules/atl-jira-brokers/$tool" "$WS/tools/$tool" \
    "$INSTALL_BACKUP/project/tools/$tool"
done

for tool in $GITHUB_BROKER_FILES; do
  install_path "project/tools/github-broker/$tool" \
    "$REPO_ROOT/modules/github-broker/$tool" "$WS/tools/github-broker/$tool" \
    "$INSTALL_BACKUP/project/tools/github-broker/$tool"
done

if [ "$INSTALL_ATLASSIAN_TOOLS" = "1" ]; then
install_path "project/tools/jira-adf.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-adf.mts" "$WS/tools/jira-adf.mts" \
  "$INSTALL_BACKUP/project/tools/jira-adf.mts"
install_path "project/tools/jira-config.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-config.mts" "$WS/tools/jira-config.mts" \
  "$INSTALL_BACKUP/project/tools/jira-config.mts"
install_path "project/tools/jira-transition-guard.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-transition-guard.mts" "$WS/tools/jira-transition-guard.mts" \
  "$INSTALL_BACKUP/project/tools/jira-transition-guard.mts"
install_path "project/tools/jira-fields.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-fields.mts" "$WS/tools/jira-fields.mts" \
  "$INSTALL_BACKUP/project/tools/jira-fields.mts"
install_path "project/tools/jira-links.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-links.mts" "$WS/tools/jira-links.mts" \
  "$INSTALL_BACKUP/project/tools/jira-links.mts"
install_path "project/tools/jira-search.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-search.mts" "$WS/tools/jira-search.mts" \
  "$INSTALL_BACKUP/project/tools/jira-search.mts"
install_path "project/tools/jira-attach.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-attach.mts" "$WS/tools/jira-attach.mts" \
  "$INSTALL_BACKUP/project/tools/jira-attach.mts"
install_path "project/tools/jira-adf-text.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-adf-text.mts" "$WS/tools/jira-adf-text.mts" \
  "$INSTALL_BACKUP/project/tools/jira-adf-text.mts"
install_path "project/tools/jira-download.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-download.mts" "$WS/tools/jira-download.mts" \
  "$INSTALL_BACKUP/project/tools/jira-download.mts"
install_path "project/tools/jira-discovery.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/jira-discovery.mts" "$WS/tools/jira-discovery.mts" \
  "$INSTALL_BACKUP/project/tools/jira-discovery.mts"
install_path "project/tools/atl-jira.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/atl-jira.mts" "$WS/tools/atl-jira.mts" \
  "$INSTALL_BACKUP/project/tools/atl-jira.mts"
install_path "project/tools/atl-jira-ccoder.mts" \
  "$REPO_ROOT/modules/atl-jira-brokers/atl-jira-ccoder.mts" "$WS/tools/atl-jira-ccoder.mts" \
  "$INSTALL_BACKUP/project/tools/atl-jira-ccoder.mts"
fi

# Managed settings come from the repo while unknown existing preferences,
# hooks and host-only plugins survive. Both rendered files replace live state
# atomically and park the exact prior versions in this install's backup.
install_path "settings.json" "$PREFLIGHT_DIR/settings.json" \
  "$CLAUDE_HOME/settings.json" "$INSTALL_BACKUP/settings.json"
install_path "project/settings.local.json" "$PREFLIGHT_DIR/settings.local.json" \
  "$WS/.claude/settings.local.json" "$INSTALL_BACKUP/project/settings.local.json"
# provider-neutral local inference runner (privacy lane + non-private local work)
install_path "runtime/local-inference/runner.mts" \
  "$REPO_ROOT/modules/local-inference/runner.mts" "$CLAUDE_HOME/kherep/local-inference/runner.mts" \
  "$INSTALL_BACKUP/runtime/local-inference/runner.mts"
install_entry "lib" "$REPO_ROOT/modules/local-inference" "$CLAUDE_HOME/kherep/local-inference" "$INSTALL_BACKUP/runtime/local-inference"
install_path "runtime/local-inference/config.json" "$PREFLIGHT_DIR/local-inference.json" \
  "$CLAUDE_HOME/kherep/local-inference/config.json" "$INSTALL_BACKUP/runtime/local-inference/config.json"
# Bounded read-only Teamwork Graph wrapper. Vendor binary and OAuth stay host-managed.
install_path "runtime/twg" "$REPO_ROOT/modules/twg/runtime" \
  "$CLAUDE_HOME/kherep/twg" "$INSTALL_BACKUP/runtime/twg"
# Secret-safe stdio bridge for remote MCPs that still require scoped TLS compatibility.
install_entry "mcp-auth-bridge" "$REPO_ROOT/modules" "$CLAUDE_HOME/kherep" "$INSTALL_BACKUP/runtime"
# A file the repo stopped managing does not disappear on its own: install.sh
# installs by name and owns no remove primitive. Declared retirements are
# parked in a _deprecated/ sibling, never deleted (Golden Rule 1), inside this
# same transaction, so a rollback puts them back where they were (OP-1136).
# project/ entries are workspace files the installer used to place (#33).
bootstrap_retire_declared "$REPO_ROOT/bootstrap/manifest/retired.txt" "$CLAUDE_HOME" "$WS" "$INSTALL_BACKUP"
echo "install: files placed -> $CLAUDE_HOME"
echo "install: previous managed state parked -> $INSTALL_BACKUP"
# Where this install came from, so claude/hooks/live-hook-integrity.mts can reach
# the versioned source from ANY session. The hooks are global and a wiped guard
# is broken everywhere, while resolving through the session cwd gives up outside
# the workspace. Advisory: the reader re-validates the path, so this must never
# fail an install - and it stays outside the transaction because a rollback does
# not change which checkout ran.
node "$REPO_ROOT/bootstrap/record-install-source.mts" "$CLAUDE_HOME" "$REPO_ROOT" ||
  echo "install: source checkout NOT recorded (self-heal falls back to the session workspace)"

# ---- B. secrets via SOPS (age key on NAS) ----
if [ "$SKIP_SECRETS" = "0" ]; then
  install_path "secrets/.mcp.json" "$PREFLIGHT_DIR/secrets/mcp.json" \
    "$CLAUDE_HOME/.mcp.json" "$INSTALL_BACKUP/secrets/.mcp.json"
  echo "install: encrypted bundle installed"
else
  echo "install: SKIP_SECRETS=1 (existing external bindings untouched)"
fi

# Die Datei-Transaktion endet HIER, nicht am Skript-Ende (OP-1085). npm-Globals,
# Plugins und die git-Konfiguration fassen kein einziges Backup-Ziel an, gehoeren
# also nicht in die Transaktion. Solange der Commit dahinter lag, rollte eine
# gescheiterte Deps-Phase fehlerfrei ausgelieferte Dateien zurueck: gemessen am
# 2026-09-02 auf dem Mac, `npm i -g bun` in EEXIST gegen Homebrew-bun, Backup
# install-20260902T085305Z-q7hfw2 mit ROLLED-BACK, nichts ausgeliefert. Ab hier
# ist TX_ACTIVE=0, ein spaeterer Fehlschlag meldet sich nur ueber den Exit-Code.
transaction_commit
echo "install: managed files committed -> $INSTALL_BACKUP"

# ---- C. deps + plugins + mcp (post-commit) ----
# Fehler werden gesammelt statt abzubrechen: die gitconfig-Phase unten ist von
# npm und den Plugins unabhaengig und soll auch dann laufen. Im `||`-Kontext
# feuert der ERR-Trap nicht, `set -e` beendet das Skript hier also nicht.
post_rc=0
# Issue #403. From here to the readiness check (section E) the installer runs
# the claude CLI. Meanwhile an enrolled Kherep node's daemon starts no Claude
# readiness probe (install lock in the node directory; pause waits for a probe
# already in flight), so the two never renew the saved login at the same time.
# The lock is removed after section E and by the EXIT trap. The pre-check names
# a sign-out that existed before this install. The readiness check makes a real
# model call with the account's login, so a candidate home skips both (profile.sh).
SKIP_CLAUDE_READINESS="$(kherep_install_skip_reason CLAUDE_READINESS)"
if [ "$SKIP_DEPS" = "0" ]; then
  CLAUDE_PROBE_PAUSED=1
  node "$REPO_ROOT/bootstrap/claude-readiness-check.mts" pause "$$" ||
    echo "install: WARNING Kherep node Claude probe not paused; it may run during the deps phase"
  [ -n "$SKIP_CLAUDE_READINESS" ] || node "$REPO_ROOT/bootstrap/claude-readiness-check.mts" precheck || true
  node "$REPO_ROOT/bootstrap/npm-globals.mts" "$REPO_ROOT/bootstrap/manifest/npm-globals.txt" \
    "?$REPO_ROOT/bootstrap/manifest/npm-globals.${KHEREP_PROFILE}.txt" || post_rc=1
  node "$REPO_ROOT/bootstrap/reconcile-plugins.mts" \
    "$REPO_ROOT/bootstrap/manifest/marketplaces.json" "$REPO_ROOT/bootstrap/manifest/plugins.json" || post_rc=1
  if [ "$post_rc" = 0 ]; then
    echo "install: npm globals + marketplaces + plugins done."
  else
    echo "install: WARNING deps phase incomplete (npm globals and/or plugins) - managed files stay committed"
  fi
  # Issue #376. The Atlassian MCP server v2 as the Claude service account: its
  # API key file, never the operator's OAuth login. It writes the user-scope
  # registry (~/.claude.json), live host state outside CLAUDE_HOME, so it has
  # the same skip rules as the credential step. The OAuth plugin is disabled
  # only after the server reads back as registered.
  if [ "$INSTALL_ATLASSIAN_TOOLS" = "1" ]; then
    SKIP_ATL_MCP="$(kherep_install_skip_reason ATL_MCP)"
    if [ -n "$SKIP_ATL_MCP" ]; then
      echo "install: SKIP_ATL_MCP=1 (by $SKIP_ATL_MCP; Atlassian MCP server not registered, ~/.claude.json untouched)"
    elif ! node "$REPO_ROOT/bootstrap/atl-mcp-claude.mts" --claude-home "$CLAUDE_HOME"; then
      post_rc=1
      echo "install: WARNING no Atlassian MCP server for Claude - nothing falls back to a personal login"
    fi
  fi
  echo "install: MCP -> review 'claude mcp list'. forge-knowledge needs interactive OAuth re-consent."
else
  echo "install: SKIP_DEPS=1 (no npm/plugins/mcp)"
fi
# ---- C2. Atlassian service-account credential (post-commit) ----
# Die beiden Werte wurden bisher von Hand in die Datei kopiert. Gleicher
# Hausbrauch wie der Space-Schritt, plus zwei Unterschiede: das Secret wird ohne Echo gelesen,
# und gueltig ist die Datei erst, wenn der Broker-Selftest das diskriminierende
# PASS liefert - ein Exit 0 allein ist kein Beweis.
#
# The credential is real per-host state, and checking it is a live call against
# Atlassian through the broker selftest. A throwaway home holds no credential
# file and no terminal; the step passes there only when KHEREP_ATL_CRED_FILE_CLAUDE
# is set, and then it reads the host's real file outside the throwaway home. It
# therefore sits behind its own skip switch. Only the exact value 1 skips; a real
# install without the switch still runs the step and still fails on a missing or
# unverified credential. A CLAUDE_HOME other than the default one skips the
# step too, unless KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL=1 (issue #256, profile.sh).
SKIP_ATL_CREDENTIAL="$(kherep_install_skip_reason ATL_CREDENTIAL)"
atl_credential_ok=0
if [ -n "$SKIP_ATL_CREDENTIAL" ]; then
  echo "install: SKIP_ATL_CREDENTIAL=1 (by $SKIP_ATL_CREDENTIAL; Atlassian service-account credential not read or verified, no broker selftest; $CLAUDE_HOME/kherep/atl-credential-claude.txt untouched)"
elif node "$REPO_ROOT/bootstrap/atl-credential.mts" --runtime claude --out "$CLAUDE_HOME/kherep/atl-credential-claude.txt"; then
  atl_credential_ok=1
else
  post_rc=1
  echo "install: WARNING no verified Atlassian service-account credential - the Claude broker will not authenticate"
fi

# ---- C3. Confluence knowledge space (post-commit) ----
# Ohne Space haben die Observation-Agents kein Ziel. Der Wert ist host-eigen und
# folgt dem Hausbrauch fuer solche Werte: Umgebungsvariable, beim Install geprueft.
#
# The space is real per-host state, resolved through the Confluence broker with
# the service-account credential C2 verified, so it runs only after C2 passed.
# It reads the same file C2 resolved: KHEREP_ATL_CRED_FILE_CLAUDE if set, else
# C2's --out target. The smoke test installs into throwaway homes that have
# neither a space key nor a terminal, so there the step can only fail. It
# therefore sits behind a skip switch in the same style as SKIP_GITCONFIG below.
# Only the exact value 1 skips; a real install without the switch still runs the
# step and still fails on a missing space. Skipping only C2 does not make the
# space optional: the install then fails, because the space was never checked.
# The same file carries `broker`, the absolute command claude-obs runs, placed
# on every install by the preflight broker-only step (issue #13). This step
# passes the same profile and workspace, so it writes the same value, and it
# merges: every key it does not own survives.
SKIP_KNOWLEDGE_SPACE="$(kherep_install_skip_reason KNOWLEDGE_SPACE)"
if [ -n "$SKIP_KNOWLEDGE_SPACE" ]; then
  echo "install: SKIP_KNOWLEDGE_SPACE=1 (by $SKIP_KNOWLEDGE_SPACE; Confluence knowledge space not resolved; the space keys in $CLAUDE_HOME/kherep/confluence.json stay as they were)"
elif [ "$atl_credential_ok" = "1" ]; then
  KHEREP_ATL_CRED_FILE_CLAUDE="${KHEREP_ATL_CRED_FILE_CLAUDE:-$CLAUDE_HOME/kherep/atl-credential-claude.txt}" \
    node "$REPO_ROOT/bootstrap/confluence-space.mts" --out "$CLAUDE_HOME/kherep/confluence.json" \
      --runtime claude --profile "$KHEREP_PROFILE" --workspace "$WS" \
    || { post_rc=1; echo "install: WARNING no Confluence knowledge space configured - observation agents will not write"; }
elif [ -n "$SKIP_ATL_CREDENTIAL" ]; then
  post_rc=1
  echo "install: WARNING Confluence knowledge space was not checked because the credential step was skipped"
else
  # post_rc is already 1 from C2; this line only names the consequence for C3.
  echo "install: WARNING Confluence knowledge space was not checked without a verified credential"
fi

# ---- D. git commit-msg hook (Kherep work-item rule, post-commit) ----
# The Claude PreToolUse guard only sees Claude's own tool calls. Commits made by
# Codex, by the IDE or by hand in a terminal never pass through it, so the
# binding rule lives in a git hook. One shared core.hooksPath, so there are no
# per-repo copies to drift apart. The hook itself is scoped to KHEREP_WORKSPACE
# and stays out of the way everywhere else. Its policy (workspace, required,
# pattern) is the commit-policy file placed inside the transaction in section A
# (OP-1426), so it also binds processes that do not carry KHEREP_*.
#
# core.hooksPath is real, machine-wide git state, NOT a managed file under
# CLAUDE_HOME. The smoke test runs this installer against a throwaway profile
# and must not rewrite the developer's actual git config, so the write sits
# behind a skip switch in the same style as SKIP_SECRETS / SKIP_DEPS. A
# CLAUDE_HOME other than the default one skips it too, unless
# KHEREP_INSTALL_ALLOW_GITCONFIG=1: a candidate home bound globally leaves every
# repository of the account on a hook directory that is deleted later (#256).
# The same directory holds post-checkout (issue #325). It only warns when a
# branch checkout leaves a workspace repository's main checkout off its default
# branch, and needs the mode bit like commit-msg. pre-push (issue #325, PR-A)
# records who pushed in the local attribution log and never blocks a push; it
# needs the bit too, attribution-record.mts beside it is run through node.
SKIP_GITCONFIG="$(kherep_install_skip_reason GITCONFIG)"
GITHOOKS_DIR="$CLAUDE_HOME/kherep/githooks"
if [ -n "$SKIP_GITCONFIG" ]; then
  chmod +x "$GITHOOKS_DIR/commit-msg" "$GITHOOKS_DIR/post-checkout" "$GITHOOKS_DIR/pre-push" 2>/dev/null || true
  echo "install: SKIP_GITCONFIG=1 (by $SKIP_GITCONFIG; global, system and repo-local core.hooksPath untouched; hook file still placed)"
elif [ -f "$GITHOOKS_DIR/commit-msg" ]; then
  # Windows checkouts routinely drop the mode bit; without +x git skips the hook
  # silently and the rule would bind on one host but not the other.
  chmod +x "$GITHOOKS_DIR/commit-msg" "$GITHOOKS_DIR/post-checkout" "$GITHOOKS_DIR/pre-push" 2>/dev/null || true
  # Git for Windows stores the drive form C:/... of the /c/... path passed here,
  # so the same directory must not read as a replacement (issue #99).
  source "$REPO_ROOT/bootstrap/bind-repo-hookspath.sh"
  PREV_HOOKS_PATH="$(git config --global core.hooksPath 2>/dev/null || true)"
  if [ -n "$PREV_HOOKS_PATH" ] && [ "$(norm_hookspath "$PREV_HOOKS_PATH")" != "$(norm_hookspath "$GITHOOKS_DIR")" ]; then
    echo "install: WARNING core.hooksPath was '$PREV_HOOKS_PATH' and is being replaced by '$GITHOOKS_DIR'. The previous directory is NOT merged; move any hooks you still need."
  fi
  # Post-Commit: gesammelt statt abgebrochen, wie die Nachbarzeilen (OP-1085 Review).
  if git config --global core.hooksPath "$GITHOOKS_DIR"; then
    echo "install: git core.hooksPath -> $GITHOOKS_DIR (global, binds THIS account)"
  else
    echo "install: WARNING global core.hooksPath could not be set - the work-item rule is NOT enforced for this account"
    post_rc=1
  fi
  # System level binds EVERY account on the host from one place. A writable
  # system file is no consent: Git for Windows can ship one that a non-elevated
  # shell may write, and a normal install then silently re-pointed the hook for
  # every account (issue #23). The value is only read, and a difference reported,
  # unless KHEREP_INSTALL_SYSTEM_HOOKSPATH is exactly 1. Git for Windows stores
  # the drive form of a /c/... path, so compare like the repo-local binding does.
  SYSTEM_HOOKS_PATH="$(git config --system --get core.hooksPath 2>/dev/null || true)"
  if [ "$(norm_hookspath "$SYSTEM_HOOKS_PATH")" != "$(norm_hookspath "$GITHOOKS_DIR")" ]; then
    SYSTEM_HOOKS_SHOWN="'$SYSTEM_HOOKS_PATH'"
    [ -n "$SYSTEM_HOOKS_PATH" ] || SYSTEM_HOOKS_SHOWN="unset"
    if [ "$(kherep_env INSTALL_SYSTEM_HOOKSPATH 0)" != "1" ]; then
      echo "install: system core.hooksPath is $SYSTEM_HOOKS_SHOWN, not '$GITHOOKS_DIR' - left unchanged; KHEREP_INSTALL_SYSTEM_HOOKSPATH=1 replaces it for EVERY account on this host"
    elif git config --system core.hooksPath "$GITHOOKS_DIR"; then
      echo "install: git core.hooksPath -> $GITHOOKS_DIR (system, binds EVERY account; replaced $SYSTEM_HOOKS_SHOWN)"
    else
      echo "install: WARNING system core.hooksPath could not be set despite KHEREP_INSTALL_SYSTEM_HOOKSPATH=1 (still $SYSTEM_HOOKS_SHOWN; writing it usually needs elevation)"
      post_rc=1
    fi
  fi
  # A global setting lives in one account's home and binds only that account.
  # A repository-local pointer is read by whichever account runs git in that
  # repository. Advisory like record-install-source: guarded
  # with || so it can never fail an install.
  bash "$REPO_ROOT/bootstrap/bind-repo-hookspath.sh" "$WS" "$GITHOOKS_DIR" ||
    echo "install: WARNING repo-local core.hooksPath not fully bound - commits by OTHER accounts are unenforced in the repos named above (OP-684)"
else
  echo "install: WARNING $GITHOOKS_DIR/commit-msg missing. The work-item rule is NOT enforced on this host."
fi

# ---- E. Claude readiness (issue #403, post-commit) ----
# The daemon's own probe, once, while the daemon's probe is still paused, so
# the two do not run together; the lock goes right after. A lost sign-in fails
# the install with the fix named; a timeout or another failure only warns.
# Without SKIP_DEPS (a test that runs section D onward) nothing is probed.
claude_rc=0
if [ "${SKIP_DEPS:-1}" != "0" ]; then
  :
elif [ -n "${SKIP_CLAUDE_READINESS:-}" ]; then
  echo "install: SKIP_CLAUDE_READINESS=1 (by $SKIP_CLAUDE_READINESS; claude sign-in not probed)"
else
  # Refreshes the lock: a credential prompt above may have aged it past 30 min.
  node "$REPO_ROOT/bootstrap/claude-readiness-check.mts" pause "$$" >/dev/null || true
  node "$REPO_ROOT/bootstrap/claude-readiness-check.mts" check || claude_rc=1
fi
[ "${CLAUDE_PROBE_PAUSED:-0}" != 1 ] || claude_probe_resume

if [ "$post_rc" = 0 ] && [ "$claude_rc" = 0 ]; then
  echo "install done."
elif [ "$post_rc" = 0 ]; then
  echo "install: DONE WITH ERRORS (Claude sign-in lost, see above; managed files stay committed)"
  exit 1
else
  echo "install: DONE WITH ERRORS (deps phase failed; managed files stay committed, see above)"
  exit 1
fi
