// A throwaway repository tree for bootstrap/atl-credential.mts: byte-identical
// copies of the step and its two helpers, declared for coverage, beside a stub
// Claude Jira broker. The step resolves its broker relative to its own file,
// so the copy reaches the stub and never the real broker or the network.
//
// The stub decides its verdict from the credential file the step points it at:
// a file holding "good" passes, "unknown" is inconclusive, "misconfigured" is
// the broker's fixed configuration refusal, "killed" ends the broker by a
// signal, anything else fails.
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import { declareCopy } from "./coverage-copy-fixture.mts";

const HERE = import.meta.dirname;
const COPIED = ["atl-credential.mts", "atl-credential-format.mts", "atl-credential-config.mts"];
const PRELOAD = pathToFileURL(path.join(HERE, "terminal-preload.fixture.mts")).href;

const STUB_BROKER = `import fs from "node:fs";
const text = fs.readFileSync(process.env.KHEREP_ATL_CRED_FILE_CLAUDE, "utf8");
if (text.includes("misconfigured")) { process.stderr.write("KHEREP_ATL_SITE is not set for this test.\\n"); process.exit(1); }
if (text.includes("killed")) process.kill(process.pid, "SIGKILL");
const verdict = text.includes("good") ? "PASS" : text.includes("unknown") ? "UNKNOWN" : "FAIL";
process.stdout.write("verdikt: " + verdict + "\\n");
process.exit(verdict === "PASS" ? 0 : 1);
`;

export interface CredentialTree {
  root: string;
  step: string;
  target: string;
  terminalLog: string;
  env: (extra?: Record<string, string>) => NodeJS.ProcessEnv;
}

export function credentialTree(t: TestContext, { broker = true } = {}): CredentialTree {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-atl-credential-tree-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bootstrap = path.join(root, "bootstrap");
  const brokers = path.join(root, "modules", "atl-jira-brokers");
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.mkdirSync(brokers, { recursive: true });
  for (const file of COPIED) {
    fs.copyFileSync(path.join(HERE, file), path.join(bootstrap, file));
    declareCopy(path.join(HERE, file), path.join(bootstrap, file));
  }
  if (broker) fs.writeFileSync(path.join(brokers, "atl-jira-ccoder.mts"), STUB_BROKER);
  const terminalLog = path.join(root, "terminal.json");
  // Every inherited credential binding is stripped, so only the test decides
  // which file the step looks at.
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => {
    const out: NodeJS.ProcessEnv = { ...process.env, TERMINAL_PRELOAD_LOG: terminalLog };
    for (const key of Object.keys(out)) if (key.toUpperCase().startsWith("KHEREP_ATL_CRED_FILE")) delete out[key];
    return { ...out, ...extra };
  };
  return { root, step: path.join(bootstrap, "atl-credential.mts"), target: path.join(root, "home", "cred.txt"), terminalLog, env };
}

export function runStep(tree: CredentialTree, args: string[], options: { env?: Record<string, string>; stdin?: number } = {}): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [tree.step, "--runtime", "claude", ...args], {
    env: tree.env(options.env), encoding: "utf8", timeout: 60_000,
    stdio: [options.stdin ?? "pipe", "pipe", "pipe"],
  });
}

export interface Conversation { status: number | null; stdout: string; stderr: string; rawModes: boolean[] }

/**
 * Runs the step with the terminal preload and answers each prompt only once
 * it has appeared, so each blocking read of the step sees exactly its answer.
 */
export function converse(tree: CredentialTree, script: Array<[prompt: string, answer: string]>, stdin?: number): Promise<Conversation> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", PRELOAD, tree.step, "--runtime", "claude", "--out", tree.target], {
      env: tree.env(), stdio: [stdin ?? "pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "", seen = 0, step = 0;
    const answer = (): void => {
      while (child.stdin && step < script.length) {
        const at = stdout.indexOf(script[step][0], seen);
        if (at < 0) return;
        seen = at + script[step][0].length;
        child.stdin.write(script[step][1]);
        step += 1;
      }
      if (step === script.length) child.stdin?.end();
    };
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; answer(); });
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
    child.stdin?.on("error", () => {});
    child.on("error", reject);
    child.on("close", (status) => {
      clearTimeout(timer);
      const rawModes = fs.existsSync(tree.terminalLog) ? JSON.parse(fs.readFileSync(tree.terminalLog, "utf8")) as boolean[] : [];
      resolve({ status, stdout, stderr, rawModes });
    });
    answer();
  });
}
