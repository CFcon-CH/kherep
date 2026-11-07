# Codex Desktop client binding probe

This directory is a disabled-by-default compatibility probe for issue #127. It checks whether one exact `PreToolUse` invocation and the matching MCP call carry the same native client identity. It cannot read or send messages, inspect tasks, control sessions, open a network listener, or grant general tool approval.

This probe targets the Codex hook and MCP metadata contract. Do not install this hook in Claude: its outgoing identity metadata and hook approval behavior need a separate compatibility check. A Codex pass makes no Claude compatibility claim.

## What it proves

The hook accepts only `mcp__kherep_binding_probe__binding_probe` with one bounded synthetic nonce. It stores a 30-second intent in an operator-selected directory outside the checkout, then adds a random request ID to the tool arguments. The official MCP SDK stdio server checks native `sessionId`, `threadId`, and `callId` metadata against the intent. Results contain fixed codes, keyed SHA-256 hashes and, on success, the boolean `threadMatchesHookSession`. Raw hook input, working directories, transcripts, session IDs and call IDs are not returned or logged.

After binding verification succeeds, `threadMatchesHookSession` reports whether the native thread ID equals the verified native session ID from the hook. `false` is a valid equality observation with `binding_confirmed`. This response-only field leaves stored receipts unchanged and does not establish main-chat classification, registration authority or compatibility on unmeasured hosts.

A passing automated test proves the SDK transport preserves supplied request metadata. It does not prove that an installed Desktop build supplies those fields. Direct, Code Mode, resumed and parallel calls still require an operator-authorized actual-client canary. Until that canary passes, remote messaging remains unsupported through this route.

## Source-only verification

```text
npm test
npm run typecheck
```

The tests use temporary synthetic state. `transport.test.mts` starts real SDK stdio client and server processes, verifies both equality outcomes, missing and foreign identity rejection, thread-change replay rejection, identical repeated public results, text/structured parity and raw-identity privacy, and races two server processes against one idempotent intent.

## Lock files, recovery and manual cleanup

Intent creation and each verification run under an exclusive lock file in `<state-dir>/locks/`: `create.lock` for creation, `<requestId>.lock` for the verification of one request. A holder writes an owner record into its lock before it does any work: one line `{"version":1,"pid":…,"token":…,"at":…}` followed by a newline, where `token` is 32 random hex characters and the trailing newline marks the record complete. `at` is diagnostic only. A holder whose owner record cannot be written completely closes its lock, removes it and reports `storage_error` without doing any work.

A create that finds the lock held, or that fails with `EPERM`, `EACCES` or `EBUSY` (on Windows the lock of a holder that is releasing it is delete-pending for a moment, issue #600), waits and tries again: at most 50 attempts of at least 4 ms per call, after which the call fails closed with `storage_error`. A lock is removed automatically only when its owner record is complete and `process.kill(pid, 0)` reports its process absent (`ESRCH`). The removal goes through a sibling `.reclaim` gate, which rereads the exact record under the gate and keeps any replacement; a reclaimer that died holding a gate is recovered one gate level deeper, at most 4 gate levels in all (issue #602). A live owner, an owner whose process cannot be probed, and an empty, incomplete, malformed, oversized or symlinked lock are never removed automatically, whatever their age. An empty lock is what an older version of the probe leaves.

A release that fails reports `storage_error`. What the action already persisted stays: a created intent, or a receipt written by a verification. That process creates no new probe lock until it has retried the same release; the retry runs at the start of its next probe call, and an exact repeated verification then returns the same receipt. The hook runs once per call, so a hook whose release failed exits with the lock still holding its complete record; the next call reclaims it once that process is gone.

A lock descriptor whose close fails is reported as `storage_error` once and never closed again, because its number may already belong to another descriptor of the process; the release still removes the lock by path. On a Windows filesystem without POSIX delete semantics such a leaked descriptor can keep the lock name delete-pending for the life of that server process: other contenders then see `EPERM` until the bound and fail closed. A restart of the MCP server clears it. Which delete semantics the installed Node and libuv use is not established here.

Manual cleanup, for a lock that the probe will not remove on its own: disable the MCP server entry and make sure that no `hook.mts` or `server.mts` process of that state directory runs (a quiescent host, verified by the operator). Then either delete the files under `<state-dir>/locks/` that hold no complete owner record, or discard the whole synthetic state directory and start with a fresh one. Never delete a lock whose record names a running process. No tool automates this.

## Candidate Codex configuration

Do not add these entries automatically. Before activation, verify the installed client source identity and current config schema, review the concrete diff, and preserve every existing MCP server, hook and approval rule. Codex loads MCP servers from native `mcp_servers` TOML tables and hooks from `[[hooks.PreToolUse]]`. The official configuration reference documents `command`, `args`, `enabled`, and per-tool `approval_mode`; the hooks reference documents inline TOML and `commandWindows`.

Use an absolute external state directory with owner-only access. Both processes receive it through the exact `--state-dir` argument. Neither process reads the state path from model input. The MCP entry remains disabled until the canary is explicitly activated.

Windows candidate for the MCP server:

```toml
[mcp_servers.kherep_binding_probe]
enabled = false
required = false
command = 'C:\absolute\path\to\node.exe'
args = ['D:\absolute\path\to\kherep\modules\control-plane\client-binding-probe\server.mts', '--state-dir', 'D:\absolute\path\to\synthetic-probe-state']
enabled_tools = ['binding_probe']

[mcp_servers.kherep_binding_probe.tools.binding_probe]
approval_mode = 'prompt'
```

macOS candidate for the same MCP server:

```toml
[mcp_servers.kherep_binding_probe]
enabled = false
required = false
command = '/absolute/path/to/node'
args = ['/absolute/path/to/kherep/modules/control-plane/client-binding-probe/server.mts', '--state-dir', '/absolute/path/to/synthetic-probe-state']
enabled_tools = ['binding_probe']

[mcp_servers.kherep_binding_probe.tools.binding_probe]
approval_mode = 'prompt'
```

Add one exact hook group to the same native Codex TOML layer. `command` is the macOS form. `commandWindows` is the Windows override and uses PowerShell's call operator for a quoted executable:

```toml
[[hooks.PreToolUse]]
matcher = '^mcp__kherep_binding_probe__binding_probe$'

[[hooks.PreToolUse.hooks]]
type = 'command'
command = '"/absolute/path/to/node" "/absolute/path/to/kherep/modules/control-plane/client-binding-probe/hook.mts" "--state-dir" "/absolute/path/to/synthetic-probe-state"'
commandWindows = '& "C:\absolute\path\to\node.exe" "D:\absolute\path\to\kherep\modules\control-plane\client-binding-probe\hook.mts" "--state-dir" "D:\absolute\path\to\synthetic-probe-state"'
timeout = 10
```

Keep normal MCP approval enabled. A valid exact-call rewrite returns the per-call `permissionDecision = "allow"` required alongside `updatedInput`; that rewrite does not approve the MCP tool itself. Do not add a `PermissionRequest` hook or a blanket allow rule. The probe hook denies malformed exact-tool calls and leaves unrelated tools untouched.

References: [Codex hooks](https://learn.chatgpt.com/docs/hooks), [Codex configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).

## Actual-client canary

Use fresh synthetic nonces and record only client/server versions, fixed result codes and keyed hashes:

1. Enable only the candidate MCP entry after reviewing the exact config diff. Run one direct call and one Code Mode call. Each must return `binding_confirmed`.
2. Resume the same chat without restarting the app and make a fresh call. It must return `binding_confirmed`; compare its session and thread hashes with the pre-resume receipt.
3. Run fresh parallel calls in two chats. Each must succeed with its own call hash, and the chat identity hashes must remain separated.
4. Call without a hook-created intent, or with native metadata absent in the synthetic harness. It must fail with `intent_not_found` or `missing_native_meta`.
5. Confirm ordinary MCP approval still appears according to the existing policy. Any blanket approval behavior fails the canary.

Two negative cases belong to the SDK harness, not the model-driven canary:

- Replaying an old request ID from another chat through the SDK must return `identity_mismatch`. A model call cannot perform that replay through the exact hook because the extra `requestId` makes the hook input invalid.
- Repeating the exact completed transport call with the same request ID and call metadata must return the same receipt. A fresh model tool call has a new call ID and receives a new request ID, so it is not a transport replay.

Any missing native metadata, unexpected approval behavior, raw identifier output or cross-chat acceptance fails the canary. Source-only tests do not establish installed Desktop compatibility.

## Rollback

Set `mcp_servers.kherep_binding_probe.enabled = false`, then remove only its MCP tables and exact `PreToolUse` group after the client is no longer using them. Remove the external synthetic state directory according to the operator's normal local cleanup procedure. No other MCP server, hook, approval or application setting belongs to this probe.
