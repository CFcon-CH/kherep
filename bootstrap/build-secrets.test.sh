#!/usr/bin/env bash
# Failure-path regression tests for build-secrets.sh. Everything runs below a
# throwaway root with fake sops/age binaries; no live or repository secret is touched.
set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fail() { echo "BUILD-SECRETS TEST FAIL: $*" >&2; exit 1; }

make_repo_fixture() {
  local name="$1"
  CASE_ROOT="$TMP/$name"
  TEST_REPO="$CASE_ROOT/repo"
  TEST_HOME="$CASE_ROOT/home"
  TEST_CLAUDE_HOME="$TEST_HOME/.claude"
  TEST_CREDENTIALS="$CASE_ROOT/credentials"
  TEST_BIN="$CASE_ROOT/bin"
  TOOL_MARKER="$CASE_ROOT/tool-called"
  mkdir -p "$TEST_REPO/bootstrap" "$TEST_REPO/secrets" \
    "$TEST_CLAUDE_HOME" "$TEST_CREDENTIALS/age" "$TEST_BIN"
  cp "$HERE/build-secrets.sh" "$HERE/profile.sh" "$TEST_REPO/bootstrap/"
  TEST_BUNDLE="$CASE_ROOT/secrets.sops.yaml"
  printf '%s\n' 'existing-encrypted-bundle-sentinel' > "$TEST_BUNDLE"
  cp "$TEST_BUNDLE" "$CASE_ROOT/bundle.before"
  printf '%s\n' '# public key: age1testrecipient' 'AGE-SECRET-KEY-TEST' > \
    "$TEST_CREDENTIALS/age/kherep.key"

  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "sops\n" >> "$TOOL_MARKER"' \
    'printf "%s\n" "fake encrypted output"' > "$TEST_BIN/sops"
  printf '%s\n' '#!/usr/bin/env bash' \
    'printf "age-keygen\n" >> "$TOOL_MARKER"' \
    'exit 90' > "$TEST_BIN/age-keygen"
  chmod +x "$TEST_BIN/sops" "$TEST_BIN/age-keygen"
}

run_build() {
  (
    cd "$CASE_ROOT"
    PATH="$TEST_BIN:$PATH" TOOL_MARKER="$TOOL_MARKER" \
      HOME="$TEST_HOME" CLAUDE_HOME="$TEST_CLAUDE_HOME" \
      KHEREP_PROFILE=mac KHEREP_CREDENTIALS_ROOT="$TEST_CREDENTIALS" \
      SOPS_AGE_KEY_FILE="${SOPS_AGE_KEY_FILE:-$TEST_CREDENTIALS/age/kherep.key}" \
      KHEREP_SECRETS_BUNDLE="$TEST_BUNDLE" \
      bash "$TEST_REPO/bootstrap/build-secrets.sh"
  )
}

test_missing_required_secret_fails_closed() {
  local missing rc
  for missing in mcp_json; do
    make_repo_fixture "missing-$missing"
    [[ "$missing" = "mcp_json" ]] || \
      printf '%s\n' '{"mcpServers":{}}' > "$TEST_CLAUDE_HOME/.mcp.json"

    set +e
    run_build > "$CASE_ROOT/output.log" 2>&1
    rc=$?
    set -e

    [[ "$rc" -ne 0 ]] || fail "$missing missing returned success"
    cmp "$TEST_BUNDLE" "$CASE_ROOT/bundle.before" >/dev/null || \
      fail "$missing missing changed the existing encrypted bundle"
    [[ ! -e "$TOOL_MARKER" ]] || fail "sops/age-keygen ran after $missing validation failed"
    grep -q "FATAL missing required live secrets:.*$missing" "$CASE_ROOT/output.log" || \
      fail "$missing was not identified"
  done
}

test_windows_age_path_is_rejected_before_mutation() {
  local rc
  make_repo_fixture windows-age-path

  set +e
  SOPS_AGE_KEY_FILE='D:\Work-credentials\age\kherep.key' \
    run_build > "$CASE_ROOT/output.log" 2>&1
  rc=$?
  set -e

  [[ "$rc" -ne 0 ]] || fail "Windows SOPS_AGE_KEY_FILE passed on the Mac profile"
  cmp "$TEST_BUNDLE" "$CASE_ROOT/bundle.before" >/dev/null || \
    fail "invalid age-key path changed the existing encrypted bundle"
  [[ ! -e "$TOOL_MARKER" ]] || fail "mkdir/age-keygen/sops phase was reached for invalid age-key path"
  [[ ! -e "$CASE_ROOT/D:\Work-credentials\age\kherep.key" ]] || \
    fail "invalid Windows age-key path was materialized"
  grep -Eq 'FATAL: SOPS_AGE_KEY_FILE (must be an absolute forward-slash path|contains Windows backslashes)' \
    "$CASE_ROOT/output.log" || \
    fail "invalid age-key path did not fail in shell-path validation"
}

test_missing_required_secret_fails_closed
test_windows_age_path_is_rejected_before_mutation
echo 'BUILD-SECRETS TEST PASS'
