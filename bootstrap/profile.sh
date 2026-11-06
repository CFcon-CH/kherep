#!/usr/bin/env bash
# Host-profile defaults shared by install and drift checks. Sourcing this file
# sets KHEREP_PROFILE, but never mutates host state.

kherep_env_present() {
  printenv "KHEREP_$1" >/dev/null 2>&1
}

kherep_env() {
  local suffix="$1" default_value="${2-}" canonical="KHEREP_$1"
  if printenv "$canonical" >/dev/null 2>&1; then printenv "$canonical"
  else printf '%s' "$default_value"
  fi
}

kherep_resolve_profile() {
  local requested kernel
  requested="$(kherep_env PROFILE)"
  if kherep_env_present PROFILE; then
    case "$requested" in
      win|mac) printf '%s\n' "$requested"; return 0 ;;
      *) echo "FATAL: KHEREP_PROFILE must be win or mac" >&2; return 2 ;;
    esac
  fi

  kernel="$(uname -s 2>/dev/null || true)"
  case "$kernel" in
    Darwin) printf '%s\n' mac ;;
    MINGW*|MSYS*|CYGWIN*) printf '%s\n' win ;;
    # Linux remains the backwards-compatible files-only/bootstrap default.
    # A Mac is unambiguously Darwin; WSL and CI exercise the win profile.
    *) printf '%s\n' win ;;
  esac
}

KHEREP_PROFILE="$(kherep_resolve_profile)" || return $?
export KHEREP_PROFILE

kherep_default_workspace() {
  printf '%s\n' "$HOME/Kherep"
}

kherep_default_credentials_root() {
  printf '%s\n' "$HOME/.kherep/credentials"
}

# Issue #256. Three install steps act outside CLAUDE_HOME: the global (and opted-in
# system) core.hooksPath binds the whole account, the credential step reads
# the file an inherited KHEREP_ATL_CRED_FILE_CLAUDE names and checks it live, and
# the Atlassian MCP step (issue #376) writes the user-scope ~/.claude.json. A
# CLAUDE_HOME other than <HOME>/.claude is a candidate until the operator says
# otherwise, so there each step needs KHEREP_INSTALL_ALLOW_<STEP>=1. The same
# holds for the Claude readiness check (issue #403): it makes a real model call
# with the account's login, whichever home is installed.
# KHEREP_INSTALL_PREVIEW=1 skips them and the knowledge space for any home.
# Prints why step $1 (GITCONFIG, ATL_CREDENTIAL, ATL_MCP, CLAUDE_READINESS,
# KNOWLEDGE_SPACE) is skipped, or nothing when it runs. Only the exact value 1
# counts, for every switch.
kherep_install_skip_reason() {
  local step="$1" default home claude
  if [[ "$(kherep_env "INSTALL_SKIP_$step" 0)" = "1" ]]; then
    printf 'KHEREP_INSTALL_SKIP_%s=1\n' "$step"; return 0
  fi
  if [[ "$(kherep_env INSTALL_PREVIEW 0)" = "1" ]]; then
    printf 'KHEREP_INSTALL_PREVIEW=1\n'; return 0
  fi
  case "$step" in GITCONFIG|ATL_CREDENTIAL|ATL_MCP|CLAUDE_READINESS) ;; *) return 0 ;; esac
  [[ "$(kherep_env "INSTALL_ALLOW_$step" 0)" = "1" ]] && return 0
  # lib.sh builds the default as $HOME/.claude, so HOME=/u/ gives /u//.claude:
  # repeated and trailing slashes do not make another home. Git Bash paths are
  # case-insensitive: /c/Users/Me and /c/users/me are one home.
  default="$(printf '%s/.claude' "${HOME-}" | tr -s /)"
  # A Windows CLAUDE_HOME or HOME in drive form (C:/x, C:\x) passes through
  # Git Bash unconverted; compare the Git Bash form (/c/x).
  home="$(printf '%s/.claude' "$(kherep_shell_path "${HOME-}")" | tr -s /)"
  claude="$(kherep_shell_path "${CLAUDE_HOME-}" | tr -s /)"; claude="${claude%/}"
  if [[ "$KHEREP_PROFILE" = "win" ]]; then
    home="$(printf '%s' "$home" | tr 'A-Z' 'a-z')"; claude="$(printf '%s' "$claude" | tr 'A-Z' 'a-z')"
  fi
  [[ "$claude" = "$home" ]] && return 0
  printf "CLAUDE_HOME '%s', not the default '%s'; KHEREP_INSTALL_ALLOW_%s=1 runs this step for it\n" \
    "${CLAUDE_HOME-}" "$default" "$step"
}

# Issue #75. On Windows the Claude settings carry the workspace in native form
# (D:/Work), and the harness injects that value into every tool call. Git Bash
# names the same directory /d/Work. On the win profile a drive path is turned
# into that form before validation; every other value passes unchanged, so the
# mac profile still refuses a drive path below.
kherep_shell_path() {
  local value="$1"
  if [[ "$KHEREP_PROFILE" = "win" ]]; then
    case "$value" in
      [A-Za-z]:[/\\]*|[A-Za-z]:)
        local letter rest
        letter="$(printf '%s' "${value%%:*}" | tr 'A-Z' 'a-z')"
        rest="$(printf '%s' "${value#?:}" | tr '\\' '/')"
        value="/$letter${rest:-/}"
        ;;
    esac
  fi
  printf '%s\n' "$value"
}

# Paths consumed by bash file operations must already use the host shell's
# absolute syntax. In particular, accepting D:\... on macOS would create a
# relative directory literally named "D:\..." before the JSON renderer could
# normalize it.
kherep_validate_shell_path() {
  local label="$1" value="$2"
  [[ -n "$value" ]] || { echo "FATAL: $label must not be empty" >&2; return 2; }
  case "$value" in
    /*) ;;
    *) echo "FATAL: $label must be an absolute forward-slash path for bash: $value" >&2; return 2 ;;
  esac
  case "$value" in
    *\\*) echo "FATAL: $label contains Windows backslashes; use the bash-visible path" >&2; return 2 ;;
  esac
  case "$value" in
    /) echo "FATAL: $label must not be the filesystem root" >&2; return 2 ;;
    */../*|*/..)
      echo "FATAL: $label contains a parent traversal segment: $value" >&2
      return 2
      ;;
  esac
  if [[ "$KHEREP_PROFILE" = "mac" ]]; then
    case "$value" in
      //[A-Za-z]/*|/[A-Za-z]:/*|/[cCdD]/*)
        echo "FATAL: $label is a Windows drive/mount path, not a macOS path: $value" >&2
        return 2 ;;
    esac
  fi
}

# Issue #30. The workspace is the one path rendered UNQUOTED into commands: the
# `Bash(node <workspace>/tools/...)` allow rules and the claude-obs `broker`
# (render-profile-paths.mts, workspaceCommandPath). Agents run that string as
# stored, and a quoted call would not match the rules, so the path must stay one
# shell word. Refused: whitespace, the characters POSIX always requires quoting,
# and the glob and brace characters, which expand inside a word. The other
# sometimes-special characters (# ~ = % ! ^ ,) act only at the start of a word,
# in an interactive shell or inside the refused brackets and braces, and this
# word starts with / (or a drive letter once rendered); ~ also appears in 8.3
# names such as RUNNER~1. CLAUDE_HOME and the credentials root are rendered
# quoted and are not restricted.
kherep_validate_workspace_command_path() {
  local value="$1" unsafe=$'| & ; < > ( ) $ ` \\ " \' * ? [ ] { }' refused=0 i
  case "$value" in *[[:space:]]*) refused=1 ;; esac
  for (( i = 0; i < ${#unsafe}; i++ )); do
    case "$value" in *"${unsafe:i:1}"*) refused=1 ;; esac
  done
  [[ "$refused" = "0" ]] && return 0
  echo "FATAL: KHEREP_WORKSPACE contains whitespace or a shell metacharacter: $value" >&2
  echo "Kherep names the workspace unquoted in its tool commands (permission rules, claude-obs broker), so no quoting can make this path work." >&2
  echo "Choose a workspace path without whitespace and without any of $unsafe and set it with KHEREP_WORKSPACE." >&2
  return 2
}

# Repo manifests are trusted input only after this lexical gate. Keeping the
# path relative and traversal-free makes the configured install roots the sole
# authority over where a manifest entry can land.
kherep_validate_manifest_relative_path() {
  local label="$1" value="$2"
  [[ -n "$value" ]] || { echo "FATAL: $label must not be empty" >&2; return 2; }
  case "$value" in
    /*|*\\*|../*|*/../*|*/..|..|./*|*/./*|*/.|.|*/)
      echo "FATAL: $label must be a strict traversal-free relative path: $value" >&2
      return 2
      ;;
  esac
}
