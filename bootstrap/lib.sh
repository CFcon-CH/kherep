#!/usr/bin/env bash
# Shared helpers for capture.sh / install.sh. Source me; do not execute.
set -euo pipefail

source "$(dirname "${BASH_SOURCE[0]}")/transaction.sh"

CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_SRC="$REPO_ROOT/claude"

# Rewrite machine-absolute paths -> portable ~ form, and the Kherep checkout
# back to its __KHEREP_REPO__ placeholder (render-profile-paths.mts). Idempotent.
# Uses a temp file (NOT sed -i) so it works on both GNU sed (Git Bash) and BSD sed (macOS).
portable_paths() {
  local f="$1" tmp
  tmp="$(mktemp)"
  node -e '
    const fs=require("fs");
    const [source,target,home,repo]=process.argv.slice(1);
    let text=fs.readFileSync(source,"utf8");
    const variants=(value)=>[value,value.replace(/\\/g,"/"),JSON.stringify(value).slice(1,-1)];
    for(const value of new Set(variants(repo)))if(value)text=text.split(value).join("__KHEREP_REPO__");
    // The renderer writes the Claude home as path.resolve gives it (render-profile-paths.mts),
    // on Windows with backslashes, so that form is folded too, and first.
    const homes=home?[...variants(require("path").resolve(home)),...variants(home)]:[];
    for(const value of new Set(homes))if(value)text=text.split(value).join("~/.claude");
    fs.writeFileSync(target,text);
  ' "$f" "$tmp" "$CLAUDE_HOME" "$REPO_ROOT" && mv "$tmp" "$f"
}

# Issue #436. The reverse of the intercom render (render-intercom.mts): this
# host's launcher command and example target back to __KHEREP_NODE__ and
# __KHEREP_EXAMPLE_TARGET__, so a captured file names neither the config root
# nor the node. A config root the command cannot quote fails the capture.
portable_intercom() {
  local f="$1" tmp
  tmp="$(mktemp)"
  node "$REPO_ROOT/bootstrap/render-profile.mts" intercom-capture "$f" "$tmp" && mv "$tmp" "$f"
}

# Copy a manifest entry (file or dir) from $2 root to $3 root, preserving rel path $1.
copy_entry() {
  local rel="$1" from="$2" to="$3"
  if [[ -d "$from/$rel" ]]; then
    mkdir -p "$to/$rel"
    cp -a "$from/$rel/." "$to/$rel/"
  elif [[ -f "$from/$rel" ]]; then
    mkdir -p "$to/$(dirname "$rel")"
    cp -a "$from/$rel" "$to/$rel"
  else
    echo "WARN: missing $from/$rel" >&2
  fi
}

# Install a file or closed managed directory through the active global
# transaction. Source and backup may be on other volumes; the live swap stays
# in the target parent.
install_path() {
  local label="$1" src="$2" target="$3" parked="$4"
  transaction_install_path "$label" "$src" "$target" "$parked"
}

# Install one explicit manifest entry. Closed managed directories prevent a
# source-deleted file from surviving, while unlisted top-level host extras are
# untouched.
install_entry() {
  local rel="$1" from="$2" to="$3" backup="$4"
  if declare -F kherep_validate_manifest_relative_path >/dev/null 2>&1; then
    kherep_validate_manifest_relative_path "managed install entry" "$rel" || return $?
  fi
  install_path "$rel" "$from/$rel" "$to/$rel" "$backup/$rel"
}

# Make a bash script prefer python3 then python (fresh Linux pods often lack `python`).
# Idempotent: only rewrites a bare `| python -c` invocation.
python_fallback() {
  local f="$1" tmp
  [[ -f "$f" ]] || return 0
  tmp="$(mktemp)"
  sed -e 's#| python -c#| "$(command -v python3 || command -v python)" -c#g' "$f" > "$tmp" && mv "$tmp" "$f"
}
