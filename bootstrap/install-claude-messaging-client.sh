#!/usr/bin/env bash
# Explicit, client-only Claude messaging projection. It never edits Claude settings or MCP registries.
set -Eeuo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
CLIENT_CLI="$REPO_ROOT/modules/control-plane/node/claude-mcp-client.mts"
HOME_ROOT=""
CONFIG_ROOT=""
NODE_COMMAND=""
STAGE_PARENT=""
INSTALL_BACKUP=""

usage() {
  printf '%s\n' \
    "Usage: bash bootstrap/install-claude-messaging-client.sh --home ABS --config-root ABS [--node ABS]" \
    "Installs no defaults. Activate a session with the command printed after a successful install."
}

[[ "$#" -gt 0 ]] || { usage >&2; exit 2; }
if [[ "$#" -eq 1 ]] && [[ "$1" = "--help" ]]; then usage; exit 0; fi
while [[ "$#" -gt 0 ]]; do
  case "$1" in
    --home) [[ "$#" -ge 2 ]] || { echo "FATAL: --home requires a value" >&2; exit 2; }; HOME_ROOT="$2"; shift 2 ;;
    --config-root) [[ "$#" -ge 2 ]] || { echo "FATAL: --config-root requires a value" >&2; exit 2; }; CONFIG_ROOT="$2"; shift 2 ;;
    --node) [[ "$#" -ge 2 ]] || { echo "FATAL: --node requires a value" >&2; exit 2; }; NODE_COMMAND="$2"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "FATAL: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done
[[ -n "$HOME_ROOT" ]] && [[ -n "$CONFIG_ROOT" ]] || { echo "FATAL: --home and --config-root are required" >&2; exit 2; }

source "$HERE/transaction.sh"
source "$HERE/install-lock.sh"

cleanup_stage() {
  [[ -n "$STAGE_PARENT" ]] || return 0
  case "$STAGE_PARENT" in
    "${TMPDIR:-/tmp}"/kherep-claude-client.*) rm -rf -- "$STAGE_PARENT" ;;
    *) echo "ERROR: refusing to remove unexpected stage path: $STAGE_PARENT" >&2; return 1 ;;
  esac
  STAGE_PARENT=""
}

on_err() {
  local rc="$1" line="$2"
  [[ -n "$TX_FAILURE_REASON" ]] || TX_FAILURE_REASON="command failed with exit $rc at install-claude-messaging-client.sh:$line"
}

on_exit() {
  local rc="$1" rollback_rc=0
  trap - ERR INT TERM EXIT
  if [[ "$TX_ACTIVE" = "1" ]]; then
    if transaction_commit_is_durable; then transaction_accept_durable_commit || rollback_rc=1
    else transaction_rollback "${TX_FAILURE_REASON:-client install failed with exit $rc}" || rollback_rc=1
    fi
  fi
  cleanup_stage || rollback_rc=1
  bootstrap_lock_release || rollback_rc=1
  [[ "$rollback_rc" = "0" ]] || rc=1
  exit "$rc"
}

trap 'on_err $? $LINENO' ERR
trap 'TX_FAILURE_REASON="received SIGINT"; exit 130' INT
trap 'TX_FAILURE_REASON="received SIGTERM"; exit 143' TERM
trap 'on_exit $?' EXIT

transaction_validate_absolute_path "Claude home" "$HOME_ROOT"
transaction_validate_absolute_path "node config root" "$CONFIG_ROOT"
[[ "$HOME_ROOT" != "/" ]] && [[ "$CONFIG_ROOT" != "/" ]] || { echo "FATAL: configured roots must not be /" >&2; exit 2; }
[[ -d "$HOME_ROOT" ]] && [[ ! -L "$HOME_ROOT" ]] || { echo "FATAL: Claude home must be an existing real directory" >&2; exit 2; }
[[ -d "$CONFIG_ROOT" ]] && [[ ! -L "$CONFIG_ROOT" ]] || { echo "FATAL: node config root must be an existing real directory" >&2; exit 2; }
if [[ -z "$NODE_COMMAND" ]]; then NODE_COMMAND="$(command -v node || true)"; fi
[[ -n "$NODE_COMMAND" ]] || { echo "FATAL: node required" >&2; exit 1; }
transaction_validate_absolute_path "node command" "$NODE_COMMAND"
node() {
  "$NODE_COMMAND" "$@"
}

for source in "$CLIENT_CLI" "$HERE/transaction.sh" "$HERE/transaction-paths.sh" \
  "$HERE/transaction-rollback.sh" "$HERE/transaction-retire.sh" "$HERE/install-lock.sh"; do
  [[ -f "$source" ]] && [[ ! -L "$source" ]] || { echo "FATAL: unsafe or missing installer source: $source" >&2; exit 1; }
done

TARGET="$HOME_ROOT/kherep/claude-messaging-client"
BACKUP_BASE="$HOME_ROOT/backups/claude-messaging-client"
LOCK_PARENT="$HOME_ROOT/backups/bootstrap"
LOCK="$LOCK_PARENT/.install.lock"
transaction_validate_path_under_root "managed client target" "$TARGET" "$HOME_ROOT" 1
transaction_validate_path_under_root "client backup root" "$BACKUP_BASE" "$HOME_ROOT" 1
transaction_validate_path_under_root "shared bootstrap lock" "$LOCK" "$HOME_ROOT" 1
if transaction_path_exists "$TARGET"; then
  "$NODE_COMMAND" "$CLIENT_CLI" verify --client-root "$TARGET" --expected-client-root "$TARGET" >/dev/null
fi

STAGE_PARENT="$(mktemp -d "${TMPDIR:-/tmp}/kherep-claude-client.XXXXXX")"
CANDIDATE="$STAGE_PARENT/client"
"$NODE_COMMAND" "$CLIENT_CLI" stage --output-root "$CANDIDATE" --client-root "$TARGET" \
  --config-root "$CONFIG_ROOT" --node "$NODE_COMMAND" >/dev/null
IDENTITY="$("$NODE_COMMAND" "$CLIENT_CLI" verify --client-root "$CANDIDATE" --expected-client-root "$TARGET")"

mkdir -p "$LOCK_PARENT" "$BACKUP_BASE"
transaction_validate_path_under_root "shared bootstrap lock" "$LOCK" "$HOME_ROOT" 1
transaction_validate_path_under_root "client backup root" "$BACKUP_BASE" "$HOME_ROOT" 1
bootstrap_lock_acquire "$LOCK"
if transaction_path_exists "$TARGET"; then
  "$NODE_COMMAND" "$CLIENT_CLI" verify --client-root "$TARGET" --expected-client-root "$TARGET" >/dev/null
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)-$$-${RANDOM:-0}"
INSTALL_BACKUP="$BACKUP_BASE/install-$stamp"
transaction_begin "$INSTALL_BACKUP" "$HOME_ROOT"
transaction_install_path "claude-messaging-client" "$CANDIDATE" "$TARGET" "$INSTALL_BACKUP/previous-client"
"$NODE_COMMAND" "$CLIENT_CLI" verify --client-root "$TARGET" --expected-client-root "$TARGET" >/dev/null
transaction_commit

shell_arg() {
  case "$1" in *"'"*) echo "FATAL: activation argument contains a quote" >&2; return 2;; esac
  printf "'%s'" "$1"
}

printf 'install: Claude messaging client identity %s\n' "$IDENTITY"
printf 'activate: claude --plugin-dir '; shell_arg "$TARGET/plugin"
printf ' --mcp-config '; shell_arg "$TARGET/mcp.json"
printf ' --strict-mcp-config\n'
