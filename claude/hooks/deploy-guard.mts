#!/usr/bin/env node
// PreToolUse hook: blocks risky production deploys without explicit user confirmation.
// Triggers on:
//   - forge deploy --environment production / -e production
//   - npm/pnpm/yarn production-deploy wrappers (for example deploy:jira:prod)
//   - forge install on any named site
//   - git force-push (--force / -f / --force-with-lease / +refspec)
//   - kubectl apply (mutates the live cluster)
//   - destructive kubectl verbs: delete, drain, cordon, uncordon, taint,
//     replace, edit, patch, rollout undo (OP-1045; rollout restart stays allowed)
//   - kubectl scale
//   - destructive helm verbs: uninstall, delete, rollback (upgrade/install stay allowed)
// Rationale: CLAUDE.md (project-level) requires dev-deploy-first + explicit user OK for prod.

import fs from 'node:fs';
import { forcePushVerdict, legacyForcePush } from './lib/git-push-match.mts';
import {
  forgeDeployVerdict, forgeInstallVerdict, forgeTunnelVerdict, legacyForgeDeploy, legacyForgeInstall, legacyForgeTunnel,
} from './lib/forge-match.mts';

// The fields this hook reads from a PreToolUse payload.
interface ToolPayload {
  tool_name?: unknown;
  tool_input?: { command?: unknown } | null;
  transcript_path?: unknown;
}

function read(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    stream.on('data', (c) => (data += c));
    stream.on('end', () => resolve(data));
  });
}

function lastUserText(transcriptPath: unknown): string {
  if (!transcriptPath) return '';
  let lines: string[];
  try { lines = fs.readFileSync(transcriptPath as string, 'utf8').split(/\r?\n/).filter(Boolean); }
  catch { return ''; }
  for (let i = lines.length - 1; i >= 0; i--) {
    let row: { message?: { role?: unknown; content?: unknown } } | null;
    try { row = JSON.parse(lines[i]); } catch { continue; }
    const message = row && row.message;
    if (!message || message.role !== 'user') continue;
    if (typeof message.content === 'string') return message.content;
    if (Array.isArray(message.content)) {
      const text = message.content
        .filter((block: { type?: unknown; text?: unknown } | null) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block: { text: string }) => block.text)
        .join('\n');
      if (text) return text;
    }
  }
  return '';
}

// Anchors a kubectl SUBCOMMAND: kubectl, then any number of global flags
// (-n kherep, --context=x, ...), then the verb. NOT a free substring match, so
// `get pod delete-me`, `logs x | grep scale` or `> patch.yaml` never match.
// The head and the trailing word boundary come from regex literals, never from
// string literals: a hand-escaped '\\b' in a string is one typo away from the
// backspace character, and the resulting regex would silently match nothing.
// `.exe` because both workstations are Windows hosts. Quoted flag values because
// a value with an embedded space (--context "my cluster") otherwise ends the
// flag group early and the verb is never reached: measured false negative.
// Known gap, deliberately left open: a shell alias such as `k delete` is invisible
// here. Anchoring on a bare `k` would add false positives for no measured use.
const KUBECTL_HEAD = /\bkubectl(?:\.exe)?\b(?:\s+(?:-{1,2}[\w-]+(?:[=\s](?:"[^"]*"|'[^']*'|\S+))?))*\s+/;
const HELM_HEAD = /\bhelm(?:\.exe)?\b(?:\s+(?:-{1,2}[\w-]+(?:[=\s](?:"[^"]*"|'[^']*'|\S+))?))*\s+/;
const WORD_END = /\b/;
function subcommand(cmd: string, head: RegExp, verbPattern: string): boolean {
  return new RegExp(`${head.source}(?:${verbPattern})${WORD_END.source}`).test(cmd);
}

function explicitlyApprovesProductionDeploy(text: string): boolean {
  if (!text) return false;
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (/\b(?:nicht|kein(?:e[nsr]?)?|never|do not|don't|stop|abbrechen)\b.{0,80}\b(?:deploy|production|prod)\b/i.test(normalized)) return false;
  const deployThenProd = /\b(?:deploy\w*|ausroll\w*|veroeffentlich\w*|roll\s+out)\b.{0,100}\b(?:prod|production|produktion|produktiv)\b/i;
  const prodThenApproval = /\b(?:prod|production|produktion|produktiv)\b.{0,100}\b(?:deploy\w*|freigegeben|genehmigt|go\s+ahead|mach(?:en)?|start(?:en)?)\b/i;
  return deployThenProd.test(normalized) || prodThenApproval.test(normalized);
}

await (async () => {
  const raw = await read(process.stdin);
  let payload: ToolPayload | null = null;
  try {
    payload = JSON.parse(raw) as ToolPayload | null;
  } catch {
    process.exit(0);
  }

  if (!payload || payload.tool_name !== 'Bash') process.exit(0);
  const cmd = ((payload.tool_input && payload.tool_input.command) || '') as string;
  const violations: string[] = [];

  // Per-command authorization token. User explicitly authorized
  // self-bypass on 2026-05-06. Token visible in command (not opaque env)
  // so every prod deploy is transcript-traceable.
  // Usage: KHEREP_DEPLOY_AUTH=approved forge deploy -e production
  //
  // The token MUST sit where a shell assignment can sit: at the start of the
  // command or right after a segment separator. A free \b match anywhere was a
  // measured false authorization (OP-1045, 2026-08-30): a heredoc that merely
  // DOCUMENTS the token disarmed every rule for that whole call, and a trailing
  // `# KHEREP_DEPLOY_AUTH=approved` comment would have done the same. Prose about
  // the token is not an approval of the command it happens to sit next to.
  const inlineDeployAuth = /(?:^|[;&|(]\s*)KHEREP_DEPLOY_AUTH=approved(?=\s)/.test(cmd);
  const transcriptDeployAuth = explicitlyApprovesProductionDeploy(lastUserText(payload.transcript_path));
  const hasDeployAuth = inlineDeployAuth || transcriptDeployAuth;

  // 1. Direct Forge deploy to production. Only an environment flag in the
  // arguments of the same forge deploy counts (issue #328); an uncertain parse
  // falls back to the pre-#328 regexes, so it fails closed.
  const deployVerdict = forgeDeployVerdict(cmd);
  const isProdDeploy = deployVerdict === 'match' || (deployVerdict === 'uncertain' && legacyForgeDeploy(cmd));
  if (isProdDeploy && !hasDeployAuth) {
    violations.push(
      'forge deploy --environment production blocked. Bypass with KHEREP_DEPLOY_AUTH=approved prefix once user approved this session.'
    );
  }

  // 1b. Production deploys are normally wrapped in package scripts. A
  // PreToolUse hook only sees the wrapper command, not the script body, so
  // guard the canonical deploy:*:prod naming contract explicitly. Production
  // aliases that do not contain both "deploy" and "prod/production" are
  // forbidden by CLAUDE.md because no command-text hook can classify them.
  const isProductionDeployWrapper =
    /\b(?:npm|pnpm|yarn)\b[^\r\n;&|]{0,160}\b(?:run\s+)?["']?[^\s"';&|]*deploy[^\s"';&|]*(?:prod|production)\b/i.test(cmd) ||
    /\b(?:npm|pnpm|yarn)\b[^\r\n;&|]{0,160}\b(?:run\s+)?["']?[^\s"';&|]*(?:prod|production)[^\s"';&|]*deploy\b/i.test(cmd);
  if (isProductionDeployWrapper && !hasDeployAuth) {
    violations.push(
      'production deploy wrapper blocked. After explicit user approval, re-run the SAME command with visible KHEREP_DEPLOY_AUTH=approved prefix.'
    );
  }


  // 2. Forge install changes a remote site and always needs explicit approval.
  // Same scan and fallback as rule 1 (issue #328).
  const install = forgeInstallVerdict(cmd);
  let site = install.verdict === 'match' ? install.site : null;
  if (install.verdict === 'uncertain') site = legacyForgeInstall(cmd);
  if (site !== null && !hasDeployAuth) {
    violations.push(
      `forge install on site "${site}" blocked until explicitly approved.`
    );
  }

  // 4. forge tunnel - explicitly forbidden by CLAUDE.md even in VOLLGAS mode.
  // Only the verb of a forge invocation counts (issue #347), with the same
  // fallback as rule 1. The deploy-auth token never disarms this rule.
  const tunnelVerdict = forgeTunnelVerdict(cmd);
  if (tunnelVerdict === 'match' || (tunnelVerdict === 'uncertain' && legacyForgeTunnel(cmd))) {
    violations.push('forge tunnel blocked. CLAUDE.md forbids it without explicit user request.');
  }

  // 5. git force-push - rewrites shared remote history. Only a force flag in the
  // arguments of the same `git push` counts (issue #327): --force,
  // --force-with-lease, a short cluster with f, or a +refspec. Quoted words are
  // scanned again as shell, heredoc body lines word by word. When the parse is uncertain the
  // pre-#327 regexes decide, so it fails closed. Bypass via the deploy-auth token.
  const pushVerdict = forcePushVerdict(cmd);
  const isForce = pushVerdict === 'force' || (pushVerdict === 'uncertain' && legacyForcePush(cmd));
  if (isForce && !hasDeployAuth) {
    violations.push(
      'git force-push blocked. Rewrites shared remote history. Bypass with KHEREP_DEPLOY_AUTH=approved once user approved.'
    );
  }

  // 6. kubectl apply - mutates the live cluster (also when ssh-wrapped, the
  // command string still contains it). "apply" is anchored as the SUBCOMMAND
  // (after kubectl + optional global flags), NOT a free substring, so benign
  // commands like `get pod apply-config`, `logs x | grep apply`, `> apply.yaml`
  // are not false-blocked. get/logs/exec/cp/describe stay allowed for the
  // build-runner. Bypass via token.
  if (subcommand(cmd, KUBECTL_HEAD, 'apply') && !hasDeployAuth) {
    violations.push(
      'kubectl apply blocked until explicitly approved with KHEREP_DEPLOY_AUTH=approved.'
    );
  }

  // 7. Destructive kubectl verbs (OP-1045). The Bash permission list cannot
  // refuse these: Bash(*) in the user scope and Bash(ssh:*) / Bash(kubectl:*)
  // in the project scope pre-approve them, which makes the autoMode classifier
  // a non-layer for Bash. A PreToolUse hook runs regardless of permissions.allow,
  // so this is the only lever that actually holds. Blocked on EVERY host and
  // host or namespace. A configured route never creates an implicit exception.
  // `rollout restart` stays allowed, it is routine, reversible and Director-approved.
  // Bypass is the INLINE token only. A spoken production-deploy approval in the
  // transcript must never carry over into a cluster delete.
  const DESTRUCTIVE_KUBECTL = /delete|drain|cordon|uncordon|taint|replace|edit|patch|rollout\s+undo/.source;
  if (subcommand(cmd, KUBECTL_HEAD, DESTRUCTIVE_KUBECTL) && !inlineDeployAuth) {
    violations.push(
      'destructive kubectl verb blocked (delete/drain/cordon/uncordon/taint/replace/edit/patch/rollout undo). ' +
        'Read-only verbs and `rollout restart` are unaffected. If the user explicitly approved THIS command, ' +
        're-run the same command with a visible KHEREP_DEPLOY_AUTH=approved prefix.'
    );
  }

  if (subcommand(cmd, KUBECTL_HEAD, 'scale') && !inlineDeployAuth) {
    violations.push(
      'kubectl scale blocked until explicitly approved with KHEREP_DEPLOY_AUTH=approved.'
    );
  }

  // 8. Destructive Helm verbs (OP-1045). Guarding only the kubectl route while
  // Helm reaches the same workloads unguarded would be a guard in name only:
  // `helm uninstall` removes a release outright and lives in the repo
  // (infra/analysis/atlassian-dc-migration/snapshot-atlassian-release.sh).
  // `helm upgrade` and `helm install` stay untouched on purpose. They are the
  // documented routine change path (values.yaml -> helm upgrade -> verify),
  // including the on-demand replica switch, and blocking them would cost daily
  // operations without buying protection the rollback/uninstall block already gives.
  const DESTRUCTIVE_HELM = /uninstall|delete|rollback/.source;
  if (subcommand(cmd, HELM_HEAD, DESTRUCTIVE_HELM) && !inlineDeployAuth) {
    violations.push(
      'destructive helm verb blocked (uninstall/delete/rollback). helm upgrade, install, list and status are unaffected. ' +
        'If the user explicitly approved THIS command, re-run it with a visible KHEREP_DEPLOY_AUTH=approved prefix.'
    );
  }

  if (violations.length === 0) process.exit(0);

  process.stderr.write(
    `deploy-guard blocked this command:\n  - ${violations.join('\n  - ')}\n\n` +
      'If the user explicitly approves this action, re-run the same command with a visible per-command KHEREP_DEPLOY_AUTH=approved prefix. The prefix never unblocks forge tunnel. A persistent environment variable is intentionally ignored.\n'
  );
  process.exit(2);
})();
