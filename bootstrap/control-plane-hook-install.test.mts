// Issue #31, step 3b, and issue #592. The installer wires the control-plane
// hooks into the user settings. Every command names the stable entry point
// <CLAUDE_HOME>/kherep/control-plane/claude-control-plane-hook.mts and the hook
// by name; the pointer beside it, source.json, names the checkout the installer
// ran from, and the entry runs that checkout's hook. No command names the
// checkout, so a move or an install from another root leaves settings.json as
// it is. These tests render, install, drift-check and capture against
// throwaway homes only.
//
// Every run builds its environment without the host's KHEREP_* variables and
// points GIT_CONFIG_SYSTEM and GIT_CONFIG_GLOBAL at fixture files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { KHEREP_REPO, substituteTemplatePaths } from "./render-profile-paths.mts";

const HERE = import.meta.dirname;
const HOOK = "modules/control-plane/node/deliver-hook.mts";
const WAKE = "modules/control-plane/node/wake-hook.mts";
const ATTRIBUTION = "modules/control-plane/node/attribution-hook.mts";
const ENTRY = "kherep/control-plane/claude-control-plane-hook.mts";
// PostToolUse (issue #388) delivers inside a running turn, from the all-tools group.
const EVENTS = ["UserPromptSubmit", "Stop", "StopFailure", "PostToolUse"];
// The events the wake listener is armed at, after the delivery hook where the
// event has one. SessionStart (issue #97) has none: the listener ends its group.
const WAKE_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];
const forward = (value: string): string => value.replace(/\\/g, "/");
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  forward(value).replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);
// The path form of an install before #592.
const hookCommand = (repo: string, hook = HOOK): string => `node "${repo}/${hook}"`;
type Hook = { command: string; [field: string]: unknown };
type HookGroups = { hooks: Record<string, { matcher?: string; hooks: Hook[] }[]> };
const commandsOf = (value: HookGroups, event: string): string[] => value.hooks[event].flatMap((group) => group.hooks.map((h) => h.command));
// The delivery hook ends each event's last group, except where the wake
// listener follows it; on PostToolUse it ends the all-tools group.
const deliverGroup = (value: HookGroups, event: string) =>
  event === "PostToolUse" ? value.hooks[event].find((group) => !group.matcher) : value.hooks[event].at(-1);
const deliverCommand = (value: HookGroups, event: string) =>
  deliverGroup(value, event)?.hooks.at(WAKE_EVENTS.includes(event) ? -2 : -1)?.command;
const wakeEntry = (value: HookGroups, event: string) => value.hooks[event].at(-1)?.hooks.at(-1);
// Issue #325. The PostToolUse group that records gh pr create.
const attributionGroup = (value: HookGroups) => value.hooks.PostToolUse.find((group) => group.matcher === "Bash|PowerShell");
// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

// The arguments of a stable command whose entry is the one under `home`, else undefined.
const STABLE = /^node "(?<home>[^"]+)\/kherep\/control-plane\/claude-control-plane-hook\.mts" (?<args>[^"]+)$/;
function stableArgs(command: string | undefined, home: string): string | undefined {
  const match = STABLE.exec(command ?? "");
  return match && fs.realpathSync(match.groups!.home) === fs.realpathSync(home) ? match.groups!.args : undefined;
}
const controlPlane = (command: string): boolean => /claude-control-plane-hook|[\\/]modules[\\/]control-plane[\\/]node[\\/]/.test(command);
const wakeHook = (repo: string, seconds: number) =>
  ({ type: "command", command: `${hookCommand(repo, WAKE)} --timeout ${seconds}`, asyncRewake: true, timeout: seconds });

function hostEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("KHEREP_")));
}

test("__KHEREP_REPO__ renders the checkout with forward slashes on a Windows drive path", { skip: process.platform !== "win32" }, () => {
  const rendered = substituteTemplatePaths(`node "__KHEREP_REPO__/${HOOK}"`, "win", "D:\\Work", "D:\\creds", "D:\\home\\.claude", "D:\\Tools\\Kherep");
  assert.equal(rendered, hookCommand("D:/Tools/Kherep"));
});

test("__KHEREP_REPO__ defaults to the checkout the renderer runs from", () => {
  const rendered = substituteTemplatePaths("__KHEREP_REPO__", "mac", "/w", "/c", "/h");
  assert.equal(rendered, substituteTemplatePaths("__KHEREP_REPO__", "mac", "/w", "/c", "/h", KHEREP_REPO));
  assert.equal(path.resolve(HERE, ".."), KHEREP_REPO);
});

interface Fixture { root: string; home: string; claude: string; ws: string; config: string }

function fixture(t: TestContext): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-issue31-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f = { root, home: path.join(root, "home"), claude: path.join(root, "home", ".claude"),
    ws: path.join(root, "Kherep"), config: path.join(root, "no-node") };
  for (const dir of [f.claude, f.ws]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(f.claude, "settings.json"), "{}\n");
  return f;
}

// The profile bootstrap/profile.sh resolves on this host: mac on Darwin, win
// everywhere else. The macOS CI job therefore installs with the mac profile (#51).
const PROFILE = process.platform === "darwin" ? "mac" : "win";

function bash(args: string[], f: Fixture, input?: string) {
  const env = {
    ...hostEnv(), HOME: slash(f.home), CLAUDE_HOME: slash(f.claude), KHEREP_PROFILE: PROFILE, KHEREP_WORKSPACE: slash(f.ws),
    GIT_CONFIG_SYSTEM: path.join(f.root, "gitconfig-system"), GIT_CONFIG_GLOBAL: path.join(f.root, "gitconfig-global"),
    KHEREP_INSTALL_SKIP_GITCONFIG: "1", KHEREP_INSTALL_SKIP_KNOWLEDGE_SPACE: "1", KHEREP_INSTALL_SKIP_ATL_CREDENTIAL: "1",
    SKIP_SECRETS: "1", SKIP_DEPS: "1", KHEREP_CONFIG_DIR: f.config,
  };
  return spawnSync("bash", args, { encoding: "utf8", env, input, timeout: 240_000 });
}

test("install wires the hooks through the stable entry, points it at the checkout, drift-check is clean and capture folds the home", (t) => {
  const f = fixture(t);
  const install = bash([slash(path.join(HERE, "install.sh"))], f);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);

  const text = fs.readFileSync(path.join(f.claude, "settings.json"), "utf8");
  assert.ok(!text.includes("__KHEREP_REPO__"), "unresolved __KHEREP_REPO__ in the rendered settings");
  assert.ok(!text.includes(forward(KHEREP_REPO)) && !text.includes(JSON.stringify(KHEREP_REPO).slice(1, -1)), "settings.json names the checkout");
  const settings = JSON.parse(text) as HookGroups;
  for (const event of EVENTS) {
    const commands = commandsOf(settings, event).filter(controlPlane);
    assert.equal(commands.filter((command) => stableArgs(command, f.claude) === "deliver").length, 1, `${event}: ${commands.join(" | ")}`);
    assert.equal(commands.filter((command) => stableArgs(command, f.claude) === "wake --timeout 90000").length, WAKE_EVENTS.includes(event) ? 1 : 0, event);
    assert.equal(stableArgs(deliverCommand(settings, event), f.claude), "deliver", `${event} does not end with the delivery hook`);
  }
  for (const event of WAKE_EVENTS) {
    const { command, ...fields } = wakeEntry(settings, event)!;
    assert.equal(stableArgs(command, f.claude), "wake --timeout 90000", event);
    assert.deepEqual(fields, { type: "command", asyncRewake: true, timeout: 90000 }, event);
  }
  assert.deepEqual(attributionGroup(settings)!.hooks.map((hook) => stableArgs(hook.command, f.claude)), ["attribution"]);
  const all = Object.keys(settings.hooks).flatMap((event) => commandsOf(settings, event)).filter(controlPlane);
  assert.equal(all.length, 9, all.join("\n"));
  const expansion = settings.hooks.UserPromptExpansion;
  assert.equal(expansion.length, 1);
  assert.equal(expansion[0].matcher, "^(kherep-slot|kherep-set-lead)$");
  assert.deepEqual(expansion[0].hooks.map(({ command, ...fields }) => ({ args: stableArgs(command, f.claude), ...fields })),
    [{ args: "deliver", type: "command", timeout: 30 }]);
  for (const name of ["kherep-slot", "kherep-set-lead"]) {
    assert.ok(fs.readFileSync(path.join(f.claude, "skills", name, "SKILL.md"))
      .equals(fs.readFileSync(path.join(HERE, "..", "claude", "skills", name, "SKILL.md"))), `${name} installed bytes`);
  }
  assert.ok(all.every((command) => stableArgs(command, f.claude) !== undefined), all.join("\n"));

  // The entry is a manifest file; the pointer names the checkout this installer ran from.
  assert.ok(fs.readFileSync(path.join(f.claude, ENTRY)).equals(fs.readFileSync(path.join(HERE, "..", "claude", ENTRY))));
  const pointer = JSON.parse(fs.readFileSync(path.join(f.claude, "kherep", "control-plane", "source.json"), "utf8"));
  assert.equal(pointer.version, 1);
  assert.equal(fs.realpathSync(pointer.root), fs.realpathSync(KHEREP_REPO));

  // Run as stored, through bash like Claude Code: inert without an enrolled node.
  const payload = (event: string) => JSON.stringify({ session_id: "s", hook_event_name: event, tool_name: "Bash",
    tool_input: { command: "gh pr create --fill" }, cwd: f.ws });
  for (const event of Object.keys(settings.hooks)) {
    for (const command of commandsOf(settings, event).filter(controlPlane)) {
      const run = bash(["-c", command], f, payload(event));
      if (event === "UserPromptExpansion") {
        assert.deepEqual([run.status, JSON.parse(run.stdout), withoutTypeStrippingWarning(run.stderr)],
          [0, { hookSpecificOutput: { hookEventName: "UserPromptExpansion", additionalContext: "Kherep rejected the slot command as invalid." } }, ""], `${event} ${command}: ${run.stderr}`);
      } else {
        assert.deepEqual([run.status, run.stdout, withoutTypeStrippingWarning(run.stderr)], [0, "", ""], `${event} ${command}: ${run.stderr}`);
      }
    }
  }
  // The entry runs the hook in its own process as the main module: the hook's own argument check answers.
  assert.match(bash(["-c", `${deliverCommand(settings, "Stop")} --runtime bogus`], f, payload("Stop")).stderr, /kherep deliver-hook: unknown --runtime/);

  const drift = bash([slash(path.join(HERE, "drift-check.sh"))], f);
  assert.equal(drift.status, 0, `${drift.stdout}\n${drift.stderr}`);
  assert.match(drift.stdout, /^ok\s+kherep\/control-plane\/source\.json \(checkout (?:[0-9a-f]{7}|unverified)\)$/m, drift.stdout);

  // capture.sh writes into the repository's claude/ directory, so its settings
  // step, portable_paths from lib.sh, runs here on a copy. It folds the Claude
  // home to ~/.claude, as for every other command that names the home.
  const copy = path.join(f.root, "captured.json");
  fs.copyFileSync(path.join(f.claude, "settings.json"), copy);
  const capture = bash(["-c", `. "${slash(path.join(HERE, "lib.sh"))}" && portable_paths "${slash(copy)}"`], f);
  assert.equal(capture.status, 0, capture.stderr);
  const captured = JSON.parse(fs.readFileSync(copy, "utf8")) as HookGroups;
  const source = JSON.parse(fs.readFileSync(path.join(HERE, "..", "claude", "settings.user.json"), "utf8")) as HookGroups;
  const folded = (command: string | undefined) => command?.replace("__KHEREP_CLAUDE_HOME__", "~/.claude");
  for (const event of EVENTS) assert.equal(deliverCommand(captured, event), folded(deliverCommand(source, event)), event);
  assert.equal(commandsOf(captured, "UserPromptExpansion")[0], folded(commandsOf(source, "UserPromptExpansion")[0]));
  for (const event of WAKE_EVENTS) assert.equal(wakeEntry(captured, event)?.command, folded(wakeEntry(source, event)?.command), event);
  // The listener joins SessionStart last; the hooks before it keep their order.
  const scripts = (value: HookGroups) => value.hooks.SessionStart.flatMap((group) => group.hooks)
    .map((hook) => /\/([^/"]+)"( wake)?/.exec(hook.command)?.slice(1).join(""));
  assert.deepEqual(scripts(settings), scripts(source));
  assert.equal(scripts(settings).at(-1), "claude-control-plane-hook.mts wake");

  // Removing the entries by hand, as docs/INSTALLATION.md describes, is drift.
  for (const event of EVENTS) deliverGroup(settings, event)!.hooks.pop();
  fs.writeFileSync(path.join(f.claude, "settings.json"), `${JSON.stringify(settings, null, 2)}\n`);
  const removed = bash([slash(path.join(HERE, "drift-check.sh"))], f);
  assert.equal(removed.status, 1, `${removed.stdout}\n${removed.stderr}`);
});

test("an upgrade replaces the path-form wake entries of an older install with a changed timeout by the stable ones", (t) => {
  const f = fixture(t);
  const repo = forward(KHEREP_REPO);
  const settingsFile = path.join(f.claude, "settings.json");
  // An earlier install: the wake entries carry another timeout, Stop's in the form without the argument.
  // Next to them, hooks of the operator that the upgrade must keep as they are.
  const own = { type: "command", command: 'node "/opt/own/stop-note.mts" --timeout 43200', timeout: 43200 };
  const ownGroup = { matcher: "Bash", hooks: [{ type: "command", command: "node /opt/own/bash-note.mts" }] };
  const older = { hooks: {
    UserPromptSubmit: [{ matcher: "", hooks: [wakeHook(repo, 43200)] }, ownGroup],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: hookCommand(repo, WAKE), asyncRewake: true, timeout: 43200 }, own] }],
  } };
  fs.writeFileSync(settingsFile, `${JSON.stringify(older, null, 2)}\n`);
  const install = bash([slash(path.join(HERE, "install.sh"))], f);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const settings = JSON.parse(fs.readFileSync(settingsFile, "utf8")) as HookGroups;
  for (const event of WAKE_EVENTS) {
    const wakes = settings.hooks[event].flatMap((group) => group.hooks).filter((hook) => hook.command.includes("wake"));
    assert.deepEqual(wakes.map((hook) => [stableArgs(hook.command, f.claude), hook.timeout, hook.asyncRewake]), [["wake --timeout 90000", 90000, true]], event);
  }
  assert.deepEqual(settings.hooks.UserPromptSubmit.filter((group) => group.matcher === "Bash"), [ownGroup]);
  assert.deepEqual(settings.hooks.Stop.at(-1)!.hooks.filter((hook) => hook.command.includes("/opt/own/")), [own]);
});

// Issue #590. Installs from two roots (the checkout and a service source pin)
// left every control-plane entry once per root, the state a node measured. One
// install collapses both path-form sets to the one stable set (#592), and the
// file with both sets fails drift-check with a line that names the script and event.
test("an install collapses the path-form entries of two roots to one stable set; a file with both sets fails drift-check", (t) => {
  const f = fixture(t);
  const settingsFile = path.join(f.claude, "settings.json");
  const other = slash(path.join(f.root, "control-plane", "service", "source-pins", "0123456789abcdef0123456789abcdef01234567"));
  const repo = forward(KHEREP_REPO);
  const own = { type: "command", command: 'node "/opt/own/stop-note.mts"' };
  const deliver = (root: string) => ({ type: "command", command: hookCommand(root) });
  const fromRoot = (root: string): Record<string, { matcher: string; hooks: { type: string; command: string }[] }[]> => ({
    UserPromptSubmit: [{ matcher: "", hooks: [deliver(root), wakeHook(root, 86400)] }],
    Stop: [{ matcher: "", hooks: [own, deliver(root), wakeHook(root, 86400)] }],
    StopFailure: [{ matcher: "", hooks: [deliver(root)] }],
    PostToolUse: [{ matcher: "", hooks: [deliver(root)] }, { matcher: "Bash|PowerShell", hooks: [{ type: "command", command: hookCommand(root, ATTRIBUTION) }] }],
    SessionStart: [{ matcher: "", hooks: [wakeHook(root, 86400)] }],
  });
  const pinned = fromRoot(other);
  const bothRoots = `${JSON.stringify({ hooks: Object.fromEntries(Object.entries(fromRoot(repo)).map(([event, groups]) => [event,
    groups.map((group, i) => ({ ...group, hooks: [...group.hooks, ...pinned[event][i].hooks.filter((hook) => hook !== own)] }))])) }, null, 2)}\n`;
  fs.writeFileSync(settingsFile, bothRoots);
  const install = bash([slash(path.join(HERE, "install.sh"))], f);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  const text = fs.readFileSync(settingsFile, "utf8");
  assert.ok(!text.includes(other) && !text.includes(repo), "a path-form entry survived the install");
  const settings = JSON.parse(text) as HookGroups;
  const wake = "wake --timeout 90000";
  const stableSet: Record<string, string[]> = { UserPromptSubmit: ["deliver", wake], Stop: ["deliver", wake], StopFailure: ["deliver"],
    PostToolUse: ["deliver", "attribution"], SessionStart: [wake] };
  for (const [event, expected] of Object.entries(stableSet)) {
    assert.deepEqual(commandsOf(settings, event).filter(controlPlane).map((c) => stableArgs(c, f.claude)), expected, event);
  }
  assert.deepEqual(attributionGroup(settings)?.hooks.map((hook) => stableArgs(hook.command, f.claude)), ["attribution"]);
  assert.deepEqual(settings.hooks.Stop.flatMap((group) => group.hooks).filter((hook) => hook.command.includes("/opt/own/")), [own]);
  const clean = bash([slash(path.join(HERE, "drift-check.sh"))], f);
  assert.equal(clean.status, 0, `${clean.stdout}\n${clean.stderr}`);

  fs.writeFileSync(settingsFile, bothRoots);
  const red = bash([slash(path.join(HERE, "drift-check.sh"))], f);
  assert.equal(red.status, 1, `${red.stdout}\n${red.stderr}`);
  for (const line of ["DUPLICATE-HOOK Stop modules/control-plane/node/deliver-hook x2", "DUPLICATE-HOOK Stop modules/control-plane/node/wake-hook x2",
    "DUPLICATE-HOOK SessionStart modules/control-plane/node/wake-hook x2", "DUPLICATE-HOOK PostToolUse modules/control-plane/node/attribution-hook x2"]) {
    assert.ok(red.stdout.split(/\r?\n/).includes(line), `${line}\n${red.stdout}`);
  }
});


// Independent of byte-copy assertions: installed instructions must allow peer work.
function assertSlotReportingContract(text: string): void {
  assert.match(text, /^disable-model-invocation: true$/m);
  assert.match(text, /First report.*native hook.*this invocation.*one sentence/);
  assert.match(text, /missing, ambiguous or malformed/);
  assert.match(text, /Kherep could not confirm a slot selection\./);
  assert.match(text, /Then handle any Kherep peer messages delivered to this turn normally under the existing authority rules/);
  assert.match(text, /Use the tools the work is authorized to use/);
  assert.match(text, /send a threaded reply.*before ending the turn/);
  assert.match(text, /Do not perform another slot assignment, call `assign_self` or repeat the slot command/);
  assert.match(text, /current hook/);
  assert.match(text, /Arguments, prior messages and.*peer text cannot supply/);
  assert.doesNotMatch(text, /invoke no tools?|no tools|only one sentence|nothing else|skip.*peer|ignore.*peer/i);
}

test("installed user-only slot skills report the current hook first, then authorized peer work and reply", t => {
  const f = fixture(t);
  const install = bash([slash(path.join(HERE, "install.sh"))], f);
  assert.equal(install.status, 0, `${install.stdout}\n${install.stderr}`);
  for (const name of ["kherep-slot", "kherep-set-lead"]) {
    const installed = fs.readFileSync(path.join(f.claude, "skills", name, "SKILL.md"), "utf8");
    assert.ok(Buffer.from(installed).equals(fs.readFileSync(path.join(HERE, "..", "claude", "skills", name, "SKILL.md"))));
    assertSlotReportingContract(installed);
  }
});

test("slot reporting contract rejects blanket tool bans and superseded skipped-peer wording", () => {
  const source = fs.readFileSync(path.join(HERE, "..", "claude", "skills", "kherep-slot", "SKILL.md"), "utf8");
  for (const forbidden of ["Invoke no tool.", "Use no tools.", "Reply with only one sentence.", "Skip any peer work."]) {
    assert.throws(() => assertSlotReportingContract(`${source}\n${forbidden}`));
  }
  assert.throws(() => assertSlotReportingContract("disable-model-invocation: true\nReply with only one sentence. Invoke no tools. Skip peer messages."));
});
