import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { requireTrustedExecutable } from "../../../claude/hooks/lib/trusted-executable.mts";

import { intercomValues, renderIntercom } from "../../../bootstrap/render-intercom.mts";
import { launcherRule, renderControlPlaneRules } from "../../../codex/lib/control-plane-rules.mts";
import type { NodePaths } from "./config.mts";
import { INTERCOM_INSTRUCTIONS, intercomInstructionFiles, type IntercomInstruction } from "./intercom-instructions.mts";
import { ensureLauncher } from "./launcher.mts";
import { serviceRoot, writeServiceReceipt, type ServiceReceipt } from "./service-records.mts";
import { pinServiceSource } from "./service-source.mts";

// Issue #436. A synthetic host on which the intercom command works: a managed
// service receipt naming a real, digest-verified source pin of a throwaway git
// checkout, the launcher files the current renderer writes and the five
// instruction files naming the command. Every path is under the caller's
// mkdtemp directory; no real home or config root is read or written.

export interface IntercomHost { root: string; pin: string; receipt: ServiceReceipt; files: Record<IntercomInstruction, string> }

function git(root: string, ...args: string[]): string {
  const command = requireTrustedExecutable("git", { cwd: root });
  const result = spawnSync(command, ["-C", root, ...args], { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function sourceCheckout(dir: string): string {
  fs.mkdirSync(path.join(dir, "modules", "control-plane", "node"), { recursive: true });
  git(dir, "init", "-q");
  fs.writeFileSync(path.join(dir, "modules", "control-plane", "node", "cli.mts"), "export const synthetic = true;\n");
  fs.writeFileSync(path.join(dir, "package.json"), "{}\n");
  git(dir, "add", ".");
  const commit = git(dir, "-c", "user.name=Kherep Fixture", "-c", "user.email=fixture@example.invalid",
    "commit-tree", git(dir, "write-tree"), "-m", "fixture");
  git(dir, "update-ref", "HEAD", commit);
  return dir;
}

const REPO = path.resolve(import.meta.dirname, "..", "..", "..");
const TEMPLATES: Readonly<Record<Exclude<IntercomInstruction, "codexRules">, string>> = {
  claudeUser: "claude/CLAUDE.user.md", claudeRouting: "claude/teams/kherep/ROUTING.md",
  codexAgents: "codex/AGENTS.maestro.md", codexRouting: "codex/ROUTING.md",
};

// What the installers write into each file: the repository's own templates
// through render-intercom.mts, and the rules with the launcher rule alone, as
// codex/install.mts renders them.
export function instructionText(kind: IntercomInstruction, root: string): string {
  const values = intercomValues(root);
  if (kind === "codexRules") return renderControlPlaneRules([launcherRule(values.command)]);
  return renderIntercom(fs.readFileSync(path.join(REPO, TEMPLATES[kind]), "utf8"), values);
}

export function writeIntercomHost(paths: NodePaths, claudeDir: string, codexHome: string, scratch: string): IntercomHost {
  const root = path.dirname(paths.dir);
  const pin = pinServiceSource(sourceCheckout(path.join(scratch, "intercom-source")), serviceRoot(paths));
  const platform = process.platform === "win32" ? "win32" : "darwin";
  const receipt: ServiceReceipt = {
    version: 1,
    binding: { serviceName: "kherep-node", platform, workspace: scratch, configRoot: root, nodeExecutable: process.execPath,
      ...(platform === "win32" ? { supervisorGeneration: crypto.randomUUID() } : {}), source: pin.identity },
    definitionDigest: "0".repeat(64), securityDigest: "1".repeat(64), activatedAt: new Date(0).toISOString(),
  };
  writeServiceReceipt(paths, receipt);
  ensureLauncher(root, { platform, nodeExecutable: process.execPath });
  const files = intercomInstructionFiles(claudeDir, codexHome);
  for (const kind of INTERCOM_INSTRUCTIONS) {
    fs.mkdirSync(path.dirname(files[kind]), { recursive: true });
    fs.writeFileSync(files[kind], instructionText(kind, root));
  }
  return { root, pin: pin.root, receipt, files };
}
