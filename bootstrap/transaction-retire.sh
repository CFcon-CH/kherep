#!/usr/bin/env bash
# Retirement half of bootstrap/transaction.sh. Sourced after its helpers.
#
# OP-1136. install.sh installs BY NAME and owns no remove primitive, so a live
# file the repo stopped managing simply stays behind: unmanaged, unwired and
# invisible to drift-check. Deleting it is not an option (Golden Rule 1), so it
# is PARKED. The file moves into a _deprecated/ sibling of its own directory
# after its exact prior version has been copied into the install backup, which
# is what lets rollback put it back at the original path.
#
# A rolled-back retirement deliberately leaves the parked copy where it is:
# removing it would be the delete this primitive exists to avoid. The dated
# suffix is what keeps a later run from ever overwriting an already parked file.
# Two retirements inside the same second would collide on that stamp, so the
# suffix counts up (.<stamp>-1, -2, ...) until a free name is found: a collision
# can no longer abort the install. TX_RETIRE_STAMP overrides the stamp and
# exists only so tests can force that collision; production never sets it.
#
# A _deprecated/ the pass creates is journalled like a created parent (#45).
# Rollback removes it only while it is empty, i.e. when the retirement failed
# before its file landed there. One that holds a parked copy stays, by design.

TX_CREATED_GRAVEYARDS=()

transaction_cleanup_created_graveyards() {
  local i path
  for ((i=${#TX_CREATED_GRAVEYARDS[@]}-1; i>=0; i--)); do
    path="${TX_CREATED_GRAVEYARDS[$i]}"
    if [[ -d "$path" ]] && [[ ! -L "$path" ]]; then rmdir "$path" 2>/dev/null || true; fi
  done
  TX_CREATED_GRAVEYARDS=()
}

transaction_retire_path() {
  local label="$1" live="$2" backup="$3"
  local parent base graveyard dest holder stamp attempt
  [[ "$TX_ACTIVE" = "1" ]] || { echo "FATAL: retire_path requires an active transaction" >&2; return 1; }
  if ! transaction_path_exists "$live"; then
    echo "retire: SKIP $label (nothing at $live)"
    return 0
  fi
  parent="$(dirname "$live")"; base="$(basename "$live")"
  graveyard="$parent/_deprecated"; dest="$graveyard/$base"
  transaction_assert_allowed_path target "$label retire source" "$live" || return $?
  transaction_assert_allowed_path target "$label retire target" "$dest" || return $?
  transaction_assert_allowed_path backup "$label retire backup" "$backup" || return $?
  transaction_claim_target "$live" || return $?
  if [[ ! -d "$graveyard" ]]; then
    mkdir "$graveyard" || return $?
    TX_CREATED_GRAVEYARDS[${#TX_CREATED_GRAVEYARDS[@]}]="$graveyard"
    printf '%s\n' "$graveyard" >> "$TX_BACKUP_ROOT/journal/created-parents"
  fi
  if transaction_path_exists "$dest"; then
    stamp="${TX_RETIRE_STAMP:-$(date -u +%Y%m%d-%H%M%S)}"
    dest="$graveyard/$base.$stamp"
    attempt=1
    while transaction_path_exists "$dest"; do
      dest="$graveyard/$base.$stamp-$attempt"; attempt=$((attempt + 1))
    done
  fi
  if transaction_path_exists "$dest"; then
    echo "FATAL: refusing to overwrite an already parked file: $dest" >&2
    return 1
  fi
  transaction_register "$label" "$live" "$backup" 1
  holder="$(mktemp -d "$parent/.kherep-retire-$base-XXXXXX")"
  TX_PENDING_OLD_HOLDER="$holder"
  TX_PENDING_OLD_TARGET="$live"
  TX_PENDING_OLD_ID="${TX_IDS[$((TX_COUNT - 1))]}"
  # Same order as transaction_install_path: the atomic sibling move first, then
  # the backup of that parked payload, never of a live path that may still move.
  mv "$live" "$holder/payload"
  transaction_backup_path "$holder/payload" "$backup"
  mv "$holder/payload" "$dest"
  rmdir "$holder"
  TX_PENDING_OLD_HOLDER=""; TX_PENDING_OLD_TARGET=""; TX_PENDING_OLD_ID=""
  echo "retire: $label -> $dest"
}
