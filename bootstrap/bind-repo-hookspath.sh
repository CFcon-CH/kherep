#!/usr/bin/env bash
# bind-repo-hookspath.sh  -  make the work-item rule bind for EVERY account
#
# Usage: bind-repo-hookspath.sh <workspace> <githooks-dir>
#
# A global core.hooksPath belongs to one account. Repository-local bindings
# ensure the same hook also applies when another account owns a worktree.
#
# A repository-LOCAL core.hooksPath lives inside the repo and is read by
# whichever account runs git there, so it binds per author with no elevation.
# It points at the same single hook file, so no hook COPIES exist to drift
# apart - only the pointer is repeated, and this script re-establishes it.
#
# Linked worktrees share their parent's config, so binding top-level repos
# covers them too.
#
# Advisory, exactly like record-install-source.mts: the caller guards it with
# `||` and it must never fail an install.
set -uo pipefail

# OP-755. Git speichert unter Windows nicht zwingend die Zeichenkette, die es
# bekommen hat: der Installer uebergibt die Git-Bash-Form /c/Users/..., gelesen
# wird danach die Laufwerksform C:/Users/.... Ein Vergleich auf exakte Gleichheit
# meldet deshalb JEDE Bindung als fehlgeschlagen, obwohl alle stehen - gemessen
# am 2026-08-12: 23 von 23 Repositories korrekt gebunden, Meldung "24 failed".
#
# Normalisiert wird nur, was plattformbedingt abweicht: Backslashes werden zu
# Schraegstrichen, und ein fuehrendes Laufwerk wird in die /c/-Form gebracht,
# wobei ausschliesslich der Laufwerksbuchstabe kleingeschrieben wird. Der Rest
# des Pfades bleibt unangetastet, weil macOS-Pfade case-sensitiv sind und ein
# pauschales Kleinschreiben dort ein Falsch-Positiv erzeugen wuerde.
norm_hookspath() {
  local v="${1//\\//}"
  case "$v" in
    [A-Za-z]:/*)
      local drive="${v%%:*}"
      v="/$(printf '%s' "$drive" | tr 'A-Z' 'a-z')/${v#*:/}"
      ;;
  esac
  printf '%s' "$v"
}

# install.sh sources this file for norm_hookspath alone (issue #23); only a
# direct run goes on to the self-test and the binding.
[[ "${BASH_SOURCE[0]}" = "$0" ]] || return 0

# Der Selbsttest steht VOR der Argumentpruefung: sonst faengt ihn die
# usage-Meldung ab, und ein Test, der nie laeuft, ist kein Test.
if [[ "${1:-}" = "--selftest" ]]; then
  fails=0
  check() {
    local got; got="$(norm_hookspath "$1")"
    if [[ "$got" = "$2" ]]; then echo "PASS  $1 -> $got"
    else echo "FAIL  $1 -> $got (erwartet $2)"; fails=$((fails + 1)); fi
  }
  check 'C:/Users/X/.claude/kherep/githooks' '/c/Users/X/.claude/kherep/githooks'
  check '/c/Users/X/.claude/kherep/githooks' '/c/Users/X/.claude/kherep/githooks'
  check 'C:\Users\X\.claude\kherep\githooks' '/c/Users/X/.claude/kherep/githooks'
  check '/Users/example/.claude/kherep/githooks' '/Users/example/.claude/kherep/githooks'
  check '/Users/ExampleUser/Mixed/Case' '/Users/ExampleUser/Mixed/Case'
  echo "selftest: $fails Fehler"
  [[ "$fails" -eq 0 ]] || exit 1
  exit 0
fi

WS="${1:-}"
GITHOOKS_DIR="${2:-}"

if [[ -z "$WS" ]] || [[ -z "$GITHOOKS_DIR" ]]; then
  echo "bind-repo-hookspath: usage: $0 <workspace> <githooks-dir>" >&2
  exit 2
fi
if [[ ! -d "$WS" ]]; then
  echo "bind-repo-hookspath: workspace '$WS' is not a directory, nothing bound" >&2
  exit 2
fi
if [[ ! -f "$GITHOOKS_DIR/commit-msg" ]]; then
  echo "bind-repo-hookspath: no commit-msg under '$GITHOOKS_DIR', refusing to point repos at an empty directory" >&2
  exit 2
fi

bound=0
skipped=0
failed=0

# -type d excludes linked worktrees, whose .git is a FILE. A .git without HEAD
# is not a repository: D:/Work/.git is exactly that, an empty directory
# that makes tools report "is a git repository" while git itself says no.
# Parked repositories under _deprecated are skipped, as the smoke test's
# coverage scan skips them (issue #99).
while IFS= read -r gitdir; do
  repo="$(dirname "$gitdir")"
  if [[ ! -e "$gitdir/HEAD" ]]; then
    echo "bind-repo-hookspath: SKIP $repo (.git without HEAD, not a repository)"
    skipped=$((skipped + 1))
    continue
  fi
  if git -C "$repo" config --local core.hooksPath "$GITHOOKS_DIR" 2>/dev/null &&
     [[ "$(norm_hookspath "$(git -C "$repo" config --local --get core.hooksPath 2>/dev/null)")" \
       = "$(norm_hookspath "$GITHOOKS_DIR")" ]]; then
    bound=$((bound + 1))
  else
    # Read back, never trust the write call: a repo owned by another account
    # refuses here, and that is exactly the case this whole file is about.
    echo "bind-repo-hookspath: FAILED $repo (not bound; commits by other accounts stay unenforced there)" >&2
    failed=$((failed + 1))
  fi
done < <(find "$WS" -maxdepth 4 -name _deprecated -prune -o -name '.git' -type d -print 2>/dev/null | sort)

echo "bind-repo-hookspath: $bound bound, $skipped skipped, $failed failed -> $GITHOOKS_DIR"
[[ "$failed" -eq 0 ]] || exit 1
exit 0
