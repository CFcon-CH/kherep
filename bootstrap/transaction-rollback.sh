#!/usr/bin/env bash
# Reverse-restore half of bootstrap/transaction.sh. Sourced after its helpers.

transaction_park_failed_holder() {
  local holder="$1" id="$2" entry="$TX_BACKUP_ROOT/journal/$2" failed="$TX_BACKUP_ROOT/failed/$2"
  [[ -n "$holder" ]] || return 0
  if cp -a "$holder/payload" "$failed"; then
    if ! transaction_remove_holder "$holder"; then
      printf '%s\n' "$holder/payload" > "$entry/failed-live-sibling"
      echo "ERROR: copied failed payload, but live sibling could not be removed: $holder/payload" >&2
      return 1
    fi
    return 0
  fi
  printf '%s\n' "$holder/payload" > "$entry/failed-live-sibling"
  echo "ERROR: failed live payload remains parked at $holder/payload" >&2
  return 1
}

transaction_restore_entry() {
  local i="$1" target backup existed id parent base restore_holder="" failed_holder="" direct=0 ok=0
  target="${TX_TARGETS[$i]}"; backup="${TX_BACKUPS[$i]}"
  existed="${TX_EXISTED[$i]}"; id="${TX_IDS[$i]}"
  parent="$(dirname "$target")"; base="$(basename "$target")"
  if [[ "$existed" = "1" ]]; then
    if [[ "$TX_PENDING_OLD_TARGET" = "$target" ]] && [[ "$TX_PENDING_OLD_ID" = "$id" ]] &&
       transaction_path_exists "$TX_PENDING_OLD_HOLDER/payload"; then
      restore_holder="$TX_PENDING_OLD_HOLDER"
      direct=1
    else
      transaction_path_exists "$backup" || {
        echo "ERROR: rollback backup missing for $target: $backup" >&2; return 1;
      }
      transaction_copy_to_holder "$backup" "$parent" ".kherep-restore-$base-" || return 1
      restore_holder="$TX_COPY_HOLDER"; TX_COPY_HOLDER=""
    fi
  fi
  if transaction_path_exists "$target"; then
    failed_holder="$(mktemp -d "$parent/.kherep-failed-$base-XXXXXX")"
    mv "$target" "$failed_holder/payload" || { transaction_remove_holder "$failed_holder"; return 1; }
  fi
  if [[ "$existed" = "1" ]]; then
    if mv "$restore_holder/payload" "$target"; then
      rmdir "$restore_holder" || ok=1
      if [[ "$direct" = "1" ]]; then
        TX_PENDING_OLD_HOLDER=""; TX_PENDING_OLD_TARGET=""; TX_PENDING_OLD_ID=""
      fi
    else
      [[ -z "$failed_holder" ]] || mv "$failed_holder/payload" "$target" || true
      [[ "$direct" = "1" ]] || transaction_remove_holder "$restore_holder" || true
      return 1
    fi
  fi
  [[ -z "$failed_holder" ]] || transaction_park_failed_holder "$failed_holder" "$id" || ok=1
  return "$ok"
}

transaction_rollback() {
  local reason="${1:-unexpected exit}" i ok=0
  [[ "$TX_ACTIVE" = "1" ]] || return 0
  if transaction_commit_is_durable; then
    echo "ERROR: refusing to roll back a durably committed transaction" >&2
    transaction_accept_durable_commit
    return 2
  fi
  set +e
  printf '%s\n' "$reason" > "$TX_BACKUP_ROOT/ROLLBACK-REASON"
  for ((i=TX_COUNT-1; i>=0; i--)); do transaction_restore_entry "$i" || ok=1; done
  transaction_cleanup_pending || ok=1
  transaction_cleanup_created_graveyards
  transaction_cleanup_created_parents || ok=1
  rm -f "$TX_BACKUP_ROOT/ACTIVE"
  if [[ "$ok" = "0" ]]; then
    printf '%s\n' "rolled-back=$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$TX_BACKUP_ROOT/ROLLED-BACK"
  else
    printf '%s\n' "manual recovery required" > "$TX_BACKUP_ROOT/ROLLBACK-INCOMPLETE"
  fi
  TX_ACTIVE=0
  return "$ok"
}
