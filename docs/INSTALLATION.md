# Installation

Kherep installs rules, hooks, skills and runtime adapters into your existing coding-agent setup. Use Node.js 24 (at least 22.18 on the 22 line, or 23.6), npm, Git and a working Claude Code or Codex installation. The Claude installer needs Bash; on Windows use Git Bash.

Choose the workspace in which Kherep should apply. The source checkout can be anywhere; the workspace is the set of repositories your agents work on.

## 1. Get the source

```sh
git clone https://github.com/CFcon-CH/kherep.git
cd kherep
npm ci
```

Use absolute paths. For the Bash installer on Windows, use Git Bash paths such as `/c/Projects`, including for environment-variable overrides. On macOS, use native absolute POSIX paths. The Node-based Codex installer accepts native paths separately.

The workspace path must be a single shell word: no whitespace and none of ``| & ; < > ( ) $ ` \ " ' * ? [ ] { }``. The Claude adapter names the workspace unquoted in the permission rules for its Confluence broker and in the stored `broker` command (see [section 5](#5-configure-integrations)), and a quoted call would not match those rules. `install.sh` and `drift-check.sh` therefore stop before writing anything when the workspace contains one of these characters, and name the path. The default workspace is `$HOME/Kherep`, so if your home path contains a space, set `KHEREP_WORKSPACE` to a path without one. `CLAUDE_HOME` may contain spaces, because every hook command quotes it, and so may `KHEREP_CREDENTIALS_ROOT`, which is rendered only as an environment value. The Codex installer quotes the workspace wherever it names it in a command and does not apply this restriction.

## 2. Review an isolated installation

For Codex, follow the [isolated candidate procedure](CODEX.md) and inspect the native hook definitions. The shell dispatcher introduced in issue #386 replaces three guard adapters and pre-tool attribution with one command. Existing state and custom groups are preserved, but the changed definition needs host review in `/hooks` and a native-session restart after an authorized update. Repository checks do not establish Desktop activation; use the [bounded host acceptance](CODEX-HOOK-RUNS.md#host-acceptance) to verify guards and Intercom.

This preview writes managed files to a new candidate directory, leaves global, system and workspace Git configuration unchanged and does not install dependencies or start a memory agent. `KHEREP_INSTALL_PREVIEW=1` implies `KHEREP_INSTALL_SKIP_GITCONFIG`, `KHEREP_INSTALL_SKIP_RUNTIME_AGENT`, `KHEREP_INSTALL_SKIP_ATL_CREDENTIAL` and `KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE`, so the preview never reads a real credential file named by an inherited `KHEREP_ATL_CRED_FILE_*` variable and makes no live call. The Git, credential and knowledge-space steps each print one `install: SKIP_<STEP>=1 (by <reason>; ...)` line when skipped.

```sh
candidate_root="$(mktemp -d)"
mkdir -p "$candidate_root/claude" "$candidate_root/workspace"

CLAUDE_HOME="$candidate_root/claude" \
KHEREP_WORKSPACE="$candidate_root/workspace" \
KHEREP_CREDENTIALS_ROOT="$candidate_root/integration-config" \
KHEREP_INSTALL_PREVIEW=1 \
SKIP_SECRETS=1 SKIP_DEPS=1 bash bootstrap/install.sh
```

A `CLAUDE_HOME` other than `<HOME>/.claude` is treated as a candidate even without the switch: the installer then leaves global and system `core.hooksPath` unchanged and skips the credential step, so a forgotten switch cannot point the account's Git hooks at a temporary directory. The knowledge-space step is not skipped by the home, so such a run without `KHEREP_INSTALL_PREVIEW=1` ends with `DONE WITH ERRORS` because the space was not checked. If a non-default `CLAUDE_HOME` is your real Claude home, opt in per step with `KHEREP_INSTALL_ALLOW_GITCONFIG=1` and `KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL=1` (see [section 5](#5-configure-integrations)).

Inspect the candidate's rules, settings, hook commands and installation receipt. Keep its backup until you have checked recovery. A files-only preview does not establish that connected services work.

## 3. Install the Claude adapter

From the checkout, select your actual workspace:

```sh
KHEREP_WORKSPACE="$HOME/projects" \
KHEREP_INSTALL_SKIP_RUNTIME_AGENT=1 \
bash bootstrap/install.sh
```

Replace the workspace with your chosen absolute path. The normal dependency phase installs the declared npm tools and Claude plugins. It runs the Claude CLI without a shell; on Windows it uses the first `claude.exe` on `PATH`, or the native `bin/claude.exe` that an npm install ships next to its `claude.cmd` shim. If neither is found, set `KHEREP_CLAUDE_BIN` to the Claude executable. Encrypted secrets are skipped by default. The memory-agent switch leaves an existing agent untouched and avoids starting an unconfigured one.

The dependency phase and an enrolled Control Plane node's daemon both run the Claude CLI with the same saved login. From the start of the phase to the end-of-install readiness check, the installer keeps `install.lock` in the node directory (`<config root>/control-plane/`). The daemon starts no new Claude readiness probe while the file is younger than 30 minutes and logs `probe deferred: install in progress` once; a probe that was already running when the file appeared is waited for, at most 60 seconds. When the file is gone, the daemon probes Claude once more, even when its last verdict was ready. The installer removes the file after the readiness check, and its exit trap removes it when the installation is interrupted. After writing the file, the installer reads `claude auth status --json` and warns when Claude already reports no sign-in, so a sign-out from before the installation is visible as such; this check never stops the installation. At the end it runs the daemon's readiness probe once, a minimal real `claude -p` call, and prints one of `install: claude ready`, `install: WARNING claude SIGN-IN LOST (...) - run 'claude auth login'`, which makes the installation exit 1 with the verdict `DONE WITH ERRORS (Claude sign-in lost ...)`, or `install: claude probe inconclusive (...)`, which is only a warning; a login renewal held by another Claude process counts as inconclusive. `claude auth status` alone is not used for this verdict because it has reported an expired login as signed in. `KHEREP_INSTALL_PREVIEW=1`, `KHEREP_INSTALL_SKIP_CLAUDE_READINESS=1` and a `CLAUDE_HOME` other than `~/.claude` (unless `KHEREP_INSTALL_ALLOW_CLAUDE_READINESS=1`) skip the pre-check and the probe; `SKIP_DEPS=1` skips the whole phase.

The installer places managed rules, hooks, skills, agents and routing. It uses backups and updates its managed configuration. Workspace Git-hook binding is part of normal installation; review the chosen workspace before applying it.

The Git hook is bound through `core.hooksPath`: globally for your account and locally in each repository under the workspace, except repositories under a `_deprecated` directory. A previous global value is reported as replaced only when it names a different directory; the Windows spellings `C:/...`, `C:\...` and `/c/...` of the same directory count as equal. The system scope binds every account on the host, so the installer only reads it: when the system value differs from Kherep's hook directory or is unset, it prints both values and changes nothing, even when the system file happens to be writable without elevation. Set `KHEREP_INSTALL_SYSTEM_HOOKSPATH=1` to replace the system value; the installer then reports the value it replaced, and a failed write fails the installation.

The same hook directory holds a `post-checkout` hook. Sessions share a repository's main checkout, so a branch switch there moves every other session's working tree. When a branch checkout leaves the main checkout of a repository under the workspace off its default branch, the hook prints a warning that names the branch to switch back to and `git worktree add <path> -b <branch>` for branch work. The default branch is `origin/HEAD`, else a local `main` or `master`; `init.defaultBranch` alone is never used. Git runs the hook after HEAD has moved, so it cannot stop the checkout; it always exits 0. It stays silent in linked worktrees, after `git clone` and `git worktree add`, during a rebase, for file checkouts, and when the command carries `KHEREP_MAIN_CHECKOUT=switch`. The workspace comes from `KHEREP_WORKSPACE`, else from `commit-policy`, as for `commit-msg`. The blocking layer is the `main-checkout-guard` hook for the Bash and PowerShell tools in Claude and for the shell tools in Codex: in such a main checkout it refuses `git checkout <ref>` without `--` (a SHA included), `checkout -b`, `-B`, `--orphan` and `--detach`, and `git switch` to any branch other than the default, including `-c`, `-C` and `--detach`. File checkouts, `restore`, `worktree add`, `pull`, `fetch`, `merge`, `rebase`, linked worktrees and repositories outside the workspace are unaffected. It follows `git -C` and `cd`. When the user approves a switch of the main checkout, prefix that one command with `KHEREP_MAIN_CHECKOUT=switch`, or in PowerShell `$env:KHEREP_MAIN_CHECKOUT='switch';`; a persistent environment variable is ignored. When the default branch cannot be determined, the guard warns and lets the command run.

A `pre-push` hook in the same directory records which session pushed which ref in the node's local attribution log, `<config root>/control-plane/attribution.jsonl`, for repositories under the workspace (read the same way as for `commit-msg`). It runs `attribution-record.mts` beside it through `node`, never blocks a push and always exits 0. Read the log with `kherep-node attribution`; see the [Control Plane](../modules/control-plane/README.md#attribution) for the record fields and the session sources. `gh pr create` does not pass through git, so a `PostToolUse` hook records it in Claude and in Codex, through each runtime's stable control-plane entry point.

The installer also wires the control-plane delivery hook, `modules/control-plane/node/deliver-hook.mts`, into the `UserPromptSubmit`, `Stop` and `PostToolUse` hooks of `settings.json`. Every control-plane command there names the stable entry point `<CLAUDE_HOME>/kherep/control-plane/claude-control-plane-hook.mts` and the hook by name, `deliver`, `wake --timeout 90000` or `attribution` (issue #592). The entry reads the pointer beside it, `<CLAUDE_HOME>/kherep/control-plane/source.json`, which names the source the installer last ran from, and runs that source's hook inside its own process: the hook gets Claude Code's stdin, environment, working directory and parent process, and its exit code is the command's. The commands therefore stay the same across upgrades and across the roots you install from; only the pointer follows an install, in the same transaction as `settings.json`. Moving or deleting the source the pointer names stops these hooks until you install again: without a usable pointer, a known hook name or the hook file, the entry runs nothing, writes one line to stderr, `kherep control-plane-hook: <reason>; pointer <file>; run bootstrap/install.sh`, and exits 1, which Claude Code treats as a non-blocking error. It never exits 2 and never falls back to another source. `drift-check.sh` compares the pointer with the source it runs from by commit, not by root, so a source pin and a checkout of the same commit agree: it prints `ok kherep/control-plane/source.json (<kind> <commit>)`, or `(<kind> unverified)` when the commit could not be read, and reports `MISSING-LIVE`, `POINTER-INVALID`, `POINTER-UNRESOLVED (<reason>: ...)` when the pointer's source cannot run the hook of one of the three names, and `POINTER-STALE (commit <a> != <b>)`. The `hooks` check of `kherep-node doctor` reports `pointer`, `stable`, `legacy` and, with a stable command, `entry` for Claude as for Codex, and fails when the pointer or the entry is unusable. The hook hands messages that other agent sessions sent through the Kherep control plane to their Claude Code session. It reads local files only, and on a machine without an enrolled control-plane node it finds no inbox and exits without output, so it is inert until you enroll one (see [the control plane](../modules/control-plane/README.md#delivery-hook)). It reads the node's default per-user config directory; when the daemon runs with `KHEREP_CONFIG_DIR`, set the same value in the `env` block of `settings.json`. The same hook also runs for `StopFailure`, so messages offered in a turn that ended with an API error are offered again. On `PostToolUse` it is the last entry of the all-tools group: a session in a running turn receives a peer message after its next successful tool call, and only the turn's `Stop` confirms it. A second entry on `UserPromptSubmit` and on `Stop` runs the wake hook, `modules/control-plane/node/wake-hook.mts`, through the entry point as `wake --timeout 90000` with `asyncRewake` and the same 25-hour `timeout`: it waits in the background for peer messages and wakes an idle session when one arrives. Arming at `UserPromptSubmit` too keeps a listener after a turn that ended without `Stop`. The same entry runs at `SessionStart`, but that event has no `permission_mode`. A restart before the user types therefore arms only when the session is named explicitly by its full id or current unique name in `wake.sessions`, its last known mode is safe, its settings are safe and the fresh launch check succeeds. A synthetic example is `"wake": { "enabled": true, "sessions": ["review", "7f9c2d1e-0b4a-4c1e-9a55-3c2f8e6d1a90"] }`. The wildcard default still covers permission-bearing `UserPromptSubmit` and `Stop`, but it is not explicit restart authorization. Waking is on by default: a node `policy.json` without a `wake` section wakes every session (`"sessions": ["*"]`, with `codexApp` and `replies`) for the messages its `messaging` section accepts; an existing file without a `messaging` section accepts nothing, while onboarding writes an explicit rule for every sender into a new file. `"wake": { "enabled": false }` turns it off, and a malformed section wakes nothing (issue #390). Editing the policy can change what an existing listener accepts, but it cannot attach `asyncRewake` after the native owner hook has exited. Recovery needs a genuine owner hook event; fabricated listener files or a detached `--resume` copy are not substitutes. `kherep-node doctor` reports observed policy eligibility, exact restart authorization, remembered permission and live listed-listener evidence separately. It labels the local session snapshot complete, partial, or unknown for a legacy file and does not derive a ready verdict. Those checks do not prove that a message was received. Wakes and turns the delivery hook continues at `Stop` share a budget of 20 per rolling hour, 100 per rolling day and 30 s between two per session; a session in permission mode `bypassPermissions` is neither woken nor continued, and its messages wait for the next prompt. A headless run (`claude -p`) can never be woken: its listener removes its own files and exits within the time of one process listing, before it polls. A listener whose Claude Code process has exited ends at its next poll; a `wake.disabled` file in the node directory switches waking off. Details: [listening while idle](../modules/control-plane/README.md#listening-while-idle). An upgrade replaces every existing entry that runs one of these control-plane scripts on the same event with the managed one, so a changed timeout never leaves two listeners; managed hooks that run through the hook runtime follow their own replace rule (see [Upgrades and rollback](#upgrades-and-rollback)), and your other hooks stay as they are. The script is identified by its path from `modules/control-plane/node/` on, not by the root it runs from (issue #590), and a stable command by the script its name selects (issue #592): an install replaces the path-form entries an earlier install wrote from any root with the stable ones instead of adding a second set, and its pointer names its own root from then on. An install from a worktree therefore points the only set of these hooks at that worktree: install again from a lasting source, the service source pin or the main checkout, before you remove the worktree. A command that chains such a script with a shell control operator, a substitution or a redirection is an operator hook and stays as it is; so does a stable command with a hand-quoted name such as `"deliver"`, which the shell would still run. `drift-check.sh` reports a script the installer wires that is still wired more than once on an event it wires it for as `DUPLICATE-HOOK <event> modules/control-plane/node/<script> x<n>` and fails, and the `hooks` check of `kherep-node doctor` lists such `duplicates` in `settings.json` and fails; installing again removes them. To turn it off, remove these entries from `settings.json`; the next installation adds them back, and `drift-check.sh` reports the difference until then.

The weekly usage watcher (issue #748) reads only the documented status-line field `rate_limits.seven_day` (`used_percentage`, `resets_at`), which Claude Code sends to claude.ai subscribers after the first API response of a session. The managed `statusline-command.sh` starts `hooks/usage-record.mts` detached whenever that pair differs from `<CLAUDE_HOME>/.cache/usage-watch/last-input`; the recorder is a CLI, not a wired hook, so hook integrity does not restore it, the installer does. The recorder writes `state.json` (the evaluated window) and `last-input` in that directory and shows at most one Windows toast per condition per reset window: it claims an empty marker `toast-<window>-threshold` or `toast-<window>-pace` by exclusive create, and removes the markers of older windows when the window rolls over, so the directory holds at most four files. The conditions are a fixed threshold of 50 % used, and a pace warning once 10 % of the 7-day window has elapsed and usage leads the elapsed share by at least 5 points. `KHEREP_USAGE_TOAST=0` in the status line's environment turns the toast off; `KHEREP_USAGE_TOAST_LOG=<file>` is a test seam that records the toast to a file instead of showing it. The toast needs Windows PowerShell 5.1 (`powershell.exe`, present on Windows 10 and 11) and shows under its app name; on macOS the recorder shows the same title and text as a notification through `osascript` (`display notification`, part of macOS); on other platforms there is no notification. The cache refreshes only from sessions that render the status line, so a host that renders none keeps the last reading until its reset time passes.

For a files-only installation, set `SKIP_DEPS=1`. Install and configure the required external tools separately before relying on their integrations.

### Rolling back the stable entry

Going back to a source from before issue #592 does not undo the stable entry by itself. That installer does not recognise the stable commands, so it keeps them as your own hooks and adds its path-form entries beside them; the entry and the pointer stay on disk, both sets run, and neither its `drift-check.sh` nor its doctor reports it. On each host, in this order:

1. Remove the pointer first: `rm "<CLAUDE_HOME>/kherep/control-plane/source.json"`. Every stable command now fails closed (exit 1, the one-line notice, nothing runs), so no hook runs from a source the older installer did not install. Open sessions show the notice until step 4.
2. Run `bootstrap/install.sh` from the older source. It writes the path-form entries and leaves the stable ones.
3. Copy `settings.json` aside, then remove every entry whose `command` contains `kherep/control-plane/claude-control-plane-hook.mts`: eight entries (`SessionStart` wake; `UserPromptSubmit` deliver and wake; `Stop` deliver and wake; `StopFailure` deliver; `PostToolUse` deliver and attribution). Check that `grep -c claude-control-plane-hook "<CLAUDE_HOME>/settings.json"` prints `0`.
4. Remove the entry and its directory: `rm -r "<CLAUDE_HOME>/kherep/control-plane"`. The older manifest does not list it.
5. Run `bootstrap/drift-check.sh` (exit 0) and `kherep-node doctor` (`hooks.ok` is `true`), then restart each Claude session.

The forward direction needs no step beyond an install: on a host from before #592, one `bootstrap/install.sh` from the new source replaces the path-form entries with the stable set.

### Optional Claude messaging client

For an enrolled control-plane node, the messaging MCP client can be installed separately from the
broad Claude adapter. Pass the existing Claude home and the same non-secret config root used by the
node daemon. Use absolute POSIX paths on macOS and Git Bash paths on Windows, including `--node`
when supplied.

```sh
bash bootstrap/install-claude-messaging-client.sh \
  --home /absolute/path/to/claude-home \
  --config-root /absolute/path/to/enrolled-node-config-root
```

The optional `--node /absolute/path/to/node` selects the executable for both projection and
transaction comparisons. No-argument and help invocations install nothing. A successful install
prints the client identity and a session activation command:

```sh
claude --plugin-dir /absolute/claude-home/kherep/claude-messaging-client/plugin \
  --mcp-config /absolute/claude-home/kherep/claude-messaging-client/mcp.json --strict-mcp-config
```

Only that invocation uses the supplied MCP configuration. Persistent settings, independent MCP
entries, hooks and permissions are unchanged. The managed client is a closed directory with a
verified fixed public module graph; updates refuse drift, undeclared content and symlinks. A changed
installation retains its previous client under `<home>/backups/claude-messaging-client/`, and failed
transactions restore the prior target. This installer shares the normal bootstrap lock and does not
run the broad installer, copy node state or enable any tool permission, node policy or Worker route.

Claude messaging additionally requires the node's literal `remoteMcp.claudeCode: true` opt-in and
an enabled remote MCP Worker route. Review [MCP activation and native identity](../modules/control-plane/MCP.md)
before activation. An isolated installed candidate does not prove an actual native client or
cross-host acceptance.

## 4. Set up Codex

After setting up the shared dependencies, follow [Codex integration](CODEX.md). It has a separate installer and configuration home. Select the MCP registry appropriate to your setup.

## 5. Configure integrations

Connection profiles ship unconfigured. Kherep does not provision a Confluence space, local model or remote MCP service. Use your own backend and account bindings.

| Setting | Purpose |
| --- | --- |
| `KHEREP_WORKSPACE` | Workspace where orchestration applies |
| `KHEREP_PROFILE` | Explicit `win` or `mac` host profile |
| `KHEREP_CREDENTIALS_ROOT` | External integration-configuration root |
| `KHEREP_LOCAL_CONFIG` | Local-inference configuration |
| `KHEREP_INSTALL_PREVIEW` | Candidate preview: implies `KHEREP_INSTALL_SKIP_GITCONFIG`, `_SKIP_RUNTIME_AGENT`, `_SKIP_ATL_CREDENTIAL`, `_SKIP_ATL_MCP` and `_SKIP_KNOWLEDGE_SPACE` for any `CLAUDE_HOME` and wins over the `ALLOW` switches; only `1` counts |
| `KHEREP_INSTALL_SKIP_GITCONFIG` | Skip Git configuration during a preview |
| `KHEREP_INSTALL_ALLOW_GITCONFIG` | With a `CLAUDE_HOME` other than `<HOME>/.claude`, set global (and opted-in system) and repo-local `core.hooksPath` anyway; without it that step is skipped. Only `1` allows; the default home needs no switch |
| `KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL` | With a `CLAUDE_HOME` other than `<HOME>/.claude`, run the credential step anyway, which reads the file named by `KHEREP_ATL_CRED_FILE_CLAUDE` and checks it live; without it that step is skipped. Only `1` allows; the default home needs no switch |
| `KHEREP_INSTALL_ALLOW_ATL_MCP` | With a `CLAUDE_HOME` other than `<HOME>/.claude`, run the Atlassian MCP step anyway, which writes the user-scope `~/.claude.json` and disables `atlassian@claude-plugins-official`; without it that step is skipped. Only `1` allows; the default home needs no switch |
| `KHEREP_INSTALL_SYSTEM_HOOKSPATH` | Opt into setting the system-wide `core.hooksPath`, which binds every account on the host; only `1` opts in. Without it a differing system value is reported and left unchanged |
| `KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE` | Skip resolving the Confluence knowledge space (throwaway installs such as the smoke test); only `1` skips |
| `KHEREP_INSTALL_SKIP_ATL_CREDENTIAL` | Skip reading and live-verifying the Atlassian service-account credential (throwaway installs such as the smoke test); only `1` skips |
| `KHEREP_INSTALL_SKIP_ATL_MCP` | Skip registering the Atlassian MCP server for Claude; only `1` skips |
| `KHEREP_INSTALL_SKIP_RUNTIME_AGENT` | Leave the memory runtime agent untouched |
| `KHEREP_INSTALL_ATLASSIAN_TOOLS` | Opt into the Jira helpers and the Atlassian MCP server, which each runtime reaches as its own service account (see [Atlassian MCP server](#atlassian-mcp-server)). The two Confluence brokers and the modules they import are installed without it, because the observation agent needs them. `drift-check.sh` compares the Jira helpers when this is `1` or when any of them is present in `<workspace>/tools/`, so the switch is not needed to check an existing set |
| `KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE` | The Claude service account's Atlassian MCP API key file; default `<CLAUDE_HOME>/kherep/atl-mcp-credential-claude.txt` |
| `KHEREP_ATL_MCP_TOKEN_FILE_CODEX` | The Codex service account's Atlassian MCP API key file; default `<CODEX_HOME>/kherep/atl-mcp-credential-codex.txt` |
| `KHEREP_EXISTING_USER_SETTINGS` | Read-only settings fixture for candidate review |
| `KHEREP_EXISTING_PROJECT_SETTINGS` | Read-only project-settings fixture |
| `KHEREP_WORK_ITEM_REQUIRED` | `1` enforces work-item keys under `KHEREP_WORKSPACE`, `0` turns it off. Persisted into the commit policy file; without it an upgrade keeps the installed value, a fresh install uses `0` |
| `KHEREP_WORK_ITEM_PATTERN` | Extended regex for the accepted key. Persisted into the commit policy file; without it an upgrade keeps the installed pattern |

The Central Brain is the knowledge space the installer resolves for this host; the observation agents write to it through the [Atlassian brokers](../modules/atl-jira-brokers/README.md), which also cover Jira operations. Keep private configuration outside Git.

### Atlassian MCP server

With `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` both runtimes reach the Atlassian remote MCP server v2 (`https://mcp.atlassian.com/v2/mcp`) as their own Atlassian service account, never as the operator's personal login. Prepare it once per site:

1. An organization admin allows API token authentication for the Atlassian MCP server in Atlassian Administration.
2. For each runtime's service account, create an API key with the server's agent-interface scopes (below). This key is a different credential from the OAuth client the brokers use, and it cannot be changed after creation: a missing scope means a new key.
3. Store each key alone in a file that only the installing user can read, outside the repository. On macOS the installer and the wrapper refuse a file that grants any group or other access or belongs to another user; on Windows they do not check the ACL, so restrict the file to your account yourself. Put the Claude key in `KHEREP_ATL_MCP_TOKEN_FILE_CLAUDE`, the Codex key in `KHEREP_ATL_MCP_TOKEN_FILE_CODEX`, or at their default paths. A file that is also the other runtime's key file or a broker credential file is refused.

The server checks agent-interface scopes per tool group. A key with only the classic product scopes (`read:jira-work`, `write:confluence-content`, `search:confluence` and the like) authenticates, but every tool call answers 403 `Insufficient scopes` and names the scope it needs. Atlassian lists the groups on [Supported tools](https://developer.atlassian.com/cloud/rovo-mcp/guides/supported-tools/) and the selectable scopes on [Configuring authentication via API token](https://developer.atlassian.com/cloud/rovo-mcp/guides/configuring-authentication-via-api-token/); as read on 2026-10-11, the Jira and Confluence work of the Kherep agents needs:

| Scope | Tool group |
| --- | --- |
| `read:jira:agent-interface` | Read work items, comments and transitions; `getJiraCurrentUser` |
| `write:jira:agent-interface` | Create and edit work items, transitions, comments; also sprints, boards and versions |
| `search:jira:agent-interface` | `searchJiraIssuesUsingJql` |
| `read:confluence:agent-interface` | Read pages and other content |
| `write:confluence:agent-interface` | Create and update content; also spaces, content permissions and restrictions, and public links |
| `search:confluence:agent-interface` | `searchConfluence` (CQL) |
| `search:rovo:agent-interface` | Rovo search across products; Atlassian bills it in Rovo credits per call |

`delete:jira:agent-interface` and `manage:jira:agent-interface` are left out on purpose; Atlassian disables those groups by default. A write scope covers its whole group: `write:confluence:agent-interface` cannot be granted without the permission and space operations, and only an organization admin can block whole groups. The server additionally answers `Required: [read:me]` for `atlassianUserInfo` and `[read:me, read:account]` for `getAccessibleAtlassianResources`, although neither page lists those scopes; select them where Atlassian offers them for a service-account key, otherwise those two tools stay unavailable and the site URL serves as `cloudId`.

The key reaches only the secret-file wrapper `kherep/mcp-auth-bridge/supergateway-secret-wrapper.mts`, which runs the pinned `supergateway` from the npm globals and sends it as `Authorization: Bearer`. Configuration files and receipts name the file at most, never the key.

- **Claude:** the installer registers the user-scope stdio server `atlassian` in `~/.claude.json` through `claude mcp add-json`, reads it back, and only then disables `atlassian@claude-plugins-official`, whose server ran as the personal OAuth login. Its five skills go with the plugin. An `atlassian` entry the installer did not write stays, and so does the plugin. A local-scope `atlassian` entry in `~/.claude.json` takes precedence in its directory, so a session there does not reach the service account; the installer names each such directory with the removal command, leaves the entry as it is and exits 1.
- **Codex:** the managed `atlassian` table runs the same wrapper with the Codex key file. A block written with the earlier native OAuth table is replaced.
- **Destructive operations:** `executeDestructive` asks for confirmation in Claude. Codex hooks cannot ask, so Codex denies it, and the managed table also sets `approval_mode = "prompt"` for it.

Without a usable key file no Atlassian server is written on that runtime and nothing falls back to OAuth. The rest of the installation stands, and the installer warns and exits 1. A passing installation does not prove access: open a session and call a harmless Atlassian read, such as `searchConfluence`, before relying on the server. A 401 means the key was refused, a 403 names the missing scope. A claude.ai account connector for Atlassian is outside Kherep and keeps its own login.

Every Claude install writes `broker` into `<claude-home>/kherep/confluence.json`, before and independent of the credential and space steps, inside the install transaction: the absolute Claude broker command, rendered from the `KHEREP_PROFILE` and `KHEREP_WORKSPACE` values the permission rules are rendered from, so it is their exact prefix. On Windows both name the workspace with forward slashes (`node D:/ws/tools/...`), because Git Bash consumes the backslashes of a native path; the rendered merge drops an existing backslash form of a rule whose forward-slash twin it adds, and every other allow rule and the `additionalDirectories` grant keep their form. `claude-obs` runs that stored command and never composes a broker path. Only `broker` changes in that step: every other key is kept, and a missing file is created with `broker` alone. The space step then merges the space keys into the same file and keeps every key it does not own; a file without `spaceKey` means no knowledge space is configured, so `claude-obs` writes nothing and the orphan check skips.

The `research-stop` hook counts a Skill as a Central Brain lookup when its name is listed in the optional operator file `<claude-home>/kherep/research-sources.json`, shaped `{"brainSkills": ["<skill-name>"]}`; the installer neither creates nor manages this file, and a missing or malformed file leaves only the built-in lookups.

The optional encrypted-secrets phase requires an external bundle and key. Enable `SKIP_SECRETS=0` only after configuring and reviewing the destination.

### Control-plane tasks

An enrolled control-plane node can run tasks as Claude Code background sessions (details: [Tasks](../modules/control-plane/README.md#tasks)). The installer changes nothing for this; it stays off until the node's `policy.json` enables it. Prerequisites on the node: the daemon runs (`kherep-node daemon`), and the Claude CLI is installed and signed in for the account the daemon runs as. On Windows the node runs the native `claude.exe` that an npm install ships next to its `claude.cmd` shim; a shim without it cannot receive the task text safely through `cmd.exe`, so starts through it fail with that reason.

Enable sessions in the node's `policy.json`, with the directory the sessions may work in as workspace root:

```json
{
  "version": 1,
  "allowedCommands": ["node.status", "runtime.list", "session.list"],
  "sessions": { "enabled": true, "workspaceRoots": ["D:/work"] }
}
```

Restart the daemon so it reads the policy and advertises `sessions.v1`. The limits default to the operator caps: at most 3 running task sessions, 10 starts per rolling day and 120 minutes per run, permission mode `auto` (also allowed: `default`, `acceptEdits`; `bypassPermissions` never). Runtime `codex` runs only where the policy lists it in `"runtimes": ["claude", "codex"]` (the default is `["claude"]`); see the Codex tasks section of `modules/control-plane/README.md`. A session may request tasks only when its node sets `"delegate": { "request": true }` and the target node `"delegate": { "accept": true }`, and only on the operator's explicit directive in that session.

Create and manage tasks through the Access-protected API, for example with `cloudflared access curl`:

```sh
cloudflared access curl https://control.example.com/api/tasks -X POST -H "content-type: application/json" \
  --data '{"title": "Fix the flaky test", "text": "Fix the flaky SettingsChangeDetector test", "requirements": {"os": "win32", "cwd": "D:/work/repo"}}'
cloudflared access curl https://control.example.com/api/tasks/<taskId>
cloudflared access curl https://control.example.com/api/tasks/<taskId>/continue -X POST -H "content-type: application/json" --data '{"prompt": "Also add a regression test"}'
cloudflared access curl https://control.example.com/api/tasks/<taskId>/stop -X POST
```

A 409 answer names why no node could take the task.

## Model and work-item policy

On Claude, the model and effort of every role and Kherep agent are defaults you can change, not pins (issue #737). The installer places the shipped default `<CLAUDE_HOME>/kherep/model-policy.json` (source `claude/kherep/model-policy.json`). It assigns each agent a role (`root`, `designer`, `builder`, `support`, `researcher`, `observer`, `broker`), gives each role a default model, and lists the model catalog. The observer default is `haiku` with effort `medium`. You override it in `<CLAUDE_HOME>/kherep/model-policy.user.json`, which belongs to you: the installer never writes it except for the one-time migration below, `drift-check.sh` never compares it, and it stays byte-identical through an install, a failed install and a rollback. A synthetic example:

```json
{
  "schema_version": 1,
  "roles": { "builder": { "model": "sonnet", "effort": "high" }, "observer": { "effort": "low" } },
  "agents": { "claude-obs": { "model": "inherit" } },
  "models": { "opus-next": { "dispatchable": true } }
}
```

Each field resolves on its own, later wins: shipped role, shipped agent, the deprecated environment inputs, your role, your agent. A missing field inherits. Agent keys are the source agent names, the file names in `claude/agents/`. An entry under `roles` or `agents` sets only `model` and `effort`; a role assignment, a tool set or any other key, an unknown role or agent, a model outside the catalog and an effort outside `low`, `medium`, `high`, `xhigh`, `max` are rejected by file and key, never by content. A `models` entry may add a model or set `dispatchable: false` on a shipped alias to take it out of dispatch, with `dispatchable` for an alias the Agent tool takes and `efforts` for its static effort list, but it cannot widen the effort vocabulary.

Claude adapter limitation: Claude Code offers no model catalog to query. Kherep therefore checks a model only against the catalog in these files (`inherit` is valid in frontmatter, not as a dispatch model, and a full model id is valid in frontmatter but needs an alias to be dispatched), checks an effort only against the vocabulary, and treats a per-model `efforts` list as a warning, never a deny. Whether the runtime supports a pair is not verified.

The installer renders the resolved values into the frontmatter of every installed agent, from the `model: __KHEREP_MODEL__` and `effort: __KHEREP_EFFORT__` lines of the source. A value you did not set and the shipped agent entry does not name stays out: an agent that only inherits its role's default model keeps no `model:` line (native inherit), and an agent without an effort keeps no `effort:` line. `drift-check.sh` renders the same way, so an overridden frontmatter is `ok`; a hand edit of the installed agent is `DRIFT`. An invalid policy or an unresolved placeholder stops the installation before anything is changed. Kherep never sets `CLAUDE_CODE_EFFORT_LEVEL`, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`, project `.claude/agents` or managed settings.

The `dispatch-contract-guard` hook requires an explicit model on every Agent or Task call and accepts any `dispatchable` model of the resolved policy; it no longer requires the shipped default. It denies a model outside the catalog (`DISPATCH_MODEL_UNKNOWN`), a call effort outside the vocabulary (`DISPATCH_EFFORT_UNSUPPORTED`) and every dispatch while the policy is missing or invalid (`DISPATCH_POLICY_INVALID`, naming the file and key). Whether Claude Code passes a call's `effort` to `PreToolUse` is unverified; the guard checks it only when present.

`KHEREP_ALLOWED_MODELS` and `KHEREP_AGENT_MODEL_POLICY` are deprecated and stay an input for one release. `KHEREP_ALLOWED_MODELS` stays the complete dispatchable list: aliases it names are dispatchable, shipped aliases it omits are not, and your file still wins per field (`models.<name>.dispatchable`); `KHEREP_AGENT_MODEL_POLICY` sets an agent's model below your file and no longer pins it, and entries for agents Kherep does not ship are ignored. Set but empty or malformed, either still blocks dispatch. The installer and `drift-check.sh` render frontmatter from the two policy files only; the deprecated variables affect dispatch and the hook texts, not the rendered agents, and an installation that sees them prints a note instead of stopping. Move their values into `model-policy.user.json` to make them durable. On a host this installer has never reached before, with no user file, the first installation migrates explicit values into a new `model-policy.user.json` and prints each one: both environment inputs, even where they equal the old default, and every frontmatter `model:` or `effort:` of an installed agent that differs from what the earlier installer wrote. A narrowed allow-list is migrated as `models.<name>.dispatchable: false`.

Set `KHEREP_WORK_ITEM_REQUIRED=1` during installation to require work-item keys for repositories under `KHEREP_WORKSPACE`. `KHEREP_WORK_ITEM_PATTERN` configures the accepted subject pattern. The installer writes the workspace and both values to `kherep/githooks/commit-policy` next to the Git `commit-msg` hook, so the rule binds every commit on the host, whether it comes from a terminal, an IDE, Codex or Claude, without the variables being set there. The file is LF-only `key=value` text, backed up like every managed file and checked by `drift-check.sh`. At commit time a non-empty `KHEREP_WORKSPACE`, `KHEREP_WORK_ITEM_REQUIRED` or `KHEREP_WORK_ITEM_PATTERN` still overrides the file, and `KHEREP_WORK_ITEM=none` still skips the key check for one commit. A malformed file is ignored with a warning instead of blocking commits. The product does not require a particular tracker or space key.

A single repository can opt out of the work-item key with `git config --local kherep.workItemRequired false`. The hook reads only the repository-local scope, so a global or system value has no effect. Git boolean rules apply: `false`, `no`, `off` and `0` opt out in any letter case; an absent, unreadable or invalid value such as `maybe` does not. The precedence is a non-empty `KHEREP_WORK_ITEM_REQUIRED` at commit time first, then the repository value, then the policy file. Co-author trailers and AI attribution are allowed without configuration; this does not waive the work-item rule where it is required. The Claude `commit-guard` hook checks keys only when `KHEREP_WORK_ITEM_REQUIRED=1` is set in its environment, and that value wins over the repository opt-out in the Git hook as well, so both give the same verdict. Remove the opt-out with `git config --local --unset kherep.workItemRequired`.

## Verify the installed runtime

Start the selected runtime normally in the configured workspace. Confirm:

1. Kherep rules and routing are discovered.
2. A harmless tool call completes.
3. Managed hook commands execute.
4. Each integration you need is discovered and answers a harmless request.
5. A synthetic private-input fixture follows the configured privacy route.

Read the installed source receipt and target files when comparing an upgrade. Report unavailable integrations separately from working ones.

### Codex observation publisher upgrade

An existing Codex installation can use the [observation-only updater](CODEX.md#observation-only-upgrade) after an isolated review. It preserves authority, model pin, read-only sandbox, unrelated MCP settings, hook positions/state and the shared Control Plane pointer. Its separate receipt and observation-only restore snapshot cover the changed artifacts. Restart the native session and measure exact tool discovery and target readback before claiming activation; source tests do not prove live publication. Claude installation and publication remain unchanged.

## Upgrades and rollback

### Failed managed service activation (#746)

Upgrade and rollback distinguish a daemon instance by PID and `startedAt`. A reused
PID is accepted only after the preceding stop proof and the unchanged source,
service and process-ownership checks. Windows retains the native supervisor and
daemon handles through stop and consumes one binding-specific exit/family proof.
An unknown proof or surviving supervisor blocks replacement.

After drain and stop validation, the transaction atomically writes and reads back
a `prepared` candidate before changing the native definition. It records actual
definition/security digests as `attested` before start. Attestation does not mean
healthy. Failure retains evidence, or restores the verified prior definition,
receipt and original pending record byte for byte. V1 candidate records remain
readable. Never invent or hand-edit a candidate record.

For an older Windows failure with a switched task, unchanged receipt and **no**
candidate, ordinary upgrade and rollback still refuse drift. The fixed CLI adds:

```text
node <fix-clean-checkout>/modules/control-plane/node/cli.mts service rollback --recover --backup <backup-id> --source <candidate-clean-checkout>
```

Use the same explicitly configured node context as the failed service. The stable
launcher may still name an older CLI that does not understand these flags. Do not
rewrite it first. Select the exact receipt-bound backup ID from the failed
transaction's evidence, never the newest directory. `--source` identifies the clean
checkout of the **failed candidate**, not a new upgrade source. Under the existing
service lock, recovery verifies both canonical source pins and the checkout,
receipt/backup binding, task action/generation, principal/environment, exact
retargeted definition and security, process ownership and reclaimable drain.
Links, unknown state, conflicting bytes, active/unknown drain ownership or an
invalid candidate refuse before a stop or native write. Native XML normalization
preventing the exact comparison is a conflict, not permission to ignore drift.

After verified recovery, normal upgrade can target the fixed checkout. Repository
tests establish a source failure class, not the historical host's health cause.
Authorized Windows live acceptance must separately measure `ok:true`, matching
receipt/daemon commits, definition/source `match`, and drift checks.

The enrolled Control Plane node can run as a supported per-user login service
on macOS or Windows. Install it from a clean committed checkout and name the
workspace in which daemon-started work should run:

```sh
kherep-node service install --workspace /absolute/workspace --source /absolute/kherep-checkout
kherep-node service status
```

Do not end the daemon by killing its process tree, for example with End process
tree, `taskkill /T /F` or a signal to its process group. A Claude readiness
probe or task the daemon started may be renewing the saved Claude login at that
moment, and a process killed halfway through a renewal can leave the login
unusable (issue #403). Change or restart a managed service with `kherep-node
service upgrade` or `kherep-node service rollback`: they drain the daemon's
helpers before stopping it, as described below. This version has no separate
`service stop` command. After an installation, the installer's readiness line
and `kherep-node doctor` show whether Claude is still signed in.

On SIGINT, SIGTERM or SIGHUP the daemon starts no new readiness probe and
waits for one in flight to finish, about 50 seconds (the 45-second probe
timeout plus a 5-second grace), logging `stopping; waiting for the claude probe
to finish`. A probe that times out on macOS or Linux gets SIGTERM and only
after that grace SIGKILL; on Windows it is still ended with `taskkill /T /F`.
The macOS LaunchAgent sets `ExitTimeOut` to 60 seconds, on a fresh
installation and on each upgrade of a definition that does not already set it,
so launchd does not send SIGKILL during that wait. On Windows `taskkill /F`,
Task Manager and `Stop-Process` end the daemon without a signal it can handle,
and a Claude CLI it started ends with it. A restarted daemon whose
previous Claude probe was ready less than 10 minutes earlier reuses that
verdict instead of probing at once. When the previous daemon was killed during
a probe, the next start logs `the previous daemon stop interrupted a claude
probe`, probes at once, and `kherep-node doctor` shows
`lastStopInterruptedProbeAt` under `runtimes.claude` until a probe is ready
again. Every daemon log line, in the service log and from `kherep-node daemon`,
starts with an ISO 8601 UTC timestamp.

On Windows, `--service-name '\Example\KherepNode'` selects a task in a nested
Task Scheduler folder. The equivalent split form is `--service-name KherepNode
--task-path '\Example\'`. A macOS service name is a LaunchAgent label and has no
task path. Fresh definitions run as the current interactive user with least
privilege. The fresh defaults are `org.kherep.node` on macOS and `KherepNode`
on Windows. They do not install a system service.

Platform behavior follows Apple's [launchd job guidance](https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html)
and Microsoft's [`Register-ScheduledTask` reference](https://learn.microsoft.com/en-us/powershell/module/scheduledtasks/register-scheduledtask?view=win10-ps).

An existing definition is never taken over implicitly. To adopt one, supply its
exact name and `--adopt`. On macOS this explicitly selects the configured
on-disk plist as authoritative. The adapter checks the exact loaded origin,
program, arguments, observable working directory and log paths, environment,
process ownership and descendants before stopping the selected job. It probes
the loaded identity twice and rereads configured bytes and security metadata;
configured and loaded path presence must agree as well as path values. Cleanup
without a recorded PID surrounds a complete process inventory with native job
probes; a mismatch, orphan or uncertain observation refuses the operation. The
last probe and `bootout` are not one atomic launchd operation. A complete snapshot of
the previous launchd memory cache is unknown and is not claimed as a backup.
On Windows, adoption accepts only the documented direct daemon or dedicated
PowerShell supervisor forms, current-user ownership, one `Exec` action and one
logon trigger, least privilege and no execution-affecting Node environment.
Any additional action type is refused. Adoption replaces only the selected
daemon action and retains the exported task definition or configured plist,
security metadata and recorded source identity for recovery. Adoption reads and retains
the selected service's existing Node executable; it does not turn a source
upgrade into a Node runtime upgrade. On Windows it also retains the selected
dedicated supervisor's absolute log path. The managed product supervisor appends
daemon stdout and stderr to that file and restarts an exited daemon after 30
seconds. It uses a fixed binding and does not accept an operator-supplied command,
arguments, environment or shell setting. A fresh installation uses the Node
executable that runs `kherep-node` and writes its service log below the per-user
Control Plane service directory.

```sh
kherep-node service install --workspace /absolute/workspace --source /absolute/kherep-checkout --service-name <exact-name> --adopt
kherep-node service upgrade --source /absolute/clean-kherep-checkout
kherep-node service rollback
```

`upgrade` uses the existing managed service binding. If `--source` is omitted,
it uses the checkout that contains the invoked CLI. The command archives only
tracked committed files into a complete verified per-user source pin. Dirty or
uncertain source, symbolic links, manifest drift and unlisted pin content are
refused. On Windows extraction uses the native system archive tool, so Git Bash
path rewriting and cross-drive source/config locations do not change the pin.
Before a service stop, the daemon blocks new session admissions,
waits for in-flight admissions, verifies the exact process again and refuses
unknown or present descendants. A daemon of this version honors the drain for
managed task starts. On Windows the transaction also verifies the selected task
and may wait read-only for positively owned daemon descendants to exit. Each
probe repeats native action, security and process-identity checks; drift or an
extra supervisor child refuses immediately. The polling budget is 30 seconds,
then the mutating stop repeats the same read-only checks inside one bounded
native invocation before its first effect. That call has a 65-second limit to
include two possible 10-second retained-handle exit waits. It performs one
mutation sequence, never follows a replacement pid and still refuses unknown
or persistent descendants. It verifies the
supervisor and its one direct daemon child, retains both process handles, stops
the supervisor first and then stops only that already retained daemon process.
The candidate generation gets one binding-specific launch permit only after the
old generation is proven absent. Every other supervisor launch or restart waits
while the drain exists. During legacy adoption, the immediate descendant and
ownership recheck narrows but cannot eliminate a process-start race, so any
uncertain observation aborts and the operator should retry. The
transaction then requires a fresh pid, authenticated connection and matching
startup source. The health stage waits up to 30 seconds for the new daemon's
authenticated connection. The daemon's inbox maintenance (settle, then purge)
runs after that connection and cannot delay it, so the deadline bounds process
start, the source identity of the pin, which grows with the source tree, and
the connection itself, not the size of the local queue (issue #581). The
daemon logs the seconds since its start and the process uptime on its
`connected as` line. When a failed health check makes the transaction restore
the prior service, that restore waits up to 180 seconds for its health, since
a prior source may still maintain its queue before it connects.
It never stops Claude Code or Codex session processes by pid.
Admission leases record PID, process start and owner provenance. A crashed
lease is removed only when that owner is positively stale; an uncertain owner
aborts the transaction. `service status` succeeds only when the native service
is running and its live, authenticated daemon matches the recorded process,
source, config and service binding.

The daemon also takes an admission before readiness probes, session discovery,
native Queue submission and native Queue reconciliation actually execute.
Queued work waits through a drain without spending a turn budget, writing an
attempt or publishing an empty result. Nested Queue work reuses the same opaque
admission. Its lease remains until the operation finishes and the helper process
has exited and closed. Direct native Queue reconciliation can release a retained
lease after that same child's later `exit` and `close` confirm every held helper
stopped. Missing or rejected evidence and permanent holds keep blocking. This
does not certify Queue deletion. All disk leases keep the same PID, process
start time and owner fields; helper identity is not persisted. This release
requires the creating daemon to retain the admission and proof from that exact
child in memory. If that evidence is lost, or an earlier daemon never held it,
this path cannot recover the lease retroactively. Existing positive stale-owner
recovery stays unchanged.

Exported Windows task definitions, configured macOS plist bytes and their
security metadata are backed up before mutation and kept after rollback.
Recovery restores and reads back those exact selected configured bytes.
On macOS, successful bootstrap, native origin and process readback, source
identity and authenticated health establish the newly loaded generation;
subsequent managed rollback uses its retained configured snapshot. A historical adopted definition that still points at a mutable
checkout can be rolled back only while that prior source identity still
verifies. Managed-to-managed rollback uses the retained immutable prior pin.
When an adopted legacy daemon has no startup source record, its native action,
Node executable, PID and start provenance must still match before mutation. The
backup records the prior loaded source as `unknown`; failure recovery restores
and reads back the exact native bytes but does not restart that unknown source.
After a mutating command fails, the CLI reports only a fixed service failure
code and the measured recovery state, `restored` or `unknown`; it does not print
the native definition, environment or native command output. It adds the
`stage` that failed (`stop`, `prove-stopped`, `write`, `verify`, `start`,
`health`, `settle` or `receipt`) and, for an `unknown` recovery, a fixed
`blocker` such as `RECOVERY_ABSENCE_UNPROVEN` (issue #472). A failure in
`stop` or `prove-stopped` also carries a fixed `stopCode` from the allowlist
the candidate record uses, for example `STOP_UNPROVEN_TIMEOUT` when the stop
proof ran out of time, also when no `service/candidate.json` is written
(issue #677).

A rollback keeps a running node running: it starts the restored definition
when the current service or the backed-up one was running, also when the backup
was taken from a stopped service. Upgrade and rollback report success only after
they read the native service back with the exact expected bytes and, when it
should run, as running with the daemon that passed the health check still
recorded. The stop proof starts nothing after 75 seconds from its start, right
after the stop returned, longer than the 60-second launchd `ExitTimeOut`; a
native call already running at that point may still return later (each keeps
its own 15 second timeout, which ends the call's process but does not
guarantee its return). On macOS a stop refused before
`launchctl bootout` runs leaves the running service untouched and reports
`restored`; any other stop failure counts as a stop that may have taken effect,
so its recovery is never reported `restored` without proof. An `unknown`
recovery keeps the drain marker once a definition write was attempted or while
the daemon told to stop is still alive, and releases it otherwise.

The CLI never writes a service definition that differs from a loaded job
(issue #582). When a failed activation cannot stop its candidate, recovery
fails closed: the candidate stays loaded and configured (consistent), the
failure reports blocker `RECOVERY_CANDIDATE_LOADED` with a fixed `stopCode`,
and `service/candidate.json` records the candidate. `service status` then
shows `candidate` with the candidate's commit, the failed stage, the blocker
and the stop code, never a path or pid.
On macOS the write itself enforces this (issue #594): right before the file is
replaced, `launchctl print` must report the job as not found, or as loaded with
the same bytes the file already holds and a loaded identity that attests
against them (the check `read` uses). Otherwise the adapter retries every
100 ms within a 1 second grace on a monotonic clock. The grace limits when a new
check may start (no check starts after it), not the total duration: each `launchctl` and `plutil` call
keeps its own 15 second timeout. In the issue's measurements the slowest first
print after the pid was gone took 145 ms and already reported not found; no
stale listing was observed, so the grace is a heuristic, not a measured bound. A
job still loaded with another definition after the grace, or a launchd state
that cannot be read, refuses the write and the file stays as it was. Not found
is not a stop proof: a job launchd no longer lists may still have a live
process (issue #677).

`launchctl bootout` can return 0 and unlist a job whose process stays alive
(issue #677); launchd then neither escalates to SIGKILL nor reaps the process.
The macOS stop proof therefore does what launchd would have done, to the pid it
attested before the bootout and to nothing else, within the same 75 seconds:
it polls the pid every 100 ms and `launchctl print` every second. Only when the
job is reported not found twice at least 1 second apart while the pid is
alive, and at least 5 seconds of grace remain before the last 5 seconds of the
budget, does it send one SIGTERM; if the pid still runs when those last 5
seconds begin, it sends one SIGKILL. Before each signal it reads the complete
process table (any descendant of the daemon refuses the signal), `launchctl
print` again (not found) and the process identity (user, Node executable,
exact daemon arguments and the start time read before the bootout); the
signal follows that read without a pause. The pid could still be reused by
another process of your user between that read and the signal; that risk is
accepted and not measured. After the pid is gone, one more process table must
show nothing left in the daemon's process group and none of the children seen
while it lived; only then does the upgrade continue, and the CLI prints one
line to stderr without pid or path. The same proof applies when the pid ends
on its own once launchd reported the job not found, and a stop proof that then
runs out of time without having seen the pid alive at its end keeps the
family unproven, so recovery writes and starts nothing. A refusal (identity drift,
children, an unreadable process table) stays the result even when the pid
exits afterwards, and no `launchctl`, `ps` or `osascript` call, including the
second call of a two-step read, and no liveness poll starts after the 75
seconds. Every other outcome fails closed with
`stage: prove-stopped`, `blocker: RECOVERY_ABSENCE_UNPROVEN` and one of
`stopCode: STOP_UNLISTED_ALIVE` (the daemon outlived the budget),
`STOP_BLOCKED_NATIVE_DESCENDANTS` (children appeared or may remain),
`STOP_UNKNOWN_DESCENDANTS` (the process table could not be read before a
signal), `STOP_IDENTITY_MISMATCH` (the pid no longer reads as the daemon,
launchd lists the job again, or the signal was refused) or
`STOP_UNPROVEN_TIMEOUT` (launchd still lists the job, its state could not be
read, or not found came too late for a grace). Recovery then writes and starts
nothing while the old daemon or a child it left may still run, and the drain
marker stays. Children that a dead daemon left behind do not block a later
`service upgrade`.

When the selected service is stopped (on macOS: launchd no longer lists the
job) but the recorded daemon's process still runs, `service status` reports
`running: false` with a recovery text that names this state. Upgrade and
rollback refuse it with `a live daemon remains outside the stopped selected
service`; the stale-drain reclaim does not apply. End that process by hand:
its pid is `pid` in `<config>/control-plane/daemon.json`; first check with
`ps -ww -p <pid> -o command=` that it is the node daemon of this service. Then
run `kherep-node service upgrade --source <clean checkout>`.

`kherep-node service upgrade --source <clean checkout>` activates over the
recorded candidate and stops it through the proven path; `kherep-node service
rollback` restores the receipt's definition from the recorded prior backup and
waits up to 180 seconds for its health; after a failed `service install` (no
receipt) repeat `kherep-node service install` with the same `--workspace` and
`--service-name`, without `--adopt`. `--adopt` over a recorded candidate is
refused. A second failed upgrade over the record can take several minutes
before it reports: each stop proof starts nothing after 75 seconds (for the recorded
candidate, and again for the new candidate during recovery), the health wait
up to 30 seconds and a restore up to 180 seconds.

A recorded candidate loaded without a process (`running: unknown`, for example
a crash loop under `KeepAlive`) is refused by both verbs; `service status` says
so. Unload it by hand, `launchctl bootout gui/<uid>/<label>` (the plist in place
is the recorded candidate, which `status` verified), then run `kherep-node
service rollback`. On Windows stop the task by hand, then roll back. Without a
receipt (a failed install), `service status` shows `running: unknown` with the
repeat-install recovery, but the repeated install refuses while the state is
unknown: unload or stop the candidate by hand the same way first, then repeat
`kherep-node service install` with the same `--workspace` and `--service-name`,
without `--adopt`.

A node where launchd and the plist already disagree reports `definition:
unattested` with `configured: receipt | candidate | unknown`. Reload launchd
only when `configured` is `receipt` or `candidate`, and only after this check:
`shasum -a 256 ~/Library/LaunchAgents/<label>.plist` must equal
`definitionDigest` in `<config>/control-plane/service/receipt.json` (or in
`candidate.json`), the file must be a regular file owned by you with mode 0600
or 0644 and no symlink in its path. Then `launchctl bootout gui/<uid>/<label>`
and `launchctl bootstrap gui/<uid> ~/Library/LaunchAgents/<label>.plist`. For
`configured: unknown` do not reload: inspect and restore the file from
`service/backups/` first. On Windows inspect the task before re-registering it.

`candidate: invalid` means `service/candidate.json` is unreadable or does not
validate. While the receipt matches the loaded definition the next successful
upgrade removes it; otherwise remove the file by hand and run `service status`
again.

On Windows a stop refused by the native script is reported as
`STOP_NATIVE_REFUSED`; `STOP_BLOCKED_NATIVE_DESCENDANTS` is reported for the
read-only descendant wait and on macOS.

`service status` also reports `drain`: `none`, `active`, `stale` or `unknown`.
A stale or unverifiable drain, left by a controller that exited during a
transaction, blocks new session admissions, and status then fails. For a stale
drain it names the recovery `kherep-node service upgrade --source <clean
checkout> reclaims the stale drain (installed source <commit>)` with the
receipt's commit; the upgrade reclaims the drain. For an `unknown` drain, whose
owner cannot be verified, it asks to inspect the `service/drain` owner file
instead, since an upgrade refuses that drain too. A stopped service whose
recorded daemon is dead gets the recovery `kherep-node service upgrade --source
<clean checkout> (installed source <commit>)`: upgrade accepts a stale daemon
record while the service is stopped, and still refuses a
live daemon outside it or a running service whose daemon does not match the
receipt. Status prints the commit, never a local path or pid.
These service commands do not edit runtime hook configuration; run `kherep-node
doctor` and update an independently managed stale hook binding separately.

### Intercom command

Agent sessions reach the Control Plane through one command per host (issue
#436):

```sh
node "<config directory>/bin/kherep-node.mjs" msg sessions
```

The config directory is `KHEREP_CONFIG_DIR` or the per-OS location
(`%APPDATA%\kherep` on Windows, `~/Library/Application Support/kherep` on
macOS). The path is written with forward slashes on Windows and always in
double quotes, since the macOS default contains a space. `service install`,
`upgrade` and `rollback` write the launcher; at every call it reads the managed
service receipt and runs the CLI of the active pin, so the command keeps
working across upgrade and rollback. Without a valid receipt, or when the pin
or its CLI is missing, it exits 1 with a fixed message and does not fall back
to a checkout. Nothing changes PATH.

Both installers render this command into the always-loaded instructions: the
Claude installer into the managed `<!-- kherep-intercom:start -->` block of
`~/.claude/CLAUDE.md` and into `~/.claude/teams/kherep/ROUTING.md`, the Codex
installer into the `<!-- kherep:start -->` block of `<CODEX_HOME>/AGENTS.md`,
into `<CODEX_HOME>/orchestra/ROUTING.md` and into the rules file (see
[Codex integration](CODEX.md#verify-and-upgrade)). The example names this node
from `control-plane/node.json` when it is enrolled and `peer/session`
otherwise. The installers render the command when they run, so after changing
`KHEREP_CONFIG_DIR` or enrolling the node, run both installers again. A config
directory that no shell can quote (a double quote, `` ` `` or `$`, on Windows
also `'` or `%`) stops either installer before it changes a file.

The daemon names the same command in what it writes for sessions: the task
prompt of a started or continued task, the intercom prompt of a resumed or new
intercom session, and the delivery hooks' reply and receive recipes. It does so
when the host's managed launcher resolves (a valid receipt, the pin and its CLI
present, and the launcher file in place); otherwise, as on a node without a
managed service, they keep naming the CLI of the running code. The Codex rules
file holds only the launcher rule, so a Codex session on a host without a
managed service asks for approval per `msg` command. Upgrade in this order:
first `kherep-node service upgrade` to a pin that contains this change, so the
daemon names the launcher, then run `codex/install.mts`, which
rewrites the rules file and drops the rule for the checkout's `cli.mts`.
`kherep-node doctor` reports a rules file that still carries that rule as
`stale`.

From Git Bash, Git Bash still rewrites a `/`-leading argument such as `--cwd
/Users/...` before Node sees it; set `MSYS_NO_PATHCONV=1` for that call or use
PowerShell.

Compare managed source and installed files in both directions before replacing an existing setup. Preserve operator edits and inspect an isolated candidate with read-only settings fixtures.

The installer records backups through managed transactions. Verify recovery in a disposable candidate and retain the recorded backup. Never recursively remove a configuration home to repair an installation.

The workspace rule files `CLAUDE.md` and `AGENTS.md` keep the operator's content. Kherep manages only the block between `<!-- kherep-project-rules:start -->` and `<!-- kherep-project-rules:end -->`. The block is a short reference: the Kherep rules themselves are installed at user level, in `~/.claude/CLAUDE.md` for Claude and in the Codex home `AGENTS.md` for Codex, and both runtimes load those files in every session. On the first upgrade the block is appended after the existing text, which stays byte for byte as it was. A file that still equals a template from an earlier Kherep version is replaced by the block, and a file with only one of the two markers is refused before anything changes. Drift checking compares only the block.

Existing memory services can have persisted identities and state outside the managed files. Preserve recovery copies and verify the selected backend before retiring an existing integration.

A host that was enrolled in the retired Central Brain server backend loses that wiring on upgrade. The Claude installer removes the hook commands it added to `settings.json` and parks `kherep/central-brain/selection.json` in a `_deprecated/` sibling; both previous versions stay in the installation backup. The Codex installer does the same for its managed configuration block, see [Codex integration](CODEX.md#retired-memory-backend). Data held by that server is not touched.

Files the repository no longer ships are listed in `bootstrap/manifest/retired.txt`; an upgrade parks each one in a `_deprecated/` sibling. It also removes every `settings.json` hook command that runs one of these files with `node`, whether the command names the Claude home by its absolute path or, while `CLAUDE_HOME` is the default `~/.claude`, as `~/.claude` or `$HOME/.claude`, and drops a hook group left empty. Only commands whose first token is `node` followed directly by the script are recognised: `node <flags> script`, `ENV=x node script`, `node.exe`, a quoted node path and `$CLAUDE_CONFIG_DIR` forms are not matched, so they are neither unwired nor reported. Each removal prints a line `retire: unwire <event> <command>`. Other hooks, including your own, stay. `drift-check.sh` reports a wired hook command whose script in the Claude home, or a Claude-home script it passes as an argument, is missing or retired as `DANGLING-HOOK <event> <command>` and fails.

The Claude guards of the six `PreToolUse` groups run through `hooks/guard-dispatch.mts` (issue #507): each group has one dispatcher entry with its guards as arguments and a `timeout` of 30 seconds. Since part 2 every managed hook command, the dispatcher entries included, starts through the hook runtime: `node "<CLAUDE_HOME>/kherep/hook-runtime/entry.mts" <pretool|reader|writer> "<CLAUDE_HOME>/hooks/<main>" ...` (see the hook runtime below). The upgrade removes every `settings.json` hook command that runs a managed hook from the absolute Claude home path without the entry, or at an event where the template no longer runs it, a guard the dispatcher now runs included, so nothing runs a second time next to its new entry. It prints a line `hooks: unwire <event> <command> (managed under <event>)` for each, or `(managed under PreToolUse via hooks/guard-dispatch.mts)` for a guard. While `CLAUDE_HOME` is the default `~/.claude`, a raw hand-written entry that is exactly `node ~/.claude/hooks/<hook>` (also as `$HOME/.claude`, `${HOME}/.claude` or `%USERPROFILE%/.claude`, the script quoted or not, with no argument, operator, redirect or line break after it, the path below the token plain and literal with no expansion, glob, escape, `.`, `..` or empty segment, in a hook with no field besides `type` and `command`) is removed the same way when the template runs that hook through the entry or passes it to the dispatcher, also at a matcher the template's entry does not cover. Any other hand-written entry under `hooks/`, for a hook the template does not manage, with more than the script, or in a form that is not matched (`node.exe`, `node <flags>`, `& node`), stays; while it runs outside the entry the integrity run repairs nothing (see below). The install output names each such kept command by its event, matcher and hook file, `hooks: keep <event> [<matcher>] <claude-home>/hooks/<file> (uncoordinated, blocks live-hook-integrity)`, without printing the command or any host path; an event that is not a plain name is shown as `<event>`.

An upgrade replaces an existing entry that runs the same managed hook through the entry, at the same event and matcher, with the template's entry (issue #568). The managed hook is the file after `entry.mts <mode>` under `<CLAUDE_HOME>/hooks/`; whatever else differs, a `timeout`, the mode or the dispatcher's guard arguments, a changed entry never leaves two. This includes an entry you edited: the template's entry wins, and the install output prints `hooks: replace <event> [<matcher>] hooks/<main>` for each replaced entry that differed from it, without the bracket for an empty matcher; an unchanged upgrade prints nothing. An extra entry you added for a managed hook file inside one of these groups is replaced too, a second `guard-dispatch.mts` entry with your own guards included: it prints the same `hooks: replace` line and your guards stop running. Put your own guard in a group with its own matcher, or run it as its own hook file; both stay. An entry for another hook file, the same hook at another matcher or under another Claude home, and a command in a form the rule does not recognise stay: `& node`, `node <flags>`, single quotes, the entry path quoted and the main bare or the reverse, the Git Bash form `/c/...` of a drive path, `.` or `..` segments in the main path, a line break between `node`, the entry, the mode and the main, and, outside double quotes after the main, a shell control operator (`;`, `&&`, `||`, `|`, `&` or a line break), a command substitution (`$(` or a backtick) or a redirection (`>` or `<`). Characters such as `&` inside a quoted path, a Claude home named `R&D` for example, do not count. Text inside double quotes is never checked, so a `$(` or a backtick there is not treated as an operator: such an entry is replaced like any other, and its command substitution stops running. A changed matcher is not covered: an upgrade whose template changes the matcher of an existing managed group leaves the old group wired next to the new one, so do not change a managed group's matcher.

A guard's result passes through the dispatcher only in the `PreToolUse` shape: `hookSpecificOutput` alone, with `hookEventName`, an optional `permissionDecision` with an optional `permissionDecisionReason` (a reason without a decision denies), and an optional `additionalContext`. A result with only `additionalContext`, a notice, passes through unchanged and without a `permissionDecision`; notices of several guards are joined in argument order. Any other field, such as `updatedInput` or a top-level `systemMessage`, denies the tool call and the reason names the field, because dropping it would change what the guard meant. A guard's stderr, its own Node warnings included, is forwarded and is the reason of an exit-2 deny; only Node's type-stripping warning for the `.mts` file is dropped. The dispatcher has these limits:

- The hook runtime entry checks the dispatcher before it runs: a missing, empty or broken `guard-dispatch.mts` is a deny that names it, and the entry starts one integrity writer to restore it for the next call. The entry itself cannot be checked: a missing or broken `kherep/hook-runtime/entry.mts` makes every managed hook exit 1, which Claude Code treats as a non-blocking error.
- Its entries have a `timeout` of 30 seconds. A command hook that reaches its timeout is cancelled and its output discarded (see `docs/superpowers/specs/2026-10-12-claude-midturn-delivery-design.md`), which would let the tool call through. The dispatcher therefore runs the guards in parallel, stops each one after 10 seconds, and bounds reading stdin, the guards and the re-check below by one deadline 25 seconds after it starts (`HOOK_TIMEOUT_MS` minus `SAFETY_MARGIN_MS` in `claude/hooks/guard-dispatch.mts`). The 5-second margin assumes Node starts within 2 seconds and the output is written within 0.5 seconds; the start was measured at 0.09 seconds on macOS and is UNKNOWN on Windows. A test pins `HOOK_TIMEOUT_MS` to the `timeout` of the settings template.
- The entries do not set `onFailure`. The repository declares no minimum Claude Code version, and how an older Claude Code treats a hook field it does not know is not documented here.
- Hook integrity is re-checked on the next matching tool call, not on a timer. `hooks/live-hook-integrity.mts` writes `<CLAUDE_HOME>/.cache/hook-integrity/heartbeat.json` (`ts`, `trigger`, `runtime`, `files`, `pid`; a temporary file renamed into place) only after a run in which every inventoried file ended OK or was restored with a SHA-256 match at the target, the live settings were read completely and the final check below passed; it walks the import closure again after its restores, at most three passes. When the heartbeat is older than 30 minutes or missing, or a guard of the call could not run, the dispatcher re-checks after its guards with at most 20 seconds of what is left of the deadline, and not below 2 seconds. Its lines, headed `hook integrity re-check (<reason>, last OK <time or none>):`, are added as `additionalContext` and written to stderr; they never change the decision. A guard restored during a call is still denied for that call and runs from the next one. The re-check lib must load within 2 seconds and answer before the deadline; the dispatcher exits as soon as stdout and stderr have taken every byte. One Bash call runs three dispatcher groups, so it can show up to three re-check blocks; two of them then usually say `re-check not admitted (busy)`, which names no holder: other integrity runs and the readers of parallel calls both keep a writer out. Whether the session displays a `PreToolUse` `additionalContext` is UNVERIFIED; stderr and `incidents.jsonl`, whose entries name the `trigger`, carry the same findings. An idle session is not re-checked. The restore code itself lives in `hooks/lib/integrity-verdict.mts`, `workspace-scope.mts`, `orchestra-checkout.mts` and `integrity-heartbeat.mts`: when one of them is broken it is reported but not restored until the next installation, and the guards keep failing closed meanwhile. The repair-pass loop, `hooks/lib/integrity-passes.mts`, is shared with the Codex integrity hook; a broken copy is restored like the other libs on both runtimes. Codex has no hook runtime: its hook adapter re-checks within its own 10-second budget (15 seconds for the messaging intent entry), and `codex-hook-integrity.mts` serializes its runs itself by holding `<CODEX_HOME>/.cache/hook-integrity/run.lock.sqlite` as an `EXCLUSIVE` SQLite transaction, which the operating system releases when the run ends; a second run retries a busy answer three times within about 40 ms (measured on macOS; Windows UNKNOWN, T4.11 bounds it at 250 ms; issue #620) and then reports `busy, holder UNKNOWN` and changes nothing, a `run.lock.sqlite` the run can read but not write is refused as `run.lock unavailable (ERR_SQLITE_ERROR)` because its `BEGIN EXCLUSIVE` would exclude nothing, and network filesystems are not supported for it ([Codex integration](CODEX.md)).

Denied calls of delegated workers (issue #504): the dispatcher, and the hook runtime entry for its own denies, append one line per guarded call of a delegated run (a payload with a valid `agent_id`, the handback excluded) to `<CLAUDE_HOME>/.cache/denied-calls/<agent_id>.jsonl`, directory `0700` and files `0600` on POSIX; on Windows the profile's access control applies. A line holds opaque ids, the tool name, the worker's `agent_type`, a target class (the program's basename, a path relative to the call's cwd or `<outside cwd>`, the agent type, the MCP tool name) and per denying guard its tag and one line of its reason with every absolute path reduced to its basename: the first non-empty line or, when that line ends with `:` and another follows (the header of the commit, deploy and main-checkout guards), the next line without its list marker (issue #700). A privacy denial, and any target or reason matching the private marker pattern, is `<withheld>`. No prompt, command text, patch body, file content or session id is stored. The write is capped at 1.5 seconds (0.5 in the entry) inside the hook's deadline and never changes the decision; a write that fails or stalls leaves `<agent_id>.failed`, a marker line, else the journal renamed to it. The marker write is awaited until the writer's own deadline (the dispatcher's, at most 25 seconds after its start; the entry's, 26 seconds; the delivery recorder's, 5.5 seconds after its process start), because each writer exits through `process.exit`, which abandons a pending write (issue #614); the recorder's rename retry for `EPERM`, `EACCES` and `EBUSY` runs up to that deadline as well. A marker write that never settles holds the decision until that deadline and leaves no marker; the decision still arrives before the hook's `timeout` as long as each Node start stays within the assumed 2 seconds. The delivery recorder's own start-up counts inside its 5.5 seconds, so a recorder that starts near 4.8 seconds or later leaves no marker for a marker write that is still pending at its deadline (issue #664). The `PostToolUse` group with matcher `SubagentHandback` also runs `hooks/denied-calls-delivered.mts` (`timeout` 10), after the handback executed, and appends a `delivered` line; it prints nothing and cannot block. The Maestro reads a worker's list with `node "<CLAUDE_HOME>/hooks/denied-calls.mts" render <agent_id>`, which prints `DENIED-CALLS: none | <n> | unknown (<code>)`, at most 200 denials, write tools first, and a status line, and exits 3 on `unknown`; `none` needs the journal, no marker, at least one `call` line and no denial. `list [--minutes <n>]` is an operator diagnostic, never acceptance evidence, and `prune` removes a journal and its marker once both are older than 24 hours; no hook prunes. The renderer is not wired as a hook, so hook integrity does not restore it; the installer does. Limits:

- When the marker append and the rename both fail or stall within one hook run, the lost line leaves no evidence and a later `render` can read `none`; the decision was still emitted.
- A dispatcher that Claude Code cancels at its timeout before it wrote denied nothing either: the call proceeded. A `PreToolUse` that never ran is not detected; this change has no transcript audit.
- A call that the hook runtime entry itself denies and whose payload is over 1 MiB is not parsed, so it leaves no line and no marker; when the worker's other calls were journalled, a later `render` can read `none`.
- A deny with several violations records only the first; the other bullets, which can carry the command, and the advice after them are never recorded. A warning line printed before a guard's header (main-checkout-guard) is recorded instead of the header, with the tag `guard`. The handback's own denials stay out of the list.
- A reason's absolute path ends at the first space: `/a/My Docs/x.txt` is recorded as `My Docs/x.txt`, so directory names after a space remain.
- On Windows a rename held by a foreign handle is retried only by the delivery recorder; the dispatcher, the entry and the Codex paths try the marker and the rename once.
- That the agent ID Claude Code returns for a worker equals the `agent_id` of its hook payloads is UNVERIFIED until measured on a host; a mismatch reads `unknown (journal-missing)`. A resumed worker keeps its agent ID, so `render` covers its whole life. Explore and Plan workers return no agent ID and read `unknown (no-agent-id)`.

The hook runtime (`claude/kherep/hook-runtime/`, installed under `<CLAUDE_HOME>/kherep/hook-runtime/`, issue #507 part 2) serializes hook integrity repairs against every hook it starts. `entry.mts` imports only Node built-ins and lives outside the repaired `hooks/` tree. It starts the main as a real Node main, with the same arguments, working directory, environment and stdin bytes, behind a preload that first opens `<real hooks directory>/.kherep-integrity/run.sqlite` of the installation's own hooks directory (`<CLAUDE_HOME>/hooks` beside `<CLAUDE_HOME>/kherep/hook-runtime`; a main in a subdirectory uses the same database, and a main outside it is refused) through `node:sqlite` (rollback journal mode `DELETE`, checked on every open; no runtime flag on the supported Node releases) and takes a read transaction, or, for `live-hook-integrity.mts`, an `EXCLUSIVE` one. Node loads the main and its imports only after that, and the entry accepts the main's output only after the child reported its admission over a private IPC channel. The transaction belongs to the process that runs the hook and ends when it ends, also when the entry above it was killed. The dispatcher passes the same admission to each guard child, ends its own read transaction after the guards, and only then starts the integrity writer. A writer kept out by readers, or a reader kept out by a writer, retries for a few seconds; a writer then reports `re-check not admitted (busy)`, a `PreToolUse` reader becomes a deny `not admitted: busy`.

The integrity writer records each repair, with its complete bytes, in the database before it writes the first byte. It writes an existing file in place, in the same inode, so its owner, mode and access-control list stay as they were, and publishes an absent file complete through a hard link that fails if anything appeared at the name. The record is cleared only after the target holds every byte; a process that dies in between leaves it, and the next admitted process replays exactly those bytes before anything loads the file. A write refused before it touched the target clears the record. The writer removes the old heartbeat before its first repair and writes a new one only after a final read-only check of the live import closure (supported inventory and syntax checks; no versioned source stands in for a missing file), within one `EXCLUSIVE` hold. For `PreToolUse` the entry turns every runtime failure (no admission, a missing, empty or broken main, a signal, a timeout, output that is no `PreToolUse` decision) into a deny that names the main; other events keep their own output and exit code, and get a fixed line with exit 1 when the runtime cannot admit them. The runtime has these limits:

- It covers only hooks it starts. Installers, editors, Codex's own hook copies and any other writer or reader outside it are outside the guarantee; an uncoordinated reader can see a file while it is being written. The integrity run repairs only as the admitted writer on its own hooks directory, and only while every wired command that runs `hooks/` code is exactly one entry call, `node <entry> <mode> <main> [args]` with no shell operator, separator, redirection or command substitution; otherwise it reports and repairs nothing.
- The database is permanent: Kherep never deletes, renames or replaces it. A database that is a link, has a second name, uses `WAL`, holds a foreign schema or cannot be read is refused without a repair, and every `PreToolUse` call of that hooks directory is denied until an operator fixes it. A database the hook process can read but not write (a read-only file or mount, another owner) opens read-only, and there `BEGIN EXCLUSIVE` excludes nothing: the integrity writer and every replay of a recorded repair are refused as `not admitted: unavailable` before anything is written, so a recorded repair stays pending; a hook without a pending repair is still admitted, because its read lock still keeps a writer out. Network filesystems are not supported. A hooks directory on a filesystem without hard links (FAT, exFAT, some WSL mounts) cannot have a missing file restored: its publication fails closed with `publication failed`, and Codex hook integrity, which shares `restore-write.mts`, has the same limit; existing files are still written in place. A missing file is created beside its target, so it gets that directory's ACL, default ACL and group, and before its first byte it gets a second name `*.kherep-tmp` in the hooks directory; the name beside the target is then removed, and the file is linked into place only while the hooks directory, the target's directory and that second name are still the ones measured at the start (otherwise `target directory changed before the publication; refusing to publish` or `staging file or hooks directory changed before the publication; refusing to publish`). Before its first byte the publication needs the right to add a name in the hooks directory and to remove the new name beside the target, and the target's directory on the same volume as the hooks directory: without them a missing file is not repaired, the publication fails closed with `publication failed (<code>); the target stays absent` before any byte is written, and an existing file is still written in place. Removing the second name in the hooks directory after the link, or after a refusal, is best effort and not reported: where the hooks directory does not allow that removal, the `*.kherep-tmp` stays there as a second name of the published (or refused) file. Leftovers are not excluded in every case: a crash, or a directory rename in the short window before the first byte, can leave an empty `*.kherep-tmp` beside the target or in the hooks directory (both after a crash in that window), a crash after it one `*.kherep-tmp` in the hooks directory, and a hooks directory renamed during a publication keeps the writer's file under its old name. None of them is ever loaded, and each may be removed. A swap between the last identity check and the link is not closed; every caller measures the target's bytes afterwards, which catches other bytes but not a foreign file with the same bytes.
- A recorded repair that keeps failing after it may have touched its file keeps every hook of that hooks directory out, fail-closed, until it completes. The guarantee is recovery after a process crash on a local filesystem, not power-loss durability.
- When an outside writer (an installer or an editor) replaced the target of a recorded repair with another file, the repair stays refused; nothing replaces a file it did not judge. Stop that writer, then recover explicitly from a terminal of your own, since guarded tool calls are denied meanwhile. `node "<CLAUDE_HOME>/kherep/hook-runtime/replay-pending.mts" inspect --hooks-root "<CLAUDE_HOME>/hooks"` prints the pending intent, its root-relative target, the recorded hash and the current file's device, inode and hash, and changes nothing. `replay-pending.mts replay --hooks-root <root> --intent <id> --desired-sha <sha256> --current-dev <n> --current-ino <n> --current-sha <sha256>` with exactly those values writes the recorded bytes, an older version if the outside writer brought a newer one, into that file in place (same inode, owner, mode and ACL) and clears the intent only when the file is measured to hold them; any value that no longer matches, a moved hooks or parent directory, a link, a second name or a missing database is refused without a change. It binds the intent to the confirmed file before it writes, so a crash after that point is completed by the next hook like any other recorded repair. It runs no hook and writes no heartbeat; the next integrity run proves the hooks again. An intent recorded for an absent target, or a replaced directory, is not covered. Upgrade again afterwards through the installer if the newer version was intended.
- On Node releases that still call `node:sqlite` or type stripping experimental, every process the runtime starts drops exactly those two `ExperimentalWarning` lines, so they reach no hook output or exit-2 reason; every other warning stays. Busy detection reads Node's numeric SQLite error code; where it is absent, contention denies instead of retrying.
- On Windows a hook process ends together with the entry that started it (libuv's job object), so a cancelled hook leaves no child behind; elsewhere such a child runs on and keeps its admission until it ends.
- Access-control preservation is tested with macOS `chmod +a`, Linux `setfacl` and Windows `icacls`, each compared through two reads of the same file (on Windows a complete `Get-Acl` snapshot of the Access SDDL and its inheritance flag). Where a tool or a non-root user is missing on macOS or Linux the case is skipped. On Windows a case is skipped only when the operation it relies on being denied (a read, a write open, or adding a hard link to the hooks directory) is measured to succeed although the deny entry was read back in place, and the skip names that measured fact; every other setup or read failure fails the case.

The observation result check (issue #555) has two Claude hooks. A `PostToolUse` group with matcher `SubagentHandback` runs `hooks/obs-handback-record.mts` (`timeout` 10 seconds): it checks a `claude-obs` report where the subagent hands it back, records the verdict in `<CLAUDE_HOME>/.cache/obs-result-check/<agent_id>.delivered` and warns the operator about a `failed` or malformed line, without refusing the handback. The `SubagentStop` group with matcher `claude-obs` runs `hooks/obs-result-check.mts` without a `timeout` field, so the stop uses Claude Code's default hook timeout. It reads that record first and, without one, waits up to 2 seconds for it when Claude Code reports `permission_mode` `auto` or the subagent transcript shows a `SubagentHandback` call; it never blocks in either case. Only without any handback evidence and outside auto mode does it judge `last_assistant_message`, and only then can it send a malformed line back once. After each stop it clears the record, writes `<agent_id>.stop`, a line of fixed keys (`mode`, `state`, `waited`, `after`, `transcript`, `branch`) for measuring the order of the two hooks on a host, and removes files of that directory older than 24 hours, except the `.refused` markers, which no hook removes. Known limits: the operator can see the same notice twice when the recorder runs after the stop hook's transcript check, and a resumed subagent whose transcript shows no handback accepts an older record of the same `agent_id`.
A resumed subagent keeps its history, so the last handback visible at its stop can be the previous run's, whose id matches the old record: the stop hook then stays silent for the new run, and only the recorder judges the new run's handback.

A third Claude hook refuses a malformed handback before it runs (issue #571). The sixth `PreToolUse` group, matcher `SubagentHandback`, runs `hooks/obs-handback-gate.mts` through the dispatcher (`timeout` 30). When a `claude-obs` handback's first non-empty line is not exactly one valid `OBS-RESULT` status line, the gate creates `<CLAUDE_HOME>/.cache/obs-result-check/<agent_id>.refused` exclusively, one line `refused\t<tool_use_id>`, and denies the call with a reason naming the fixed problem; the subagent then sends a corrected handback. A later malformed handback of the same `agent_id` finds the marker and passes, so the recorder reports it as before. The marker is retained, because a resumed subagent keeps its id: no hook, installer or drift check removes it, and deleting it by hand re-arms the gate for that id. When the marker cannot be created the gate lets the call through, since a refusal it cannot remember could repeat on every attempt. Without a valid `agent_id`, without a visible message, or for any other tool or agent the gate does nothing. The once-per-id bound holds for a gate that ran; a gate file that cannot run is denied by the dispatcher on every `SubagentHandback` call, like every guard. On a host whose `settings.json` already has a dispatcher entry under `PreToolUse` with matcher `SubagentHandback`, the upgrade replaces it with the gate's entry and prints the `hooks: replace` line, as for every managed group above; other hooks in that group stay.

Rolling the gate back takes more than reverting the template: a render of an older template keeps the gate entry, because that template still runs `guard-dispatch.mts` at `PreToolUse`. Parking `hooks/obs-handback-gate.mts` while it is wired makes the dispatcher deny every `SubagentHandback` call of every agent. Remove the entry first, in this order:

1. Revert the template commit and install, so the template no longer carries the group.
2. Take an inventory of both settings files that `drift-check.sh` reads, `<CLAUDE_HOME>/settings.json` and `<workspace>/.claude/settings.local.json`: every hook object of every event and group whose `command` contains `obs-handback-gate`, compared case-insensitively, whatever its quoting, path, extension or wrapper. Note each candidate's file, event, matcher and full hook object.
3. Remove only when there is exactly one candidate, it is in `<CLAUDE_HOME>/settings.json` under `PreToolUse` with matcher `SubagentHandback`, and it is exactly `{ "type": "command", "command": "node \"<CLAUDE_HOME>/kherep/hook-runtime/entry.mts\" pretool \"<CLAUDE_HOME>/hooks/guard-dispatch.mts\" \"<CLAUDE_HOME>/hooks/obs-handback-gate.mts\"", "timeout": 30 }` with no other key. Any other result (no candidate, more than one, another file, event or group, another command or an extra field) stops the procedure with no change.
4. Remove that one hook object. Keep every other hook object of the group as it is, and remove the group only when it is then empty; never remove a group by its matcher.
5. Verify: the inventory of step 2 finds no candidate in either file, and both files equal their state before the removal except for that object (and the emptied group). Compare every unrelated hook object, not their count.
6. Only then park the file, if wanted. A failed step 3 or 5 forbids parking.

Neither check of `drift-check.sh` proves that the gate is unwired: `DANGLING-HOOK` reports a wired command only once its file is missing or retired, which is the unsafe order, and the expected `settings.json` is rendered from the live one, so it carries the same residual gate entry and compares clean. Only the inventory of steps 2 and 5 proves it.

The Jira helpers in `<workspace>/tools/` (`atl-jira.mts`, `atl-jira-ccoder.mts` and the `jira-*.mts` modules they import) are optional. `drift-check.sh` compares them when `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` is set or when any of these exact file names is present, so a stale copy left by an earlier installation with the switch is reported as `DRIFT`, and an incomplete set reports its absent members as `MISSING-LIVE`. Reinstall with `KHEREP_INSTALL_ATLASSIAN_TOOLS=1` to refresh them. Files that only resemble them, such as `atl-jira.mjs`, a `*.bak-*` copy or anything under `_deprecated/`, do not count. On a host with none of them and without the switch, `drift-check.sh` prints one line `NOT-INSTALLED project/tools/<Jira set>`, which is information and does not change the result.

The observation tools in `<workspace>/tools/` (`observation-*.mts`) are written by `codex/install.mts`, not by `bootstrap/install.sh`. After a change under `modules/atl-jira-brokers/`, run both installers on a host with the Codex adapter. `drift-check.sh` compares the set when any of its files is present: a stale copy is `DRIFT` with a `HINT` line naming the installer, and absent members are `MISSING-LIVE`. On a host without the set it prints `NOT-INSTALLED project/tools/<observation set>`, which does not change the result.


## GitHub App issue broker source

The installer projects the same validated shared closure to
`<workspace>/tools/github-broker/`, including `github-claude.mts` and
`github-codex.mts`. Each entrypoint binds its runtime internally. The source copy
uses the existing installation transaction, preserving rollback and idempotence;
bootstrap drift checking compares every file in that closure. Both actual staged
entrypoints are import-tested without configuration, key or network side effects.

Installation creates no enabled policy, key, App registration, installation,
permission grant or network probe. Operational setup and publication authority
remain separate. See the [broker contract](../modules/github-broker/README.md)
for its strict stdin interface, default-off policy, fixed GitHub.com public scope,
secret handling, uncertain-outcome receipts and native/live acceptance gates.
