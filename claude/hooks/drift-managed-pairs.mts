/**
 * drift-managed-pairs.mts  -  the live -> repo-source map of drift-check.sh
 *
 * Split out of drift-managed-path-watch during the TypeScript migration
 * (OP-1138): typed, the hook and this table together crossed the 250-line
 * ceiling from CLAUDE.md. The cut follows the line that was already there. This
 * module answers WHICH live file has WHICH versioned source, the hook answers
 * WHETHER a just-written path is one of them.
 *
 * Mirrors bootstrap/drift-check.sh:
 *   - every entry of bootstrap/manifest/files.txt is relative to CLAUDE_HOME and
 *     maps to claude/<rel>; directory entries cover their whole subtree, because
 *     the script walks them with cmp_tree
 *   - settings.json, CLAUDE.md and teams/kherep/ROUTING.md are special-cased
 *     there and here: install.sh builds them from their sources
 *   - the runtime and project pairs the script compares outside the manifest loop
 * drift-managed-path-watch.test.mts parses the cmp_file/cmp_tree invocations out
 * of the script and asserts this map covers every live target they name, so the
 * two cannot drift apart unnoticed.
 *
 * Reading the manifest is best effort - no checkout, no manifest pairs, but the
 * fixed pairs still fire.
 */
import fs from "node:fs";

import { joinPathLike } from "./lib/workspace-scope.mts";
import { checkoutFor } from "./lib/orchestra-checkout.mts";

// `rendered` marks a live file that install.sh BUILDS from the source, so the
// edit has to be redone in the source rather than copied over. `block` marks a
// live file of which install.sh manages only the marked Kherep block (OP-1425).
export interface ManagedPair {
  live: string;
  source: string;
  rendered?: boolean;
  block?: boolean;
}

// Pairs drift-check.sh compares outside the manifest loop, in its order.
export function fixedPairs(home: string, workspace: string): ManagedPair[] {
  const pairs: ManagedPair[] = [
    // drift-check.sh:103-109 - the manifest lists the live-side names.
    { live: joinPathLike(home, "settings.json"), source: "claude/settings.user.json", rendered: true },
    // Issue #436. Both name this host's intercom command, rendered in by install.sh.
    { live: joinPathLike(home, "CLAUDE.md"), source: "claude/CLAUDE.user.md", rendered: true },
    { live: joinPathLike(home, "teams/kherep/ROUTING.md"), source: "claude/teams/kherep/ROUTING.md", rendered: true },
    // drift-check.sh:118-125 - runtime modules, installed outside claude/.
    { live: joinPathLike(home, "kherep/local-inference/runner.mts"), source: "modules/local-inference/runner.mts" },
    { live: joinPathLike(home, "kherep/local-inference/lib"), source: "modules/local-inference/lib" },
    {
      live: joinPathLike(home, "kherep/local-inference/config.json"),
      source: "bootstrap/manifest/local-inference.json",
      rendered: true,
    },
    { live: joinPathLike(home, "kherep/twg"), source: "modules/twg/runtime" },
    // Issue #592. The source the stable control-plane entry point runs, rendered by install.sh.
    { live: joinPathLike(home, "kherep/control-plane/source.json"), source: "bootstrap/control-plane-pointer.mts", rendered: true },
    // OP-1426. Rendered from the install-time KHEREP_WORK_ITEM_* values.
    {
      live: joinPathLike(home, "kherep/githooks/commit-policy"),
      source: "bootstrap/commit-policy.mts",
      rendered: true,
    },
  ];
  if (!workspace) return pairs;
  // drift-check.sh:131-132 - project-scoped, installed explicitly, not in the manifest.
  return pairs.concat([
    {
      live: joinPathLike(workspace, ".claude/settings.local.json"),
      source: "claude/settings.project.json",
      rendered: true,
    },
    { live: joinPathLike(workspace, "CLAUDE.md"), source: "claude/CLAUDE.project.md", block: true },
    // The Codex-side rule file. Unmanaged until OP-686, which is exactly how it
    // drifted seven rules behind CLAUDE.md without anything noticing.
    { live: joinPathLike(workspace, "AGENTS.md"), source: "claude/AGENTS.project.md", block: true },
    { live: joinPathLike(workspace, "tools/atl-jira.mts"), source: "modules/atl-jira-brokers/atl-jira.mts" },
    {
      live: joinPathLike(workspace, "tools/atlassian-credentials.mts"),
      source: "modules/atl-jira-brokers/atlassian-credentials.mts",
    },
    {
      live: joinPathLike(workspace, "tools/atlassian-cli-args.mts"),
      source: "modules/atl-jira-brokers/atlassian-cli-args.mts",
    },
    {
      live: joinPathLike(workspace, "tools/atl-jira-ccoder.mts"),
      source: "modules/atl-jira-brokers/atl-jira-ccoder.mts",
    },
    { live: joinPathLike(workspace, "tools/jira-adf.mts"), source: "modules/atl-jira-brokers/jira-adf.mts" },
    { live: joinPathLike(workspace, "tools/jira-adf-text.mts"), source: "modules/atl-jira-brokers/jira-adf-text.mts" },
    { live: joinPathLike(workspace, "tools/jira-attach.mts"), source: "modules/atl-jira-brokers/jira-attach.mts" },
    { live: joinPathLike(workspace, "tools/jira-download.mts"), source: "modules/atl-jira-brokers/jira-download.mts" },
    {
      live: joinPathLike(workspace, "tools/jira-transition-guard.mts"),
      source: "modules/atl-jira-brokers/jira-transition-guard.mts",
    },
    // Keep this runtime map independent; the equivalence test binds it to drift-check.sh.
    { live: joinPathLike(workspace, "tools/jira-config.mts"), source: "modules/atl-jira-brokers/jira-config.mts" },
    { live: joinPathLike(workspace, "tools/jira-fields.mts"), source: "modules/atl-jira-brokers/jira-fields.mts" },
    { live: joinPathLike(workspace, "tools/jira-links.mts"), source: "modules/atl-jira-brokers/jira-links.mts" },
    { live: joinPathLike(workspace, "tools/jira-search.mts"), source: "modules/atl-jira-brokers/jira-search.mts" },
    { live: joinPathLike(workspace, "tools/jira-discovery.mts"), source: "modules/atl-jira-brokers/jira-discovery.mts" },
    // OP-1405. The Confluence broker. Its sources live in the Jira broker
    // directory because the installers copy that directory FLAT into
    // <workspace>/tools/; see the header of confluence-session.mts.
    {
      live: joinPathLike(workspace, "tools/atl-confluence.mts"),
      source: "modules/atl-jira-brokers/atl-confluence.mts",
    },
    {
      live: joinPathLike(workspace, "tools/atl-confluence-ccoder.mts"),
      source: "modules/atl-jira-brokers/atl-confluence-ccoder.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-contract.mts"),
      source: "modules/atl-jira-brokers/confluence-contract.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-content.mts"),
      source: "modules/atl-jira-brokers/confluence-content.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-session.mts"),
      source: "modules/atl-jira-brokers/confluence-session.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-related.mts"),
      source: "modules/atl-jira-brokers/confluence-related.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-text-search.mts"),
      source: "modules/atl-jira-brokers/confluence-text-search.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-semantic.mts"),
      source: "modules/atl-jira-brokers/confluence-semantic.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-neighbours.mts"),
      source: "modules/atl-jira-brokers/confluence-neighbours.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-neighbour-cli.mts"),
      source: "modules/atl-jira-brokers/confluence-neighbour-cli.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-topic-query.mts"),
      source: "modules/atl-jira-brokers/confluence-topic-query.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-candidates.mts"),
      source: "modules/atl-jira-brokers/confluence-candidates.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-stitch.mts"),
      source: "modules/atl-jira-brokers/confluence-stitch.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-list-cli.mts"),
      source: "modules/atl-jira-brokers/confluence-list-cli.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-runtime-label.mts"),
      source: "modules/atl-jira-brokers/confluence-runtime-label.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-label-cli.mts"),
      source: "modules/atl-jira-brokers/confluence-label-cli.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-pagination.mts"),
      source: "modules/atl-jira-brokers/confluence-pagination.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-drainage-rules.mts"),
      source: "modules/atl-jira-brokers/confluence-drainage-rules.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-drainage-snapshot.mts"),
      source: "modules/atl-jira-brokers/confluence-drainage-snapshot.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-drainage-scan.mts"),
      source: "modules/atl-jira-brokers/confluence-drainage-scan.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-drainage-cli.mts"),
      source: "modules/atl-jira-brokers/confluence-drainage-cli.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-evidence.mts"),
      source: "modules/atl-jira-brokers/confluence-evidence.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-evidence-report.mts"),
      source: "modules/atl-jira-brokers/confluence-evidence-report.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-evidence-io.mts"),
      source: "modules/atl-jira-brokers/confluence-evidence-io.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-evidence-cli.mts"),
      source: "modules/atl-jira-brokers/confluence-evidence-cli.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-claim-text.mts"),
      source: "modules/atl-jira-brokers/confluence-claim-text.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-revision-staleness.mts"),
      source: "modules/atl-jira-brokers/confluence-revision-staleness.mts",
    },
    {
      live: joinPathLike(workspace, "tools/confluence-revision-staleness-git.mts"),
      source: "modules/atl-jira-brokers/confluence-revision-staleness-git.mts",
    },
    ...["auth.mts", "broker.mts", "cli.mts", "config.mts", "contract.mts", "issues.mts",
      "key-access.mts", "receipt.mts", "transport.mts", "windows-access.mts", "github-claude.mts", "github-codex.mts"]
      .map((name) => ({
        live: joinPathLike(workspace, `tools/github-broker/${name}`), source: `modules/github-broker/${name}`,
      })),
  ]);
}

const RENDERED_ENTRIES = new Set(["settings.json", "CLAUDE.md", "teams/kherep/ROUTING.md"]);

export function manifestPairs(home: string, workspace: string): ManagedPair[] {
  if (!workspace) return [];
  const checkout = checkoutFor({}, home, { KHEREP_WORKSPACE: workspace });
  if (!checkout) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(joinPathLike(checkout, "bootstrap/manifest/files.txt"), "utf8");
  } catch {
    return [];
  }
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    // These are special-cased in fixedPairs with their real sources, exactly as
    // drift-check.sh special-cases them inside the same loop.
    .filter((rel) => !RENDERED_ENTRIES.has(rel))
    .map((rel) => ({ live: joinPathLike(home, rel), source: `claude/${rel}` }));
}
