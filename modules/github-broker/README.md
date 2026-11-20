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
| `pr.merge` | required prNumber and sha (the PR head, 40 lowercase hex) |
| `branch.delete` | required branch, sha (the branch head) and prNumber (a closed pull request of this branch) |

Each operation authenticates with exactly one installation-token permission set,
and a token that carries anything else besides `metadata: read` is refused:

| Operation | Token permissions |
| --- | --- |
| `issue.*` | `issues: write` |
| `branch.push`, `pr.merge`, `branch.delete` | `contents: write` |
| `pr.create` | `pull_requests: write`, plus `issues: write` when labels are given |
| `pr.update`, `pr.comment` | `pull_requests: write` |
| `run.rerun`, `run.cancel` | `actions: write` |

There is no auto-merge, force-push, tag push or `workflows` permission, and the
only branch deletion is `branch.delete` of a closed pull request's head branch.
`pr.merge` is off by default per repository (see the policy below).

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
against every parent). Both bases, the remote branch and the remote default branch,
come from GitHub's API readback, never from a ref of the checkout. Every git call uses system Git from a fixed path, never
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

The checkout is only read once, to find its toplevel and object directory. The
preflight and the push each run in their own clean bare repository under the
broker's private root, never under the caller's temporary directory: the root is
checked as a protected directory first (its whole chain on POSIX, its ACL on
Windows, where the new directory inherits it), then `mkdtemp` creates the
repository (prefix `kherep-push-`; on POSIX owned by the broker and mode 0700,
else `target-refused`), removed in `finally` also on error. Clean repositories
older than ten minutes in the root, left by a crashed broker, are removed before
a new one is created. The repository borrows only the checkout's objects through `objects/info/alternates`
and has no repository configuration beyond `core.bare`, `core.commitGraph=false`
and `pack.useBitmaps=false`, no hooks, no refs and so no replace refs, no shallow
file and no grafts. Commit-graph files of the alternate are off because git
trusts their parent data during traversal: a crafted one could hide a foreign
ancestor from `sha --not <base>`. Git does not verify object hashes on read, so
git only lists and fetches objects for the preflight: it reads every commit
reachable from sha and the base, and the root and `.github` trees it decides on,
through `cat-file --batch`, recomputes each SHA-1 and derives ancestry, authorship,
the fast-forward and the workflow check from those bytes alone. A forged loose
object under a real commit's or tree's name is refused. The push needs no such
check: GitHub names the objects it receives by their computed hash. Every git child in it gets a constructed
environment, nothing copied from the broker's: the fixed `PATH`
(`C:\Program Files\Git\cmd;C:\Windows\System32;C:\Windows` on Windows, `/usr/bin:/bin`
elsewhere), `HOME` set to the clean repository (no `~/.gitconfig`, `~/.config/git`
or `~/.netrc`), `GIT_CONFIG_NOSYSTEM=1`, an empty `GIT_CONFIG_GLOBAL`,
`GIT_ATTR_NOSYSTEM=1`, `GIT_NO_REPLACE_OBJECTS=1`, `GIT_TERMINAL_PROMPT=0`,
`GCM_INTERACTIVE=never`, on Windows `SystemRoot` and `WINDIR`. Proxy, TLS, CA,
trace, toolchain and Node variables, `url.*.insteadOf`, `http.*` settings and
`core.hooksPath` of the checkout, the user or the system never reach the push.
The empty first helper also resets every configured helper (manager, keychain,
store), so no personal credential can answer. No repository hook runs on a broker
push, so operator `pre-push` hooks, including a system-level `core.hooksPath`,
do not run for it; the push still carries `KHEREP_BROKER_PUSH=1`, on which the
Kherep `pre-push` hook would record nothing, because the broker records the push
itself. The discovery call in the checkout keeps the filtered environment (git
tracing, `GIT_CONFIG*`, askpass, alternative repository variables and
`GH_TOKEN`/`GITHUB_TOKEN` dropped, fixed `PATH`, `GIT_NO_REPLACE_OBJECTS=1`). After the readback verifies the push, the broker appends one
`push` record to the host-local attribution log (`<config root>/control-plane/attribution.jsonl`,
see the control-plane README): session, runtime, owner/name, toplevel, branch,
`refs/heads/<branch>` and sha, never the URL, token, operationId or bot. The session
is resolved before the push in the hook's order (`CLAUDE_CODE_SESSION_ID`,
`KHEREP_SESSION_ID`, a fresh Codex marker of this runtime for the toplevel, else
`unknown`). The result of that run carries `attributionRecorded` (`true`, or `false`
when the log could not be written; the push stays verified); a replay, a retry of a
known receipt and `verify` record nothing and carry no such field. A push whose
outcome is unknown and is settled later by `verify` therefore gets no record. The credential helper answers only `get` for
`https://github.com/<allowlisted slug>.git`, and only while a pending, locked
`branch.push` receipt for that runtime and operation, admitted less than 120 s
earlier, exists, and once: the broker creates one grant file beside the receipt
(`O_EXCL`, mode 0600) while it holds the lock, right before the push, and removes
it after. The grant holds only the SHA-256 of a fresh 32-byte nonce, which the
broker passes as `KHEREP_PUSH_GRANT` in its git child's environment alone, never
in argv or a file. The first `get` that passes every other check and presents that
nonce redeems the grant, so a refused `get` or a wrong nonce never burns it and a
second `get` is refused. Then it mints a
`contents: write` token and writes it to git's pipe. `store` and `erase` get no answer and nothing is persisted. Any refusal is
silent with exit 1. The token never appears in argv, environment, disk, git
configuration, receipts or output. Readback compares the remote branch with sha.
A failed push leaves the receipt pending (`outcome-unknown`); retry with a new
operationId after checking the branch.

Residuals of `branch.push`. The grant holds only the SHA-256 of a nonce that
exists only in the environment of the broker's git child, and the helper answers
only a `get` that presents it. That closes one class of same-account process and
no other:

- A, a process that can only start the helper and knows the operationId: it gets
  no token and cannot burn the grant. The nonce closes this class.
- B, a same-account process that can write the receipt directory: it can write
  its own grant, receipt and lock and still obtain a token.
- C, a process that reads the broker's git child's variables from process memory
  (`/proc/<pid>/environ`, the Windows process environment block): it gets the
  nonce and can still obtain a token.

The nonce closes A only; anything that can read the key can obtain a token as
well. The permission rule that allows a runtime only the broker entry point
follows in PR-B. Until then nothing stops a session from doing B or C. After a
crash mid-push the grant and the retained lock stay usable until the 120 s window
ends. Forged object bytes at push time cost the operation (`outcome-unknown`),
never admit a foreign commit. The preflight reads every commit reachable from sha
and the base, linear in history, and refuses above 256 MB of commit data; it
relies on SHA-1 collision resistance in Node, without collision detection
(GitHub's side has it). Operator `pre-push` hooks do not run on a broker push. The
push supports no proxy and no system-level TLS setting (on Git for Windows the
system `http.sslBackend` no longer applies). Commit-graph files are off for the
reason above. The clean repository lives under the broker's private root; on
Windows it is safe by inheriting the checked root's ACL, not by its own check.

`pr.create` verifies that the PR author is the bot, that the head branch is in the
same repository and that title, body, base, head, draft and labels read back as
sent; labels are set on the PR's issue after the PR exists, and a repository with
`moduleLabels` refuses a `pr.create` without a listed label like `issue.create`.
`pr.update` and `pr.comment` act only on an existing PR of the repository.
`run.rerun` accepts only a completed run and verifies a new attempt triggered by
the bot. GitHub raises the attempt a few seconds after the rerun request, so a
readback that still sees the old attempt ends as `outcome-unknown` and a later
`verify` with the same operationId settles it. `run.cancel` accepts only a
running one and verifies the `cancelled` conclusion, which GitHub sets
asynchronously, so an early readback fails with `verification-failed` and a
later `verify` settles it. Successful results of these operations name their
`operation`.

`pr.merge` merges one pull request once, at the exact head the caller names, with
the merge method of the repository's policy entry. Preflight reads the PR once and
refuses with `target-refused`, before any receipt, unless it is open, unmerged and
not a draft, its base is the repository default branch, its head is in the same
repository (no fork), its head SHA equals the request `sha`, and `mergeable` is
`true` (`null`, not yet computed, also refuses; retry later). The broker evaluates
no checks, reviews or rulesets itself: GitHub's branch rules enforce them when it
answers `PUT /repos/{owner}/{repo}/pulls/{n}/merge` with `{sha, merge_method}`.
The receipt is known before that PUT, so a lost answer is settled by `verify` or
a retry with the same operationId, never by a second PUT. Readback requires
`merged` true, `merged_by` this runtime's bot and the head still at the receipt
SHA; it checks `merge_commit_sha` only when GitHub returns it, because the pull
answer under a `contents: write` installation token can omit it. The result
names `mergeSha` when the PUT answered.
A PUT that GitHub refuses (405, 409, 422) ends as `outcome-unknown`, and `verify`
or a retry then reports `verification-failed`; the receipt stays bound to that
attempt, so a new merge attempt needs a new operationId.

`branch.delete` removes the head branch of one closed pull request (merged or
not). Before any receipt it refuses with `target-refused` and a fixed `reason`
unless, in this order: the branch is not the default branch (`default-branch`);
the list of pull requests with this head (`state=all`, `per_page=30`) has fewer
than 30 items (`pull-list-incomplete`) and none of them is open
(`open-pull-request`); the named prNumber is in it (`pull-not-found`), closed
(`pull-not-closed`), its head is in this repository (`foreign-head`) with this
branch name at the request sha (`pull-head-mismatch`), and its author is a bot
whose noreply address `allowedAuthorBotIds` admits for this runtime
(`foreign-author`); no open pull request uses the branch as its base
(`open-base-pull-request`); no active ruleset rule applies to it
(`branch-rules`); `refs/pull/<n>/head` points at the request sha
(`pull-ref-mismatch`); and, read last, the branch is unprotected
(`protected-branch`) and still at the request sha (`head-moved`). A non-array
answer to a list read fails as `transport-failed`; any other malformed provider
answer refuses with `unexpected-answer`. A branch already absent at the
last read is not deleted again, after all the checks before it passed. Otherwise
the receipt is known before the one
`DELETE /repos/{owner}/{repo}/git/refs/heads/{branch}`, so a lost answer is
settled by `verify` or a retry, never by a second DELETE. Readback requires the
ref to be absent. A verified result names `result`: `deleted` when this
operation's DELETE was answered and the ref then read absent, `absent` when no
answered DELETE of this operation exists (already gone, or an answer lost). A
failure, and `verify` of a receipt that is known but not yet verified, names no
`result`. A DELETE GitHub refuses ends as `outcome-unknown`, then
`verification-failed`, and a new attempt needs a new operationId.
The REST delete takes no expected SHA, so the head check and the DELETE are a
check-then-act: a push that lands between the branch read and the DELETE is
deleted with the branch and is kept only by the pusher. A pull request opened on
the branch inside that window is closed by GitHub, its commits kept in
`refs/pull/<n>/head`. The branch read uses `/branches/{branch}` and readback
`/git/ref/heads/{branch}`; if the two disagree the result is
`verification-failed`, never a false success.

Production policy lives in `<OS account home>/.kherep/github-broker/policy.json`.
The OS account home comes from `os.userInfo()`, ignoring HOME, USERPROFILE,
runtime homes, checkout and current directory. Selected keys are flat references
under `keys/`; operation state lives under `receipts/`. Internal test injection
can supply a synthetic root; no CLI, request or environment root override exists.

Policy schema version 1 admits the issue operations only and stays valid for
them. Version 2 has the same shape, admits every operation above (`identity`
needs no listing) and allows `allowedAuthorBotIds` per runtime: the configured
bot user IDs whose commits that runtime may push, and whose closed pull request
branches `branch.delete` may remove, default its own bot only.
A version 2 repository entry may add `merge: {"method": "rebase"|"squash"|"merge"}`;
`pr.merge`, even when listed in the runtime's operations, returns `policy-invalid`
before any key read or provider call for a repository without that entry.
Policy schema version 1 contains `enabled`, `runtimes.claude` and/or
`runtimes.codex`. Each runtime names appId, clientId, botId, botLogin,
installationId, keyRef (a flat `.pem` reference), allowed operations and
repositories (`slug`, numeric `id`, optional `moduleLabels`, in version 2 optional `merge`). Configuration is maintained outside source
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
Transport fixes `https://api.github.com`, API version `2026-03-10`, ten requests
(twelve for `branch.delete`), 15 seconds per request, 1 MiB response, and refuses
redirects. It sends `DELETE` only to a `git/refs/heads/` branch ref, and reads a
JSON array, with a bounded query string, only in an explicit list mode. Mutations never
retry automatically. Errors expose fixed codes, never provider messages or paths.

Version 1 receipts record issue operations; version 2 receipts add `kind`
(`push`, `pull`, `run`, `branch`) and the public targets `branch`, `sha`, `prNumber`,
`runId`, `attempt` and `admittedAt`, for `pr.merge` the merge commit `mergeSha`, and
for `branch.delete` its `result`.
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
