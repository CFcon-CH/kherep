# GitHub App broker

Two local Node entrypoints share one implementation: `github-claude.mts` binds
Claude; `github-codex.mts` binds Codex. Two more, `github-claude-credential.mts`
and `github-codex-credential.mts`, are the git credential helpers that only the
broker's own `branch.push` starts. Source installation is disabled by default.
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
| `issue.create` | required title, optional body and labels |
| `issue.comment` | required issueNumber and body |
| `issue.update` | required issueNumber and at least one title/body/state/stateReason |
| `verify` | none; reads the recorded operation's exact target |
| `identity` | none; no key, no network, no receipt |
| `branch.push` | required branch and sha |
| `pr.create` | required head, base and title; optional body, draft and labels |
| `pr.update` | required prNumber and at least one title/body/state/base |
| `pr.comment` | required prNumber and body |
| `run.rerun` | required runId, optional failedOnly |
| `run.cancel` | required runId |

Each operation authenticates with exactly one installation-token permission set,
and a token that carries anything else besides `metadata: read` is refused:

| Operation | Token permissions |
| --- | --- |
| `issue.*` | `issues: write` |
| `branch.push` | `contents: write` |
| `pr.create` | `pull_requests: write`, plus `issues: write` when labels are given |
| `pr.update`, `pr.comment` | `pull_requests: write` |
| `run.rerun`, `run.cancel` | `actions: write` |

There is no merge, force-push, branch deletion, tag push, auto-merge or
`workflows` permission.

State is `open` or `closed`; stateReason is `completed`, `not_planned`, or
`reopened`. Requests are at most 64 KiB, titles 256 codepoints, and bodies 32 KiB.
Labels are 1 to 20 unique, trimmed names of at most 50 characters without a comma.
Unknown fields, private repositories, pull requests, unknown targets and identity
or scope mismatches fail closed. The provider's original issue author is never
reported as the updater. Update attribution means authenticated installation
context plus exact field readback, not independent actor evidence in `issue.user`.

Branch and base names are plain branch names of the same repository (no owner
prefix, `..`, ref prefix or trailing dot); sha is 40 lowercase hex characters;
draft and failedOnly are booleans. Pull request state is `open` or `closed`.

`identity` returns `name` (the bot login) and `email`
(`<botId>+<botLogin>@users.noreply.github.com`). A session commits with
`git -c user.name=<name> -c user.email=<email> commit`; no repository or global
configuration is written.

`branch.push` runs in the git checkout of the current directory. Before the
write-ahead receipt it refuses (`target-refused`) when the sha is not a local
commit, the branch is the repository's default branch or starts with `v`, the
remote branch exists and is not a local ancestor of sha (no fast-forward), the
remote default branch tip is not available locally, or any commit in
`sha --not <remote default>` (at most 256) has an author or committer email outside
the allowed bot emails or touches `.github/workflows` (merge commits are diffed
against every parent). Every git call uses system Git from a fixed path, never
from `PATH`: `C:\Program Files\Git\cmd\git.exe` or `...\bin\git.exe` on
Windows, `/usr/bin/git` or `/usr/local/bin/git` elsewhere (owned by root and its
directory too, neither writable by group or others). Without one, `branch.push`
fails with `git-unavailable` before the receipt; API operations do not need Git.
The push itself is one fixed command:

```text
git -c credential.helper= -c credential.helper=!'<node>' '<tools>/github-<rt>-credential.mts' <operationId>
    -c credential.useHttpPath=true -c http.extraHeader= -c core.askPass=
    -c protocol.ssh.allow=never -c protocol.git.allow=never -c protocol.file.allow=never
    push --porcelain https://github.com/<slug>.git <sha>:refs/heads/<branch>
```

The empty first helper resets every configured helper (manager, keychain, store),
so no personal credential can answer. The child environment drops git tracing,
`GIT_CONFIG*`, askpass, alternative repository variables and `GH_TOKEN`/`GITHUB_TOKEN`,
replaces `PATH` with a fixed system list (`C:\Program Files\Git\cmd;C:\Windows\System32;C:\Windows`
on Windows, `/usr/bin:/bin` elsewhere) and sets `GIT_TERMINAL_PROMPT=0` and
`GCM_INTERACTIVE=never`. Repository hooks
such as `pre-push` still run. The credential helper answers only `get` for
`https://github.com/<allowlisted slug>.git`, and only while a pending, locked
`branch.push` receipt for that runtime and operation, admitted less than 120 s
earlier, exists; then it mints a `contents: write` token and writes it to git's
pipe. `store` and `erase` get no answer and nothing is persisted. Any refusal is
silent with exit 1. The token never appears in argv, environment, disk, git
configuration, receipts or output. Readback compares the remote branch with sha.
A failed push leaves the receipt pending (`outcome-unknown`); retry with a new
operationId after checking the branch.

`pr.create` verifies that the PR author is the bot, that the head branch is in the
same repository and that title, body, base, head, draft and labels read back as
sent; labels are set on the PR's issue after the PR exists, and a repository with
`moduleLabels` refuses a `pr.create` without a listed label like `issue.create`.
`pr.update` and `pr.comment` act only on an existing PR of the repository.
`run.rerun` accepts only a completed run and verifies a new attempt triggered by
the bot; `run.cancel` accepts only a running one and verifies the `cancelled`
conclusion, which GitHub sets asynchronously, so an early readback fails with
`verification-failed` and a later `verify` settles it. Successful results of
these operations name their `operation`.

Production policy lives in `<OS account home>/.kherep/github-broker/policy.json`.
The OS account home comes from `os.userInfo()`, ignoring HOME, USERPROFILE,
runtime homes, checkout and current directory. Selected keys are flat references
under `keys/`; operation state lives under `receipts/`. Internal test injection
can supply a synthetic root; no CLI, request or environment root override exists.

Policy schema version 1 admits the issue operations only and stays valid for
them. Version 2 has the same shape, admits every operation above (`identity`
needs no listing) and allows `allowedAuthorBotIds` per runtime: the configured
bot user IDs whose commits that runtime may push, default its own bot only.
Policy schema version 1 contains `enabled`, `runtimes.claude` and/or
`runtimes.codex`. Each runtime names appId, clientId, botId, botLogin,
installationId, keyRef (a flat `.pem` reference), allowed operations and
repositories (`slug`, numeric `id`, optional `moduleLabels`). Configuration is maintained outside source
control by an authorized operator. No request field grants publication authority.

A repository entry with `moduleLabels` (1 to 100 names) refuses an `issue.create` with
`label-required`, before any provider call, unless a request label is in that list; a
repository without it keeps creating without labels. The broker cannot read a repository
file, so the operator repeats the list of `.github/module-labels.json` there. Readback
compares the sorted label names, so labels GitHub dropped fail with `verification-failed`.
The comparison is case-sensitive, so a request label must match its stored case: `Bug` for
a stored `bug` creates the issue and then fails with `verification-failed`.

The selected key stays inside the broker. RS256 JWT claims use a 60-second clock
allowance and five-minute future expiration. App slug/client/installation checks and a numeric public bot-ID lookup precede
each mutation. Authentication includes an explicit one-repository token exchange with the operation's permission set; the token exists only in
process memory. Optional provider scope fields are validated when present.
Transport fixes `https://api.github.com`, API version `2026-03-10`, ten requests,
15 seconds per request, 1 MiB response, and refuses redirects. Mutations never
retry automatically. Errors expose fixed codes, never provider messages or paths.

Version 1 receipts record issue operations; version 2 receipts add `kind`
(`push`, `pull`, `run`) and the public targets `branch`, `sha`, `prNumber`,
`runId`, `attempt` and `admittedAt`.
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

Push tests use temporary repositories, a loopback smart-HTTP remote through
`git http-backend` that requires Basic credentials, and a fake helper reached
through the same single-quoted `!` command, including on Windows. On Windows the
flow tests replace only the PowerShell ACL probe with a passing answer, which is
control-flow evidence, not ACL evidence.
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
[Comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10),
[Pulls](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10),
[Git references](https://docs.github.com/en/rest/git/refs?apiVersion=2026-03-10),
[Workflow runs](https://docs.github.com/en/rest/actions/workflow-runs?apiVersion=2026-03-10),
[git credentials](https://git-scm.com/docs/gitcredentials).
