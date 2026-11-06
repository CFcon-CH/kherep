#!/usr/bin/env bash
# Retirement pass for bootstrap/install.sh (OP-1136). Source me; do not execute.
#
# Reads bootstrap/manifest/retired.txt and hands every declared live path to
# transaction_retire_path, so a file the repo no longer manages is parked in a
# _deprecated/ sibling instead of surviving unmanaged and unwired. Own file so
# install.sh stays a readable sequence of phases rather than growing a loop.
#
# An entry is relative to the Claude home, unless it carries the project/ prefix
# that install.sh and drift-check.sh already use for workspace files: those map
# to the workspace (#33). Both kinds are parked the same way, inside the same
# transaction, with their backup under retired/<entry> in the install backup.
#
# A project/ entry is gated (#45): the workspace belongs to the operator, so a
# file is parked only while its content, with CRLF folded to LF, still hashes to
# one of the versions the installer placed. Anything else is kept in place and
# reported as KEEP, without backup or journal entry, and the install goes on.

# Prints the live path a validated retirement entry names. drift-check.sh uses
# the same mapping, so an entry the installer parks is the entry it reports.
bootstrap_retired_live_path() {
  local rel="$1" home="$2" ws="$3"
  case "$rel" in
    project/*) printf '%s\n' "$ws/${rel#project/}" ;;
    *) printf '%s\n' "$home/$rel" ;;
  esac
}

# Splits one manifest line into RETIRED_REL and RETIRED_HASHES (comma-separated,
# empty for a Claude-home entry). Returns 1 for a blank or comment line and 2 for
# an invalid one, so the whole manifest is refused before anything moves.
bootstrap_retired_parse_line() {
  local line="${1%$'\r'}" hashes=""
  RETIRED_REL=""; RETIRED_HASHES=""
  case "$line" in ''|'#'*) return 1 ;; esac
  RETIRED_REL="${line%% *}"
  kherep_validate_manifest_relative_path "retirement manifest entry" "$RETIRED_REL" || return 2
  [[ "$RETIRED_REL" = "$line" ]] || hashes="${line#* }"
  case "$RETIRED_REL" in
    project/*)
      if ! [[ "$hashes" =~ ^sha256:[0-9a-f]{64}(,[0-9a-f]{64})*$ ]]; then
        echo "FATAL: retirement manifest entry $RETIRED_REL needs 'sha256:<hex>[,<hex>...]' of every version the installer placed" >&2
        return 2
      fi
      RETIRED_HASHES="${hashes#sha256:}" ;;
    *)
      [[ -z "$hashes" ]] || {
        echo "FATAL: retirement manifest entry $RETIRED_REL is a Claude-home entry and takes no hashes" >&2; return 2;
      } ;;
  esac
}

# True when live is a regular file whose LF-folded SHA-256 is in the list.
bootstrap_retired_known_content() {
  local live="$1" hashes="$2" digest
  [[ -f "$live" ]] && [[ ! -L "$live" ]] || return 1
  digest="$(node -e '
    const text = require("node:fs").readFileSync(process.argv[1]).toString("latin1").replace(/\r\n/g, "\n");
    process.stdout.write(require("node:crypto").createHash("sha256").update(text, "latin1").digest("hex"));
  ' "$live")" || return 1
  case ",$hashes," in *",$digest,"*) return 0 ;; esac
  return 1
}

bootstrap_retire_declared() {
  local manifest="$1" home="$2" ws="$3" backup="$4" line rc i live
  local rels=() hashes=()
  [[ -f "$manifest" ]] || { echo "FATAL: retirement manifest missing: $manifest" >&2; return 1; }
  while IFS= read -r line || [[ -n "$line" ]]; do
    rc=0; bootstrap_retired_parse_line "$line" || rc=$?
    [[ "$rc" -ne 1 ]] || continue
    [[ "$rc" -eq 0 ]] || return "$rc"
    rels[${#rels[@]}]="$RETIRED_REL"; hashes[${#hashes[@]}]="$RETIRED_HASHES"
  done < "$manifest"
  for ((i=0; i<${#rels[@]}; i++)); do
    live="$(bootstrap_retired_live_path "${rels[$i]}" "$home" "$ws")"
    if [[ -n "${hashes[$i]}" ]] && { [[ -e "$live" ]] || [[ -L "$live" ]]; } &&
       ! bootstrap_retired_known_content "$live" "${hashes[$i]}"; then
      echo "retire: KEEP ${rels[$i]} (content not placed by the installer)"
      continue
    fi
    transaction_retire_path "${rels[$i]}" "$live" "$backup/retired/${rels[$i]}" || return $?
  done
}
