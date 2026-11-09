# Public release review

Kherep is developed in its public repository, `CFcon-CH/kherep`. Every commit pushed to it, on any branch, is public from that moment, and a release is a tagged revision of `main` in the same repository. Review each change before it is pushed, and review the release revision and the third-party material it redistributes before it is tagged.

## Content and configuration

- Keep sessions, internal project records, connection profiles, credentials, and private infrastructure inventories outside source control.
- Use synthetic identities and reserved domains in examples.
- Commit with a GitHub noreply address; the author and committer addresses are published with every commit and tag. Review co-author names and email addresses before pushing, because they are part of the public commit message.
- Describe configured, tested, and running capabilities separately.
- Verify installation instructions in a disposable candidate and preserve recovery evidence outside the public tree.

Run the local publication audit with an external JSON array of organization-specific forbidden terms:

```bash
npm run audit:publication -- . /absolute/outside-repository/publication-policy.json
```

The audit inspects both indexed and working-tree bytes. It reports review categories, including binary assets, email addresses, private endpoints, sensitive filenames, and secret markers. Investigate each finding. Synthetic security fixtures and required upstream notices can trigger findings; document their review without weakening the audit. A failed or incomplete read is not a clean result.

## Content-bound review evidence

The trusted scanner uses the fixed public `bootstrap/publication-reviews.json`
beside its source. Each entry is exactly `[relativePath, category, sha256]`.
An entry records an individual review of one category on the exact file bytes;
it is not permission to omit a file from scanning. The only reviewable categories
are `email-review`, `private-endpoint` and `binary-review`. Record the public
source, pinned commit, byte digest and applicable license in the review evidence.
For bundled snapshots, check the pins and notices in
[THIRD-PARTY-NOTICES.md](../THIRD-PARTY-NOTICES.md) against the actual upstream
bytes before approving an entry. A proposed record is not an individual review
approval. Review the scanner and its public evidence together before using a
private external policy.

There is no CLI override, wildcard or global category exemption. The target's
regular Stage-0 evidence blob and regular working-tree evidence file must both
be byte-identical to the trusted scanner's evidence. Linked parents or files,
missing partners, conflict stages, malformed arrays, noncanonical paths, duplicate
pairs, contradictory digests and unsupported categories make the entire evidence
unusable. No record can review the evidence file itself. The scanner compares
inventory keys and never opens a path supplied by an evidence record.

For a category to appear in `reviewed`, the target must have exactly one regular
Stage-0 file and an unredirected regular working-tree file, both with the exact
recorded SHA-256, and that category must actually occur in both. Hashes cover
original bytes with no newline, encoding or whitespace normalization. A single
byte change, CRLF conversion, rename, missing index partner or removed finding
requires a fresh review and produces `stale-review`. The scanner decides for
each source before merging per-file categories. Unversioned copies remain
unreviewed. With no target evidence, it performs the full raw audit.

The evidence file is itself scanned, including when an ignore rule would hide
an untracked copy. Tracked ignored files and other untracked, nonignored files
remain in the ordinary inventory. `files`, `scanned` and `indexed` retain their
full inventory, working-tree and index-view counts; a reviewed file still counts.
Every nonzero index stage makes the scan incomplete with `index-conflict`,
even for a harmless file without any review record. Its content is still
classified and counted.
The JSON report separates open `issues` from content-bound `reviewed` pairs and
marks `complete` independently. Both lists redact sensitive labels. An unusable
evidence set retains all otherwise detectable findings without partial approval.

`forbidden-content`, `secret-marker`, path, structure and read errors cannot be
reviewed away. Both hard content predicates inspect the full UTF-8-decoded
buffer, including after NUL in a binary file. A newly forbidden external policy
term can therefore block unchanged previously reviewed bytes. This does not
inspect compressed content or prove image provenance, embedded metadata or
redistribution rights. Binary review needs separate inspection of the exact
asset and its rights; unresolved assets keep their open finding.

Exit 0 means the complete audit has no open finding. Exit 1 means it completed
with open findings, including stale reviews. Exit 2 means an incomplete scan,
unusable evidence or an execution/policy error. Failed scans are never clean.
Retain all findings and review decisions, refresh evidence after relevant byte
changes, and rerun the complete audit on the exact approved committed candidate
and, after an authorized merge, on the actual main revision. A changed-file audit
or a synthetic-policy test is not that release verdict. Keep private policy
terms and raw local output outside public issues, PRs and logs.

## History and redistribution

Removing a file from the current tree leaves earlier versions in Git history, and a pushed branch is public even if it is never merged. If private data reaches the repository, rotate any exposed credential first, because a history rewrite cannot revoke it, and obtain explicit authority before rewriting remote history.

Choose the project license explicitly. Preserve the licenses, attribution, and redistribution obligations of bundled third-party material. Check source snapshots and binary branding assets separately.

## Delivery

Run the checks required by [CONTRIBUTING.md](../CONTRIBUTING.md), inspect the final diff, and identify the candidate by its revision. Obtain authority for the publication action and read back the exact revision at the destination before claiming delivery.

## Versions and releases

Kherep has one product version, `version` in the root `package.json`, following [Semantic Versioning](https://semver.org/). `package-lock.json`, the Codex plugin manifests and the newest release section of [CHANGELOG.md](../CHANGELOG.md) repeat it, and `bootstrap/version-contract.test.mts` keeps them equal. While the version is `0.y.z`, a release that breaks a documented interface increments the minor version; every other release increments the patch version.

A release goes through the same pull request path as any other change:

1. On a branch from the current `main`, set the new version in `package.json`, in both version fields of `package-lock.json` and in the two Codex plugin manifests. In `CHANGELOG.md`, rename `## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, add an empty `## [Unreleased]` above it, and update the link references at the end of the file. Run `node bootstrap/version-contract.test.mts` and the checks above.
2. Open a pull request and merge it by rebase once its checks pass.
3. Fetch `main` and tag the merged commit on `main`, not the commit on the release branch: a rebase merge gives the commit a new hash. Confirm that `package.json` at that commit carries the version, then create an annotated tag: `git tag -a vX.Y.Z -m "Kherep X.Y.Z" <commit>`.
4. Push that one tag by name, for example `git push origin refs/tags/vX.Y.Z`. Never push with `--tags`, `--mirror` or `--follow-tags`: they would publish every local tag.
5. Read the tag back from the remote with `git ls-remote --tags origin vX.Y.Z`; its peeled entry (`vX.Y.Z^{}`) must name the merged commit on `main`.
