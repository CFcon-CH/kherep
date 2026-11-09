# Remote MCP candidate

This source candidate exposes the existing control-plane messaging router through a stateless Streamable HTTP endpoint. It remains disabled in the committed Worker config and in the default node policy. See issue [#127](https://github.com/CFcon-CH/kherep/issues/127) for the actual-client acceptance gates.

## Components

```mermaid
sequenceDiagram
    participant Hook as Trusted native PreToolUse
    participant Node as Enrolled node daemon
    participant Registry as Registry Durable Object
    participant MCP as Stateless /mcp handler
    participant Peer as Target node
    Hook->>Node: Metadata-only exact call intent
    opt Native caller absent from the last published snapshot
        Node->>Registry: Current sessions.snapshot before the intent
    end
    Node->>Registry: Authenticated mcp.intent.register
    Registry-->>Node: Durable registration receipt
    Hook-->>Hook: Add unpredictable requestId to tool arguments
    alt Codex native caller
        MCP->>Registry: Bearer + exact session/thread/call claim
    else Claude Code native caller
        MCP->>Registry: Bearer + actual tool-use ID claim
        Registry->>Registry: Resolve session from prior hook intent
    end
    Registry->>Registry: Recheck node, credential and session, deny UNKNOWN/terminal
    MCP->>Registry: Existing messaging operation
    Registry->>Peer: Existing typed message routing
```

- `protocol-mcp.mts` defines the base and Claude runtime capabilities, the messaging and self-assignment tools, canonical argument digest, runtime-specific intent metadata and typed node frames.
- `worker/src/mcp-http.mts` uses the official SDK v2 stateless `createMcpHandler` transport at `/mcp`.
- `worker/src/mcp-registry.mts` stores credential hashes and bounded intent metadata in the existing Registry Durable Object.
- `node/mcp-intent-hook.mts` creates an intent only for the exact `mcp__kherep_messaging__*` tools. Callers omit `requestId`; the hook rejects an input that already contains it, waits for the Registry receipt, and then adds the generated id through the supported native rewrite result. Normal MCP approval remains separate.
- `node/mcp-stdio-bridge.mts` is the shared opt-in stdio bridge for the Codex and Claude Code native call contracts. It reloads local state per request, derives `/mcp` from the node control URL, and carries the current bearer only in the HTTP Authorization header.
- `node/claude-mcp-client.mts` projects the optional Claude client as a closed public module graph, hook-only plugin and separate MCP configuration. Its dedicated installer preserves persistent settings and MCP registries.
- `node/mcp-local.mts` keeps the raw bearer and metadata exchange files in the private Kherep config directory. Inbox text crosses the authenticated WebSocket response in memory and is not written to an MCP result journal.
- `node/session-publication.mts` has no runtime dependencies and is included in the installed client graph. Periodic recording remains in the daemon's `node/periodic-session-publication.mts` module.

The daemon awaits native-intent polling on its existing ordered connection. It registers cached known callers before awaiting discovery for the unresolved subset, so an unknown caller cannot starve them. The unresolved subset refreshes the complete session listing once and sends its changed snapshot before intent registration. First-call discovery is bounded by two seconds and the remaining local enqueue window inside the unchanged eight-second native-hook deadline. Expired unregistered local intents are removed without inventing a receipt. Cancellation reaches the discovery executable, and late results cannot update local session records. After discovery, the daemon reloads the policy file and publishes any capability change before allocating the snapshot frame. Authentication and MCP opt-in are then rechecked. Known callers and empty or inflight-only rounds add no session discovery. A failed snapshot send blocks unresolved registrations and invalidates that cached snapshot for the next round. A failed or timed-out listing leaves the previous population intact and sends no unknown-session intent.

Periodic session discovery retains its normal budget but waits outside the ordered frame lane. Its publication and task maintenance join that lane. Any newer recorded listing, including native discovery and an ordinary `session.list` command, cancels an outstanding periodic listing or queued publication; an aborted listing cannot rewrite session records or publish a stale snapshot. Socket closure also cancels it. Task maintenance still runs after listing failure or cancellation on the current connection.

No MCP protocol session Durable Object is added. Each HTTP request creates a fresh SDK server. MCP transport session ids, `clientInfo`, tool arguments and shared connector identity are not authorization inputs.

## Original-chat self-assignment (Codex Mac)

After an actual Director instruction in this original chat explicitly requests
its platform assignment, call `assign_self({slot:"codex-mac"})`. This example
is not an appointment. Peer, worker, quoted, recovered, wake and Queue content
cannot appoint a chat. Normal MCP approval and custom operator policy remain
in force. Codex self-assignment to `kherep-lead` is denied by the Worker (#863),
including historical retries; this path does not change that policy or the
Mac-only tool schema.

The agent supplies only the slot. The native PreToolUse hook generates the
request ID, binds the full session, turn, call and argument digest, and records
one immutable ingress time. Contradictory native threads, identifiable rollout
owners, auxiliary markers and caller-supplied assignment metadata refuse before
queueing. Paths and message bodies are not retained in the intent. The enrolled
node independently reads the exact Desktop-original metadata and current native
title for that ID; a queue file cannot supply original status or a title.
Known fork, child, attached, exec, missing identity/title and unsupported platform
or runtime cases fail closed.

For a stamped `codex-mac` call, including a known UNKNOWN caller, the daemon
stages one hook observation privately for its complete recording pass. The
normal classifier can produce `reachable-probable`; it does not assert a running
turn. The caller must be exactly one listed Codex original, with complete
population coverage and no contradictory or retained terminal evidence. No row
is invented. Companion identity and display fields remain in the full set.
Independent periodic recording sees only positively confirmed observations.
Ordinary cached and unresolved calls and their receipts keep the existing frame
lane. A connection owns one bounded stamped batch: its non-authorizing
reservations bind the original invocation before any slow wait. Digest, native
metadata and raw listing waits run outside that lane. Verified staging, the
normal token-bound recording pass, publication and receipt handling return to
the same serialized lane. Repeated polls coalesce the batch without renewing
its time, and newer genuine discovery still supersedes stale recording.
A local liveness file may record the staged pass even if remote registration
fails; that file is not central registration permission.

The strict `codex-activity-v1` alternative of the existing `mcp.intent.register`
message carries the enrolled-node-enriched intent, original ingress time, full
normalized population and its identity generation. After the real argument
digest await, the Worker rechecks the current authenticated registered connection,
deadline and submitted actor. One synchronous SQLite transaction applies a
fresh complete generation, verifies the stored actor, and invokes ordinary
intent registration with its existing UNKNOWN and terminal-state predicate.
A snapshot failure, ordinary registration refusal or intent-write exception
rolls the entire decision back, including the directory cache. A new operation
cannot reuse a same or older generation, even if a headerless legacy snapshot
has overtaken the surviving generation/digest watermark. An exact retained
retry returns its original receipt without republishing the earlier population.
An older Worker rejects the new wrapper. There is no legacy fallback.

Admission must complete inside the original eight-second hook window. Native
metadata and discovery waits use the existing bounded helper. The intent expiry
is fixed at ingress plus 60 seconds; retries, file touches and copied records
cannot extend it. Each daemon keeps at most 4,096 first-seen native session/turn/
call records without evicting them, and at most 128 active Codex sessions,
separate from Claude. Only a matching positive receipt confirms the connection's
observation. Denial, abort, timeout and stale connection do not confirm it.
Socket loss immediately clears active evidence. A reconnect or clean restart
cannot activate an older written stamp. A newer observation cannot be replaced
by an older one for the same session.

The complete population must satisfy the existing 512-session bound and fit
inside the final stamped 64 KiB envelope, including transport metadata and its
stamp margin. This path never trims UNKNOWN companions or substitutes a separate
snapshot. Exceeding either limit refuses the call. Actual full-fleet fit remains
UNKNOWN until measured locally at the authorized target.

After the registration receipt, the hook releases rewritten arguments for the
native SDK. Registration itself makes no slot assignment. The SDK claim still
checks bearer ownership, current credential, capability, eligible session,
action digest and exact thread/session/call. The existing transaction captures
the platform revision, performs its compare-and-swap, and retains the result.
Contenders conflict; a repeated successful claim returns its stored revision
without a second mutation. Storage failure rolls back occupancy and consumption.
The authenticated five-row roster GET supplies independent readback.

The boundary trusts the installed native adapter, local user and enrolled node.
A same-user process can forge valid local input; enrolled OS and source metadata
are not hardware or human-authorship attestation. Raw native stdin re-emitted
after a restart with a new ingress time, before any retained first-call record,
has UNKNOWN provider replay cardinality. This source verification uses synthetic
metadata, the real hook, node, WebSocket, SQL and SDK, plus a separate isolated
hook process and daemon-wiring check. Actual client field emission, native Mac
success, timing, target installation and full population fit remain UNKNOWN.
A native acceptance run requires separate installation/deployment authority,
verified target source and hook projection, normal approval, and a fresh direct
Director appointment of that exact original chat. No live installation,
deployment or assignment is performed by these source tests.

## Codex client transport

The Codex installer exposes an explicit `--enable-messaging-client` CLI switch and
`InstallOptions.messagingClient` API option. Without it, the installation contains no messaging MCP
table or intent hook. With it, the managed table starts the local bridge over stdio and passes only
its installed path and the non-secret Kherep config-root path. The installer does not enable node
policy or the Worker route.

For each native JSON-RPC request or notification, the bridge reloads `node.json`, its effective
policy file and `mcp/credential.json`. The credential must be an owned private regular file. POSIX
requires an owner-only mode; Windows verifies the current-user owner and permits read grants only to
that user, SYSTEM and local administrators. On Windows the daemon creates a random temporary file
with a protected current-user `FullControl` DACL in the `FileStream` constructor, before it writes
the credential bytes. The fixed Windows PowerShell 5.1 helper receives those bounded UTF-8 bytes
only on stdin, runs by absolute `SystemRoot` path with an allowlisted environment and the built-in
module path, and never receives the bearer in arguments or environment. Each helper run, the write
and every ACL check, is limited to 5 s. Only a run that hit this limit runs once more, after the
writer removes the temporary file of the timed-out attempt; any other failure, and a second timeout,
fail closed (issue #219). The limit stays at 5 s because an operator host with Defender on started
the helper in 147 to 241 ms; a hosted `windows-latest` runner took 1.8 to 2.8 s idle and more than
5 s under test load, so the tests inject the helper and only those that must start the real one pass
a longer, test-only limit. Node atomically publishes
the file, then the strict reader verifies its ACL and content digest at the published path. The
Windows reader calls .NET [`File.GetAccessControl`](https://learn.microsoft.com/en-us/dotnet/api/system.io.file.getaccesscontrol?view=netframework-4.8.1)
for access and owner data, requests the owner through
[`GetOwner(SecurityIdentifier)`](https://learn.microsoft.com/en-us/dotnet/api/system.security.accesscontrol.objectsecurity.getowner?view=netframework-4.8.1),
and requests rules as `SecurityIdentifier` values. It uses no PowerShell cmdlets or account-name translation.
Links,
unsafe access, an unreadable ACL, invalid schema, missing state and a removed opt-in fail before
HTTP. The control URL is the only endpoint source. Secure WebSocket becomes HTTPS and the path becomes `/mcp`; credentials in
the URL are refused. The bearer exists only in the request Authorization header, with redirects
disabled and bounded request, response and deadline handling.

The request body crosses unchanged, including runtime-native `params._meta`. The bridge never creates
session, thread or call identifiers and never changes tool arguments. JSON and SSE responses become
stdio JSON-RPC responses; HTTP 202 for a notification produces no response. Fixed local error codes
contain no endpoint, credential or server body. The exact-tool hook returns `permissionDecision:
"allow"` together with `updatedInput`, as required by the [native Codex PreToolUse rewrite contract](https://learn.chatgpt.com/docs/hooks#pretooluse).
This result applies the argument rewrite; normal native MCP approval remains separate.

## Claude Code client transport

The separate `bootstrap/install-claude-messaging-client.sh` entry requires explicit existing absolute
`--home` and `--config-root` paths. It installs only `<home>/kherep/claude-messaging-client`; the broad
Claude adapter installer does not invoke it. `--node` selects the absolute executable used for
projection, verification and the imported transaction comparison. Without it, the installer resolves
Node from `PATH`. On Windows, invoke the installer through Git Bash with Bash-visible paths.

The closed client contains the same 14 public modules as the installed Codex client graph, a
hook-only plugin and a separately named `kherep_messaging` MCP configuration. It contains no node
state or credentials. A fixed file population, manifest hashes and regenerated configuration bind
the installed artifact. The installer refuses drift, extra or missing files, a mismatched target
identity and symlinked content before replacement. It stages the candidate, checks the target again
under the shared bootstrap lock and uses the existing reversible transaction. Changed installations
retain the previous closed directory in the installation backup; a failed transaction restores it.

Activate only the intended Claude invocation with the printed arguments:

```sh
claude --plugin-dir /absolute/client-root/plugin \
  --mcp-config /absolute/client-root/mcp.json --strict-mcp-config
```

This invocation selects the supplied MCP configuration. Other persistent MCP entries, user hooks
and permissions remain unchanged. The plugin adds only the exact five-tool PreToolUse matcher. It
uses structured executable arguments, including `--runtime claude-code`; no shell constructs,
listener, bearer, environment credential or automatic permission grant are rendered. Node policy
and Worker activation remain separate operator actions. See [installation](../../docs/INSTALLATION.md#optional-claude-messaging-client).

The trusted Claude hook binds its actual native `session_id` and `tool_use_id`. After the unchanged
eight-second durable positive-receipt check, it returns `updatedInput` without a `permissionDecision`.
Normal Claude tool approval still applies. Claude's HTTP request supplies the actual
`_meta["claudecode/toolUseId"]`; the bridge forwards it unchanged and never invents a native session
or thread field. The Registry resolves the source session only from the exact prior hook intent.

## Authentication and intent claim

Credential provisioning is available only as `mcp.credential.rotate` on an authenticated enrolled-node WebSocket. The Registry stores only a SHA-256 hash and the current credential version. Rotation within an active opt-in increments the version and removes outstanding intents. Base capability retraction or node revocation removes the credential and all intents, so later opt-in provisions a new token even when its fresh row starts again at version 1. The raw token returns only to that same node and is stored with its local helper files. Every MCP HTTP request verifies the current node, capability, revocation state and credential version.

The node must advertise `mcp.messaging.v1`, which requires this exact local policy opt-in for Codex:

```json
{
  "version": 1,
  "allowedCommands": [],
  "remoteMcp": { "enabled": true }
}
```

Claude Code additionally requires literal `remoteMcp.claudeCode: true` alongside literal
`enabled: true`. This advertises `mcp.messaging.claude.v1`; an existing Codex-only policy does not
enable Claude. For both native runtimes, the relevant policy section is:

```json
{ "remoteMcp": { "enabled": true, "claudeCode": true } }
```

The daemon reloads this policy on every exchange round. Removing the base opt-in updates the connected client before further inbox or intent work, publishes a reduced registration, deletes the node's Registry credential and intents in that registration transaction, and clears local credential and intent exchange files. Restoring the base opt-in publishes the capability first and provisions a new credential version; an older bearer does not become valid again.

Removing only the Claude runtime capability transactionally deletes retained Claude intents while
preserving Codex intents and the shared credential. Re-enabling it cannot revive the deleted
intents. Claude capability is rechecked at registration, first claim and recovery. The node also
rechecks the current runtime policy before reading an inbox.

The trusted hook registers these fields before the MCP request:

- unpredictable UUID `requestId`
- enrolled node and current credential version, assigned by the Registry
- runtime `codex` or `claude-code`, selected by the trusted hook invocation
- exact native `sessionId` and `callId`
- exact tool name
- SHA-256 digest of canonical JSON arguments before `requestId` is added
- creation time and fixed expiry

Ordinary intents default to 120 seconds. A requested ordinary lifetime may be shorter and cannot exceed 300 seconds. Stamped Codex Mac assignment intents instead expire at their immutable hook ingress plus 60 seconds. Idempotent registration keeps the original expiry. An expired call receives `intent expired; register a fresh native intent` and requires a new native call.

### Runtime-specific native identity

| Runtime | Trusted hook intent | Native HTTP claim | Source binding |
| --- | --- | --- | --- |
| Codex | Actual session and call, optional retained native thread | `_meta.sessionId`, `_meta.threadId`, `_meta.callId` | Exact stored session and call; first claim binds thread, recovery must retain it |
| Claude Code | Actual hook `session_id` and `tool_use_id`, no thread | `_meta["claudecode/toolUseId"]` only | Exact prior intent supplies the session; native tool-use ID must match |

Claude registration and claim refuse a thread field. HTTP refuses missing or invalid native
identifiers and mixed Claude/Codex identity fields, including partial Codex fields. A caller cannot
supply its source through tool arguments, `clientInfo` or an MCP transport session. Both claim
paths recheck the live node's required capabilities, credential version and exact Registry session
runtime. Removal or runtime replacement of the originating session invalidates first use and recovery.

### Authorization denials

Every denied call returns a fixed error and creates no message. Write tools return the same fixed
claim error as read tools; only a routing failure after a successful claim stays generic.

| Case | Caller-visible result |
| --- | --- |
| Wrong binding: another call, session, thread or node, or changed arguments | `native call identity does not match intent`, `intent not found` or `tool arguments do not match intent` |
| Missing binding: no or partial native metadata, or no registered intent | `verified native call metadata is required` or `intent not found` |
| Replayed request: a used `requestId` from another native call | `native call identity does not match intent` |
| Expired binding | `intent expired; register a fresh native intent` |
| Revoked node, superseded credential or removed opt-in | HTTP 401 `{"error":"unauthorized"}` before any tool runs |

The trusted hook adds its own fixed denials before HTTP, such as `remote_mcp_request_id_must_be_native`
and `remote_mcp_intent_rejected`. `worker/test/mcp-denials.test.mts` covers each case and asserts that
no message exists for either node.

`requestId` is the `messageId` for `send` and `reply`. A retry claims the same intent and calls the existing message router with the same immutable id. Router idempotency prevents a second message. Routing failures after the Registry write return an explicit uncertain result and require retrying the same native call.

Intent rows contain identifiers, digests, timestamps and one fixed outcome value. They contain no message body, inbox result or arbitrary tool result. Unchanged registration retries do not write or extend the row.

Each node may hold at most 128 unexpired intents. Claimed intents continue to count until their original expiry. Expired rows remain as replay metadata for 24 hours after that original expiry, bounded to 32,768 retained rows per node. Before admitting a new request ID, the Registry removes only rows whose original `expires_at` is at or before `now - 24 hours`, then checks the unexpired and retained limits independently. The fixed errors are `too many unexpired MCP intents` and `too many retained MCP intents`. Duplicate lookup remains first: an exact duplicate keeps its original identity and expiry, while changed metadata is refused.

## Tools

| Tool | Behavior |
| --- | --- |
| `sessions` | Returns bounded address references from Registry metadata, with the node-reported `kind` when present |
| `send` | Sends through the existing message router from the verified originating session |
| `inbox` | Reads the exact originating session inbox from its online node and marks the waiting messages it returned `offered` |
| `reply` | Derives the recipient from stored message provenance, or from the replying node's inbox once the original was deleted, and enforces Worker lineage plus pair loop admission, with the six-hop compatibility limit on legacy paths |
| `status` | Returns metadata-only state for a message visible to the caller's node |

A `sessions` entry carries `kind` when the node reported one. `codex-task` marks a Codex task run
the node started on request, `codex-intercom` a Codex Intercom run the node started on its own for
peer messages (issue #198), and `codex` a Codex session recorded by its hooks. Other runtimes' kinds
pass through as their node reported them. A node older than `codex-intercom` reports its Intercom
runs as `codex-task`. The kind is node-reported metadata; it does not imply that the run appears in
a desktop session list.

For a `replied` message, `status` also returns `replyMessageId`: the reply that marked the message
replied, recorded by the Registry at that moment. A reply refused at send time never marks the
original and is never named; a marking reply that its recipient later refuses stays named. Messages
marked replied before this column existed carry no `replyMessageId`. The sending session can read
the reply with `status` and, while its node is online, with `inbox`.

After the sender acknowledged the final status, the Worker deletes the message (issue #308) and
`status` answers from its tombstone for 24 hours: the final `state`, `updatedAt` as the deletion
time, no `progress`, and `replyMessageId` when it was replied. After that the message is no longer
available to `status`.

`reply` to a message the Worker no longer holds asks the replying node for that one inbox item:
`mcp.inbox.request` with `limit` 1, `messageId` and `reply: true`, for the claimed session. The node
returns the item only when it is addressed to that session and marks it answered, as
`msg send --reply-to` does. The Worker sends the reply to the item's sender, checked against the
tombstone while one exists, and derives the reply depth itself (tombstone depth plus one; only legacy mixed paths may use 1 once
the tombstone is gone). The claim is recovered for the second step, not spent twice. An offline
node, an older node that ignores `messageId`, or a missing or contradicting item fails closed with
`reply was not accepted`.

For an accepted message, `status` also returns validated `progress` metadata when available: a fixed `phase` and `code`, `observedAt`, and optional `retryAt`. These codes distinguish waiting for a user turn, waking, fallback activity and delivery failures. Accepted progress does not prove delivery. Invalid progress and stale progress on terminal states are omitted. Message bodies are never included in a status result. A fixed loop refusal reason is returned from a live row or its tombstone so the operator hold ID remains visible. `state` stays the canonical state. `status` also returns `senderState` (issue #197), the state a sender reads, derived from `state` and the returned `progress` by `senderState` in `protocol-messages.mts`, the function `msg status` uses: `running` for `awaiting-turn-confirmation` and `fallback-running`, `stopped` for `operator-stopped`, otherwise the canonical state. `running` reports the last observation, not liveness. An `accepted` message without progress whose `updatedAt` is at least 5 minutes before the Worker's clock (`silentlyAccepted`, `ACCEPTED_SILENCE_MS`) also carries `hint`: a fixed text naming the possible causes (target session not running, target node offline or on an older version) and the `sessions` tool as the next check. `hint` never contains a persisted reason. Clients that read only `state` are unaffected.

Inbox has three distinct results: items, a successful empty list, or a fixed offline/read error. The body transits from the expected authenticated node socket directly to the waiting HTTP request. It does not enter `SessionStore`, the command-result journal, Registry SQLite, an audit record or a log. The read uses the exact current session id. Alias ownership is not inferred from a reused display name.

Codex CLI replies preserve the full sender session id supplied by the delivery hook, so a native MCP message and its CLI response retain the same exact identities. Explicit aliases remain supported by the CLI, but historical alias messages are not reinterpreted as full-id hops in a native reply chain.

An inbox read offers what it returned (issue #308). The node marks each returned `accepted` record `offered`, as a delivery hook offer does, once the response fits the transport limit; it marks nothing `delivered`, because returning text over HTTP does not prove that a chat saw or understood it. The session's `Stop` hook, or a reply, confirms the offered records: `msg send --reply-to` marks a message `delivered`, and a threaded reply, through the `reply` tool or the CLI, makes the Worker mark it `replied`. `StopFailure` is no receipt. If the MCP client fires no hooks, an MCP-read message reaches `delivered` only through a reply.

The complete serialized inbox response must fit the existing 64 KiB transport limit, measured as UTF-8 bytes including JSON escaping and envelope metadata. If the requested messages do not fit, the tool returns a fixed error rather than truncating messages, omitting records or reporting a successful empty inbox. Retry with a smaller `limit` and a fresh native intent. If one message alone exceeds the serialized limit, use the local `msg inbox` CLI. A read that does not fit leaves message bodies and delivery state unchanged.

## Measuring native ACK latency

The ACK of a native call is the trusted hook's durable intent receipt: the Registry's
`mcp.intent.receipt` for the hook's exact intent, which the daemon writes locally and the hook
consumes before it returns the rewritten arguments. The hook waits at most eight seconds for it.
The later MCP HTTP tool result is the call's outcome, not its ACK.

To measure, create the private directory `<config-root>/control-plane/mcp/diagnostics` on the
calling node. While it exists, the hook appends one JSON line per receipt wait to
`ack-latency.jsonl` there. A file reaching 64 KiB is rotated once to `ack-latency.jsonl.1`. Remove
the directory to stop recording; without it the hook writes nothing and behaves unchanged.

Each record has `method: "hook-intent-receipt"`, `runtime`, `tool`, `outcome` (`accepted`,
`rejected`, `timeout` or `storage_error`), `ackWaitMs`, `hookMs`, `pollIntervalMs`, `at` and
`hookSha256`. `ackWaitMs` is measured with the monotonic clock from the published local intent file
to the observed receipt, so it covers daemon pickup, any first-caller session discovery, the
WebSocket round trip and the Registry write. Receipt observation polls every 25 ms, so the value is
an upper bound within that interval. For `timeout` it is the time waited, not an ACK. `hookMs`
additionally includes argument digesting and the local write. The records contain no session,
call or request identifiers, arguments or bodies.

Not measured: model time before the call, client approval prompts, the MCP HTTP request after the
hook, peer delivery and the whole fixture or script duration.

Report a result per platform with the `ackWaitMs` of a real native `send` record whose `outcome`
is `accepted`, the method above, the client version (`codex --version` or `claude --version`, plus
the Desktop build where used), the Worker target, and the source commit. Identify the commit by
matching `hookSha256` with `git show <commit>:modules/control-plane/node/mcp-intent-hook.mts`
hashed with SHA-256.

## Activation gates

The committed `REMOTE_MCP_ENABLED` value is `false`, and the default node policy has no `remoteMcp` section. This candidate does not change live config.

Source tests use synthetic native metadata. They cover SDK transport, client and runtime opt-in, provisioning, revocation, per-call credential rotation, local policy removal, session removal, runtime replacement, missing or mixed metadata, changed arguments, cross-node reuse, expiry, recovery, online and offline inbox behavior, metadata-body exclusion, bounded JSON and SSE responses, and secret-free installed settings. The isolated Claude client tests also execute the copied hook and bridge, verify the fixed module graph and cover target drift, unchanged independent settings, idempotence and rollback. These tests do not establish actual-client support.

Before activation, the production Codex path needs a successful direct canary and two-distinct-chat canary against the deployed backend, including missing-metadata denial and the supported `permissionDecision: "allow"` plus `updatedInput` hook result under normal approval. A Code Mode binding-probe success is evidence for that probe only and is not production authentication.

Actual compatibility canaries measured Claude Code 2.1.283 on macOS on 2026-10-02: the real hook
session and tool-use ID joined the actual MCP metadata, the required request-ID schema worked after
native rewrite, and the real session appeared in native discovery. The [recorded evidence](https://github.com/CFcon-CH/kherep/issues/127#issuecomment-5958977972)
establishes that contract, rather than delivery of this adapter. Issue [#187](https://github.com/CFcon-CH/kherep/issues/187)
also requires an actual native CLI canary after the accepted adapter reaches its target. Production
ACK latency, normal permissions, two-session isolation and both-host messaging remain separate
acceptance gates in [#127](https://github.com/CFcon-CH/kherep/issues/127); lifecycle and Windows
process/window/Stop acceptance remain in [#128](https://github.com/CFcon-CH/kherep/issues/128).

## Dependencies

The Worker pins `agents` 0.24.0, `@modelcontextprotocol/server` 2.0.0 and `zod` 4.6.5. `agents` and Zod ship MIT license texts. The MCP SDK server package declares MIT in its package metadata and ships its upstream transition notice with Apache-2.0, MIT and CC-BY-4.0 terms for the material each term covers. Kherep continues under Apache-2.0. The transport follows Cloudflare's current stateless `createMcpHandler` guidance; `McpAgent` is not used.

### Guarded replies and holds

Upgraded new/new canonical pairs use `messaging.loop-brake.v1`. The Worker alone derives thread, depth, direction and pair admission. A returned inbox item is only a candidate address, never authority for missing/expired guarded lineage. Same-node replies after deletion must reverse the retained Worker direction bit. Malformed/partial lineage, a queued/refused/expired parent, capability downgrade or missing pair state refuses; it never becomes a fresh depth-one guarded thread. Exact live-original proxy checks remain mandatory.

Three consecutive bounded ACK/normalized-repeat strikes or the 256-admission pair fuse refuse before delivery with `loop-held: ...; hold=<UUID>; operator release required`. `status` returns that content-free reason for rows/tombstones. No MCP tool releases a hold. Only the existing Access-authenticated operator API can release with the current version; release starts no message or session. Explicit owner continuation uses a new ID and retained valid parent in the same thread. See [pair brake and retention](README.md#pair-loop-brake-and-operator-release).

The trusted Claude and Codex reply hook saves deny-only request-ID provenance before publishing an intent when its retained inbox parent has valid guarded context. This local content-free marker survives missing sent records and parent loss; it can refuse a metadata-free descendant but cannot grant any send or advanced authority. Up to 4096 markers are retained without automatic expiry/eviction. A full or unreadable store, invalid retained guarded parent, or persistence failure denies the hook before intent publication. Valid Worker-issued descendants remain allowed; genuine legacy/mixed history retains its compatibility ceiling. Both staged clients include this helper.

Marker capacity uses an exclusive directory mutex at the existing index record-lock path, with bounded contention and no stale-owner takeover. Old file locks and new directory locks exclude each other at that same path. Only the successful owner removes its own empty directory after an identity check. Leftover lock state fails closed and is handled only through existing offline operator maintenance with all writers stopped, never automatic cleanup. This does not change marker retention or the shared inbox lock helper.


## Claude user commands and fixed address aliases

Claude users select a top-level session with the personal `/kherep-slot
claude-mac`, `/kherep-slot claude-windows` or `/kherep-slot kherep-lead`
command. `/kherep-set-lead` is the zero-argument Lead alias. A selected top-level
fork is allowed; auxiliary agents and teammates are refused. These user-only
skills leave selection to the native UserPromptExpansion hook through the
existing stable entry, local exchange and full session snapshot. The hook adds
one fixed correlated outcome as additionalContext without blocking expansion.
The model reports that outcome first, then handles concurrently delivered peer
work with its existing authorized tools and any required threaded reply before
ordinary Stop. The skill grants no new authority and forbids another selection,
`assign_self` or repetition of the command.

Only the current validated hook result can supply the slot sentence. Missing,
ambiguous or malformed results use "Kherep could not confirm a slot selection."
Null assigned/conflict revisions, exchange failures and uncertain cleanup never
establish success or authorize a retry: a central selection may already have
committed. Native first-sentence compliance, before-Stop peer processing and
subsequent idle wake require separate native verification. There is no Claude
MCP callback and no title requirement. A missing native prompt_id refuses
selection. A fresh hook proves reachable-probable only.

The trust boundary is the enrolled local user. A process running as that user
can forge valid hook stdin or local exchange records and obtain an assignment.
Event binding and argument digests provide idempotency, not human attribution.
Accepted success/conflict decisions add one permanent receipt to the existing
audit table, with no TTL, application row cap or sweeper. Malformed requests,
lookups and duplicate events add no rows. Storage failure rolls back assignment.
An exact retained replay returns its historical result even after reassignment
or expiry; changed arguments refuse. Audit loss/backup rollback has no dedup
promise. Titles, five rows, revisions and legacy historical occupancy survive
migration. Occupied Claude rows may have NULL chat_name.

`msg send kherep-lead -- <text>` and the other four canonical bare seat names
perform a fresh correlated address lookup on the enrolled directory lane, then
one ordinary message send to the literal node/session tuple. Vacant,
incompatible legacy Lead, unsupported, offline or unconfirmed lookup enqueues
no message. `--new` cannot target a seat. Exact node/session destinations and
ordinary `--reply-to` retain their behavior. Peer text cannot appoint a role.
This is a current address alias: lookup and send are separate, so it does not
provide frozen reassignment admission, protected offline queues or retained
parent routing. Those remain follow-on work.

Before activating v2, deploy the separately reviewed #861 Codex Lead entry
guard, then inspect the actual Lead occupant and revision. This change preserves
legacy rows and does not itself remove their old assignment entry. Native macOS,
Windows, Remote Control and Desktop peer-triggered expansion behavior remain
unverified by portable tests. No installation or deployment is implied.


### Ingress time and daemon lifetime

The hook writes observedAt and the 30-second transport deadline once. Rereading
the same written element preserves those values; processing never substitutes
its current time. Within one daemon, session/prompt IDs retain the first
canonical slot and ingress timestamp in memory. An identical event never
refreshes the active overlay, including after reconnect; changed slot arguments
refuse before publication. A distinct event B can advance the source, and a
later A retry cannot roll it back. Source still expires at its original
60-second display TTL or disconnect, with all existing identity/lifecycle,
capacity, full-snapshot and Worker commit/CAS checks in effect.

The daemon remembers at most 4096 distinct events without eviction. At that
limit unseen events refuse until restart; the separate 128 active-session bound
remains. Restart intentionally clears the seen-event map. Original written bytes
still carry their original timestamp/deadline, so cold consumption cannot extend
them. A local process may instead forge new valid stdin or outbox content with a
fresh timestamp after restart and establish fresh local activity. This is part
of the Director's accepted same-local-UID capability. Existing Worker stable
event receipts still prevent another slot mutation. There is no persistent
local replay marker, history preflight, new lock or physical durability claim.

The Lead's premise that native Claude emits at most one expansion per prompt,
including resume/redelivery, is an assumption and remains UNKNOWN on actual
clients. Portable exact-byte retry tests and deliberately fabricated local input
do not prove that premise. A later authorized native resume check must measure
it. Evidence from the rejected marker/durability experiment remains diagnostic
history and is not presented as passing behavior or a current mechanism.
