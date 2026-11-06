#!/usr/bin/env bash
# Reports the pages in the knowledge space that nothing links to. READ-ONLY: it
# counts, it does not stitch. The stitching verb writes to a live space, and an
# unattended writer triggered by a session start is a different risk class than
# an unattended reader - so the CHECK has a self-trigger and the CHANGE does not.
#
# Exit 0 = no orphans, exit 1 = orphans found, exit 2 = the check could not run.
# The third case matters: an orphan count that was never measured must not read
# like a clean space (golden rule 12).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$HERE/profile.sh"
CLAUDE_HOME="${CLAUDE_HOME:-$HOME/.claude}"
kherep_validate_shell_path CLAUDE_HOME "$CLAUDE_HOME" || exit $?
command -v node >/dev/null || { echo "FATAL: node required"; exit 2; }

BROKER="$HERE/../modules/atl-jira-brokers/atl-confluence-ccoder.mts"
[[ -f "$BROKER" ]] || { echo "FATAL: Confluence broker not found at $BROKER"; exit 2; }

# The space is a per-host value, written at install time. A host without it
# writes no observations, so it has no orphans to report either.
SPACE_FILE="$CLAUDE_HOME/kherep/confluence.json"
[[ -f "$SPACE_FILE" ]] || { echo "SKIP: no knowledge space configured on this host"; exit 0; }
# Every install writes `broker` into this file, the space keys only once the
# space step resolved (issue #13): a file without spaceKey is a host without a
# space. A file that cannot be read is a check that could not run.
SPACE_KEY="$(node -e 'const f=process.argv[1];let c;try{c=JSON.parse(require("fs").readFileSync(f,"utf8"))}catch{process.exit(3)}process.stdout.write(String((c&&c.spaceKey)||""))' "$SPACE_FILE")" ||
  { echo "FATAL: $SPACE_FILE could not be read"; exit 2; }
[[ -n "$SPACE_KEY" ]] || { echo "SKIP: no knowledge space configured on this host"; exit 0; }

REPORT_DIR="$CLAUDE_HOME/.cache/orphan-check"
REPORT="$REPORT_DIR/last-report.txt"
mkdir -p "$REPORT_DIR" 2>/dev/null || true

# Staged and renamed only once the run finished, so a reader during a run keeps
# seeing the previous COMPLETE report instead of a half-written one.
TMP="$(mktemp "$REPORT_DIR/.last-report.XXXXXX" 2>/dev/null || echo "")"
[[ -n "$TMP" ]] || TMP="$(mktemp)"

{
  echo "space: $SPACE_KEY"
  echo "started: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  node "$BROKER" orphans --space "$SPACE_KEY" 2>&1
  status=$?
  echo "exit: $status"
} > "$TMP"
status="$(sed -n 's/^exit: //p' "$TMP" | tail -1)"

count="$(sed -n 's/^count: //p' "$TMP" | tail -1)"
if [[ "${status:-2}" != "0" ]] || [[ -z "$count" ]]; then
  echo "UNMEASURED" >> "$TMP"
  cat "$TMP"
  mv -f "$TMP" "$REPORT" 2>/dev/null || rm -f "$TMP"
  exit 2
fi

cat "$TMP"
mv -f "$TMP" "$REPORT" 2>/dev/null || rm -f "$TMP"
# A string compare: -eq inside [[ ]] evaluates as arithmetic, so a non-numeric
# count would read as 0 and report a clean space.
[[ "$count" == "0" ]] && exit 0
exit 1
