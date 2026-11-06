#!/usr/bin/env bash
# Exclusive bootstrap lock. A verified dead owner is quarantined, never deleted.

BOOTSTRAP_LOCK_DIR=""
BOOTSTRAP_LOCK_OWNER=""
BOOTSTRAP_LOCK_HELD=0

bootstrap_lock_acquire() {
  local lock="$1" owner pid token stale attempts=0
  [[ ! -L "$lock" ]] || { echo "FATAL: bootstrap lock path is a symlink: $lock" >&2; return 2; }
  while [[ "$attempts" -lt 4 ]]; do
    attempts=$((attempts + 1))
    if mkdir "$lock" 2>/dev/null; then
      token="$$-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM:-0}"
      owner="pid=$$\ntoken=$token"
      printf '%b\n' "$owner" > "$lock/owner"
      chmod 700 "$lock" 2>/dev/null || true
      chmod 600 "$lock/owner" 2>/dev/null || true
      BOOTSTRAP_LOCK_DIR="$lock"
      BOOTSTRAP_LOCK_OWNER="$(cat "$lock/owner")"
      BOOTSTRAP_LOCK_HELD=1
      return 0
    fi
    [[ ! -L "$lock" ]] && [[ -d "$lock" ]] || {
      echo "FATAL: bootstrap lock exists with an unsafe type: $lock" >&2; return 2;
    }
    [[ -f "$lock/owner" ]] || {
      echo "FATAL: bootstrap lock has no valid owner metadata; inspect manually: $lock" >&2; return 2;
    }
    owner="$(cat "$lock/owner")"
    pid="$(printf '%s\n' "$owner" | sed -n 's/^pid=\([0-9][0-9]*\)$/\1/p')"
    token="$(printf '%s\n' "$owner" | sed -n 's/^token=\(.*\)$/\1/p')"
    [[ -n "$pid" ]] && [[ -n "$token" ]] || {
      echo "FATAL: bootstrap lock owner metadata is invalid; inspect manually: $lock" >&2; return 2;
    }
    if kill -0 "$pid" 2>/dev/null; then
      echo "FATAL: bootstrap install already running (pid $pid): $lock" >&2
      return 3
    fi
    [[ "$(cat "$lock/owner" 2>/dev/null || true)" = "$owner" ]] || continue
    stale="$lock.stale-$pid-$(date -u +%Y%m%dT%H%M%SZ)-$$-$attempts"
    if mv "$lock" "$stale" 2>/dev/null; then
      echo "install: stale bootstrap lock quarantined -> $stale" >&2
      continue
    fi
  done
  echo "FATAL: bootstrap lock changed repeatedly; refusing concurrent install" >&2
  return 3
}

bootstrap_lock_release() {
  local current released
  [[ "$BOOTSTRAP_LOCK_HELD" = "1" ]] || return 0
  current="$(cat "$BOOTSTRAP_LOCK_DIR/owner" 2>/dev/null || true)"
  if [[ "$current" != "$BOOTSTRAP_LOCK_OWNER" ]]; then
    echo "ERROR: bootstrap lock ownership changed; refusing to remove it" >&2
    return 1
  fi
  released="$BOOTSTRAP_LOCK_DIR.released-$$-$(date -u +%Y%m%dT%H%M%SZ)-${RANDOM:-0}"
  case "$released" in "$BOOTSTRAP_LOCK_DIR".released-*) ;; *) return 1;; esac
  mv "$BOOTSTRAP_LOCK_DIR" "$released" || return 1
  BOOTSTRAP_LOCK_HELD=0
  BOOTSTRAP_LOCK_DIR=""; BOOTSTRAP_LOCK_OWNER=""
  rm -f "$released/owner" || return 1
  rmdir "$released" || return 1
}
