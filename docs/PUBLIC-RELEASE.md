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
