#!/usr/bin/env node
// Renders the host-specific files bootstrap/install.sh writes: the merged
// settings pair, the local-inference config and the intercom instructions.
// Path rewriting lives in render-profile-paths.mts, the merge in
// render-profile-settings.mts.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { retireCentralBrainHooks } from "./central-brain-retirement.mts";
import { retiredCodexRegistered, retireCodexPlugin } from "./codex-plugin-retirement.mts";
import { captureIntercom, intercomValues, renderIntercom } from "./render-intercom.mts";
import { substituteTemplatePaths, toBashPath, workspaceEnvPath } from "./render-profile-paths.mts";
import { filterMacPermissions, filterManagedDisallowedPermissions, mergeSettings, unique, type OnReplace, type Settings } from "./render-profile-settings.mts";
import { readRetiredHomeEntries, retireHookCommands, unwireMovedHooks, userHomeNow } from "./retired-hooks.mts";
import { errorMessage } from "./shape.mts";
import { keptHookLines } from "./uncoordinated-hooks.mts";

interface LocalInferenceConfig {
  backends?: Record<string, unknown>;
  profiles?: Record<string, unknown>;
  installedProfile?: string;
  [key: string]: unknown;
}

export function mergeLocalInferenceConfig(
  profile: string, source: LocalInferenceConfig, existing: LocalInferenceConfig = {},
): LocalInferenceConfig {
  if (!source.profiles || !source.profiles[profile]) {
    throw new Error(`Local-inference config has no '${profile}' profile`);
  }
  const sourceBackends = source.backends || {};
  const selected = source.profiles[profile];
  const profileBackends = selected && typeof selected === "object" && "backends" in selected
    && selected.backends && typeof selected.backends === "object" ? selected.backends : {};
  const neutralSource = Object.keys(sourceBackends).length === 0 && Object.keys(profileBackends).length === 0;
  return neutralSource && Object.keys(existing).length > 0 ? existing : { ...source, installedProfile: profile };
}

// The files are repo-owned or host-owned JSON whose shape the caller asserts;
// `optional` turns an absent file (or the `-` placeholder) into an empty object.
function readJson<T>(file: string, optional = false): T {
  if (optional && (!file || file === "-" || !fs.existsSync(file))) return {} as T;
  try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; }
  catch { throw new Error("Cannot read required JSON configuration."); }
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, file);
}

export function renderSettings(args: string[], platform: string = process.platform): void {
  const [profile, workspace, credentialsRoot, claudeHome, sourceUserFile, sourceProjectFile,
    existingUserFile, existingProjectFile, outputUserFile, outputProjectFile] = args;
  if (!["win", "mac"].includes(profile) || !outputProjectFile) {
    throw new Error("settings usage: <win|mac> <workspace> <credentials> <claude-home> <source-user> <source-project> <existing-user|-> <existing-project|-> <output-user> <output-project>");
  }
  const sourceUser = substituteTemplatePaths(readJson<Settings>(sourceUserFile), profile, workspace, credentialsRoot, claudeHome);
  const sourceProject = substituteTemplatePaths(readJson<Settings>(sourceProjectFile), profile, workspace, credentialsRoot, claudeHome);
  const retired = retireCentralBrainHooks(readJson<Settings>(existingUserFile, true));
  if (retired.removed) console.error(`central-brain: removed ${retired.removed} retired hook command(s) from settings.json`);
  // Issue #252. Legacy wiring of a script retired.txt parks, and a managed hook
  // wired at an event the template no longer uses (#254). The lines go to
  // stdout, which install.sh shows and drift-check.sh discards.
  const retiredScripts = readRetiredHomeEntries();
  // Both passes resolve ~ and $HOME through the same home within one render.
  const userHome = userHomeNow();
  const unwire = (settings: Settings, source: Settings): Settings => {
    const result = retireHookCommands(settings, retiredScripts, claudeHome, userHome);
    for (const item of result.removed) console.log(`retire: unwire ${item.event} ${item.command}`);
    const moved = unwireMovedHooks(result.settings, source, claudeHome, userHome);
    for (const item of moved.removed) {
      console.log(`hooks: unwire ${item.event} ${item.command} (managed under ${item.managedAt.join(", ")})`);
    }
    return moved.settings;
  };
  const existingUser = unwire(retired.settings, sourceUser);
  const existingProject = unwire(readJson<Settings>(existingProjectFile, true), sourceProject);
  // Issue #568. Event, matcher and main come from the template group; nothing operator-written is printed.
  const replace: OnReplace = (event, matcher, main) =>
    console.log(`hooks: replace ${event}${matcher ? ` [${matcher}]` : ""} hooks/${main}`);
  const registryFile = path.join(claudeHome, "plugins", "installed_plugins.json");
  const installed = fs.existsSync(registryFile) && retiredCodexRegistered(readJson(registryFile));
  const user = retireCodexPlugin(mergeSettings(sourceUser, existingUser, replace), installed);
  const project = retireCodexPlugin(mergeSettings(sourceProject, existingProject, replace));
  filterManagedDisallowedPermissions(user);
  filterManagedDisallowedPermissions(project);
  if (profile === "mac") {
    filterMacPermissions(user);
    filterMacPermissions(project);
  }
  project.permissions = project.permissions || {};
  project.permissions.additionalDirectories = unique(project.permissions.additionalDirectories || []);
  // OP-754. Der Credentials-Root wird in die Session-Umgebung gehoben, damit
  // verwaltete Skripte ihn aus `$KHEREP_CREDENTIALS_ROOT` aufloesen statt ihn als
  // Literal zu fuehren. Der Wert kommt aus dem Aufruf (install.sh), nicht aus
  // dieser Datei - sonst stuende der bewachte Pfad hier im Quelltext.
  // Der Wert MUSS bash-sichtbar sein: fuehrender Slash, keine Backslashes.
  // `kherep_validate_shell_path` (profile.sh) bricht sonst fail-closed ab, und
  // weil die Harness diesen env-Block in jeden Tool-Aufruf injiziert, wuerde ein
  // falscher Wert install.sh und drift-check.sh gleichermassen lahmlegen - der
  // Installer koennte sich dann nicht einmal mehr selbst reparieren.
  //
  // install.sh uebergibt die Bash-Form, aber MSYS wandelt Argumente an node.exe
  // in die Laufwerksform um (/d/x wird zu D:/x). Der Renderer sieht die
  // Bash-Form also nie und muss zurueckwandeln.
  //
  // Issue #75. Ausnahme ist der Workspace auf einem Windows-Host: dort steht
  // er in nativer Form (D:/x), weil Node-Werkzeuge /d/x zu D:\d\x aufloesen.
  // Die Bash-Skripte wandeln ihn vor der Pruefung zurueck (kherep_shell_path).
  user.env = {
    ...(user.env || {}),
    KHEREP_WORKSPACE: workspaceEnvPath(profile, workspace, platform),
    KHEREP_CREDENTIALS_ROOT: toBashPath(credentialsRoot),
  };
  // Issue #525. Each kept hooks/ command outside the entry makes live-hook-integrity.mts
  // refuse repairs and write no heartbeat; judged by its own rule. stdout: install.sh shows, drift-check.sh drops.
  for (const line of keptHookLines(user, claudeHome)) console.log(line);
  writeJson(outputUserFile, user);
  writeJson(outputProjectFile, project);
}

export function renderLocalInference(args: string[]): void {
  const [profile, sourceFile, existingFile, outputFile] = args;
  if (!["win", "mac"].includes(profile) || !outputFile) {
    throw new Error("local-inference usage: <win|mac> <source> <existing|-> <output>");
  }
  const source = readJson<LocalInferenceConfig>(sourceFile);
  const existing = readJson<LocalInferenceConfig>(existingFile, true);
  writeJson(outputFile, mergeLocalInferenceConfig(profile, source, existing));
}

// Issue #436. CLAUDE.md and ROUTING.md with this host's intercom command; the
// rendered copy keeps the source's mode, and install.sh installs it.
export function renderIntercomFile(args: string[]): void {
  const [sourceFile, outputFile] = args;
  if (!sourceFile || !outputFile) throw new Error("intercom usage: <source> <output>");
  const rendered = renderIntercom(fs.readFileSync(sourceFile, "utf8"), intercomValues());
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  fs.writeFileSync(outputFile, rendered, { mode: fs.statSync(sourceFile).mode & 0o777 });
}

// Issue #436. The reverse, for capture.sh: a live CLAUDE.md or ROUTING.md back
// to the shared source form, without this host's config root or node name.
export function captureIntercomFile(args: string[]): void {
  const [liveFile, outputFile] = args;
  if (!liveFile || !outputFile) throw new Error("intercom-capture usage: <live> <output>");
  const captured = captureIntercom(fs.readFileSync(liveFile, "utf8"), intercomValues());
  fs.writeFileSync(outputFile, captured, { mode: fs.statSync(liveFile).mode & 0o777 });
}

function main(argv: string[]): void {
  const [mode, ...args] = argv;
  if (mode === "settings") renderSettings(args);
  else if (mode === "local-inference") renderLocalInference(args);
  else if (mode === "intercom") renderIntercomFile(args);
  else if (mode === "intercom-capture") captureIntercomFile(args);
  else throw new Error("mode must be settings, local-inference, intercom or intercom-capture");
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
  try { main(process.argv.slice(2)); }
  catch (error) { console.error(`FATAL: profile render failed: ${errorMessage(error)}`); process.exit(1); }
}
