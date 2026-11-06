#!/usr/bin/env bash
# Reversible filesystem transaction for bootstrap/install.sh.
# Backups may live on another volume; every live swap stays in the target's
# parent directory and therefore relies only on same-filesystem renames.

TX_ACTIVE=0
TX_BACKUP_ROOT=""
TX_COUNT=0
TX_FAILURE_REASON=""
TX_COPY_HOLDER=""
TX_PENDING_NEW_HOLDER=""
TX_PENDING_OLD_HOLDER=""
TX_PENDING_OLD_TARGET=""
TX_PENDING_OLD_ID=""
TX_ALLOWED_TARGET_ROOTS=()
TX_ALLOWED_BACKUP_ROOTS=()
TX_CREATED_PARENTS=()
TX_TARGETS=()
TX_BACKUPS=()
TX_EXISTED=()
TX_LABELS=()
TX_IDS=()
TX_SEEN_TARGETS=()

transaction_path_exists() {
  [[ -e "$1" ]] || [[ -L "$1" ]]
}

source "$(dirname "${BASH_SOURCE[0]}")/transaction-paths.sh"

transaction_remove_holder() {
  local holder="${1:-}"
  [[ -n "$holder" ]] || return 0
  case "$holder" in
    */.kherep-*-*) rm -rf -- "$holder" ;;
    *) echo "ERROR: refusing to remove unexpected transaction path: $holder" >&2; return 1 ;;
  esac
}

transaction_cleanup_pending() {
  local ok=0 holder entry
  for holder in "$TX_COPY_HOLDER" "$TX_PENDING_NEW_HOLDER"; do
    [[ -z "$holder" ]] || transaction_remove_holder "$holder" || ok=1
  done
  TX_COPY_HOLDER=""
  TX_PENDING_NEW_HOLDER=""
  if [[ -n "$TX_PENDING_OLD_HOLDER" ]]; then
    if transaction_path_exists "$TX_PENDING_OLD_HOLDER/payload"; then
      entry="$TX_BACKUP_ROOT/journal/$TX_PENDING_OLD_ID"
      [[ -d "$entry" ]] && printf '%s\n' "$TX_PENDING_OLD_HOLDER/payload" > "$entry/original-live-sibling"
      echo "ERROR: original live payload preserved at $TX_PENDING_OLD_HOLDER/payload" >&2
      ok=1
    else
      transaction_remove_holder "$TX_PENDING_OLD_HOLDER" || ok=1
      TX_PENDING_OLD_HOLDER=""; TX_PENDING_OLD_TARGET=""; TX_PENDING_OLD_ID=""
    fi
  fi
  return "$ok"
}

# Copy a file, directory, or symlink into a sibling holder. The caller moves
# holder/payload into place only after the copy is complete.
transaction_copy_to_holder() {
  local src="$1" parent="$2" prefix="$3"
  mkdir -p "$parent"
  TX_COPY_HOLDER="$(mktemp -d "$parent/${prefix}XXXXXX")"
  if ! cp -a "$src" "$TX_COPY_HOLDER/payload"; then
    transaction_remove_holder "$TX_COPY_HOLDER" || true
    TX_COPY_HOLDER=""
    return 1
  fi
}

transaction_entries_equal() {
  local comparator rc
  comparator="$(dirname "${BASH_SOURCE[0]}")/transaction-entry-equal.mts"
  if node "$comparator" "$1" "$2"; then return 0; else rc=$?; fi
  [[ "$rc" -eq 1 ]] && return 1
  echo "FATAL: managed entry comparison failed" >&2
  return 2
}

# Backups are copied, never renamed from the live target. A temporary holder in
# the backup parent keeps incomplete copies from looking like valid backups.
transaction_backup_path() {
  local src="$1" backup="$2" parent holder
  parent="$(dirname "$backup")"
  mkdir -p "$parent"
  if transaction_path_exists "$backup"; then
    echo "FATAL: transaction backup already exists: $backup" >&2
    return 1
  fi
  transaction_copy_to_holder "$src" "$parent" ".kherep-backup-"
  holder="$TX_COPY_HOLDER"
  mv "$holder/payload" "$backup"
  rmdir "$holder"
  TX_COPY_HOLDER=""
}

transaction_begin() {
  local backup_root="$1" target_root i
  [[ "$TX_ACTIVE" = "0" ]] || { echo "FATAL: transaction already active" >&2; return 1; }
  [[ "$#" -ge 2 ]] || { echo "FATAL: transaction_begin requires at least one target root" >&2; return 2; }
  transaction_validate_absolute_path "transaction backup root" "$backup_root" || return $?
  TX_BACKUP_ROOT="$backup_root"
  TX_COUNT=0
  TX_FAILURE_REASON=""
  TX_TARGETS=(); TX_BACKUPS=(); TX_EXISTED=(); TX_LABELS=(); TX_IDS=(); TX_CREATED_PARENTS=(); TX_CREATED_GRAVEYARDS=(); TX_SEEN_TARGETS=()
  TX_ALLOWED_TARGET_ROOTS=(); TX_ALLOWED_BACKUP_ROOTS=("$(transaction_trim_root "$backup_root")")
  shift
  for target_root in "$@"; do
    transaction_validate_absolute_path "transaction target root" "$target_root" || return $?
    TX_ALLOWED_TARGET_ROOTS[${#TX_ALLOWED_TARGET_ROOTS[@]}]="$(transaction_trim_root "$target_root")"
  done
  mkdir -p "$TX_BACKUP_ROOT/journal" "$TX_BACKUP_ROOT/failed"
  chmod 700 "$TX_BACKUP_ROOT" "$TX_BACKUP_ROOT/journal" "$TX_BACKUP_ROOT/failed" 2>/dev/null || true
  printf '%s\n' "pid=$$" "started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TX_BACKUP_ROOT/ACTIVE"
  TX_ACTIVE=1
}

transaction_register() {
  local label="$1" target="$2" backup="$3" existed="$4" id entry
  id="$(printf '%06d' "$TX_COUNT")"
  entry="$TX_BACKUP_ROOT/journal/$id"
  mkdir "$entry"
  printf '%s\n' "$label" > "$entry/label"
  printf '%s\n' "$target" > "$entry/target"
  printf '%s\n' "$backup" > "$entry/backup"
  printf '%s\n' "$existed" > "$entry/original-present"
  TX_LABELS[$TX_COUNT]="$label"
  TX_TARGETS[$TX_COUNT]="$target"
  TX_BACKUPS[$TX_COUNT]="$backup"
  TX_EXISTED[$TX_COUNT]="$existed"
  TX_IDS[$TX_COUNT]="$id"
  TX_COUNT=$((TX_COUNT + 1))
}

transaction_claim_target() {
  local target="$1" target_seen
  for target_seen in ${TX_SEEN_TARGETS[@]+"${TX_SEEN_TARGETS[@]}"}; do
    [[ "$target_seen" != "$target" ]] || {
      echo "FATAL: target registered twice in one transaction: $target" >&2; return 1;
    }
  done
  TX_SEEN_TARGETS[${#TX_SEEN_TARGETS[@]}]="$target"
}

transaction_test_checkpoint() {
  local label="$1"
  if [[ "${KHEREP_BOOTSTRAP_TEST_FAIL_AFTER_LABEL:-}" = "$label" ]]; then
    echo "TEST: injected failure after $label" >&2
    return 97
  fi
  if [[ "${KHEREP_BOOTSTRAP_TEST_PAUSE_AFTER_LABEL:-}" = "$label" ]]; then
    [[ -n "${KHEREP_BOOTSTRAP_TEST_MARKER:-}" ]] || {
      echo "FATAL: test pause requires KHEREP_BOOTSTRAP_TEST_MARKER" >&2; return 98;
    }
    : > "$KHEREP_BOOTSTRAP_TEST_MARKER"
    while :; do sleep 1; done
  fi
}

transaction_install_path() {
  local label="$1" src="$2" target="$3" backup="$4"
  local parent base new_holder old_holder existed=0 compare_rc
  transaction_path_exists "$src" || {
    echo "FATAL: managed source missing for $label ($src)" >&2; return 1;
  }
  [[ "$TX_ACTIVE" = "1" ]] || { echo "FATAL: install_path requires an active transaction" >&2; return 1; }
  transaction_assert_allowed_path target "$label target" "$target" || return $?
  transaction_assert_allowed_path backup "$label backup" "$backup" || return $?
  transaction_claim_target "$target" || return $?
  transaction_ensure_target_parent "$label" "$target" || return $?
  if transaction_path_exists "$target"; then
    if transaction_entries_equal "$src" "$target"; then
      transaction_test_checkpoint "$label"
      return $?
    else
      compare_rc=$?
      [[ "$compare_rc" -eq 1 ]] || return "$compare_rc"
    fi
  fi
  parent="$(dirname "$target")"
  base="$(basename "$target")"

  transaction_copy_to_holder "$src" "$parent" ".kherep-stage-$base-"
  new_holder="$TX_COPY_HOLDER"
  TX_PENDING_NEW_HOLDER="$new_holder"
  TX_COPY_HOLDER=""

  if transaction_path_exists "$target"; then existed=1; fi
  transaction_register "$label" "$target" "$backup" "$existed"

  if [[ "$existed" = "1" ]]; then
    old_holder="$(mktemp -d "$parent/.kherep-previous-$base-XXXXXX")"
    TX_PENDING_OLD_HOLDER="$old_holder"
    TX_PENDING_OLD_TARGET="$target"
    TX_PENDING_OLD_ID="${TX_IDS[$((TX_COUNT - 1))]}"
    mv "$target" "$old_holder/payload"
    # The atomic sibling move is the source of truth. Backup only that parked
    # payload, never a live path that may change between copy and swap.
    transaction_backup_path "$old_holder/payload" "$backup"
  elif transaction_path_exists "$target"; then
    echo "FATAL: originally absent target appeared before swap: $target" >&2
    return 3
  fi
  if [[ "${KHEREP_BOOTSTRAP_TEST_FAIL_SWAP_LABEL:-}" = "$label" ]]; then
    echo "TEST: injected sibling-swap failure for $label" >&2
    return 96
  fi
  if transaction_path_exists "$target"; then
    echo "FATAL: target changed while reserved for swap: $target" >&2
    return 3
  fi
  mv "$new_holder/payload" "$target"
  rmdir "$new_holder"
  TX_PENDING_NEW_HOLDER=""
  if [[ "$existed" = "1" ]]; then
    transaction_remove_holder "$old_holder"
    TX_PENDING_OLD_HOLDER=""; TX_PENDING_OLD_TARGET=""; TX_PENDING_OLD_ID=""
  fi
  transaction_test_checkpoint "$label"
}

transaction_commit_is_durable() {
  [[ -n "$TX_BACKUP_ROOT" ]] && [[ -f "$TX_BACKUP_ROOT/COMMITTED" ]]
}

transaction_accept_durable_commit() {
  transaction_commit_is_durable || return 1
  rm -f "$TX_BACKUP_ROOT/ACTIVE"
  TX_ACTIVE=0
}

transaction_commit() {
  local marker="$TX_BACKUP_ROOT/.COMMITTED.$$"
  [[ "$TX_ACTIVE" = "1" ]] || { echo "FATAL: no active transaction to commit" >&2; return 1; }
  transaction_cleanup_pending
  printf '%s\n' "committed=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$marker"
  mv "$marker" "$TX_BACKUP_ROOT/COMMITTED"
  if [[ -n "${KHEREP_BOOTSTRAP_TEST_PAUSE_AFTER_COMMIT_MARKER:-}" ]]; then
    : > "$KHEREP_BOOTSTRAP_TEST_PAUSE_AFTER_COMMIT_MARKER"
    while :; do sleep 1; done
  fi
  rm -f "$TX_BACKUP_ROOT/ACTIVE"
  TX_ACTIVE=0
}

source "$(dirname "${BASH_SOURCE[0]}")/transaction-rollback.sh"
source "$(dirname "${BASH_SOURCE[0]}")/transaction-retire.sh"
