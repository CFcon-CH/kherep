#!/usr/bin/env bash
# Installs both host profiles into throwaway homes and asserts layout, merge,
# identity, profile rendering, and drift behavior. NEVER touches real ~/.claude,
# with one deliberate exception: the run report under ~/.claude/.cache/smoke-test
# (nothing managed, and the only way smoke-test-nudge.mts can see this ran).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"
. "$HERE/profile.sh"
TMP="$(mktemp -d)"

# Leave the result behind for claude/hooks/smoke-test-nudge.mts, with the same
# staged rename bootstrap/drift-check.sh uses: readers keep seeing the previous
# complete report while a run is in flight. CLAUDE_HOME is resolved HERE because
# check_profile rebinds it to a throwaway home. An unwritable cache means no
# report, never a failed run.
REPORT=""
REPORT_TMP=""
REPORT_DIR="${CLAUDE_HOME:-$HOME/.claude}/.cache/smoke-test"
if [ -d "$REPORT_DIR" ] || mkdir -p "$REPORT_DIR" 2>/dev/null; then
  REPORT="$REPORT_DIR/last-report.txt"
  REPORT_TMP="$(mktemp "$REPORT_DIR/.last-report.XXXXXX" 2>/dev/null || true)"
  if [ -n "$REPORT_TMP" ]; then
    exec 3>&1
    exec 1>"$REPORT_TMP"
  fi
fi
# The temp report dies with the run unless publish_report renames it, so an
# aborted run never publishes a partial report over a complete one.
trap 'rm -rf "$TMP"; [ -z "$REPORT_TMP" ] || rm -f "$REPORT_TMP"' EXIT

publish_report() {
  [ -n "$REPORT_TMP" ] || return 0
  exec 1>&3
  cat "$REPORT_TMP"
  if mv -f "$REPORT_TMP" "$REPORT" 2>/dev/null; then REPORT_TMP=""; fi
}
mkdir -p "$TMP/repo"
case "${SMOKE_SOURCE:-head}" in
  head) git -C "$REPO" archive HEAD | tar -x -C "$TMP/repo" ;;
  working-tree) tar --exclude=.git -cf - -C "$REPO" . | tar -xf - -C "$TMP/repo" ;;
  *) echo "SMOKE FAIL: SMOKE_SOURCE must be head or working-tree"; exit 1 ;;
esac
SUBTEST_TIMEOUT="${SMOKE_SUBTEST_TIMEOUT:-1800}"
case "$SUBTEST_TIMEOUT" in
  ''|*[!0-9]*) SUBTEST_TIMEOUT=0 ;;
esac
[ "$((10#$SUBTEST_TIMEOUT))" -gt 0 ] || {
  echo "SMOKE FAIL: SMOKE_SUBTEST_TIMEOUT must be a positive number of seconds" >&2; exit 1;
}

fail=0

# The single place a failing assertion is allowed to leave the script. Every
# finding therefore carries exactly one machine-readable marker, so
# claude/hooks/smoke-test-nudge.mts can match a contract instead of guessing at
# line shapes. Context output (a drift dump, a sub-test's own log) stays
# unmarked on purpose - it explains a finding, it is not one.
# GRUND: the old ALL-CAPS heuristic counted the 13 `PASS ...` lines from the
# bootstrap sub-tests as findings and reported 19 where four were real (OP-669).
FINDING_MARKER="SMOKE-FINDING"
note_fail() { echo "$FINDING_MARKER $*"; fail=1; }

# Issue #278: `node --check` never type-strips a .mts and exits 0 for any file
# with import or export, so `export const x = ;` passed. hook-syntax.mts runs
# Node's load-time parsers without executing the hook and exits 0 OK, 1 DEFEKT,
# 2 UNGEPRUEFT. Only a proven OK passes. UNGEPRUEFT, a missing checker and any
# other exit are findings marked UNCHECKED: a hook nobody could parse may be one
# that fails open, and a line without the marker never reaches the nudge.
# Usage: hook_syntax <checker> <label> <context> <file>
hook_syntax() {
  local checker="$1" label="$2" context="$3" file="$4" err="$TMP/hook-syntax.err" out rc=0
  [ -f "$checker" ] || { note_fail "$label UNCHECKED $context (checker missing: $checker)"; return 0; }
  out="$(node "$checker" "$file" 2>"$err")" || rc=$?
  # First line only, and no CR, so a CRLF stdout cannot turn OK into a finding.
  out="${out%%$'\n'*}"
  out="${out%$'\r'}"
  case "$rc:$out" in
    0:OK) ;;
    1:DEFEKT\ *) note_fail "$label $context (${out#DEFEKT })" ;;
    2:UNGEPRUEFT\ *) note_fail "$label UNCHECKED $context (${out#UNGEPRUEFT })" ;;
    *) out="${out:-$(grep -m 1 -E '^[A-Za-z]*Error\b' "$err" 2>/dev/null || head -n 1 "$err" 2>/dev/null)}"
       note_fail "$label UNCHECKED $context (checker exit $rc${out:+: $out})" ;;
  esac
}

# Issue #276. A sub-test that never returns must become a finding, or the run
# never prints the results it buffered above. --foreground keeps Ctrl-C reaching
# the sub-test; on expiry only the sub-test's own bash is signalled, so its
# children may outlive it. An exit of 124 or 137 reads as a timeout. Without GNU
# timeout (stock macOS, or Windows timeout.exe first in PATH) it runs unbounded.
run_bounded() {
  local secs="$1" bin
  shift
  bin="$(command -v timeout || command -v gtimeout || true)"
  case "$([ -z "$bin" ] || "$bin" --version 2>/dev/null </dev/null)" in
    *'GNU coreutils'*) "$bin" --foreground -k 30 "$secs" "$@" ;;
    *) echo "smoke: no GNU timeout, running the sub-test unbounded" >&2; "$@" ;;
  esac
}

check_profile() {
  local profile="$1" host_home="$TMP/$1/home" workspace credentials extra_plugin
  export HOME="$host_home" CLAUDE_HOME="$host_home/.claude" KHEREP_PROFILE="$profile"
  export SKIP_SECRETS=1 SKIP_DEPS=1 KHEREP_WORK_ITEM_REQUIRED=1
  # The property under test is "install preserves a plugin the manifest does not
  # manage", so the name only has to be unmanaged - it must NOT be a real plugin
  # an operator happens to have installed. A real name makes the fixture read
  # like a product capability and drags one operator's inventory into the
  # contract every contributor's machine is measured against.
  extra_plugin="fixture-extra@fixture"
  if [ "$profile" = "mac" ]; then
    unset KHEREP_WORKSPACE KHEREP_CREDENTIALS_ROOT
    workspace="$host_home/Kherep"
    credentials="$host_home/.kherep/credentials"
  else
    workspace="$host_home/ws"
    credentials="$host_home/credentials"
    export KHEREP_WORKSPACE="$workspace" KHEREP_CREDENTIALS_ROOT="$credentials"
  fi
  mkdir -p "$CLAUDE_HOME" "$workspace/.claude" "$credentials"
  mkdir -p "$CLAUDE_HOME/skills/codebase-memory"
  printf '%s\n' '# stale managed file fixture' > "$CLAUDE_HOME/skills/codebase-memory/obsolete.md"

  # A malformed live settings file must fail during preflight, before any
  # managed target is replaced.
  mkdir -p "$CLAUDE_HOME/hooks"
  printf '%s\n' 'preflight-mutation-sentinel' > "$CLAUDE_HOME/hooks/maestro-discipline.mts"
  printf '%s\n' '{malformed-json' > "$CLAUDE_HOME/settings.json"
  if bash "$TMP/repo/bootstrap/install.sh" >/dev/null 2>&1; then
    note_fail "INSTALL [$profile]: malformed settings passed preflight"; return
  fi
  grep -q '^preflight-mutation-sentinel$' "$CLAUDE_HOME/hooks/maestro-discipline.mts" || {
    note_fail "INSTALL [$profile]: preflight failure mutated managed state"; return;
  }

  # Existing host settings are a preflight fixture. The managed core must update
  # while unknown preferences/hooks and enabled plugins remain enabled.
  node -e '
  const fs=require("fs"),p=process.argv[1],plugin=process.argv[2];
  fs.writeFileSync(p,JSON.stringify({fixturePreference:true,enabledPlugins:{[plugin]:true},permissions:{allow:["Bash(curl http://localhost:8000*)"]},hooks:{SessionStart:[{matcher:"fixture-only",hooks:[{type:"command",command:"true"}]}],UserPromptSubmit:[{matcher:"",hooks:[{type:"command",command:"fixture-same-matcher"}]}]}},null,2));
  ' "$CLAUDE_HOME/settings.json" "$extra_plugin"
  node -e '
  const fs=require("fs"),p=process.argv[1];
  fs.writeFileSync(p,JSON.stringify({permissions:{allow:["Bash(fixture:*)"],additionalDirectories:["C:\\\\fixture","D:\\\\fixture","//server/share","/d/Work","/opt/kherep-fixture"]},hooks:{Stop:[{matcher:"fixture-only",hooks:[{type:"command",command:"true"}]}]}},null,2));
  ' "$workspace/.claude/settings.local.json"

  printf '%s\n' "{\"profile\":\"$profile\",\"secret\":true}" > "$CLAUDE_HOME/.mcp.json"
  printf '%s\n' '#!/usr/bin/env bash' "echo $profile-unmanaged-helper" > "$CLAUDE_HOME/unmanaged-helper.sh"
  cp "$CLAUDE_HOME/.mcp.json" "$host_home/mcp.before"
  cp "$CLAUDE_HOME/unmanaged-helper.sh" "$host_home/unmanaged-helper.before"

  # Mac-only live extras are deliberately seeded; install must preserve them.
  # The historic lmstudio name is a managed compatibility entrypoint and is
  # deliberately upgraded in place to the runner-only implementation.
  if [ "$profile" = "mac" ]; then
    mkdir -p "$CLAUDE_HOME/agents" "$CLAUDE_HOME/skills/pinokio" "$CLAUDE_HOME/commands"
    printf '%s\n' '---' 'name: lmstudio-mac-researcher' '---' > "$CLAUDE_HOME/agents/lmstudio-mac-researcher.md"
    printf '%s\n' '---' 'name: pinokio' '---' > "$CLAUDE_HOME/skills/pinokio/SKILL.md"
    printf '%s\n' '# memo-eod fixture' > "$CLAUDE_HOME/commands/memo-eod.md"
  fi

  # core.hooksPath is machine-wide git state, not a managed file. The installer
  # writes it for real; a smoke run must not rewrite the developer's git config.
  # The Confluence knowledge space is the same kind of host binding: a throwaway
  # home has no space key and no terminal, and the space only resolves through
  # the broker with the real service-account credential. So is that credential:
  # without the switch the step would read the host's real credential file named
  # by KHEREP_ATL_CRED_FILE_CLAUDE and check it live against Atlassian.
  if ! KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 \
    bash "$TMP/repo/bootstrap/install.sh" >/dev/null; then
    note_fail "INSTALL [$profile]: install.sh exited non-zero"; return
  fi

  local must_exist=(
    hooks/maestro-discipline.mts hooks/clq-accept-gate.mts
    hooks/privacy-boundary-guard.mts hooks/runtime-capability-snapshot.mts
    hooks/portable-scope-hooks.test.mts
    hooks/lib/private-path-policy.mts hooks/lib/private-path-rules.mts
    hooks/lib/workspace-scope.mts hooks/lib/workspace-scope.test.mts
    hooks/lib/hook-inventory.mts hooks/lib/hook-syntax.mts hooks/lib/restore-write.mts
    hooks/cbm-code-discovery-gate hooks/cbm-session-reminder hooks/cbm-subagent-reminder
    skills/codebase-memory skills/kherep-twg skills/brain-drainage agents/kherep-builder.md
    teams/kherep/ROUTING.md teams/kherep/config.json
    session-kickoff/protocol.md settings.json CLAUDE.md
    statusline-command.sh kherep/local-inference/runner.mts
    kherep/local-inference/lib/profile.mts kherep/local-inference/lib/transport.mts kherep/local-inference/config.json kherep/twg/cli.mts
    kherep/githooks/commit-msg kherep/githooks/post-checkout
    kherep/githooks/pre-push kherep/githooks/attribution-record.mts
    hooks/main-checkout-guard.mts hooks/lib/main-checkout.mts hooks/lib/command-walk.mts
    mods/usage-band/hooks/register.mts
  )
  for file in "${must_exist[@]}"; do
    [ -e "$CLAUDE_HOME/$file" ] || { note_fail "MISSING [$profile] $file"; }
  done

  # The work-item commit hook must be executable and must actually reject a
  # keyless subject. A hook that is present but not runnable looks healthy from
  # the outside and enforces nothing, which is the failure mode this whole rule
  # exists to prevent.
  if [ -e "$CLAUDE_HOME/kherep/githooks/commit-msg" ]; then
    [ -x "$CLAUDE_HOME/kherep/githooks/commit-msg" ] || {
      note_fail "COMMIT-MSG hook not executable [$profile]";
    }
    # Profile-scoped and freshly created: TMP is allocated once for the whole
    # run, so a shared probe repo would still carry the previous profile's
    # commit. The second profile then fails on "nothing to commit" and the
    # assertion misreads that as a hook rejection.
    local hookrepo="$TMP/hookcheck-$profile/Work/probe"
    rm -rf "$hookrepo"
    mkdir -p "$hookrepo"
    ( cd "$hookrepo" && git init -q . && git config user.email s@example.com \
      && git config user.name Smoke && echo probe > p.txt && git add p.txt \
      && KHEREP_WORKSPACE="$TMP/hookcheck-$profile/Work" git -c core.hooksPath="$CLAUDE_HOME/kherep/githooks" commit -q -m "fix: no key" >/dev/null 2>&1 ) \
      && { note_fail "COMMIT-MSG hook accepted a keyless subject [$profile]"; }
    ( cd "$hookrepo" && KHEREP_WORKSPACE="$TMP/hookcheck-$profile/Work" git -c core.hooksPath="$CLAUDE_HOME/kherep/githooks" commit -q -m "ABC-1 fix: with key" >/dev/null 2>&1 ) \
      || { note_fail "COMMIT-MSG hook rejected a valid subject [$profile]"; }
  fi
  # Issue #325. git skips a hook without the mode bit silently, like commit-msg.
  if [ -e "$CLAUDE_HOME/kherep/githooks/post-checkout" ] && [ ! -x "$CLAUDE_HOME/kherep/githooks/post-checkout" ]; then
    note_fail "POST-CHECKOUT hook not executable [$profile]"
  fi
  # Issue #325, PR-A. The same silent skip would leave pushes unattributed.
  if [ -e "$CLAUDE_HOME/kherep/githooks/pre-push" ] && [ ! -x "$CLAUDE_HOME/kherep/githooks/pre-push" ]; then
    note_fail "PRE-PUSH hook not executable [$profile]"
  fi
  node -e 'require(process.argv[1]);require(process.argv[2]);require(process.argv[3]);require(process.argv[4]);require(process.argv[5]);require(process.argv[6])' \
    "$CLAUDE_HOME/hooks/lib/workspace-scope.mts" "$CLAUDE_HOME/hooks/lib/private-path-policy.mts" \
    "$CLAUDE_HOME/hooks/lib/git-commit-match.mts" "$CLAUDE_HOME/hooks/lib/main-checkout.mts" \
    "$CLAUDE_HOME/hooks/lib/git-push-match.mts" "$CLAUDE_HOME/hooks/lib/forge-match.mts" || {
      note_fail "HOOK dependency resolution failed [$profile]";
    }
  printf '{}\n' | node "$CLAUDE_HOME/hooks/privacy-boundary-guard.mts" >/dev/null || {
    note_fail "INSTALLED privacy guard failed to execute [$profile]";
  }
  printf '{}\n' | node "$CLAUDE_HOME/hooks/commit-guard.mts" >/dev/null || {
    note_fail "INSTALLED commit guard failed to execute [$profile]";
  }
  printf '{}\n' | node "$CLAUDE_HOME/hooks/main-checkout-guard.mts" >/dev/null || {
    note_fail "INSTALLED main-checkout guard failed to execute [$profile]";
  }
  [ -e "$workspace/.claude/settings.local.json" ] || { note_fail "MISSING [$profile] project settings"; }
  [ -e "$workspace/CLAUDE.md" ] || { note_fail "MISSING [$profile] project CLAUDE.md"; }
  # OP-1432. The Confluence set ships with the observation agent: present by default.
  local confluence_tools=(atlassian-credentials.mts atlassian-cli-args.mts atl-confluence.mts atl-confluence-ccoder.mts confluence-contract.mts confluence-content.mts confluence-session.mts confluence-related.mts confluence-text-search.mts confluence-semantic.mts confluence-neighbours.mts confluence-neighbour-cli.mts confluence-topic-query.mts confluence-candidates.mts confluence-stitch.mts confluence-list-cli.mts confluence-runtime-label.mts confluence-label-cli.mts confluence-pagination.mts confluence-drainage-rules.mts confluence-drainage-snapshot.mts confluence-drainage-scan.mts confluence-drainage-cli.mts confluence-evidence.mts confluence-evidence-report.mts confluence-evidence-io.mts confluence-evidence-cli.mts confluence-claim-text.mts confluence-revision-staleness.mts confluence-revision-staleness-git.mts)
  for tool in "${confluence_tools[@]}"; do
    cmp -s "$TMP/repo/modules/atl-jira-brokers/$tool" "$workspace/tools/$tool" || {
      note_fail "CONFLUENCE BROKER [$profile]: default install did not project $tool";
    }
  done
  local atlassian_tools=(atl-jira.mts atl-jira-ccoder.mts jira-adf.mts jira-adf-text.mts jira-attach.mts jira-download.mts jira-config.mts jira-transition-guard.mts jira-fields.mts jira-links.mts jira-search.mts jira-discovery.mts)
  for tool in "${atlassian_tools[@]}"; do
    [ ! -e "$workspace/tools/$tool" ] || {
      note_fail "OPTIONAL TOOL [$profile]: default install projected $tool";
    }
  done
  if ! KHEREP_INSTALL_SKIP_GITCONFIG=1 KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE=1 KHEREP_INSTALL_ATLASSIAN_TOOLS=1 \
    KHEREP_INSTALL_SKIP_ATL_CREDENTIAL=1 \
    bash "$TMP/repo/bootstrap/install.sh" >/dev/null; then
    note_fail "OPTIONAL TOOL [$profile]: explicit tools install failed"
  else
    for tool in "${atlassian_tools[@]}" "${confluence_tools[@]}"; do
      cmp -s "$TMP/repo/modules/atl-jira-brokers/$tool" "$workspace/tools/$tool" || {
        note_fail "OPTIONAL TOOL [$profile]: $tool is not projected from its canonical source";
      }
    done
  fi
  [ ! -e "$CLAUDE_HOME/skills/codebase-memory/obsolete.md" ] || { note_fail "STALE managed skill file survived [$profile]"; }
  compgen -G "$CLAUDE_HOME/backups/bootstrap/*/skills/codebase-memory/obsolete.md" >/dev/null || {
    note_fail "STALE managed skill backup missing [$profile]";
  }

  # Deprecated source content must not leak into a clean profile. Pre-existing
  # Mac baseline extras are the explicit compatibility exception.
  local must_absent=( skills/intake hooks/em-dash-watch.js hooks/memo-retro-reminder.js )
  [ "$profile" = "mac" ] && must_absent=( skills/intake hooks/em-dash-watch.js hooks/memo-retro-reminder.js )
  for file in "${must_absent[@]}"; do
    [ -e "$CLAUDE_HOME/$file" ] && { note_fail "LEAKED deprecated [$profile] $file"; }
  done
  if [ "$profile" = "mac" ]; then
    [ -e "$CLAUDE_HOME/agents/lmstudio-mac-researcher.md" ] || { note_fail "REMOVED Mac legacy agent"; }
    [ -e "$CLAUDE_HOME/skills/pinokio/SKILL.md" ] || { note_fail "REMOVED Mac extra skill"; }
    [ -e "$CLAUDE_HOME/commands/memo-eod.md" ] || { note_fail "REMOVED Mac extra command"; }
  fi

  node -e '
  const fs=require("fs");const u=JSON.parse(fs.readFileSync(process.argv[1]));const p=JSON.parse(fs.readFileSync(process.argv[2]));
  if(!u.fixturePreference||!u.enabledPlugins[process.argv[3]])process.exit(1);
  if(!(u.hooks.SessionStart||[]).some(h=>h.matcher==="fixture-only"))process.exit(2);
  if(!(u.hooks.UserPromptSubmit||[]).some(h=>h.matcher===""&&(h.hooks||[]).some(x=>x.command==="fixture-same-matcher")))process.exit(5);
  if((u.permissions.allow||[]).some(x=>/localhost:8000/.test(x)))process.exit(6);
  if(!(p.permissions.allow||[]).includes("Bash(fixture:*)"))process.exit(3);
  if(!(p.hooks.Stop||[]).some(h=>h.matcher==="fixture-only"))process.exit(4);
  ' "$CLAUDE_HOME/settings.json" "$workspace/.claude/settings.local.json" "$extra_plugin" || {
    note_fail "SETTINGS MERGE failed [$profile]";
  }
  if [ "$profile" = "mac" ]; then
    node -e '
    const fs=require("fs"),p=JSON.parse(fs.readFileSync(process.argv[1]));
    const {resolveProfilePath}=require(process.argv[5]);
    const ws=resolveProfilePath("mac",process.argv[2]);
    const nativeMacWorkspace=ws.startsWith("/")&&!/^\/[a-z]\//i.test(ws);
    const want=[...(nativeMacWorkspace?[ws]:[]),"/opt/kherep-fixture"];const got=p.permissions.additionalDirectories;
    if(JSON.stringify(got)!==JSON.stringify(want))process.exit(1);
    ' "$workspace/.claude/settings.local.json" "$workspace" "$credentials" "$CLAUDE_HOME" "$TMP/repo/bootstrap/render-profile-paths.mts" || {
      note_fail "MAC additionalDirectories rendering failed";
    }
  fi
  node -e '
  const c=require(process.argv[1]);if(c.installedProfile!==process.argv[2]||!c.profiles||!c.profiles[process.argv[2]])process.exit(1)
  ' "$CLAUDE_HOME/kherep/local-inference/config.json" "$profile" || {
    note_fail "LOCAL-INFERENCE profile rendering failed [$profile]";
  }
  for alias in lmstudio-win-researcher.md lmstudio-mac-researcher.md; do
    # Issue #737: installed agents are the source rendered from the model policy.
    node "$TMP/repo/bootstrap/model-policy-render.mts" agent "$TMP/repo/claude/agents/$alias" "$host_home/rendered-$alias" \
      "$TMP/repo/claude/kherep/model-policy.json" "$CLAUDE_HOME/kherep/model-policy.user.json" &&
      cmp -s "$host_home/rendered-$alias" "$CLAUDE_HOME/agents/$alias" || { note_fail "COMPAT alias source mismatch [$profile]: $alias"; }
    grep -Eq 'http://192\.168\.|curl ' "$CLAUDE_HOME/agents/$alias" && { note_fail "COMPAT alias leaked direct LAN/curl [$profile]: $alias"; }
  done
  cmp "$CLAUDE_HOME/.mcp.json" "$host_home/mcp.before" >/dev/null || { note_fail "MCP secret overwritten [$profile]"; }
  cmp "$CLAUDE_HOME/unmanaged-helper.sh" "$host_home/unmanaged-helper.before" >/dev/null || { note_fail "Unmanaged helper secret overwritten [$profile]"; }
  compgen -G "$CLAUDE_HOME/backups/bootstrap/*/settings.json" >/dev/null || { note_fail "SETTINGS backup missing [$profile]"; }

  local wired_hooks
  wired_hooks="$(node -e '
  const fs=require("fs");const names=new Set();
  for(const f of process.argv.slice(1)){const j=JSON.parse(fs.readFileSync(f));const walk=o=>{if(Array.isArray(o)){o.forEach(walk);return}if(o&&typeof o==="object"){if(typeof o.command==="string"){for(const m of o.command.matchAll(/(?:__KHEREP_CLAUDE_HOME__|~\/\.claude)\/hooks\/([\w.-]+\.(?:js|mts))\b/g))names.add(m[1])}Object.values(o).forEach(walk)}};walk(j.hooks||{})}
  process.stdout.write([...names].sort().join("\n"));
  ' "$TMP/repo/claude/settings.user.json" "$TMP/repo/claude/settings.project.json")" || { note_fail "WIRED-HOOK extraction failed [$profile]"; wired_hooks=""; }
  [ -n "$wired_hooks" ] || { note_fail "WIRED-HOOK list empty [$profile]"; }
  while IFS= read -r hook; do
    [ -z "$hook" ] && continue
    local src="$TMP/repo/claude/hooks/$hook" live="$CLAUDE_HOME/hooks/$hook"
    if [ ! -f "$src" ]; then note_fail "HOOK MISSING [$profile]: $hook"
    elif [ ! -s "$src" ]; then note_fail "HOOK EMPTY [$profile]: $hook"
    else hook_syntax "$TMP/repo/claude/hooks/lib/hook-syntax.mts" "HOOK SYNTAX" "[$profile]: $hook" "$src"
    fi
    # The repo side says nothing about what actually runs. A wired hook that is
    # empty or unparseable AFTER install still runs, does nothing and exits 0 -
    # fail-open, and invisible to any repo-only assertion.
    # GRUND: 2026-08-05 commit-guard.js sat at 0 bytes live for 19 hours while
    # the repo source stayed correct.
    # The checker is the installed lib, the one live-hook-integrity imports, with
    # no fallback to the repo copy: a missing or broken installed lib is a
    # finding here, not hidden behind a healthy repo.
    if [ ! -f "$live" ]; then note_fail "LIVE HOOK MISSING [$profile]: $hook"
    elif [ ! -s "$live" ]; then note_fail "LIVE HOOK EMPTY [$profile]: $hook (0 bytes runs and enforces nothing)"
    else hook_syntax "$CLAUDE_HOME/hooks/lib/hook-syntax.mts" "LIVE HOOK SYNTAX" "[$profile]: $hook" "$live"
    fi
  done <<< "$wired_hooks"

  if [ "$profile" = "mac" ]; then
    node -e '
    const fs=require("fs"),u=JSON.parse(fs.readFileSync(process.argv[1])),p=JSON.parse(fs.readFileSync(process.argv[2]));
    const values=[];const walk=v=>{if(typeof v==="string")values.push(v);else if(Array.isArray(v))v.forEach(walk);else if(v&&typeof v==="object")Object.values(v).forEach(walk)};
    walk(u);walk(p);const {resolveProfilePath}=require(process.argv[5]);
    const ws=resolveProfilePath("mac",process.argv[3]),credentials=resolveProfilePath("mac",process.argv[4]);
    const readDrive=new RegExp("^Read\\\\(/{1,2}[A-Za-z]/{1,2}\\\\*\\\\*\\\\)$","i");
    const forbidden=values.some(value=>{const v=value.toLowerCase();return v.includes("d:\\\\work")||v.includes("d:/work")||v.includes("/d/work")||v.includes("//d/work")||v.includes("c:\\\\users\\\\example\\\\.claude")||v.includes("c:/users/example/.claude")||readDrive.test(value)});
    if(forbidden){console.error("mac settings check: forbidden Windows path");process.exit(1)}
    const nativeMacPaths=!/^\/[a-z]\//i.test(ws);
    if(nativeMacPaths&&!(p.permissions.additionalDirectories||[]).includes(ws)){console.error("mac settings check: workspace directory missing");process.exit(2)}
    if((p.permissions.additionalDirectories||[]).includes(credentials)){console.error("mac settings check: credentials directory was auto-granted");process.exit(3)}
    ' "$CLAUDE_HOME/settings.json" "$workspace/.claude/settings.local.json" "$workspace" "$credentials" "$TMP/repo/bootstrap/render-profile-paths.mts" || {
      note_fail "MAC settings retained a Windows-only path or lost a translated permission";
    }
  fi
  node -e 'const j=require(process.argv[1]);process.exit((j.members||[]).some(m=>m.cwd)?1:0)' "$CLAUDE_HOME/teams/kherep/config.json" || {
    note_fail "team config check failed [$profile]";
  }
  node "$TMP/repo/bootstrap/capability-check.mts" --strict --profile "$profile" >/dev/null || {
    note_fail "CAPABILITY source contract failed [$profile]";
  }
  for hook in cbm-code-discovery-gate cbm-session-reminder cbm-subagent-reminder; do
    bash -n "$CLAUDE_HOME/hooks/$hook" || { note_fail "HOOK shell syntax [$profile]: $hook"; }
    [ -x "$CLAUDE_HOME/hooks/$hook" ] || { note_fail "HOOK not executable [$profile]: $hook"; }
  done
  cmp -s "$TMP/repo/claude/session-kickoff/protocol.md" "$CLAUDE_HOME/session-kickoff/protocol.md" || { note_fail "KICKOFF source mismatch [$profile]"; }
  grep -q '^name: forge-bulk-op-pattern$' "$CLAUDE_HOME/skills/forge-bulk-op-pattern/SKILL.md" || { note_fail "FORGE skill regression [$profile]"; }
  grep -q '"KHEREP_DEPLOY_AUTH"' "$CLAUDE_HOME/settings.json" && { note_fail "PERSISTENT deploy auth [$profile]"; }

  local drift_output
  if ! drift_output="$(bash "$TMP/repo/bootstrap/drift-check.sh" 2>&1)"; then
    echo "$drift_output"
    note_fail "DRIFT-CHECK failed [$profile]"
  fi
  if [ "$profile" = "win" ]; then
    printf '%s\n' '# unexpected live-only managed file' > "$CLAUDE_HOME/skills/codebase-memory/unexpected-live.md"
    if bash "$TMP/repo/bootstrap/drift-check.sh" >/dev/null; then
      note_fail "DRIFT-CHECK missed live-only managed file [$profile]"
    fi
    rm -f "$CLAUDE_HOME/skills/codebase-memory/unexpected-live.md"
  fi
  # OP-1425: only the marked Kherep block counts; operator text outside it is never drift.
  cp "$workspace/CLAUDE.md" "$host_home/CLAUDE.md.before"
  printf '\n# intentional smoke-test operator text\n' >> "$workspace/CLAUDE.md"
  if ! drift_output="$(DRIFT_SCOPE=project bash "$TMP/repo/bootstrap/drift-check.sh" 2>&1)"; then
    echo "$drift_output"
    note_fail "DRIFT-CHECK reported operator text outside the managed block as project drift [$profile]"
  fi
  cp "$host_home/CLAUDE.md.before" "$workspace/CLAUDE.md"
  node -e '
  const fs=require("fs"),p=process.argv[1],m="<!-- kherep-project-rules:start -->",t=fs.readFileSync(p,"utf8");
  if(!t.includes(m))process.exit(1);
  fs.writeFileSync(p,t.replace(m,m+"\n# intentional smoke-test drift"));
  ' "$workspace/CLAUDE.md" || { note_fail "DRIFT fixture: managed block start marker missing in project CLAUDE.md [$profile]"; }
  if DRIFT_SCOPE=project bash "$TMP/repo/bootstrap/drift-check.sh" >/dev/null; then
    note_fail "DRIFT-CHECK missed project drift [$profile]"
  fi
  cp "$host_home/CLAUDE.md.before" "$workspace/CLAUDE.md"
}

# The machine-wide core.hooksPath carries the work-item rule for every runtime,
# including the ones that never see a Claude hook (Codex, IDE, plain terminal).
# A repo-local core.hooksPath silently overrides it, so a single `git config`
# disables the rule for that repo without one error message. Ask git for the
# EFFECTIVE path - reimplementing the precedence would reproduce the same bug one
# level up. Read-only, and it deliberately runs against the real workspace before
# check_profile rebinds HOME/CLAUDE_HOME to a throwaway.
# GRUND: 2026-08-06, DC Apps/scalpel-dc and kherep-linkedin-mcp both pointed
# core.hooksPath at their own empty .git/hooks. A fresh clone falls in the same hole.
check_git_hook_coverage() {
  # OP-1061. Dies ist als einzige Pruefung hier ein HOST-Zustands-Check: sie
  # misst, ob die Repos der Arbeitsumgebung mechanisch an den commit-msg-Guard
  # gebunden sind. Auf einem CI-Runner gibt es diese Arbeitsumgebung nicht - der
  # frische Checkout traegt den Default .git/hooks, es wird dort nie committet,
  # und der Befund waere korrekt gemessen und trotzdem bedeutungslos.
  # Bewusst SICHTBAR uebersprungen statt still: ein Check, der auf einem Runner
  # wortlos wegfaellt, sieht in jedem spaeteren Review aus wie eine bestandene
  # Pruefung. Dieselbe Linie wie die benannte windows-Luecke im smoke-Job.
  # Die Variable wird im Workflow gesetzt, nicht aus $CI abgeleitet: $CI ist ein
  # Fremdsignal, das jedes beliebige System setzt. Wer einen neuen Runner-Job
  # ergaenzt und sie vergisst, bekommt einen roten Job statt einer stillen
  # Luecke - das ist die gewollte Fehlerrichtung.
  if [ "$(kherep_env SMOKE_NO_MANAGED_WORKSPACE 0)" = "1" ]; then
    echo "GITHOOK COVERAGE: uebersprungen - kein verwalteter Workspace auf diesem Host (KHEREP_SMOKE_NO_MANAGED_WORKSPACE=1)"
    return
  fi
  local root="$(kherep_env WORKSPACE "$(cd "$REPO/.." && pwd)")" find_bin entry repo hooks_dir repos=0
  if [ -x /usr/bin/find ]; then find_bin=/usr/bin/find; else find_bin="$(command -v find || true)"; fi
  [ -n "$find_bin" ] || { note_fail "GITHOOK COVERAGE: POSIX find required"; return; }
  [ -d "$root" ] || { note_fail "GITHOOK COVERAGE: workspace does not exist: $root"; return; }
  while IFS= read -r entry; do
    # A stray or empty .git directory is not a repository. Only a gitfile
    # (worktree/submodule) or a .git holding HEAD is one.
    [ -f "$entry" ] || [ -f "$entry/HEAD" ] || continue
    repo="$(dirname "$entry")"
    repos=$((repos + 1))
    if ! hooks_dir="$(git -C "$repo" rev-parse --git-path hooks 2>"$TMP/githook-err")"; then
      # Unresolvable is UNKNOWN, not clean (goldene Regel #12).
      note_fail "GITHOOK UNRESOLVED $repo: $(head -n 1 "$TMP/githook-err" 2>/dev/null)"; continue
    fi
    case "$hooks_dir" in /*|[A-Za-z]:*) ;; *) hooks_dir="$repo/$hooks_dir" ;; esac
    if [ ! -f "$hooks_dir/commit-msg" ]; then
      note_fail "GITHOOK MISSING $repo: no commit-msg in effective hooksPath $hooks_dir"
    elif [ ! -s "$hooks_dir/commit-msg" ]; then
      note_fail "GITHOOK EMPTY $repo: commit-msg is 0 bytes in $hooks_dir"
    elif [ ! -x "$hooks_dir/commit-msg" ]; then
      note_fail "GITHOOK NOT-EXECUTABLE $repo: git skips a non-executable hook in $hooks_dir"
    fi
  done < <("$find_bin" "$root" -maxdepth 4 \
    \( -name node_modules -o -name _deprecated \) -prune -o -name .git -print -prune 2>/dev/null)
  # An empty scan is a broken scan, not a clean workspace: this checkout itself
  # always sits under the workspace.
  [ "$repos" -gt 0 ] || { note_fail "GITHOOK COVERAGE: no git repository found under $root"; }
}
check_git_hook_coverage

for smoke_profile in ${SMOKE_PROFILES:-win mac}; do
  case "$smoke_profile" in win|mac) check_profile "$smoke_profile" ;; *) echo "SMOKE FAIL: invalid profile $smoke_profile"; exit 1 ;; esac
done
if [ "${SMOKE_SKIP_BOOTSTRAP_TESTS:-0}" != 1 ]; then
  node --test "$TMP/repo/bootstrap/capability-check.test.mts" \
    "$TMP/repo/bootstrap/manifest-consistency.test.mts" \
    "$TMP/repo/bootstrap/npm-globals.test.mts" \
    "$TMP/repo/bootstrap/migrate-mcp-http-auth.test.mts" \
    "$TMP/repo/bootstrap/migrate-mcp-secret-wrapper.test.mts" \
    "$TMP/repo/modules/mcp-auth-bridge/supergateway-secret-wrapper.test.mts" \
    || note_fail "SUBTEST node --test suite failed (capability-check, manifest-consistency, migrate-mcp-*, supergateway-secret-wrapper)"
  node "$TMP/repo/bootstrap/prepare-secrets.test.mts" || note_fail "SUBTEST prepare-secrets.test.mts failed"
  node "$TMP/repo/bootstrap/reconcile-plugins.test.mts" || note_fail "SUBTEST reconcile-plugins.test.mts failed"
  bash "$TMP/repo/bootstrap/build-secrets.test.sh" || note_fail "SUBTEST build-secrets.test.sh failed"
  subtest_rc=0
  run_bounded "$SUBTEST_TIMEOUT" bash "$TMP/repo/bootstrap/install-transaction.test.sh" || subtest_rc=$?
  case "$subtest_rc" in
    0) ;;
    124|137) note_fail "SUBTEST install-transaction.test.sh timed out after ${SUBTEST_TIMEOUT}s" ;;
    *) note_fail "SUBTEST install-transaction.test.sh failed" ;;
  esac
fi
# Terminal marker first, then publish: an unmarked report is an incomplete run
# and claude/hooks/smoke-test-nudge.mts must be able to tell the two apart.
if [ "$fail" = 0 ]; then echo "SMOKE PASS (${SMOKE_PROFILES:-win mac})"; else echo "SMOKE FAIL"; fi
publish_report
[ "$fail" = 0 ] || exit 1
