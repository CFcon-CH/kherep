# GitHub App issue broker

Two local Node entrypoints share one implementation: `github-claude.mts` binds
Claude; `github-codex.mts` binds Codex. Source installation is disabled by default.
No App, key, installation, repository policy or permission is provisioned by an
installer. Actual operator identities and native activation are separate gates.

The broker supports public github.com repositories only. It accepts one JSON
object on stdin and prints one bounded JSON receipt. There are no CLI flags,
request paths, runtime selectors, arbitrary URLs, personal tokens, `gh`, or OAuth
fallbacks. Ambient GitHub credential variables are ignored.

```sh
printf '%s' '{"operationId":"550e8400-e29b-41d4-a716-446655440000","repository":"example/project","operation":"issue.create","title":"Synthetic issue","body":"Synthetic content"}' | node tools/github-broker/github-claude.mts
```

This synthetic example returns `policy-disabled` without an authorized policy.
Running the Codex entrypoint selects only its own identity. Distinct runtime
identities require distinct App/client, bot, installation and selected-key values.
The binding does not authenticate arbitrary callers sharing the same OS account.

| Operation | Accepted fields beyond operationId/repository/operation |
| --- | --- |
| `issue.create` | required title, optional body |
| `issue.comment` | required issueNumber and body |
| `issue.update` | required issueNumber and at least one title/body/state/stateReason |
| `verify` | none; reads the recorded operation's exact target |

State is `open` or `closed`; stateReason is `completed`, `not_planned`, or
`reopened`. Requests are at most 64 KiB, titles 256 codepoints, and bodies 32 KiB.
Unknown fields, private repositories, pull requests, unknown targets and identity
or scope mismatches fail closed. The provider's original issue author is never
reported as the updater. Update attribution means authenticated installation
context plus exact field readback, not independent actor evidence in `issue.user`.

Production policy lives in `<OS account home>/.kherep/github-broker/policy.json`.
The OS account home comes from `os.userInfo()`, ignoring HOME, USERPROFILE,
runtime homes, checkout and current directory. Selected keys are flat references
under `keys/`; operation state lives under `receipts/`. Internal test injection
can supply a synthetic root; no CLI, request or environment root override exists.

Policy schema version 1 contains `enabled`, `runtimes.claude` and/or
`runtimes.codex`. Each runtime names appId, clientId, botId, botLogin,
installationId, keyRef (a flat `.pem` reference), allowed operations and
repositories (`slug`, numeric `id`). Configuration is maintained outside source
control by an authorized operator. No request field grants publication authority.

The selected key stays inside the broker. RS256 JWT claims use a 60-second clock
allowance and five-minute future expiration. App slug/client/installation checks and a numeric public bot-ID lookup precede
each issue mutation. Authentication includes an explicit one-repository `issues:write` token exchange; the token exists only in
process memory. Optional provider scope fields are validated when present.
Transport fixes `https://api.github.com`, API version `2026-03-10`, ten requests,
15 seconds per request, 1 MiB response, and refuses redirects. Mutations never
retry automatically. Errors expose fixed codes, never provider messages or paths.

Durable receipts store payload/field hashes and necessary public target IDs, never
bodies or secrets. An exclusive operation lock is never stolen based on age.
Pending operations with unknown outcomes cannot replay. Known IDs survive
readback failures. A matching repeated write returns its receipt or verifies a
known target; a changed payload under the same operationId conflicts. Explicit
`verify` reads a protected existing snapshot without acquiring or releasing the
mutation lock. It always authenticates and reads the target again, including
when the saved status is already verified, and never mutates an issue/comment
or creates/writes a receipt, directory or lock. A successful invocation returns
verified with the exact checked IDs while leaving saved known/verified bytes
unchanged. A failed verification exposes no saved IDs or successful attribution.
Missing state refuses; pending state remains outcome-unknown without provider
work. Token acquisition may still use GitHub's token endpoint.

A terminated writer's retained lock still blocks mutation retries. Explicit
read-only verify can check its known target without removing that lock; its
per-call verified result is distinct from unchanged durable status. Stale locks
require separate operator investigation; there is no automatic destructive
recovery or cleanup write. The namespace remains runtime/App/repository/operationId.
Fresh checks use current policy and installation identity. Version 1 receipts do
not attest historical installation or numeric repository-policy equality, and
verification never re-stamps them.
The receipt directory admits at most 4096 state/lock entries.

POSIX access checks require current-owner private files/directories, single-link
regular files and protected ancestor ownership/write modes. Windows uses the
fixed system Windows PowerShell path under `C:\Windows`, a constant script and
selected-path stdin. It checks raw basic ACEs, protected non-null DACLs for
policy/keys/private directories, current-SID ownership, single-link files and
every ancestor to the drive root. Only the current SID, SYSTEM and Administrators
may hold Allow ACEs in the private tree. Other ancestor grants may contain only
read/traverse/metadata rights.
The drive root alone may be owned by the TrustedInstaller service SID
(`S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464`) and may hold a
non-inheriting Allow ACE giving Authenticated Users (`S-1-5-11`) the create-folder
right (`FILE_ADD_SUBDIRECTORY`, 0x4) in addition to read/traverse/metadata, which
is the Windows default for `C:\`. That right adds sibling folders but cannot rename,
delete, overwrite or redirect the existing `\Users` component: those need `DELETE`
on the component or `FILE_DELETE_CHILD`, `WRITE_DAC` or `WRITE_OWNER` on the root,
all still refused. TrustedInstaller is a constant service identity that only
SYSTEM-level code can hold. Inherit-only ACEs grant nothing on the ancestor that
carries them and are ignored outside the private tree; every child is checked on
its own DACL. Any other ancestor, including `C:\Users`, still refuses any right
outside read/traverse/metadata for untrusted SIDs.
Reparse paths, unsupported owners/ACEs, UNC/device
paths, alternate streams, missing metadata and helper failures refuse access.
No permission is repaired. Windows receipt directories must already be safely
provisioned; new receipt/lock/temp files inherit only trusted grants and are
checked before use. Nonstandard Windows system paths and ordinary profiles with
broader ACLs may be refused. These checks exclude compromised same-user,
administrator and OS processes, and do not claim universally race-free pathname
metadata reads. Native filesystem durability and positive Windows usability need
separate measurement.

Synthetic local tests use generated RSA keys and injected HTTP responses; both
actual CLI subprocesses execute all three writes without reaching GitHub. Mock
Windows outcomes establish control flow only; descriptor-shape tests evaluate the
per-level PowerShell decision only where a PowerShell with .NET access-control
types runs, and are authoritative on Windows. Native Windows ACL enforcement,
installed file identity, actual App bindings, and live bot actions require their
own authorized measurements before operational delivery or issue closure.

Provider references: [JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app),
[Apps](https://docs.github.com/en/rest/apps/apps?apiVersion=2026-03-10),
[Issues](https://docs.github.com/en/rest/issues/issues?apiVersion=2026-03-10),
[Comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10).
