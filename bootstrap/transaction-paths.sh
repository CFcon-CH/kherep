#!/usr/bin/env bash
# Lexical containment and symlink-ancestry guards for bootstrap transactions.

transaction_validate_absolute_path() {
  local label="$1" value="$2"
  [[ -n "$value" ]] || { echo "FATAL: $label must not be empty" >&2; return 2; }
  case "$value" in
    /*) ;;
    *) echo "FATAL: $label must be an absolute path: $value" >&2; return 2 ;;
  esac
  case "$value" in
    /|*\\*|*/../*|*/..)
      echo "FATAL: $label is not a safe traversal-free path: $value" >&2
      return 2
      ;;
  esac
}

transaction_trim_root() {
  local value="$1"
  while [[ "${value%/}" != "$value" ]]; do value="${value%/}"; done
  printf '%s\n' "$value"
}

transaction_path_within_root() {
  local path="$1" root
  root="$(transaction_trim_root "$2")"
  [[ "$path" = "$root" ]] && return 0
  case "$path" in "$root"/*) return 0 ;; esac
  return 1
}

# Check every existing component below the configured root, excluding the leaf
# by default. Replacing a leaf symlink is safe; following an ancestor is not.
transaction_validate_path_under_root() {
  local label="$1" path="$2" root="$3" include_leaf="${4:-0}"
  local suffix component current last
  transaction_validate_absolute_path "$label" "$path" || return $?
  transaction_validate_absolute_path "$label root" "$root" || return $?
  root="$(transaction_trim_root "$root")"
  transaction_path_within_root "$path" "$root" || {
    echo "FATAL: $label escapes allowed root $root: $path" >&2; return 2;
  }
  [[ "$path" != "$root" ]] || {
    echo "FATAL: $label must not replace its allowed root: $path" >&2; return 2;
  }
  suffix="${path#"$root"}"; suffix="${suffix#/}"; current="$root"
  while [[ -n "$suffix" ]]; do
    component="${suffix%%/*}"
    if [[ "$component" = "$suffix" ]]; then suffix=""; last=1
    else suffix="${suffix#*/}"; last=0
    fi
    [[ -n "$component" ]] || continue
    current="${current%/}/$component"
    if [[ "$last" = "1" ]] && [[ "$include_leaf" != "1" ]]; then break; fi
    if [[ -L "$current" ]]; then
      echo "FATAL: $label has a symlink ancestor below $root: $current" >&2
      return 2
    fi
    if [[ "$last" = "0" ]] && transaction_path_exists "$current" && [[ ! -d "$current" ]]; then
      echo "FATAL: $label has a non-directory ancestor: $current" >&2
      return 2
    fi
  done
}

transaction_assert_allowed_path() {
  local kind="$1" label="$2" path="$3" roots_count i root
  if [[ "$kind" = "target" ]]; then roots_count="${#TX_ALLOWED_TARGET_ROOTS[@]}"
  else roots_count="${#TX_ALLOWED_BACKUP_ROOTS[@]}"
  fi
  for ((i=0; i<roots_count; i++)); do
    if [[ "$kind" = "target" ]]; then root="${TX_ALLOWED_TARGET_ROOTS[$i]}"
    else root="${TX_ALLOWED_BACKUP_ROOTS[$i]}"
    fi
    if transaction_path_within_root "$path" "$root"; then
      transaction_validate_path_under_root "$label" "$path" "$root" 0
      return $?
    fi
  done
  echo "FATAL: $label is outside every allowed $kind root: $path" >&2
  return 2
}

transaction_allowed_root_for() {
  local kind="$1" path="$2" roots_count i root
  if [[ "$kind" = "target" ]]; then roots_count="${#TX_ALLOWED_TARGET_ROOTS[@]}"
  else roots_count="${#TX_ALLOWED_BACKUP_ROOTS[@]}"
  fi
  for ((i=0; i<roots_count; i++)); do
    if [[ "$kind" = "target" ]]; then root="${TX_ALLOWED_TARGET_ROOTS[$i]}"
    else root="${TX_ALLOWED_BACKUP_ROOTS[$i]}"
    fi
    if transaction_path_within_root "$path" "$root"; then printf '%s\n' "$root"; return 0; fi
  done
  return 1
}

# Create live target parents one component at a time. Only directories actually
# created by this transaction are recorded, so rollback never removes a host
# directory that predates the install.
transaction_ensure_target_parent() {
  local label="$1" target="$2" parent root suffix component current
  parent="$(dirname "$target")"
  root="$(transaction_allowed_root_for target "$target")" || return 2
  [[ -d "$root" ]] || { echo "FATAL: configured target root does not exist: $root" >&2; return 2; }
  [[ "$parent" != "$root" ]] || return 0
  suffix="${parent#"$root"}"; suffix="${suffix#/}"; current="$root"
  while [[ -n "$suffix" ]]; do
    component="${suffix%%/*}"
    if [[ "$component" = "$suffix" ]]; then suffix=""; else suffix="${suffix#*/}"; fi
    [[ -n "$component" ]] || continue
    current="${current%/}/$component"
    if [[ -L "$current" ]]; then echo "FATAL: $label parent became a symlink: $current" >&2; return 2; fi
    if transaction_path_exists "$current"; then
      [[ -d "$current" ]] || { echo "FATAL: $label parent is not a directory: $current" >&2; return 2; }
      continue
    fi
    if mkdir "$current" 2>/dev/null; then
      TX_CREATED_PARENTS[${#TX_CREATED_PARENTS[@]}]="$current"
      printf '%s\n' "$current" >> "$TX_BACKUP_ROOT/journal/created-parents"
    elif [[ -d "$current" ]] && [[ ! -L "$current" ]]; then
      continue
    else
      echo "FATAL: cannot create managed parent: $current" >&2
      return 2
    fi
  done
}

transaction_cleanup_created_parents() {
  local i path ok=0
  for ((i=${#TX_CREATED_PARENTS[@]}-1; i>=0; i--)); do
    path="${TX_CREATED_PARENTS[$i]}"
    if [[ -L "$path" ]] || { transaction_path_exists "$path" && [[ ! -d "$path" ]]; }; then
      echo "ERROR: transaction-created parent changed type; preserving: $path" >&2; ok=1
    elif [[ -d "$path" ]] && ! rmdir "$path" 2>/dev/null; then
      echo "ERROR: transaction-created parent is no longer empty; preserving: $path" >&2; ok=1
    fi
  done
  TX_CREATED_PARENTS=()
  return "$ok"
}
