#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import { ATTACH_USAGE, runAttach } from "./attach.mts";
import { ATTRIBUTION_USAGE, runAttribution } from "./attribution-cli.mts";
import { codexLivenessSource } from "./codex-liveness-source.mts";
import { nodePaths, readConfig } from "./config.mts";
import { startDaemon } from "./daemon.mts";
import { runDoctor } from "./doctor.mts";
import { MSG_USAGE, runMsg } from "./msg-cli.mts";
import { nodeStatus, onboard, unenroll } from "./onboard.mts";
import { parseTaskArgs, runTaskArgs, TASK_USAGE } from "./task-cli.mts";
import { runTaskControlArgs, TASK_CONTROL_USAGE } from "./task-control-cli.mts";
import { runService, safeServiceFailure, SERVICE_USAGE } from "./service-cli.mts";
import { stopOnSignals, timestamped } from "./service-runner.mts";

// kherep-node: node side of the Kherep Control Plane, Phase 1.
//
//   node cli.mts node onboard --url https://control.example.com --code <code> [--name <name>]
//   node cli.mts node status
//   node cli.mts node unenroll
//   node cli.mts daemon
//   node cli.mts doctor                               (see doctor.mts)
//   node cli.mts msg sessions|send|inbox|status ...   (see msg-cli.mts)
//   node cli.mts task done|show|new ...               (see task-cli.mts)
//   node cli.mts attach <node>/<session>              (see attach.mts)
//   node cli.mts attribution [--branch] [--pr] ...    (see attribution-cli.mts)
//
// The enrollment code can also come from KHEREP_ENROLL_CODE so it stays out of
// shell history. KHEREP_CONFIG_DIR overrides the config location.
const USAGE = `usage:
  kherep-node node onboard --url <https origin> --code <enrollment code> [--name <name>]
  kherep-node node status
  kherep-node node unenroll
  kherep-node daemon
  kherep-node doctor
${SERVICE_USAGE}
${MSG_USAGE.replace("usage:\n", "")}
${TASK_USAGE.replace("usage:\n", "")}
${TASK_CONTROL_USAGE.replace("usage:\n", "")}
${ATTACH_USAGE.replace("usage:\n", "")}
${ATTRIBUTION_USAGE.replace("usage:\n", "")}`;

export async function main(argv: string[]): Promise<number> {
  // msg has its own options, and message text may look like anything else.
  if (argv[0] === "msg") return runMsg(argv.slice(1), { paths: nodePaths(), env: process.env });
  if (argv[0] === "attach") return runAttach(argv.slice(1), { paths: nodePaths() });
  if (argv[0] === "attribution") return runAttribution(argv.slice(1), { paths: nodePaths() });
  if (argv[0] === "service") return runService(argv.slice(1));
  if (argv[0] === "task" && ["status", "stop", "result"].includes(argv[1] ?? "")) {
    return runTaskControlArgs(argv.slice(1), { paths: nodePaths() });
  }
  if (argv[0] === "task") return runTaskArgs(parseTaskArgs(argv.slice(1)), { paths: nodePaths(), env: process.env });
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { url: { type: "string" }, code: { type: "string" }, name: { type: "string" } },
  });
  const paths = nodePaths();
  const [group, action] = positionals;

  if (group === "daemon") {
    const config = readConfig(paths.config);
    if (!config) throw new Error(`not enrolled (${paths.config}); run "kherep-node node onboard" first`);
    const daemon = startDaemon(config, paths, timestamped(), undefined, undefined, undefined, undefined, undefined, codexLivenessSource({ paths }));
    stopOnSignals(daemon);
    await daemon.done;
    return 0;
  }
  if (group === "doctor") {
    const report = await runDoctor({ paths });
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  if (group !== "node") {
    console.error(USAGE);
    return 2;
  }
  if (action === "onboard") {
    const code = values.code ?? process.env.KHEREP_ENROLL_CODE;
    if (!values.url || !code) {
      console.error(USAGE);
      return 2;
    }
    const config = await onboard({ controlUrl: values.url, code, ...(values.name ? { name: values.name } : {}), paths });
    console.log(JSON.stringify({ enrolled: true, nodeId: config.nodeId, name: config.name, config: paths.config }, null, 2));
    return 0;
  }
  if (action === "status") {
    console.log(JSON.stringify(nodeStatus(paths), null, 2));
    return 0;
  }
  if (action === "unenroll") {
    const { nodeId } = unenroll(paths);
    console.log(JSON.stringify({
      unenrolled: nodeId !== null, nodeId,
      next: nodeId ? `ask an operator to revoke it: DELETE /api/nodes/${nodeId}` : "nothing was enrolled",
    }, null, 2));
    return 0;
  }
  console.error(USAGE);
  return 2;
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    const serviceFailure = safeServiceFailure(error);
    console.error(serviceFailure ? JSON.stringify(serviceFailure) : `kherep-node: ${(error as Error).message ?? String(error)}`);
    process.exitCode = 1;
  });
}
