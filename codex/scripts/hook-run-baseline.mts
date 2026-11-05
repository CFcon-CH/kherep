import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { TestContext } from "node:test";
import { pathToFileURL } from "node:url";

import * as projection from "../lib/parity-config.mts";
import type { RenderOptions } from "../lib/parity-config.mts";
import { BUSY_BODY, BUSY_OWNER, busyFixture } from "../../modules/control-plane/node/codex-busy-fixture.mts";
import { listenerDir } from "../../modules/control-plane/node/autonomy.mts";
import { publishBusyHint } from "../../modules/control-plane/node/codex-busy-ticket.mts";
import { getMessage } from "../../modules/control-plane/node/inbox.mts";
import { requireTrustedExecutable } from "../../claude/hooks/lib/trusted-executable.mts";

export interface RunRow {
  label: string; event: string; hook: string; target: string | null;
  hookCommands: number; nodeProcesses: number; totalProcesses: number;
  durationMs: number; contextBytes: number; output: string;
  children: { file: string; script: string | null }[];
}
export type Renderer = (options: RenderOptions) => string;
const repo = path.resolve(import.meta.dirname, "../..");

export function replayHooks(render: Renderer = projection.renderHooks, baselineRef?: string) {
  const cleanup: (() => void)[] = [];
  const node = busyFixture({ after: (fn: () => void) => cleanup.push(fn) } as unknown as TestContext, 1, Date.now(), false);
  try {
    const gitExecutable = requireTrustedExecutable("git", { cwd: node.workspace });
    const packetFile = path.join(node.paths.inbox, `${node.ids[0]}.json`);
    const packet = fs.readFileSync(packetFile);
    fs.unlinkSync(packetFile);
    const git = (args: string[]) => {
      const result = spawnSync(gitExecutable, ["-c", `core.hooksPath=${path.join(node.root, "no-hooks")}`, "-C", node.workspace, ...args], { encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
    };
    git(["init", "-b", "main"]);
    git(["-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "synthetic fixture"]);
    const hooks = path.join(node.root, "hooks");
    const copySource = (source: string, destination: string) => {
      if (baselineRef && ["hook-adapter.mts", "post-edit-checks.mts", "kherep-maestro-context.mts"].includes(path.basename(source))) {
        assert.match(baselineRef, /^[a-f0-9]{40}$/);
        const command = requireTrustedExecutable("git", { cwd: repo });
        const original = spawnSync(command, ["-C", repo, "show", `${baselineRef}:${path.relative(repo, source).replaceAll(path.sep, "/")}`], { encoding: "utf8" });
        assert.equal(original.status, 0, original.stderr);
        fs.writeFileSync(destination, original.stdout);
      } else fs.copyFileSync(source, destination);
    };
    fs.mkdirSync(hooks);
    fs.cpSync(path.join(repo, "claude/hooks/lib"), path.join(hooks, "lib"), { recursive: true });
    for (const name of fs.readdirSync(path.join(repo, "claude/hooks"))) {
      if (name.endsWith(".mts") && !name.includes(".test.")) fs.copyFileSync(path.join(repo, "claude/hooks", name), path.join(hooks, name));
    }
    for (const name of fs.readdirSync(path.join(repo, "codex/hooks"))) {
      if (!name.endsWith(".mts") || name.includes(".test.")) continue;
      copySource(path.join(repo, "codex/hooks", name), path.join(hooks, name));
      copySource(path.join(repo, "codex/hooks", name), path.join(hooks, "codex-" + name));
    }
    const trace = path.join(node.root, "trace.jsonl");
    const preload = path.join(node.root, "trace.mjs");
    fs.writeFileSync(preload, `import cp from 'node:child_process'; import fs from 'node:fs'; import path from 'node:path'; import {syncBuiltinESMExports} from 'node:module';
const original=cp.spawnSync; cp.spawnSync=function(file,args,options){const r=original.apply(this,arguments); if(!r.error) fs.appendFileSync(process.env.KHEREP_BENCH_TRACE,JSON.stringify({file:path.basename(String(file)),script:Array.isArray(args)?args.find(x=>String(x).endsWith('.mts')):null})+'\\n'); return r;}; syncBuiltinESMExports();`);
    const env: NodeJS.ProcessEnv = { ...process.env, KHEREP_CONFIG_DIR: node.root, KHEREP_WORKSPACE: node.workspace,
      KHEREP_WORK_ITEM_REQUIRED: "1", KHEREP_WORK_ITEM_PATTERN: "SYN-[0-9]+",
      CODEX_HOME: path.join(node.root, "codex-home"), CODEX_THREAD_ID: BUSY_OWNER,
      KHEREP_BENCH_TRACE: trace, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` };
    delete env.KHEREP_SESSION_ID;
    delete env.CLAUDE_CODE_SESSION_ID;
    const options = { node: process.execPath, hookDir: hooks, contextHook: path.join(hooks, "kherep-maestro-context.mts"),
      mcpServers: [], controlPlaneHook: path.join(repo, "modules/control-plane/node/deliver-hook.mts") };
    // Issue #503. The Control Plane hooks run through the stable entry point,
    // which runs the hooks of the source its pointer names: this checkout.
    fs.mkdirSync(path.join(env.CODEX_HOME!, "orchestra"), { recursive: true });
    fs.writeFileSync(path.join(env.CODEX_HOME!, "orchestra", "control-plane-source.json"),
      JSON.stringify({ version: 1, root: repo, kind: "checkout", verified: false }));
    const config = render(options);
    const groups = [...config.matchAll(/^\[\[hooks\.([A-Za-z]+)\]\]$/gm)].map((m, i, all) => {
      const body = config.slice(m.index, all[i + 1]?.index ?? config.length);
      const matcher = /^matcher = (.+)$/m.exec(body);
      return { event: m[1], matcher: matcher ? JSON.parse(matcher[1]) as string : "",
        commands: [...body.matchAll(/^command = (.+)$/gm)].map(x => JSON.parse(x[1]) as string) };
    });
    const rows: RunRow[] = [];
    const base = { ...node.input, cwd: node.workspace, tool_name: "functions.exec" };
    const event = (label: string, name: string, extra: Record<string, unknown> = {}) => {
      const input = { ...base, hook_event_name: name, ...extra };
      const outputs: string[] = [];
      let denied = false;
      for (const group of groups.filter(g => g.event === name && (!g.matcher || new RegExp(g.matcher).test(String(input.tool_name))))) {
        for (const command of group.commands) {
          fs.writeFileSync(trace, "");
          const args = [...command.matchAll(/"((?:\\.|[^"\\])*)"/g)].map(m => m[1].replace(/\\"/g, '"'));
          const started = performance.now();
          const result = spawnSync(args[0], args.slice(1), { env, input: JSON.stringify(input), encoding: "utf8", timeout: 30_000 });
          const children = fs.readFileSync(trace, "utf8").trim().split("\n").filter(Boolean).map(x => JSON.parse(x) as { file: string; script?: string });
          assert.equal(result.status, 0, `${label}: ${result.stderr}`);
          if (result.stdout.includes('"permissionDecision":"deny"')) denied = true;
          outputs.push(result.stdout);
          // Node options before the script (issue #503) name neither hook nor target.
          const [script, target] = args.slice(1).filter((arg) => !arg.startsWith("--"));
          rows.push({ label, event: name, hook: path.basename(script!), target: target ? path.basename(target) : null,
            hookCommands: 1, nodeProcesses: 1 + children.filter(x => x.file === path.basename(process.execPath)).length,
            totalProcesses: 1 + children.length, children: children.map(x => ({ file: x.file, script: x.script ? path.basename(x.script) : null })),
            durationMs: performance.now() - started, contextBytes: Buffer.byteLength(result.stdout),
            output: result.stdout.replaceAll(node.root, "<fixture>") });
        }
      }
      return { output: outputs.join("\n"), denied };
    };
    const shell = (command: string) => ({ tool_input: `await tools.shell_command({command:${JSON.stringify(command)}});` });
    assert.equal(event("lookup", "PreToolUse", shell("git status --short")).denied, false);
    event("lookup", "PostToolUse", shell("git status --short"));
    const edit = { tool_name: "Edit", tool_input: { file_path: path.join(node.workspace, "sample.mts"), new_string: "const value = 1;" } };
    fs.writeFileSync(path.join(node.workspace, "sample.mts"), "const value = 1;\n");
    assert.equal(event("edit", "PreToolUse", edit).denied, false);
    event("edit", "PostToolUse", edit);
    assert.equal(event("commit-allowed", "PreToolUse", shell('git commit -m "SYN-123 fix: synthetic fixture\nCo-Authored-By: Bot <bot@example.invalid>"')).denied, false);
    const deniedCommit = event("commit-denied", "PreToolUse", shell('git commit -m "SYN-123 fix: synthetic — fixture"'));
    assert.equal(deniedCommit.denied, true);
    assert.ok(deniedCommit.output.includes("commit message contains an em dash (U+2014)"));
    assert.equal(deniedCommit.output.includes("commit subject does not start with the configured work-item key and a space"), false);
    assert.equal(event("deploy-allowed", "PreToolUse", shell("kubectl get pods")).denied, false);
    assert.equal(event("deploy-denied", "PreToolUse", shell("kubectl delete pods synthetic")).denied, true);
    assert.equal(event("deploy-approved", "PreToolUse", shell("KHEREP_DEPLOY_AUTH=approved kubectl delete pods synthetic")).denied, false);
    assert.equal(event("checkout-allowed", "PreToolUse", shell("git switch main")).denied, false);
    assert.equal(event("checkout-denied", "PreToolUse", shell("git switch -c another")).denied, true);
    assert.equal(event("privacy-denied", "PreToolUse", { tool_name: "Read", tool_input: { file_path: path.join(node.workspace, "host_vars/private.yml") } }).denied, true);
    event("prompt-1", "UserPromptSubmit");
    event("prompt-2", "UserPromptSubmit");
    event("stop-empty", "Stop", { stop_hook_active: false });
    event("intercom-empty", "PostToolUse", shell("git status --short"));
    fs.writeFileSync(packetFile, packet);
    const turnsFile = path.join(listenerDir(node.paths), `${BUSY_OWNER}.turns.json`);
    fs.mkdirSync(listenerDir(node.paths), { recursive: true });
    const budgetBytes = JSON.stringify({ turns: Array.from({ length: 20 }, () => Date.now()) });
    fs.writeFileSync(turnsFile, budgetBytes);
    publishBusyHint(listenerDir(node.paths), { ...node.admission, admittedAt: Date.now(), expiresAt: Date.now() + 60_000 }, Date.now());
    const hinted = event("intercom-message", "PostToolUse", shell("git status --short"));
    assert.match(hinted.output, /New peer messages/);
    assert.equal(hinted.output.includes(BUSY_BODY), false);
    assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "accepted");
    assert.equal(fs.readFileSync(turnsFile, "utf8"), budgetBytes, "a same-turn hint spends no autonomous budget");
    const receive = spawnSync(process.execPath, [path.join(repo, "modules/control-plane/node/cli.mts"), "msg", "inbox", "--from", BUSY_OWNER, "--receive"], { env, encoding: "utf8" });
    assert.equal(receive.status, 0, receive.stderr);
    assert.ok(receive.stdout.includes(BUSY_BODY));
    assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "offered");
    event("stop-confirm", "Stop", { stop_hook_active: false });
    assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "offered", "Stop is not a processing ACK");
    const command = /msg inbox --ack ([0-9a-f-]{36}) --from ([0-9a-f-]{36})/.exec(receive.stdout);
    assert.ok(command, "complete synthetic intake prints the exact processing ACK");
    assert.equal(command[2], BUSY_OWNER);
    const ack = spawnSync(process.execPath, [path.join(repo, "modules/control-plane/node/cli.mts"), "msg", "inbox",
      "--ack", command[1]!, "--from", command[2]!], { env, encoding: "utf8" });
    assert.equal(ack.status, 0, ack.stderr);
    assert.equal(getMessage(node.paths.inbox, node.ids[0])?.state, "delivered");
    assert.equal(fs.readFileSync(turnsFile, "utf8"), budgetBytes, "processing ACK spends no autonomous budget");
    const totals = rows.reduce((r: Record<string, number>, x) => {
      for (const key of ["hookCommands", "nodeProcesses", "totalProcesses", "contextBytes", "durationMs"] as const) r[key] = (r[key] || 0) + x[key];
      return r;
    }, {});
    return { totals, rows };
  } finally { for (const fn of cleanup) fn(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  const before = process.argv[2] === "--before";
  const result = replayHooks(before ? projection.renderBeforeShellDispatcher : projection.renderHooks,
    before ? "87c317b2f88ecf689d7fb5f82bbd3bdbbdfb820f" : undefined);
  const outputFile = process.argv[before ? 3 : 2];
  if (outputFile) fs.writeFileSync(outputFile, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result.totals));
}
