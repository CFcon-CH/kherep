#!/usr/bin/env bash
# Transaction/failure tests. All paths are below one throwaway root.
set -Eeuo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"; ORIGINAL_PATH="$PATH"
trap 'rm -rf "$TMP"' EXIT
fail() { echo "TRANSACTION TEST FAIL: $*" >&2; exit 1; }
same() { cmp "$1" "$2" >/dev/null || fail "bytes differ: $1"; }

# Issue #23. install.sh writes core.hooksPath at the global scope, and at the
# system scope on an opt-in. Whatever the caller's environment, every run here
# writes both scopes to throwaway files and sees no inherited KHEREP_* (host
# workspace, credential files, install switches). The host's real values, read
# through the caller's own environment, must be byte-identical afterwards.
HOST_GIT_ENV=(HOME="$HOME")
[[ -z "${GIT_CONFIG_SYSTEM+x}" ]] || HOST_GIT_ENV+=("GIT_CONFIG_SYSTEM=$GIT_CONFIG_SYSTEM")
[[ -z "${GIT_CONFIG_GLOBAL+x}" ]] || HOST_GIT_ENV+=("GIT_CONFIG_GLOBAL=$GIT_CONFIG_GLOBAL")
host_hooks_paths() {
  local scope
  for scope in system global; do
    printf '%s=' "$scope"
    env -u GIT_CONFIG_SYSTEM -u GIT_CONFIG_GLOBAL "${HOST_GIT_ENV[@]}" \
      git config "--$scope" --get core.hooksPath || echo "<exit $?>"
  done
}
host_hooks_paths > "$TMP/host-hooks-path.before"
# Native git on Windows needs the drive form of the throwaway path.
git_config_dir="$TMP"; ! command -v cygpath >/dev/null 2>&1 || git_config_dir="$(cygpath -m "$TMP")"
export GIT_CONFIG_SYSTEM="$git_config_dir/gitconfig-system" GIT_CONFIG_GLOBAL="$git_config_dir/gitconfig-global"
unset $(compgen -e | grep '^KHEREP_' || true)

latest() {
  local dirs=("$1"/.claude/backups/bootstrap/install-*) last
  last="${dirs[${#dirs[@]}-1]}"
  [[ -d "$last" ]] || return 1
  printf '%s\n' "$last"
}

make_dir_symlink() {
  local target="$1" link="$2" link_win target_win
  ln -s "$target" "$link" 2>/dev/null || true
  [[ -L "$link" ]] && return 0
  rm -rf -- "$link"
  if command -v node >/dev/null 2>&1 && command -v cygpath >/dev/null 2>&1; then
    link_win="$(cygpath -w "$link")"; target_win="$(cygpath -w "$target")"
    LINK_PATH="$link_win" TARGET_PATH="$target_win" node -e \
      'require("node:fs").symlinkSync(process.env.TARGET_PATH, process.env.LINK_PATH, "junction")' \
      >/dev/null 2>&1 || true
  fi
  [[ -L "$link" ]] || fail "cannot create a real directory symlink/junction for path tests"
}

fixture() {
  ROOT="$TMP/$1"; H="$ROOT/home"; C="$H/.claude"; W="$ROOT/workspace"; R="$ROOT/credentials"
  mkdir -p "$C/hooks" "$W/.claude" "$R"
  printf '{}\n' > "$C/settings.json"; printf '{}\n' > "$W/.claude/settings.local.json"
  printf old-statusline > "$C/statusline-command.sh"; cp "$C/statusline-command.sh" "$ROOT/status.before"
  printf old-guard > "$C/hooks/commit-guard.mts"; cp "$C/hooks/commit-guard.mts" "$ROOT/guard.before"
}
install_files() {
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh"
}

# Cross-root contract: a fake mv rejects live<->backup moves. Backup copying,
# sibling live swaps, reverse restore, and an originally absent target must pass.
test_library() {
  local live="$TMP/lib/root-d/live" backup="$TMP/lib/root-c/backup" src="$TMP/lib/src" fake="$TMP/lib/bin" real_mv real_cp real_rm rc
  mkdir -p "$live" "$backup" "$src" "$fake"; printf old > "$live/file"; printf new > "$src/file"
  real_mv="$(command -v mv)"; real_cp="$(command -v cp)"; real_rm="$(command -v rm)"
  cat > "$fake/mv" <<'SH'
#!/usr/bin/env bash
if [ "${FAIL_LIVE_MOVE:-0}" = 1 ] && [[ "$1" == "$LIVE_ROOT/"* ]]; then
  [ -z "${LIVE_MOVE_MARKER:-}" ] || : > "$LIVE_MOVE_MARKER"
  exit 90
fi
if [[ "$1" == "$LIVE_ROOT/"* && "$2" == "$BACKUP_ROOT/"* ]] || [[ "$2" == "$LIVE_ROOT/"* && "$1" == "$BACKUP_ROOT/"* ]]; then exit 88; fi
exec "$REAL_MV" "$@"
SH
  cat > "$fake/cp" <<'SH'
#!/usr/bin/env bash
if [ "${FAIL_RESTORE_COPY:-0}" = 1 ]; then
  case "$3" in */.kherep-restore-*/payload) [ -z "${RESTORE_COPY_MARKER:-}" ] || : > "$RESTORE_COPY_MARKER"; exit 28;; esac
fi
if [ "${EXPECT_HOLDER_BACKUP:-0}" = 1 ]; then
  case "$3" in */.kherep-backup-*/payload)
    case "$2" in */.kherep-previous-*/payload) ;; *) exit 89;; esac
  esac
fi
exec "$REAL_CP" "$@"
SH
  cat > "$fake/rm" <<'SH'
#!/usr/bin/env bash
last="${!#}"
if [ "${FAIL_FAILED_HOLDER_REMOVE:-0}" = 1 ]; then
  case "$last" in */.kherep-failed-*) [ -z "${FAILED_REMOVE_MARKER:-}" ] || : > "$FAILED_REMOVE_MARKER"; exit 13;; esac
fi
exec "$REAL_RM" "$@"
SH
  chmod +x "$fake/mv" "$fake/cp" "$fake/rm"
  export PATH="$fake:$ORIGINAL_PATH" REAL_MV="$real_mv" REAL_CP="$real_cp" REAL_RM="$real_rm" LIVE_ROOT="$live" BACKUP_ROOT="$backup"
  export HOME="$TMP/lib/home" CLAUDE_HOME="$TMP/lib/claude"; source "$HERE/lib.sh"
  transaction_begin "$backup/one" "$live"
  export EXPECT_HOLDER_BACKUP=1; install_path one "$src/file" "$live/file" "$backup/one/original"; unset EXPECT_HOLDER_BACKUP
  [[ "$(cat "$backup/one/original")" = "old" ]] || fail "backup not complete before mutation"
  transaction_rollback test; [[ "$(cat "$live/file")" = "old" ]] || fail "existing target not restored"
  [[ "$(cat "$backup/one/failed/000000")" = "new" ]] || fail "failed target not parked"

  mkdir "$src/identical" "$live/identical"; printf same > "$src/identical/SKILL.md"; cp "$src/identical/SKILL.md" "$live/identical/SKILL.md"
  transaction_begin "$backup/identical" "$live"
  FAIL_LIVE_MOVE=1 LIVE_MOVE_MARKER="$TMP/lib/live-move-attempted" install_path identical "$src/identical" "$live/identical" "$backup/identical/original"
  [[ ! -e "$TMP/lib/live-move-attempted" ]] || fail "identical directory reached live rename"
  [[ "$TX_COUNT" -eq 0 ]] && [[ ! -e "$backup/identical/original" ]] || fail "identical directory was journaled or backed up"
  printf changed > "$src/identical/SKILL.md"
  set +e; install_path duplicate "$src/identical" "$live/identical" "$backup/identical/duplicate" >/dev/null 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] && [[ "$(cat "$live/identical/SKILL.md")" = "same" ]] || fail "equal-first duplicate target was accepted"
  transaction_rollback test

  mkdir "$src/different" "$live/different"; printf new > "$src/different/SKILL.md"; printf old > "$live/different/SKILL.md"; printf extra > "$live/different/extra"
  transaction_begin "$backup/different" "$live"
  install_path different "$src/different" "$live/different" "$backup/different/original"
  [[ "$(cat "$live/different/SKILL.md")" = "new" ]] && [[ ! -e "$live/different/extra" ]] || fail "different directory did not use normal replacement"
  [[ "$(cat "$backup/different/original/SKILL.md")" = "old" ]] && [[ -e "$backup/different/original/extra" ]] || fail "different directory backup incomplete"
  transaction_rollback test
  transaction_begin "$backup/two" "$live"; install_path two "$src/file" "$live/absent" "$backup/two/original"
  transaction_rollback test; [[ ! -e "$live/absent" ]] || fail "absent target survived rollback"

  transaction_begin "$backup/parents" "$live"
  install_path parents "$src/file" "$live/new-parent/nested/file" "$backup/parents/original"
  transaction_rollback test
  [[ ! -e "$live/new-parent" ]] || fail "transaction-created live parents survived rollback"

  # A failed in-flight swap retains the exact same-filesystem original and
  # restores it directly, without needing another possibly ENOSPC copy.
  printf old-inflight > "$live/inflight"
  transaction_begin "$backup/three" "$live"
  set +e; KHEREP_BOOTSTRAP_TEST_FAIL_SWAP_LABEL=inflight install_path inflight "$src/file" "$live/inflight" "$backup/three/original"; rc=$?; set -e
  [[ "$rc" -eq 96 ]] || fail "in-flight swap injection did not fire"
  FAIL_RESTORE_COPY=1 RESTORE_COPY_MARKER="$TMP/lib/restore-copy-attempted" transaction_rollback test
  [[ "$(cat "$live/inflight")" = "old-inflight" ]] || fail "in-flight original was not restored directly"
  [[ ! -e "$TMP/lib/restore-copy-attempted" ]] || fail "in-flight rollback unnecessarily copied backup"

  # If a completed entry really needs a backup copy and that copy fails, live
  # remains present, the original backup survives, and recovery is explicit.
  printf old-diskfull > "$live/diskfull"
  transaction_begin "$backup/four" "$live"; install_path diskfull "$src/file" "$live/diskfull" "$backup/four/original"
  set +e; FAIL_RESTORE_COPY=1 RESTORE_COPY_MARKER="$TMP/lib/restore-copy-failed" transaction_rollback test; rc=$?; set -e
  [[ "$rc" -ne 0 ]] && [[ -e "$TMP/lib/restore-copy-failed" ]] || fail "restore-copy failure was not exercised"
  [[ "$(cat "$live/diskfull")" = "new" ]] || fail "restore-copy failure left live target missing"
  [[ "$(cat "$backup/four/original")" = "old-diskfull" ]] || fail "restore-copy failure lost original backup"
  [[ -f "$backup/four/ROLLBACK-INCOMPLETE" ]] || fail "restore-copy failure lacks incomplete marker"

  printf old-remove > "$live/remove-fail"
  transaction_begin "$backup/remove-fail" "$live"; install_path remove-fail "$src/file" "$live/remove-fail" "$backup/remove-fail/original"
  set +e; FAIL_FAILED_HOLDER_REMOVE=1 FAILED_REMOVE_MARKER="$TMP/lib/remove-failed" transaction_rollback test; rc=$?; set -e
  [[ "$rc" -ne 0 ]] && [[ -e "$TMP/lib/remove-failed" ]] || fail "failed-holder removal error was swallowed"
  [[ -f "$backup/remove-fail/ROLLBACK-INCOMPLETE" ]] || fail "holder removal failure lacks incomplete marker"
  [[ "$(cat "$live/remove-fail")" = "old-remove" ]] || fail "holder removal failure lost restored original"
  PATH="$ORIGINAL_PATH"; unset REAL_MV REAL_CP REAL_RM LIVE_ROOT BACKUP_ROOT
}

# OP-1136. Retirement parks a live file the repo no longer manages. It is never
# a delete (Golden Rule 1): the file moves into a _deprecated/ sibling, its exact
# prior version is copied into the install backup, and rollback puts it back at
# the original path. A rolled-back retirement leaves the parked copy where it is;
# the dated suffix is what keeps the next run from overwriting it.
test_retire() {
  local live="$TMP/retire/live" backup="$TMP/retire/backup" out rc
  local crowded="$TMP/retire/crowded" stamp=19700101-000000 parked
  mkdir -p "$live/hooks" "$backup"
  printf orphan > "$live/hooks/em-dash-watch.js"

  transaction_begin "$backup/one" "$live"
  transaction_retire_path hooks/em-dash-watch.js "$live/hooks/em-dash-watch.js"     "$backup/one/retired/hooks/em-dash-watch.js" > /dev/null
  [[ ! -e "$live/hooks/em-dash-watch.js" ]] || fail "retired file stayed at its live path"
  [[ "$(cat "$live/hooks/_deprecated/em-dash-watch.js")" = "orphan" ]] || fail "retired file was not parked in _deprecated"
  [[ "$(cat "$backup/one/retired/hooks/em-dash-watch.js")" = "orphan" ]] || fail "retired file was not backed up"
  transaction_rollback test
  [[ "$(cat "$live/hooks/em-dash-watch.js")" = "orphan" ]] || fail "rollback did not restore the retired file"
  [[ -f "$backup/one/ROLLED-BACK" ]] && [[ "$(cat "$live/hooks/_deprecated/em-dash-watch.js")" = "orphan" ]] ||
    fail "a created graveyard that holds the parked copy broke the rollback or lost the copy"

  transaction_begin "$backup/two" "$live"
  out="$(transaction_retire_path hooks/gone.js "$live/hooks/gone.js" "$backup/two/retired/hooks/gone.js")"
  case "$out" in *SKIP*) ;; *) fail "an absent retirement target did not report SKIP: $out" ;; esac
  [[ "$TX_COUNT" -eq 0 ]] || fail "an absent retirement target was journalled"
  [[ ! -e "$backup/two/retired/hooks/gone.js" ]] || fail "an absent retirement target produced a backup"
  transaction_rollback test

  printf second > "$live/hooks/em-dash-watch.js"
  transaction_begin "$backup/three" "$live"
  transaction_retire_path hooks/em-dash-watch.js "$live/hooks/em-dash-watch.js"     "$backup/three/retired/hooks/em-dash-watch.js" > /dev/null
  [[ "$(cat "$live/hooks/_deprecated/em-dash-watch.js")" = "orphan" ]] || fail "an already parked file was overwritten"
  compgen -G "$live/hooks/_deprecated/em-dash-watch.js.*" > /dev/null || fail "the second retirement got no dated sibling"
  [[ "$(cat "$live/hooks/_deprecated/em-dash-watch.js".*)" = "second" ]] || fail "the dated sibling holds the wrong bytes"
  transaction_commit

  # A third retirement inside the same second: both the plain destination and the
  # dated candidate are taken. The suffix has to count up instead of aborting the
  # install. TX_RETIRE_STAMP pins the stamp so the collision is deterministic.
  parked="$crowded/hooks/_deprecated/em-dash-watch.js"
  mkdir -p "$crowded/hooks/_deprecated"
  printf first > "$parked"; printf dated > "$parked.$stamp"
  printf third > "$crowded/hooks/em-dash-watch.js"
  cp "$crowded/hooks/em-dash-watch.js" "$TMP/retire/third.before"
  transaction_begin "$backup/four" "$crowded"
  TX_RETIRE_STAMP="$stamp" transaction_retire_path hooks/em-dash-watch.js "$crowded/hooks/em-dash-watch.js"     "$backup/four/retired/hooks/em-dash-watch.js" > /dev/null
  unset TX_RETIRE_STAMP
  [[ "$(cat "$parked")" = "first" ]] || fail "a same-second collision overwrote the parked file"
  [[ "$(cat "$parked.$stamp")" = "dated" ]] || fail "a same-second collision overwrote the dated sibling"
  [[ -e "$parked.$stamp-1" ]] || fail "a same-second collision got no counted sibling"
  same "$parked.$stamp-1" "$TMP/retire/third.before"
  transaction_commit

  # #45. The graveyard a retirement creates is journalled. A retirement that
  # fails before its file lands there (here: a backup that already exists) is
  # rolled back through the same EXIT path install.sh uses, and the rollback
  # removes the now empty _deprecated/ it created. The first case above already
  # shows that one holding a parked copy stays and still rolls back cleanly.
  mkdir -p "$TMP/retire/fresh/tools/x" "$backup/five/retired/tools/x"
  printf fresh > "$TMP/retire/fresh/tools/x/tool.ps1"; printf taken > "$backup/five/retired/tools/x/tool.ps1"
  set +e
  (
    set -e; trap 'transaction_rollback injected > /dev/null 2>&1' EXIT
    transaction_begin "$backup/five" "$TMP/retire/fresh"
    transaction_retire_path tools/x/tool.ps1 "$TMP/retire/fresh/tools/x/tool.ps1" "$backup/five/retired/tools/x/tool.ps1"
  ) > "$TMP/retire/five.log" 2>&1; rc=$?
  set -e
  [[ "$rc" -ne 0 ]] || fail "a retirement over an existing backup did not fail"
  [[ "$(cat "$TMP/retire/fresh/tools/x/tool.ps1")" = "fresh" ]] || fail "rollback did not restore the half-retired file"
  grep -qxF "$TMP/retire/fresh/tools/x/_deprecated" "$backup/five/journal/created-parents" ||
    fail "the created graveyard was not journalled"
  [[ -f "$backup/five/ROLLED-BACK" ]] || fail "the rollback after a failed retirement was not clean"
  [[ ! -e "$TMP/retire/fresh/tools/x/_deprecated" ]] || fail "rollback left the empty graveyard it created"

  # #897. An entry may name a directory (skills/kherep-twg, kherep/twg). It is
  # parked whole, backed up whole and restored whole by a rollback. A sibling
  # symlink with a similar name (a vendor skills/twg-jira) is left untouched.
  local dir="$TMP/retire/dir" vendor="$TMP/retire/vendor/twg-jira"
  mkdir -p "$dir/skills/kherep-twg/references" "$vendor"
  printf wrapper-skill > "$dir/skills/kherep-twg/SKILL.md"; printf ref > "$dir/skills/kherep-twg/references/a.md"
  printf vendor-skill > "$vendor/SKILL.md"
  make_dir_symlink "$vendor" "$dir/skills/twg-jira"
  transaction_begin "$backup/six" "$dir"
  transaction_retire_path skills/kherep-twg "$dir/skills/kherep-twg" "$backup/six/retired/skills/kherep-twg" > /dev/null
  [[ ! -e "$dir/skills/kherep-twg" ]] || fail "a retired directory stayed at its live path"
  [[ "$(cat "$dir/skills/_deprecated/kherep-twg/SKILL.md")" = "wrapper-skill" ]] &&
    [[ "$(cat "$dir/skills/_deprecated/kherep-twg/references/a.md")" = "ref" ]] || fail "a retired directory was not parked whole"
  [[ "$(cat "$backup/six/retired/skills/kherep-twg/SKILL.md")" = "wrapper-skill" ]] &&
    [[ "$(cat "$backup/six/retired/skills/kherep-twg/references/a.md")" = "ref" ]] || fail "a retired directory was not backed up whole"
  [[ -L "$dir/skills/twg-jira" ]] && [[ "$(cat "$dir/skills/twg-jira/SKILL.md")" = "vendor-skill" ]] ||
    fail "retiring a directory touched a sibling symlink"
  transaction_rollback test > /dev/null
  [[ "$(cat "$dir/skills/kherep-twg/SKILL.md")" = "wrapper-skill" ]] &&
    [[ "$(cat "$dir/skills/kherep-twg/references/a.md")" = "ref" ]] || fail "rollback did not restore the retired directory"
  [[ -L "$dir/skills/twg-jira" ]] && [[ "$(cat "$vendor/SKILL.md")" = "vendor-skill" ]] ||
    fail "the rollback of a directory retirement touched a sibling symlink"
}

# #33, #45. retired.txt also names workspace files with the project/ prefix. The
# declared pass maps them to the workspace, parks them like a Claude-home entry
# with the backup under retired/project/..., skips an entry that is absent and
# restores the parked file on rollback. A project/ entry is parked only while
# its content, CRLF folded to LF, matches one of its listed hashes; anything
# else is kept with one KEEP line, without backup or journal entry. A traversing
# entry, and a project/ entry without hashes, are refused before anything moves.
sha256_lf() { if command -v sha256sum >/dev/null 2>&1; then sha256sum; else shasum -a 256; fi | cut -d' ' -f1; }
test_retire_declared() {
  local root="$TMP/retire-declared" home ws backup manifest rc known other keep
  home="$root/home/.claude"; ws="$root/workspace"; backup="$root/backup"; manifest="$root/retired.txt"
  mkdir -p "$home/hooks" "$ws/tools/mpac" "$ws/tools/edited" "$backup"
  printf home-orphan > "$home/hooks/em-dash-watch.js"
  printf 'ws-known\r\n' > "$ws/tools/mpac/mpac.ps1"; cp "$ws/tools/mpac/mpac.ps1" "$root/known.before"
  printf 'operator edit\n' > "$ws/tools/edited/tool.ps1"
  known="$(printf 'ws-known\n' | sha256_lf)"; other="$(printf 'another placed version\n' | sha256_lf)"
  keep='retire: KEEP project/tools/edited/tool.ps1 (content not placed by the installer)'
  printf '%s\n' '# comment' hooks/em-dash-watch.js "project/tools/edited/tool.ps1 sha256:$known,$other" \
    "project/tools/mpac/README.md sha256:$known" "project/tools/mpac/mpac.ps1 sha256:$other,$known" > "$manifest"
  (
    KHEREP_PROFILE=win; source "$HERE/profile.sh"; source "$HERE/install-retired.sh"
    transaction_begin "$backup/one" "$home" "$ws"
    bootstrap_retire_declared "$manifest" "$home" "$ws" "$backup/one" > "$root/out" ||
      fail "the declared retirement pass failed"
    [[ ! -e "$ws/tools/mpac/mpac.ps1" ]] || fail "a retired workspace file stayed at its live path"
    same "$ws/tools/mpac/_deprecated/mpac.ps1" "$root/known.before"
    same "$backup/one/retired/project/tools/mpac/mpac.ps1" "$root/known.before"
    [[ ! -e "$home/project" ]] || fail "a project/ entry was resolved against the Claude home"
    [[ "$(cat "$home/hooks/_deprecated/em-dash-watch.js")" = "home-orphan" ]] || fail "the Claude-home entry was not parked"
    grep -qF "retire: SKIP project/tools/mpac/README.md" "$root/out" || fail "an absent workspace entry did not report SKIP"
    [[ ! -e "$ws/tools/mpac/_deprecated/README.md" ]] && [[ ! -e "$backup/one/retired/project/tools/mpac/README.md" ]] ||
      fail "an absent workspace entry was parked or backed up"
    [[ "$(grep -c 'retire: KEEP' "$root/out")" -eq 1 ]] && grep -qxF "$keep" "$root/out" ||
      fail "unknown workspace content did not produce exactly one KEEP line: $(cat "$root/out")"
    [[ "$(cat "$ws/tools/edited/tool.ps1")" = 'operator edit' ]] && [[ ! -e "$ws/tools/edited/_deprecated" ]] ||
      fail "unknown workspace content was moved"
    [[ ! -e "$backup/one/retired/project/tools/edited" ]] || fail "unknown workspace content was backed up"
    ! grep -rqF "tools/edited" "$backup/one/journal" || fail "unknown workspace content was journalled"
    [[ "$TX_COUNT" -eq 2 ]] || fail "expected two journalled retirements, got $TX_COUNT"
    transaction_rollback test > /dev/null
    same "$ws/tools/mpac/mpac.ps1" "$root/known.before"
    [[ "$(cat "$home/hooks/em-dash-watch.js")" = "home-orphan" ]] || fail "rollback did not restore the retired Claude-home file"

    printf '%s\n' hooks/em-dash-watch.js project/tools/mpac/mpac.ps1 > "$manifest"
    transaction_begin "$backup/unhashed" "$home" "$ws"
    set +e; bootstrap_retire_declared "$manifest" "$home" "$ws" "$backup/unhashed" > "$root/unhashed.log" 2>&1; rc=$?; set -e
    [[ "$rc" -ne 0 ]] || fail "a project/ entry without hashes was accepted"
    grep -qF "FATAL: retirement manifest entry project/tools/mpac/mpac.ps1 needs 'sha256:" "$root/unhashed.log" ||
      fail "a project/ entry without hashes was not refused clearly: $(cat "$root/unhashed.log")"
    [[ "$TX_COUNT" -eq 0 ]] && [[ "$(cat "$home/hooks/em-dash-watch.js")" = "home-orphan" ]] ||
      fail "a manifest with an unhashed project/ entry moved a file before it was refused"
    transaction_rollback test > /dev/null

    printf '%s\n' 'project/../escape' > "$manifest"
    printf outside > "$root/escape"
    transaction_begin "$backup/two" "$home" "$ws"
    set +e; bootstrap_retire_declared "$manifest" "$home" "$ws" "$backup/two" > "$root/escape.log" 2>&1; rc=$?; set -e
    [[ "$rc" -ne 0 ]] || fail "a traversing project/ entry was accepted"
    grep -qF "retirement manifest entry must be a strict traversal-free relative path" "$root/escape.log" ||
      fail "a traversing project/ entry passed the manifest path gate: $(cat "$root/escape.log")"
    [[ "$(cat "$root/escape")" = "outside" ]] && [[ "$TX_COUNT" -eq 0 ]] || fail "a traversing project/ entry moved a file"
    transaction_rollback test > /dev/null
  )
}

test_lock() {
  local lock="$TMP/lock/bootstrap.lock" rc stale
  mkdir -p "$(dirname "$lock")"
  source "$HERE/install-lock.sh"
  bootstrap_lock_acquire "$lock"
  set +e; ( source "$HERE/install-lock.sh"; bootstrap_lock_acquire "$lock" ) >/dev/null 2>&1; rc=$?; set -e
  [[ "$rc" -eq 3 ]] || fail "concurrent bootstrap lock did not report an active owner (rc=$rc)"
  bootstrap_lock_release
  [[ ! -e "$lock" ]] || fail "released bootstrap lock still blocks acquisition"
  mkdir "$lock"; printf '%s\n' 'pid=999999' 'token=dead-owner' > "$lock/owner"
  bootstrap_lock_acquire "$lock"
  stale=("$lock".stale-999999-*)
  [[ -d "${stale[0]}" ]] || fail "dead bootstrap lock was not quarantined"
  bootstrap_lock_release
  [[ ! -e "$lock" ]] || fail "recovered bootstrap lock was not released"
}

test_preflights() {
  local rc
  fixture preflight
  set +e
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=mac KHEREP_WORKSPACE='D:\Work' KHEREP_CREDENTIALS_ROOT="$R" \
    SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" >/dev/null 2>&1; rc=$?
  set -e
  [[ "$rc" -ne 0 ]] && [[ ! -d "$C/backups" ]] || fail "invalid Mac path mutated bootstrap state"
  printf '{bad-json\n' > "$C/settings.json"
  set +e; install_files >/dev/null 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "malformed settings passed preflight"
  same "$C/statusline-command.sh" "$ROOT/status.before"
}

test_path_guards() {
  local rc outside before src b target

  # Root and manifest gates are lexical and run before bootstrap state exists.
  (
    KHEREP_PROFILE=win; source "$HERE/profile.sh"
    ! kherep_validate_shell_path TEST_ROOT / >/dev/null 2>&1
    ! kherep_validate_shell_path TEST_PARENT /safe/../escape >/dev/null 2>&1
    ! kherep_validate_shell_path TEST_BACKSLASH 'D:\escape' >/dev/null 2>&1
    ! kherep_validate_manifest_relative_path TEST_MANIFEST '../outside' >/dev/null 2>&1
    kherep_validate_manifest_relative_path TEST_MANIFEST 'hooks/lib/guard.js' >/dev/null
  ) || fail "root or manifest lexical path gate regressed"

  fixture containment; outside="$ROOT/outside"; src="$ROOT/src"; mkdir -p "$outside" "$src"
  printf outside-sentinel > "$outside/sentinel"; cp "$outside/sentinel" "$ROOT/outside.before"
  printf managed > "$src/file"
  transaction_begin "$ROOT/backup-one" "$C"
  set +e; install_path escape "$src/file" "$outside/sentinel" "$ROOT/backup-one/original" >/dev/null 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "target outside allowed root was accepted"
  transaction_rollback containment >/dev/null 2>&1 || true
  same "$outside/sentinel" "$ROOT/outside.before"
  cp "$outside/sentinel" "$src/equal"
  transaction_begin "$ROOT/backup-equal-escape" "$C"
  set +e; install_path equal-escape "$src/equal" "$outside/sentinel" "$ROOT/backup-equal-escape/original" >/dev/null 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "byte-identical target outside allowed root was accepted"
  transaction_rollback containment >/dev/null 2>&1 || true
  same "$outside/sentinel" "$ROOT/outside.before"
  transaction_begin "$ROOT/backup-two" "$C"
  set +e; install_path backup-escape "$src/file" "$C/contained" "$outside/backup" >/dev/null 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "backup outside allowed root was accepted"
  transaction_rollback containment >/dev/null 2>&1 || true
  same "$outside/sentinel" "$ROOT/outside.before"; [[ ! -e "$outside/backup" ]] || fail "outside backup was created"

  for target in hooks hooks-lib workspace-dot-claude local-inference; do
    fixture "symlink-$target"; outside="$ROOT/outside"; before="$ROOT/outside.before"
    mkdir -p "$outside"; printf "outside-$target" > "$outside/sentinel"; cp "$outside/sentinel" "$before"
    case "$target" in
      hooks) rm -rf -- "$C/hooks"; make_dir_symlink "$outside" "$C/hooks" ;;
      hooks-lib) mkdir -p "$C/hooks"; make_dir_symlink "$outside" "$C/hooks/lib" ;;
      workspace-dot-claude) rm -rf -- "$W/.claude"; make_dir_symlink "$outside" "$W/.claude" ;;
      local-inference) mkdir -p "$C/kherep"; make_dir_symlink "$outside" "$C/kherep/local-inference" ;;
    esac
    set +e; install_files > "$ROOT/log" 2>&1; rc=$?; set -e
    [[ "$rc" -ne 0 ]] || fail "symlink ancestor passed preflight: $target"
    same "$outside/sentinel" "$before"
    [[ ! -d "$C/backups" ]] || fail "symlink preflight created bootstrap state: $target"
  done
}

test_partial() {
  local rc b
  fixture partial
  set +e; KHEREP_BOOTSTRAP_TEST_FAIL_AFTER_LABEL='hooks/deploy-guard.mts' install_files > "$ROOT/log" 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "partial failure returned success"
  same "$C/statusline-command.sh" "$ROOT/status.before"; same "$C/hooks/commit-guard.mts" "$ROOT/guard.before"
  [[ ! -e "$C/hooks/deploy-guard.mts" ]] || fail "new target survived partial rollback"
  b="$(latest "$H")"; [[ -f "$b/ROLLED-BACK" ]] || fail "partial rollback marker missing"
}

test_term() {
  local pid rc b marker
  fixture term; marker="$ROOT/paused"
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    SKIP_SECRETS=1 SKIP_DEPS=1 KHEREP_BOOTSTRAP_TEST_PAUSE_AFTER_LABEL='hooks/commit-guard.mts' \
    KHEREP_BOOTSTRAP_TEST_MARKER="$marker" bash "$HERE/install.sh" > "$ROOT/log" 2>&1 & pid=$!
  for ((i=0; i<200; i++)); do [[ ! -e "$marker" ]] || break; sleep 0.1; done
  [[ -e "$marker" ]] || { kill -TERM "$pid" 2>/dev/null || true; fail "TERM checkpoint missing"; }
  kill -TERM "$pid"; set +e; wait "$pid"; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "TERM returned success"
  same "$C/statusline-command.sh" "$ROOT/status.before"; same "$C/hooks/commit-guard.mts" "$ROOT/guard.before"
  b="$(latest "$H")"; [[ -f "$b/ROLLED-BACK" ]] && grep -q SIGTERM "$b/ROLLBACK-REASON" || fail "TERM not journaled"
}

test_commit_signal() {
  local pid rc b marker
  fixture commit; marker="$ROOT/commit-durable"
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    SKIP_SECRETS=1 SKIP_DEPS=1 KHEREP_BOOTSTRAP_TEST_PAUSE_AFTER_COMMIT_MARKER="$marker" \
    bash "$HERE/install.sh" > "$ROOT/log" 2>&1 & pid=$!
  for ((i=0; i<1200; i++)); do [[ ! -e "$marker" ]] || break; sleep 0.1; done
  [[ -e "$marker" ]] || { kill -TERM "$pid" 2>/dev/null || true; fail "commit checkpoint missing"; }
  kill -TERM "$pid"; set +e; wait "$pid"; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "commit-race TERM returned success"
  b="$(latest "$H")"
  [[ -f "$b/COMMITTED" ]] && [[ ! -e "$b/ROLLED-BACK" ]] && [[ ! -e "$b/ACTIVE" ]] || fail "durable commit was rolled back or contradictory"
  cmp "$C/statusline-command.sh" "$HERE/../claude/statusline-command.sh" >/dev/null || fail "durably committed live target was reverted"
}

test_secrets() {
  local yaml age bin rc b f
  fixture secrets; yaml="$ROOT/plain.yaml"; age="$ROOT/age.key"; bin="$ROOT/bin"
  mkdir -p "$bin" "$ROOT/before"; printf x > "$age"
  printf '%s\n' '{"old":true}' > "$C/.mcp.json"; printf '%s\n' '#!/usr/bin/env bash' 'echo old' > "$C/registry-http-bridge.sh"
  for f in .mcp.json registry-http-bridge.sh; do mkdir -p "$ROOT/before/$(dirname "$f")"; cp "$C/$f" "$ROOT/before/$f"; done
  node -e 'const fs=require("fs"),b=s=>Buffer.from(s).toString("base64"),v={mcp_json:b("{\"mcpServers\":{}}\n"),fixture_service_sh:b("#!/usr/bin/env bash\necho new\n")};fs.writeFileSync(process.argv[1],"data:\n"+Object.entries(v).map(([k,x])=>`  ${k}: ${x}`).join("\n")+"\n")' "$yaml"
  cat > "$bin/sops" <<'SH'
#!/usr/bin/env bash
exec cat "$FAKE_SOPS_YAML"
SH
  chmod +x "$bin/sops"
  set +e
  PATH="$bin:$ORIGINAL_PATH" FAKE_SOPS_YAML="$yaml" HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win \
    KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" SOPS_AGE_KEY_FILE="$age" \
    KHEREP_SECRETS_BUNDLE="$yaml" \
    KHEREP_BOOTSTRAP_TEST_FAIL_SWAP_LABEL='secrets/.mcp.json' SKIP_SECRETS=0 SKIP_DEPS=1 \
    bash "$HERE/install.sh" > "$ROOT/log" 2>&1; rc=$?
  set -e; [[ "$rc" -ne 0 ]] || fail "secret swap failure returned success"
  for f in .mcp.json registry-http-bridge.sh; do same "$C/$f" "$ROOT/before/$f"; done
  same "$C/statusline-command.sh" "$ROOT/status.before"
  b="$(latest "$H")" || fail "secret fixture did not reach an installation transaction"
  [[ -f "$b/ROLLED-BACK" ]] && [[ -f "$b/secrets/.mcp.json" ]] || fail "secret rollback/backup missing"
  ! compgen -G "$C/backups/bootstrap/preflight-*" >/dev/null || fail "secret preflight not cleaned"
}

# OP-1432. The observation agent is installed by default, so the Confluence
# brokers and exactly the modules they import are too - without the Atlassian
# switch, which keeps gating only the Jira helpers.
test_default_confluence_brokers() {
  local rc tool
  fixture confluence
  set +e
  env -u KHEREP_INSTALL_ATLASSIAN_TOOLS HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log"; fail "default install failed (rc=$rc)"; }
  for tool in atlassian-credentials.mts atlassian-cli-args.mts confluence-contract.mts confluence-content.mts confluence-session.mts \
    confluence-related.mts confluence-text-search.mts confluence-semantic.mts confluence-neighbours.mts confluence-neighbour-cli.mts \
    confluence-topic-query.mts confluence-candidates.mts confluence-stitch.mts confluence-list-cli.mts \
    confluence-runtime-label.mts confluence-label-cli.mts confluence-pagination.mts confluence-drainage-rules.mts confluence-drainage-snapshot.mts confluence-drainage-scan.mts confluence-drainage-cli.mts confluence-evidence.mts confluence-evidence-report.mts confluence-evidence-io.mts confluence-evidence-cli.mts confluence-claim-text.mts confluence-observation-validate.mts confluence-revision-staleness.mts confluence-revision-staleness-git.mts atl-confluence.mts atl-confluence-ccoder.mts; do
    same "$HERE/../modules/atl-jira-brokers/$tool" "$W/tools/$tool"
  done
  for tool in atl-jira.mts atl-jira-ccoder.mts jira-adf.mts jira-config.mts; do
    [[ ! -e "$W/tools/$tool" ]] || fail "default install projected the optional helper $tool"
  done
  grep -qF "<confluence.json broker> create" "$C/agents/claude-obs.md" ||
    fail "installed claude-obs.md lacks the stored-broker invocation"
  ! grep -qF "<workspace>" "$C/agents/claude-obs.md" ||
    fail "installed claude-obs.md leaves the broker path to the model (issue #13)"
  # The space step is skipped here, yet the broker command is installed and
  # names the projected broker (issue #13, review MEDIUM-1).
  node -e '
    const fs = require("fs"), c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const m = /^node (\S+\/tools\/atl-confluence-ccoder\.mts)$/.exec(c.broker || "");
    if (!m || c.broker.includes("\\") || "spaceKey" in c || !fs.existsSync(m[1])) process.exit(1);
  ' "$C/kherep/confluence.json" || fail "a skipped space step left no usable broker in confluence.json"
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after a default install"; }
}

# Issue #737. The model policy user override belongs to the operator. On a host
# the policy installer never reached, explicit values are migrated once (an
# edited agent frontmatter, a deprecated environment pin equal to the old
# default). Afterwards the file stays byte-identical through a reinstall, a
# rolled-back install and a refused one, and its values reach the frontmatter
# without drift.
test_model_policy() {
  local rc user backups
  fixture model-policy; user="$C/kherep/model-policy.user.json"
  mkdir -p "$C/agents"
  printf '%s\n' '---' 'name: claude-obs' 'description: x' 'tools: Bash, Read' 'model: haiku' 'effort: low' '---' 'Body.' \
    > "$C/agents/claude-obs.md"
  policy_install() {
    HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
      KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 \
      SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh"
  }
  set +e; KHEREP_ALLOWED_MODELS=haiku,sonnet,opus KHEREP_AGENT_MODEL_POLICY='{"kherep-builder":"opus"}' policy_install > "$ROOT/log" 2>&1
  rc=$?; set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log"; fail "model policy migration install failed (rc=$rc)"; }
  grep -q 'model policy: captured agents.claude-obs.effort = low from the edited agents/claude-obs.md' "$ROOT/log" ||
    fail "the edited frontmatter effort was not captured"
  grep -q 'model policy: captured agents.kherep-builder.model = opus from KHEREP_AGENT_MODEL_POLICY' "$ROOT/log" ||
    fail "an environment pin equal to the old default was not kept as explicit"
  grep -q 'model policy: captured models.fable (not dispatchable) from KHEREP_ALLOWED_MODELS' "$ROOT/log" ||
    fail "the narrowed allow-list was not migrated"
  node -e '
    const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const want = { schema_version: 1, agents: { "kherep-builder": { model: "opus" }, "claude-obs": { effort: "low" } },
      models: { haiku: { dispatchable: true }, sonnet: { dispatchable: true }, opus: { dispatchable: true }, fable: { dispatchable: false } } };
    if (JSON.stringify(j) !== JSON.stringify(want)) process.exit(1);
  ' "$user" || fail "the migrated user override is not what was captured"
  grep -qx 'effort: low' "$C/agents/claude-obs.md" || fail "the migrated effort was not rendered"
  grep -qx 'model: opus' "$C/agents/kherep-builder.md" || fail "the migrated model was not rendered"
  same "$C/kherep/model-policy.json" "$HERE/../claude/kherep/model-policy.json"

  printf '%s\n' '{ "agents": { "claude-obs": { "model": "sonnet" } } }' > "$user"; cp "$user" "$ROOT/user.before"
  set +e; policy_install > "$ROOT/log2" 2>&1; rc=$?; set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log2"; fail "reinstall with a user override failed (rc=$rc)"; }
  same "$user" "$ROOT/user.before"
  ! grep -q 'model policy: captured' "$ROOT/log2" || fail "the migration ran a second time"
  grep -qx 'model: sonnet' "$C/agents/claude-obs.md" && grep -qx 'effort: medium' "$C/agents/claude-obs.md" ||
    fail "the user override and the observer default were not rendered on reinstall"
  ! grep -q '^model:' "$C/agents/kherep-builder.md" || fail "a role default left the builder off native inherit"
  # The deprecated environment in the checking shell never reaches the rendered frontmatter.
  KHEREP_AGENT_MODEL_POLICY='{"claude-obs":"opus","kherep-builder":"opus"}' \
    HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 || { cat "$ROOT/drift.log"; fail "drift-check failed with a user override"; }
  grep -q '^ok *agents/claude-obs.md$' "$ROOT/drift.log" || fail "the overridden agent is not reported ok"
  grep -q '^ok *agents/kherep-builder.md$' "$ROOT/drift.log" || fail "the deprecated environment reached the drift render"

  set +e; KHEREP_BOOTSTRAP_TEST_FAIL_AFTER_LABEL='hooks/deploy-guard.mts' policy_install > "$ROOT/log3" 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] && [[ -f "$(latest "$H")/ROLLED-BACK" ]] || fail "the injected failure was not rolled back"
  same "$user" "$ROOT/user.before"

  printf '{ "agents": { "claude-obs": { "tools": "Bash" } } }\n' > "$user"; cp "$user" "$ROOT/user.before"
  backups="$(ls -d "$C"/backups/bootstrap/install-* | wc -l)"
  set +e; policy_install > "$ROOT/log4" 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "an install with an invalid user override succeeded"
  grep -q 'FATAL: model policy .*model-policy.user.json, key agents.claude-obs.tools:' "$ROOT/log4" ||
    { cat "$ROOT/log4"; fail "the refusal does not name the file and key"; }
  same "$user" "$ROOT/user.before"
  [[ "$(ls -d "$C"/backups/bootstrap/install-* | wc -l)" = "$backups" ]] || fail "an invalid override reached the transaction"
}

# Kherep no longer ships the MPAC tools (#25). Hosts that installed them earlier
# get <workspace>/tools/mpac/ retired through retired.txt (#33). The workspace
# entries are hash-gated (#45): an upgrade over an operator's own mpac.ps1 keeps
# it with one KEEP line and still succeeds, while the ungated Claude-home entry
# is parked with its exact bytes in the install backup. A path that is live
# afterwards is reported as RETIRED-LIVE, which is information: drift-check still
# passes with exit 0, under the default scope and under DRIFT_SCOPE=project.
test_upgrade_retires_mpac() {
  local rc b
  fixture mpac
  mkdir -p "$W/tools/mpac" "$ROOT/mpac.before"
  printf 'operator mpac script\n' > "$W/tools/mpac/mpac.ps1"; cp "$W/tools/mpac/mpac.ps1" "$ROOT/mpac.before/"
  printf leftover > "$C/hooks/em-dash-watch.js"
  set +e
  KHEREP_INSTALL_ATLASSIAN_TOOLS=1 HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log"; fail "upgrade install with the Atlassian switch failed (rc=$rc)"; }
  b="$(latest "$H")"
  [[ "$(grep -c 'retire: KEEP' "$ROOT/log")" -eq 1 ]] &&
    grep -qxF 'retire: KEEP project/tools/mpac/mpac.ps1 (content not placed by the installer)' "$ROOT/log" ||
    { cat "$ROOT/log"; fail "the upgrade did not keep the operator's mpac.ps1 with exactly one KEEP line"; }
  same "$W/tools/mpac/mpac.ps1" "$ROOT/mpac.before/mpac.ps1"
  [[ ! -e "$W/tools/mpac/_deprecated" ]] && [[ ! -e "$b/retired/project" ]] ||
    fail "the upgrade parked or backed up workspace content it did not place"
  [[ "$(cat "$C/hooks/_deprecated/em-dash-watch.js")" = "leftover" ]] && [[ "$(cat "$b/retired/hooks/em-dash-watch.js")" = "leftover" ]] &&
    [[ ! -e "$C/hooks/em-dash-watch.js" ]] || fail "the upgrade did not park the retired Claude-home file"
  same "$HERE/../modules/atl-jira-brokers/atl-jira.mts" "$W/tools/atl-jira.mts"
  KHEREP_INSTALL_ATLASSIAN_TOOLS=1 HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed over a kept retired file"; }
  grep -qxF 'DRIFT-CHECK PASS (repo == live)' "$ROOT/drift.log" &&
    grep -q '^RETIRED-LIVE  project/tools/mpac/mpac\.ps1 ' "$ROOT/drift.log" &&
    ! grep -q 'RETIRED-LIVE  project/tools/mpac/README\.md' "$ROOT/drift.log" &&
    ! grep -q 'RETIRED-LIVE  hooks/' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "drift-check did not report exactly the kept retired path and PASS"; }

  printf leftover > "$C/hooks/em-dash-watch.js"
  set +e
  KHEREP_INSTALL_ATLASSIAN_TOOLS=1 HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1; rc=$?
  set -e
  [[ "$rc" -eq 0 ]] && grep -qxF 'DRIFT-CHECK PASS (repo == live)' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "drift-check treated live retired paths as drift (rc=$rc)"; }
  grep -q '^RETIRED-LIVE  project/tools/mpac/mpac\.ps1 ' "$ROOT/drift.log" &&
    grep -q '^RETIRED-LIVE  hooks/em-dash-watch\.js ' "$ROOT/drift.log" &&
    ! grep -q 'RETIRED-LIVE  project/tools/mpac/README\.md' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "drift-check did not report exactly the live retired paths"; }
  set +e
  DRIFT_SCOPE=project KHEREP_INSTALL_ATLASSIAN_TOOLS=1 HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win \
    KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1; rc=$?
  set -e
  [[ "$rc" -eq 0 ]] && grep -qxF 'DRIFT-CHECK PASS (repo == live)' "$ROOT/drift.log" &&
    grep -q '^RETIRED-LIVE  project/tools/mpac/mpac\.ps1 ' "$ROOT/drift.log" &&
    ! grep -q 'RETIRED-LIVE  hooks/' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "project-scope drift-check did not limit RETIRED-LIVE to workspace entries"; }
}

# Issue #237. An upgrade over a host that still runs the .js hooks retires them
# through the install transaction: each old file is parked in hooks/_deprecated
# with its exact bytes in the install backup, its .mts replacement is installed,
# and the live settings wire only the .mts. The old wiring uses the ~ form older
# installs wrote; the home is pinned for node too (USERPROFILE on Windows), so
# the managed entry folds onto it the way it does on a real host.
test_upgrade_retires_js_hooks() {
  local rc b name userprofile
  fixture jshooks
  for name in clq-accept-gate live-hook-integrity; do printf 'old-js-hook\n' > "$C/hooks/$name.js"; done
  printf '%s\n' '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"node \"~/.claude/hooks/clq-accept-gate.js\""}]}],"SessionStart":[{"matcher":"","hooks":[{"type":"command","command":"node \"~/.claude/hooks/live-hook-integrity.js\""}]}]}}' > "$C/settings.json"
  userprofile="$H"; ! command -v cygpath >/dev/null 2>&1 || userprofile="$(cygpath -w "$H")"
  set +e
  HOME="$H" USERPROFILE="$userprofile" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log"; fail "upgrade install over .js hooks failed (rc=$rc)"; }
  b="$(latest "$H")"
  for name in clq-accept-gate live-hook-integrity; do
    [[ ! -e "$C/hooks/$name.js" ]] || fail "the retired $name.js stayed at its live path"
    [[ "$(cat "$C/hooks/_deprecated/$name.js")" = "old-js-hook" ]] || fail "$name.js was not parked in hooks/_deprecated"
    [[ "$(cat "$b/retired/hooks/$name.js")" = "old-js-hook" ]] || fail "$name.js was not backed up by the transaction"
    same "$HERE/../claude/hooks/$name.mts" "$C/hooks/$name.mts"
  done
  node -e '
    const fs = require("fs"), s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const commands = Object.values(s.hooks || {}).flat().flatMap((g) => g.hooks || []).map((h) => String(h.command));
    for (const name of ["clq-accept-gate", "live-hook-integrity"]) {
      if (commands.some((c) => c.includes(`hooks/${name}.js`))) { console.error(`${name}.js still wired`); process.exit(1); }
      if (commands.filter((c) => c.includes(`hooks/${name}.mts`)).length !== 1) { console.error(`${name}.mts not wired once`); process.exit(2); }
    }
  ' "$C/settings.json" || { cat "$C/settings.json"; fail "the upgraded settings do not wire exactly the .mts hooks"; }
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after retiring the .js hooks"; }
  ! grep -q 'RETIRED-LIVE  hooks/' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "a retired .js hook is still live after the upgrade"; }
}

# Issue #897. The kherep-twg wrapper is retired in favour of the vendor TWG
# skills. An upgrade parks the runtime directory kherep/twg and the skill
# directory skills/kherep-twg in their _deprecated/ siblings, with their exact
# bytes in the install backup. The vendor's skills stay byte-identical: a real
# skills/twg directory and a skills/twg-jira symlink into a vendor directory.
# No installer calls twg: a twg on PATH that records any call stays silent.
test_upgrade_retires_twg_wrapper() {
  local rc b vendor fake userprofile
  fixture twgwrap
  vendor="$ROOT/vendor-skills"; fake="$ROOT/fake-bin"
  mkdir -p "$C/kherep/twg" "$C/skills/kherep-twg" "$C/skills/twg" "$vendor/twg-jira" "$fake" "$ROOT/before"
  printf old-wrapper-cli > "$C/kherep/twg/cli.mts"
  printf old-wrapper-skill > "$C/skills/kherep-twg/SKILL.md"
  printf vendor-twg > "$C/skills/twg/SKILL.md"; cp "$C/skills/twg/SKILL.md" "$ROOT/before/twg.md"
  printf vendor-twg-jira > "$vendor/twg-jira/SKILL.md"; cp "$vendor/twg-jira/SKILL.md" "$ROOT/before/twg-jira.md"
  make_dir_symlink "$vendor/twg-jira" "$C/skills/twg-jira"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "%s"\n' "$ROOT/twg-called" > "$fake/twg"; chmod +x "$fake/twg"
  userprofile="$H"; ! command -v cygpath >/dev/null 2>&1 || userprofile="$(cygpath -w "$H")"
  set +e
  PATH="$fake:$PATH" HOME="$H" USERPROFILE="$userprofile" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log"; fail "upgrade install over the kherep-twg wrapper failed (rc=$rc)"; }
  b="$(latest "$H")"
  [[ ! -e "$C/kherep/twg" ]] && [[ ! -e "$C/skills/kherep-twg" ]] || fail "a retired wrapper directory stayed at its live path"
  [[ "$(cat "$C/kherep/_deprecated/twg/cli.mts")" = "old-wrapper-cli" ]] || fail "kherep/twg was not parked in kherep/_deprecated"
  [[ "$(cat "$C/skills/_deprecated/kherep-twg/SKILL.md")" = "old-wrapper-skill" ]] || fail "skills/kherep-twg was not parked in skills/_deprecated"
  [[ "$(cat "$b/retired/kherep/twg/cli.mts")" = "old-wrapper-cli" ]] &&
    [[ "$(cat "$b/retired/skills/kherep-twg/SKILL.md")" = "old-wrapper-skill" ]] || fail "the retired wrapper was not backed up by the transaction"
  same "$C/skills/twg/SKILL.md" "$ROOT/before/twg.md"
  [[ -L "$C/skills/twg-jira" ]] || fail "the vendor skills/twg-jira symlink was replaced"
  same "$C/skills/twg-jira/SKILL.md" "$ROOT/before/twg-jira.md"
  [[ ! -e "$C/skills/_deprecated/twg" ]] && [[ ! -e "$C/skills/_deprecated/twg-jira" ]] || fail "a vendor TWG skill was parked"
  [[ ! -e "$ROOT/twg-called" ]] || { cat "$ROOT/twg-called"; fail "the installer called twg"; }
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after retiring the kherep-twg wrapper"; }
  ! grep -qE 'RETIRED-LIVE  (kherep/twg|skills/kherep-twg)' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "a retired wrapper path is still live after the upgrade"; }
}

# Issue #252. A host can carry a second, legacy wiring of its hooks in groups of
# their own (`node ~/.claude/hooks/<name>.js`). The upgrade unwires every one
# that runs a retired script, drops the groups that held nothing else, reports
# each removal, and keeps the rest: a legacy command for a script that is not
# retired, a user hook, and a command that only names a retired file as an
# argument. A rollback restores the previous settings byte for byte. drift-check
# then fails on any wired command whose Claude-home script is missing or retired.
test_upgrade_unwires_legacy_hooks() {
  local rc name userprofile
  fixture legacyhooks
  for name in clq-accept-gate live-hook-integrity orchestra-default; do printf 'old-js-hook\n' > "$C/hooks/$name.js"; done
  # A host-owned legacy-form hook whose script is not retired (#237 batch 2
  # retires every managed .js guard, so the example can no longer be one).
  printf 'host-hook\n' > "$C/hooks/host-guard.js"
  cat > "$C/settings.json" <<'JSON'
{"hooks":{
 "SessionStart":[{"matcher":"startup|clear|compact|resume","hooks":[
   {"type":"command","command":"node ~/.claude/hooks/live-hook-integrity.js"},
   {"type":"command","command":"node \"$HOME/.claude/hooks/orchestra-default.js\""}]}],
 "Stop":[{"matcher":"","hooks":[{"type":"command","command":"node ~/.claude/hooks/clq-accept-gate.js"}]}],
 "PreToolUse":[
   {"matcher":"Read|Grep|Glob|Edit|Write|MultiEdit|Bash","hooks":[{"type":"command","command":"node ~/.claude/hooks/host-guard.js"}]},
   {"matcher":"Write","hooks":[{"type":"command","command":"node ~/own/check.js ~/.claude/hooks/clq-accept-gate.js"}]}]}}
JSON
  cp "$C/settings.json" "$ROOT/settings.before"
  userprofile="$H"; ! command -v cygpath >/dev/null 2>&1 || userprofile="$(cygpath -w "$H")"
  legacy_install() {
    HOME="$H" USERPROFILE="$userprofile" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
      KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
      KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 \
      KHEREP_BOOTSTRAP_TEST_FAIL_AFTER_LABEL="${1:-}" bash "$HERE/install.sh"
  }
  legacy_drift() {
    HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
      bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1
  }
  set +e; legacy_install settings.json > "$ROOT/log" 2>&1; rc=$?; set -e
  [[ "$rc" -ne 0 ]] || fail "an install failing after settings.json returned success"
  same "$C/settings.json" "$ROOT/settings.before"
  set +e; legacy_install > "$ROOT/log" 2>&1; rc=$?; set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log"; fail "upgrade install over legacy hook groups failed (rc=$rc)"; }
  [[ "$(grep -c '^retire: unwire ' "$ROOT/log")" -eq 3 ]] &&
    grep -qxF 'retire: unwire SessionStart node ~/.claude/hooks/live-hook-integrity.js' "$ROOT/log" &&
    grep -qxF 'retire: unwire SessionStart node "$HOME/.claude/hooks/orchestra-default.js"' "$ROOT/log" &&
    grep -qxF 'retire: unwire Stop node ~/.claude/hooks/clq-accept-gate.js' "$ROOT/log" ||
    { cat "$ROOT/log"; fail "the install did not report exactly the three unwired commands"; }
  node -e '
    const fs = require("fs"), s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const groups = Object.values(s.hooks || {}).flat();
    const commands = groups.flatMap((g) => g.hooks || []).map((h) => String(h.command));
    const fail = (message) => { console.error(message); process.exit(1); };
    for (const name of ["clq-accept-gate", "live-hook-integrity", "orchestra-default"]) {
      if (commands.some((c) => c.includes(`hooks/${name}.js`) && !c.includes("own/check.js"))) fail(`${name}.js still wired`);
      if (commands.filter((c) => c.includes(`hooks/${name}.mts`)).length !== 1) fail(`${name}.mts not wired once`);
    }
    if (groups.some((g) => !(g.hooks || []).length)) fail("an emptied group stayed");
    if (groups.some((g) => g.matcher === "startup|clear|compact|resume")) fail("the emptied legacy SessionStart group stayed");
    const legacy = groups.filter((g) => g.matcher === "Read|Grep|Glob|Edit|Write|MultiEdit|Bash");
    if (legacy.length !== 1 || legacy[0].hooks.length !== 1 ||
      legacy[0].hooks[0].command !== "node ~/.claude/hooks/host-guard.js") fail("the non-retired legacy entry changed");
    if (commands.filter((c) => c === "node ~/own/check.js ~/.claude/hooks/clq-accept-gate.js").length !== 1) fail("user hook lost");
  ' "$C/settings.json" || { cat "$C/settings.json"; fail "the upgraded settings do not match the legacy-unwire contract"; }
  legacy_drift || { cat "$ROOT/drift.log"; fail "drift-check failed over clean upgraded settings"; }
  ! grep -q '^DANGLING-HOOK' "$ROOT/drift.log" || { cat "$ROOT/drift.log"; fail "clean settings reported a dangling hook"; }
  node -e '
    const fs = require("fs"), file = process.argv[1], s = JSON.parse(fs.readFileSync(file, "utf8"));
    s.hooks.UserPromptSubmit = [...(s.hooks.UserPromptSubmit || []),
      { matcher: "issue252", hooks: [{ type: "command", command: "node ~/.claude/hooks/no-such-hook.mts" }] }];
    fs.writeFileSync(file, JSON.stringify(s, null, 2) + "\n");
  ' "$C/settings.json"
  set +e; legacy_drift; rc=$?; set -e
  [[ "$rc" -eq 1 ]] && grep -qxF 'DANGLING-HOOK UserPromptSubmit node ~/.claude/hooks/no-such-hook.mts' "$ROOT/drift.log" &&
    grep -qxF 'DRIFT-CHECK FOUND DRIFT (see above)' "$ROOT/drift.log" && ! grep -q '^DRIFT  ' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "drift-check did not fail on a wired hook whose script is missing (rc=$rc)"; }
  # Review of #254: the user settings are checked under every DRIFT_SCOPE.
  set +e
  DRIFT_SCOPE=project HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1; rc=$?
  set -e
  [[ "$rc" -eq 1 ]] && grep -qxF 'DANGLING-HOOK UserPromptSubmit node ~/.claude/hooks/no-such-hook.mts' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "project-scope drift-check missed a dangling user-settings hook (rc=$rc)"; }
  cp "$ROOT/settings.before" "$C/settings.json"
  set +e; legacy_drift; rc=$?; set -e
  [[ "$rc" -eq 1 ]] && grep -qxF 'DANGLING-HOOK Stop node ~/.claude/hooks/clq-accept-gate.js' "$ROOT/drift.log" &&
    grep -qxF 'DANGLING-HOOK SessionStart node ~/.claude/hooks/live-hook-integrity.js' "$ROOT/drift.log" &&
    ! grep -q '^DANGLING-HOOK .*host-guard' "$ROOT/drift.log" &&
    ! grep -q '^DANGLING-HOOK .*own/check' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "drift-check did not report exactly the retired legacy commands (rc=$rc)"; }
}

# Review of #254. clq-accept-gate is a Stop hook; the template wired it under
# PreToolUse "Bash" until now. A host carries that managed entry in the form the
# installer wrote (absolute Claude home) and, on one host, a hand-added Stop
# entry. The upgrade converges to the template: one clq entry, under Stop.
test_upgrade_moves_clq_to_stop() {
  local rc home userprofile
  fixture clqstop
  home="$C"; userprofile="$H"
  ! command -v cygpath >/dev/null 2>&1 || { home="$(cygpath -w "$C")"; userprofile="$(cygpath -w "$H")"; }
  node -e '
    const [file, home] = process.argv.slice(1);
    const run = (name) => ({ type: "command", command: `node "${home}/hooks/${name}"` });
    require("fs").writeFileSync(file, JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [run("commit-guard.js"), run("deploy-guard.js"), run("clq-accept-gate.mts")] }],
      Stop: [{ matcher: "", hooks: [run("maestro-banner-gate.mts"), run("clq-accept-gate.mts")] }],
    } }, null, 2));
  ' "$C/settings.json" "$home"
  set +e
  HOME="$H" USERPROFILE="$userprofile" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log"; fail "upgrade install over a PreToolUse clq entry failed (rc=$rc)"; }
  grep -q '^hooks: unwire PreToolUse node ".*hooks/clq-accept-gate\.mts" (managed under Stop)$' "$ROOT/log" ||
    { cat "$ROOT/log"; fail "the install did not report moving clq-accept-gate off PreToolUse"; }
  node -e '
    const fs = require("fs"), path = require("path");
    const [file, home, renderer, template] = process.argv.slice(1);
    const fail = (message) => { console.error(message); process.exit(1); };
    const s = JSON.parse(fs.readFileSync(file, "utf8"));
    const where = Object.entries(s.hooks).flatMap(([event, groups]) => groups.flatMap((g) =>
      (g.hooks || []).filter((h) => String(h.command).includes("clq-accept-gate")).map(() => `${event}[${g.matcher}]`)));
    if (where.join(",") !== "Stop[]") { console.error(`clq wired at: ${where.join(",") || "nowhere"}`); process.exit(1); }
    // Issue #507: the Bash group is exactly the dispatcher entry for commit-guard and deploy-guard, started
    // through the hook runtime entry (part 2), with the Claude home as the win profile renders it:
    // resolveProfilePath, the host path.resolve, no slash rewrite.
    const dispatcher = (claudeHome) => `node "${claudeHome}/kherep/hook-runtime/entry.mts" pretool `
      + ["guard-dispatch", "commit-guard", "deploy-guard"].map((n) => `"${claudeHome}/hooks/${n}.mts"`).join(" ");
    import(require("url").pathToFileURL(renderer).href).then(({ resolveProfilePath }) => {
      if (resolveProfilePath("win", home) !== path.resolve(home)) fail("the win profile no longer renders the home with path.resolve");
      // On any host: a Windows home keeps its backslashes under path.win32, as the renderer substitutes it.
      const winHome = path.win32.resolve("C:\\Users\\Example\\.claude");
      const raw = JSON.parse(fs.readFileSync(template, "utf8")).hooks.PreToolUse.find((g) => g.matcher === "Bash").hooks[0].command;
      if (raw.replaceAll("__KHEREP_CLAUDE_HOME__", winHome) !== dispatcher(winHome)) fail(`no win32 match: ${dispatcher(winHome)}`);
      const want = JSON.stringify([{ type: "command", command: dispatcher(resolveProfilePath("win", home)), timeout: 30 }]);
      const bash = (s.hooks.PreToolUse || []).filter((g) => g.matcher === "Bash").flatMap((g) => g.hooks || []);
      if (JSON.stringify(bash) !== want) fail(`Bash group is not exactly ${want}: ${JSON.stringify(bash)}`);
    });
  ' "$C/settings.json" "$home" "$HERE/render-profile-paths.mts" "$HERE/../claude/settings.user.json" ||
    { cat "$C/settings.json"; fail "the upgrade did not converge clq-accept-gate to one Stop entry and one Bash dispatcher"; }
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after moving clq-accept-gate to Stop"; }
}

# Issue #237 batch 2. A host runs the six guards as .js: in the managed form the
# previous installer wrote (absolute Claude home) and, for three of them, in
# legacy groups of their own (~ form). The upgrade parks every .js through the
# transaction, unwires every .js command and wires each .mts exactly once at the
# template's matcher; the legacy groups are gone. drift-check passes.
test_upgrade_retires_guard_js_hooks() {
  local rc b home userprofile name
  local guards="commit-guard deploy-guard dispatch-contract-guard playwright-file-guard privacy-boundary-guard secret-output-guard"
  fixture guardjs
  home="$C"; userprofile="$H"
  ! command -v cygpath >/dev/null 2>&1 || { home="$(cygpath -w "$C")"; userprofile="$(cygpath -w "$H")"; }
  for name in $guards; do printf 'old-js-guard\n' > "$C/hooks/$name.js"; done
  rm -f "$C/hooks/commit-guard.mts"
  node -e '
    const [file, home] = process.argv.slice(1);
    const managed = (name) => ({ type: "command", command: `node "${home}/hooks/${name}.js"` });
    const legacy = (name) => ({ type: "command", command: `node ~/.claude/hooks/${name}.js` });
    require("fs").writeFileSync(file, JSON.stringify({ hooks: { PreToolUse: [
      { matcher: "", hooks: [managed("privacy-boundary-guard"), managed("secret-output-guard"), managed("playwright-file-guard")] },
      { matcher: "Agent|Task", hooks: [managed("dispatch-contract-guard")] },
      { matcher: "Bash", hooks: [managed("commit-guard"), managed("deploy-guard")] },
      { matcher: "Read|Grep|Glob|Edit|Write|MultiEdit|Bash", hooks: [legacy("privacy-boundary-guard")] },
      { matcher: "Agent|Task|Workflow|WebSearch|WebFetch|mcp__.*", hooks: [legacy("privacy-boundary-guard")] },
      { matcher: "Bash|PowerShell", hooks: [legacy("secret-output-guard")] },
      { matcher: "mcp__plugin_playwright_playwright__browser_navigate", hooks: [legacy("playwright-file-guard")] },
    ] } }, null, 2));
  ' "$C/settings.json" "$home"
  set +e
  HOME="$H" USERPROFILE="$userprofile" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" \
    KHEREP_CREDENTIALS_ROOT="$R" KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 SKIP_SECRETS=1 SKIP_DEPS=1 bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 0 ]] || { cat "$ROOT/log"; fail "upgrade install over the .js guards failed (rc=$rc)"; }
  # Six managed and four legacy commands, one line each (two legacy groups ran privacy-boundary-guard.js).
  [[ "$(grep -c '^retire: unwire PreToolUse ' "$ROOT/log")" -eq 10 ]] &&
    [[ "$(grep -c '^retire: unwire PreToolUse node ".*/hooks/[a-z-]*-guard\.js"$' "$ROOT/log")" -eq 6 ]] &&
    [[ "$(grep -cxF 'retire: unwire PreToolUse node ~/.claude/hooks/privacy-boundary-guard.js' "$ROOT/log")" -eq 2 ]] &&
    grep -qxF 'retire: unwire PreToolUse node ~/.claude/hooks/secret-output-guard.js' "$ROOT/log" &&
    grep -qxF 'retire: unwire PreToolUse node ~/.claude/hooks/playwright-file-guard.js' "$ROOT/log" ||
    { cat "$ROOT/log"; fail "the install did not report exactly the ten unwired guard commands"; }
  b="$(latest "$H")"
  for name in $guards; do
    [[ ! -e "$C/hooks/$name.js" ]] || fail "the retired $name.js stayed at its live path"
    [[ "$(cat "$C/hooks/_deprecated/$name.js")" = "old-js-guard" ]] || fail "$name.js was not parked in hooks/_deprecated"
    [[ "$(cat "$b/retired/hooks/$name.js")" = "old-js-guard" ]] || fail "$name.js was not backed up by the transaction"
    same "$HERE/../claude/hooks/$name.mts" "$C/hooks/$name.mts"
  done
  node -e '
    const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
    const fail = (message) => { console.error(message); process.exit(1); };
    const wired = Object.entries(s.hooks).flatMap(([event, groups]) => groups.flatMap((g) =>
      (g.hooks || []).map((h) => ({ event, matcher: g.matcher ?? "", command: String(h.command) }))));
    const expected = { "commit-guard": "Bash", "deploy-guard": "Bash", "dispatch-contract-guard": "Agent|Task",
      "playwright-file-guard": "", "privacy-boundary-guard": "", "secret-output-guard": "",
      "main-checkout-guard": "Bash|PowerShell", "module-label-guard": "Bash|PowerShell" };
    for (const [name, matcher] of Object.entries(expected)) {
      if (wired.some((h) => h.command.includes(`hooks/${name}.js`))) fail(`${name}.js still wired`);
      const mts = wired.filter((h) => h.command.includes(`hooks/${name}.mts`));
      if (mts.length !== 1 || mts[0].event !== "PreToolUse" || mts[0].matcher !== matcher) {
        fail(`${name}.mts not wired once under PreToolUse "${matcher}": ${JSON.stringify(mts)}`);
      }
    }
    const legacyMatchers = ["Read|Grep|Glob|Edit|Write|MultiEdit|Bash", "Agent|Task|Workflow|WebSearch|WebFetch|mcp__.*",
      "Bash|PowerShell", "mcp__plugin_playwright_playwright__browser_navigate"];
    // Issue #325: the template has its own "Bash|PowerShell" group for main-checkout-guard,
    // so that matcher may stay as long as the group holds nothing else.
    const managedOnly = (g) => (g.hooks || []).every((h) => String(h.command).includes("hooks/main-checkout-guard.mts"));
    const left = (s.hooks.PreToolUse || []).filter((g) => legacyMatchers.includes(g.matcher) && !managedOnly(g));
    if (left.length) fail(`legacy groups stayed: ${JSON.stringify(left)}`);
  ' "$C/settings.json" || { cat "$C/settings.json"; fail "the upgraded settings do not wire exactly the .mts guards"; }
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after retiring the .js guards"; }
  ! grep -q -E '^(RETIRED-LIVE  hooks/|DANGLING-HOOK)' "$ROOT/drift.log" ||
    { cat "$ROOT/drift.log"; fail "a retired .js guard is still live or wired after the upgrade"; }
}

# Issue #403: an install that is terminated during the deps phase still removes
# the node's Claude probe lock, through the EXIT trap. The fake npm sends TERM
# to the installer whose pid the lock names; bash runs the trap once npm returns.
# Placed before test_deps_failure: a pin in install-host-binding-skip.test.mts
# expects exactly one install.sh call from that function to the end of the file.
test_deps_term_releases_probe_lock() {
  local rc fake_npm config
  fixture deps-term
  cat > "$ROOT/fake-npm.js" <<'JS'
"use strict";
const fs = require("node:fs");
const { execFileSync } = require("node:child_process");
const args = process.argv.slice(2);
const lock = process.env.FAKE_PAUSE_LOCK;
if (!fs.existsSync(process.env.FAKE_TERM_SENT) && fs.existsSync(lock)) {
  const pid = /^pid=(\d+)$/m.exec(fs.readFileSync(lock, "utf8"))[1];
  fs.writeFileSync(process.env.FAKE_TERM_SENT, pid);
  execFileSync("bash", ["-c", `kill -TERM ${pid}`]);
}
if (args.join(" ") === "ls -g --depth=0 --json") process.stdout.write(JSON.stringify({ name: "npm", dependencies: {} }));
else if (args.join(" ") === "prefix -g") process.stdout.write(process.env.FAKE_NPM_PREFIX + "\n");
JS
  fake_npm="$ROOT/fake-npm.js"
  ! command -v cygpath >/dev/null 2>&1 || fake_npm="$(cygpath -m "$fake_npm")"
  config="$ROOT/kherep-config"; mkdir -p "$config/control-plane"
  ! command -v cygpath >/dev/null 2>&1 || config="$(cygpath -m "$config")"
  set +e
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 \
    SKIP_SECRETS=1 SKIP_DEPS=0 FAKE_NPM_PREFIX="$ROOT/npm-prefix" KHEREP_CONFIG_DIR="$config" \
    FAKE_PAUSE_LOCK="$config/control-plane/install.lock" FAKE_TERM_SENT="$config/term-sent" \
    KHEREP_NPM_BIN="$(node -p 'process.execPath')" KHEREP_NPM_BIN_ARGS_JSON="[\"$fake_npm\"]" \
    KHEREP_CLAUDE_BIN="$ROOT/no-such-claude" bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [[ -f "$ROOT/kherep-config/term-sent" ]] || { cat "$ROOT/log"; fail "the fake npm never saw the Claude probe lock"; }
  [[ "$rc" -eq 143 ]] || { cat "$ROOT/log"; fail "a TERM during the deps phase did not exit 143 (rc=$rc)"; }
  [[ ! -e "$ROOT/kherep-config/control-plane/install.lock" ]] || fail "the EXIT trap left the Claude probe lock behind"
  ! grep -q 'install: claude ready\|install: claude probe' "$ROOT/log" || fail "a terminated install still ran the readiness check"
  [[ ! -e "$C/backups/bootstrap/.install.lock" ]] || fail "the terminated install kept the bootstrap lock"
}

# OP-1085: the deps phase runs AFTER the commit and must not be able to undo an
# install. The fake npm answers every install with the Mac EEXIST; the plugin
# step fails too, via an unreachable claude binary. The install is forced through
# the pinned manifest entry instead of the original `bun` line: a real bun on the
# host PATH would legitimately hit the present-outside-npm skip and make the
# assertion host-dependent (that branch has its own case in npm-globals.test.mts).
# Expected: COMMITTED, no rollback, the gitconfig phase still ran, exit 1, and
# the managed files on disk pass drift-check.
test_deps_failure() {
  local rc b fake_npm config
  fixture deps
  cat > "$ROOT/fake-npm.js" <<'JS'
"use strict";
const fs = require("node:fs");
const args = process.argv.slice(2);
// Issue #403: the deps phase runs while the node's Claude probe lock exists.
if (fs.existsSync(process.env.FAKE_PAUSE_LOCK)) fs.writeFileSync(process.env.FAKE_PAUSE_SEEN, "seen");
const signature = args.join(" ");
// Everything satisfied except the pinned transport entry, which must install.
const dependencies = {
  "@anthropic-ai/claude-code": { version: "9.9.9" },
  "@forge/cli": { version: "9.9.9" },
  "@openai/codex": { version: "9.9.9" },
  "claude-baton": { version: "9.9.9" },
  "mcp-remote": { version: "9.9.9" },
  supergateway: { version: "3.0.0" },
  bun: { version: "9.9.9" },
};
if (signature === "ls -g --depth=0 --json") {
  process.stdout.write(JSON.stringify({ name: "npm", dependencies }));
} else if (signature === "prefix -g") {
  process.stdout.write(process.env.FAKE_NPM_PREFIX + "\n");
} else if (args.slice(0, 2).join(" ") === "i -g") {
  process.stderr.write(`EEXIST: file already exists (${args[2]})\n`);
  process.exit(1);
} else {
  process.exit(64);
}
JS
  # Git Bash rewrites POSIX paths in argv for native programs, never in the
  # environment: the fake path travels in KHEREP_NPM_BIN_ARGS_JSON and must
  # already be Windows-shaped when node opens it.
  fake_npm="$ROOT/fake-npm.js"
  ! command -v cygpath >/dev/null 2>&1 || fake_npm="$(cygpath -m "$fake_npm")"
  # Issue #403. A throwaway enrolled node directory: the install pauses its
  # Claude probe there, never in the host's real node directory.
  config="$ROOT/kherep-config"; mkdir -p "$config/control-plane"
  ! command -v cygpath >/dev/null 2>&1 || config="$(cygpath -m "$config")"
  # This is the only case here that runs past the commit into C2 and C3. Both
  # read real per-host state (the knowledge space, the Atlassian credential) and
  # check it live, so they sit behind their skip switches like in smoke-test.sh.
  set +e
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 \
    SKIP_SECRETS=1 SKIP_DEPS=0 FAKE_NPM_PREFIX="$ROOT/npm-prefix" KHEREP_CONFIG_DIR="$config" \
    FAKE_PAUSE_LOCK="$config/control-plane/install.lock" FAKE_PAUSE_SEEN="$config/pause-seen" \
    KHEREP_NPM_BIN="$(node -p 'process.execPath')" KHEREP_NPM_BIN_ARGS_JSON="[\"$fake_npm\"]" \
    KHEREP_CLAUDE_BIN="$ROOT/no-such-claude" bash "$HERE/install.sh" > "$ROOT/log" 2>&1
  rc=$?
  set -e
  [[ "$rc" -eq 1 ]] || fail "failing deps phase did not exit 1 (rc=$rc)"
  grep -q 'npm-globals: supergateway install (pinned' "$ROOT/log" || fail "manifest pin was not enforced"
  grep -q 'npm-globals: supergateway FAILED' "$ROOT/log" || fail "fake npm EEXIST was not reported"
  grep -q 'install: DONE WITH ERRORS' "$ROOT/log" || fail "failing deps phase lacks the DONE WITH ERRORS verdict"
  [[ -f "$ROOT/kherep-config/pause-seen" ]] || fail "the deps phase ran without the node's Claude probe lock"
  [[ ! -e "$ROOT/kherep-config/control-plane/install.lock" ]] || fail "the install left the Claude probe lock behind"
  grep -q 'install: claude sign-in status unreadable before the deps phase' "$ROOT/log" || fail "the sign-in pre-check did not run"
  grep -q 'install: claude probe inconclusive' "$ROOT/log" || fail "the end-of-install Claude readiness check did not run"
  grep -q "install: git core.hooksPath -> $C/kherep/githooks" "$ROOT/log" ||
    fail "gitconfig phase was skipped after the deps failure"
  [[ ! -e "$GIT_CONFIG_SYSTEM" ]] || fail "an install without KHEREP_INSTALL_SYSTEM_HOOKSPATH=1 wrote the system scope"
  b="$(latest "$H")"
  [[ -f "$b/COMMITTED" ]] || fail "deps failure left the transaction uncommitted"
  [[ ! -e "$b/ROLLED-BACK" ]] && [[ ! -e "$b/ACTIVE" ]] || fail "deps failure rolled the managed files back"
  ! compgen -G "$C/backups/bootstrap/preflight-*" >/dev/null || fail "deps failure left the preflight behind"
  [[ ! -e "$C/backups/bootstrap/.install.lock" ]] || fail "deps failure kept the install lock"
  cmp "$C/statusline-command.sh" "$HERE/../claude/statusline-command.sh" >/dev/null ||
    fail "deps failure did not leave the managed file installed"
  # Issue #436: the install rendered the intercom command for this config root,
  # so drift-check renders against the same one.
  HOME="$H" CLAUDE_HOME="$C" KHEREP_PROFILE=win KHEREP_WORKSPACE="$W" KHEREP_CREDENTIALS_ROOT="$R" \
    KHEREP_CONFIG_DIR="$config" bash "$HERE/drift-check.sh" > "$ROOT/drift.log" 2>&1 ||
    { cat "$ROOT/drift.log"; fail "drift-check failed after a committed install with a failed deps phase"; }
}

# Issue #276. Every test after test_lock writes only to its own log, and under
# Git Bash on Windows the run takes about 12 minutes, so a silent run looked
# like a hang. Name each test on stderr as it starts.
for tx_test in test_library test_retire test_retire_declared test_lock test_preflights test_path_guards \
  test_partial test_term test_commit_signal test_secrets test_deps_term_releases_probe_lock test_deps_failure test_default_confluence_brokers \
  test_model_policy test_upgrade_retires_mpac test_upgrade_retires_js_hooks test_upgrade_retires_twg_wrapper test_upgrade_unwires_legacy_hooks \
  test_upgrade_moves_clq_to_stop test_upgrade_retires_guard_js_hooks; do
  echo "transaction test: $tx_test (${SECONDS}s)" >&2
  "$tx_test"
done
host_hooks_paths > "$TMP/host-hooks-path.after"
cmp -s "$TMP/host-hooks-path.before" "$TMP/host-hooks-path.after" ||
  fail "the host's system or global core.hooksPath changed during the run"
echo 'TRANSACTION TEST PASS'
