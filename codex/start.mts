import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { codexCommand, findCodex } from "../modules/control-plane/node/codex-binary.mts";
import { InstallTransaction } from "./lib/install-transaction.mts";
import { readAvailableModels } from "./lib/model-catalog-process.mts";
import { parseModelPolicy } from "./lib/model-policy.mts";
import { modelEvidenceDigest } from "./lib/model-resolution-receipt.mts";
import { parseUserModelPolicy } from "./lib/model-policy-user.mts";
import { acquireSelectionLock, homeFile, MODEL_SELECTION_FILES, verifyAnchoredState, type AnchoredState } from "./lib/model-selection-anchor.mts";
import { modelSelectionGit, ModelSelectionRefusal, type ModelSelectionGit } from "./lib/model-selection-git.mts";
import { MODEL_POLICY_PATH } from "./lib/model-selection-inventory.mts";
import { assertSelectionUnchanged, assertSelectionWritten, prepareInstallSelection, type InstallSelection } from "./lib/model-selection-install.mts";
import { assertModelOnly, assertRegular, assertWorkspaceConfig, CONFIG, configureRoot, PARITY, readManagedText, updateParity } from "./lib/start-model-artifacts.mts";
import { readStartCatalog, refuseStart, strictStartSelection } from "./lib/start-model-policy.mts";
import { windowsDesktop, type DesktopStart } from "./lib/start-windows-desktop.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const USAGE = "Usage: node codex/start.mts [--workspace <absolute path>] [--desktop] [--prepare-only]";
const { anchor: ANCHOR, receipt: RECEIPT, user: USER } = MODEL_SELECTION_FILES;

export interface StartArgs { workspace: string; prepareOnly?: true; desktop?: true }
export function parseStartArgs(args: string[], cwd: string = process.cwd()): StartArgs {
  const result: StartArgs = { workspace: cwd };
  const flags = new Set<string>();
  for (let index = 0; index < args.length; index++) {
    const flag = args[index]!;
    if (flags.has(flag)) refuseStart("invalid-arguments");
    flags.add(flag);
    if (flag === "--workspace" && args[index + 1]) result.workspace = args[++index]!;
    else if (flag === "--prepare-only") result.prepareOnly = true;
    else if (flag === "--desktop") result.desktop = true;
    else refuseStart("invalid-arguments");
  }
  if (!path.isAbsolute(result.workspace)) refuseStart("invalid-arguments");
  return result;
}

interface StartContext { executable: string; codexHome: string; cwd: string }
interface StartOptions extends StartArgs { codexHome: string; executable?: string; git?: ModelSelectionGit }
interface LaunchRequest extends StartContext { args: string[] }
interface LaunchHandle { finished: Promise<number> }
interface StartDependencies {
  readCatalog?: (context: StartContext) => Promise<unknown>;
  launch?: (request: LaunchRequest) => Promise<LaunchHandle>;
  desktop?: DesktopStart;
  afterWrite?: (target: string) => void;
}

function launchCli({ executable, args, cwd, codexHome }: LaunchRequest): Promise<LaunchHandle> {
  const command = codexCommand(executable, args);
  const child = spawn(command.file, command.args, { cwd, env: { ...process.env, CODEX_HOME: codexHome }, stdio: "inherit" });
  const finished = new Promise<number>((resolve) => {
    child.once("exit", (status, signal) => resolve(status ?? (signal === "SIGINT" ? 130 : 1)));
  });
  return new Promise((resolve, reject) => {
    child.once("error", () => reject(new ModelSelectionRefusal("codex-start-launch-failed")));
    child.once("spawn", () => resolve({ finished }));
  });
}

function verifyHomePaths(home: string): void {
  for (const directory of ["orchestra", "agents", "hooks", "hooks/parity"]) assertRegular(homeFile(home, directory), true);
  for (const directory of ["kherep", "backups", "backups/kherep"]) assertRegular(homeFile(home, directory), true, true);
  if (!fs.lstatSync(homeFile(home, ANCHOR), { throwIfNoEntry: false })) refuseStart("anchor-required");
}

function compareState(codexHome: string, selection: InstallSelection, previous: AnchoredState, extra: ReadonlyMap<string, string>): void {
  verifyHomePaths(codexHome);
  for (const target of [USER, ANCHOR, ...previous.actualOutputs.map((row) => row.target)]) {
    assertRegular(homeFile(codexHome, target), false, target === USER);
  }
  assertSelectionUnchanged(codexHome, selection);
  for (const [target, expected] of extra) if (readManagedText(homeFile(codexHome, target)) !== expected) refuseStart("precondition-conflict");
}

function updateInstallation(context: StartContext, git: ModelSelectionGit, selection: InstallSelection, previous: AnchoredState, config: string,
  afterWrite?: StartDependencies["afterWrite"]): void {
  const home = context.codexHome;
  const nextConfig = configureRoot(config, selection.resolution.roles.root.effective);
  const parity = readManagedText(homeFile(home, PARITY));
  // A fresh, complete RPC is required even when no generation has to change.
  const stored = previous.verified.resolution;
  const proposed = selection.resolution;
  const advance = modelEvidenceDigest(stored) !== modelEvidenceDigest(proposed);
  const selectionId = advance ? selection.selectionId : previous.verified.selectionId;
  const nextParity = updateParity(parity, previous, selection, selectionId, nextConfig);
  const before = new Map([[CONFIG, config], [PARITY, parity], [RECEIPT, previous.receiptText]]);
  const writes = new Map<string, string>();
  if (advance) {
    for (const row of selection.plan.writes) writes.set(row.target, row.content);
    writes.set(RECEIPT, selection.receiptText!);
  }
  if (config !== nextConfig) writes.set(CONFIG, nextConfig);
  if (parity !== nextParity) writes.set(PARITY, nextParity);
  assertWorkspaceConfig(home, context.cwd);
  compareState(home, selection, previous, before);
  if (!writes.size) return;

  const backupParent = homeFile(home, "backups/kherep");
  fs.mkdirSync(backupParent, { recursive: true, mode: 0o700 });
  const backup = fs.mkdtempSync(path.join(backupParent, "model-start-"));
  // All paths written here, including config and parity, use ownership-aware
  // rollback. The transaction preserves a later external writer's bytes.
  const transaction = new InstallTransaction(home, backup, (file) => afterWrite?.(path.relative(home, file).split(path.sep).join("/")), () => true);
  const oldBytes = new Map([...before, [ANCHOR, previous.anchorText], ...previous.actualOutputs.map((row): [string, string] => [row.target, row.content])]);
  const write = (target: string, content: string) => {
    const file = homeFile(home, target);
    if (readManagedText(file) !== oldBytes.get(target)) refuseStart("precondition-conflict");
    transaction.writeFile(file, content);
  };
  try {
    for (const [target, content] of writes) write(target, content);
    assertWorkspaceConfig(home, context.cwd);
    if (advance) {
      for (const target of [RECEIPT, ...selection.outputs.map((row) => row.target)]) assertRegular(homeFile(home, target));
      assertSelectionWritten(home, selection);
    }
    if (readManagedText(homeFile(home, CONFIG)) !== nextConfig || readManagedText(homeFile(home, PARITY)) !== nextParity) refuseStart("readback-conflict");
    if (advance) {
      write(ANCHOR, selection.anchorText!);
      const published = readManagedText(homeFile(home, ANCHOR));
      if (published !== selection.anchorText || verifyAnchoredState(home, git, published, assertRegular).verified.selectionId !== selectionId) {
        refuseStart("readback-conflict");
      }
    }
  } catch {
    try {
      const touched = transaction.targets();
      const conflicts = transaction.rollback({ last: [homeFile(home, ANCHOR)] });
      if (conflicts.length || touched.some((file) => readManagedText(file) !== oldBytes.get(path.relative(home, file).split(path.sep).join("/")))) {
        refuseStart("rollback-conflict");
      }
    } catch { refuseStart("rollback-conflict"); }
    refuseStart("transaction-failed");
  }
}

export async function startCodex(options: StartOptions, dependencies: StartDependencies = {}): Promise<number> {
  try {
    if (![options.codexHome, options.workspace].every((value) => path.isAbsolute(value))) refuseStart("context-invalid");
    const codexHome = fs.realpathSync.native(options.codexHome);
    const cwd = fs.realpathSync.native(options.workspace);
    if ([codexHome, cwd].some((value) => /[\\/]\.claude(?:[\\/]|$)/iu.test(value))) refuseStart("context-invalid");
    assertRegular(cwd, true);
    verifyHomePaths(codexHome);
    assertWorkspaceConfig(codexHome, cwd);
    const desktop = options.desktop ? dependencies.desktop ?? windowsDesktop() : undefined;
    if (desktop && (!path.isAbsolute(desktop.home) || fs.realpathSync.native(desktop.home) !== codexHome)) refuseStart("desktop-home-unsupported");
    const git = options.git ?? modelSelectionGit(REPO);
    const release = acquireSelectionLock(codexHome);
    let launch: LaunchHandle;
    try {
      const executable = desktop ? await desktop.probe() : options.executable ?? findCodex();
      if (!executable || !path.isAbsolute(executable)) refuseStart("executable-unavailable");
      const context = { executable, codexHome, cwd };
      const anchorText = readManagedText(homeFile(codexHome, ANCHOR));
      const previous = verifyAnchoredState(codexHome, git, anchorText, assertRegular);
      if (previous.anchor.overlay) refuseStart("observer-overlay-unsupported");
      git.assertClean();
      const policy = parseModelPolicy(git.workingTree().read(MODEL_POLICY_PATH));
      const userFile = homeFile(codexHome, USER);
      assertRegular(userFile, false, true);
      const userText = fs.existsSync(userFile) ? readManagedText(userFile) : undefined;
      const user = parseUserModelPolicy(userText, previous.verified.inventory);
      // Validate the native root grammar before a catalog process can load it.
      const config = readManagedText(homeFile(codexHome, CONFIG));
      configureRoot(config, previous.verified.resolution.roles.root.effective);
      let raw: unknown;
      try { raw = await (dependencies.readCatalog ?? readAvailableModels)(context); }
      catch { refuseStart("catalog-unavailable"); }
      const catalog = readStartCatalog(raw);
      const verifyLatest = strictStartSelection(catalog, previous.verified.resolution, policy, user);
      const selection = prepareInstallSelection({ repoRoot: REPO, codexHome, git, refresh: true, catalog: catalog.catalog,
        checkInstalledTarget: (file) => assertRegular(file, false, file === userFile) });
      if (selection.userText !== userText || selection.previous?.anchorText !== previous.anchorText) refuseStart("precondition-conflict");
      verifyLatest(selection.resolution);
      assertModelOnly(selection, previous);
      if (desktop && await desktop.probe() !== executable) refuseStart("desktop-package-changed");
      updateInstallation(context, git, selection, previous, config, dependencies.afterWrite);
      if (options.prepareOnly) return 0;
      assertWorkspaceConfig(codexHome, cwd);
      if (desktop) { await desktop.activate(executable); return 0; }
      const root = selection.resolution.roles.root.effective;
      launch = await (dependencies.launch ?? launchCli)({ ...context, args: ["--no-daemon", "--cd", cwd, "--model", root.model] });
    } finally { release(); }
    return await launch.finished;
  } catch (error) {
    // All native RPC and filesystem errors stay local. Existing anchor/lock
    // errors expose their fixed code only, never their detail or a cause.
    if (error instanceof ModelSelectionRefusal) throw new ModelSelectionRefusal(error.code);
    return refuseStart("preflight-failed");
  }
}

function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(fs.realpathSync(entry)).href;
  } catch { return false; }
}

if (isMainModule()) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && args[0] === "--help") process.stdout.write(`${USAGE}\n`);
    else {
      const options = parseStartArgs(args);
      process.exitCode = await startCodex({ ...options, codexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex") });
      if (options.prepareOnly) process.stdout.write("Codex model selection prepared.\n");
    }
  } catch (error) {
    const detail = error instanceof ModelSelectionRefusal ? error.code : "codex-start-preflight-failed";
    process.stderr.write(`${detail}\nRun node codex/start.mts --help or see docs/CODEX.md for recovery.\n`);
    process.exitCode = 1;
  }
}
