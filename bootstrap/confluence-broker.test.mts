// Issue #13. claude-obs takes its broker command from confluence.json and never
// composes one. The installer writes that command through the substitution that
// renders the permission rules, so the stored command and the allow rules
// cannot drift apart. These tests render both for the same profile and
// workspace and compare them byte for byte, then pin the re-install behaviour.
//
// On Windows the command names the workspace with forward slashes: Git Bash
// consumes the backslashes of a native path, so node D:\ws/tools/x.mts reaches
// node as D:ws/tools/x.mts, relative to the current directory.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";

import { parseArgs } from "./confluence-space.mts";
import { resolveProfilePath } from "./render-profile-paths.mts";
import { renderSettings } from "./render-profile.mts";
import type { Settings } from "./render-profile-settings.mts";

// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const HERE = import.meta.dirname;
const REPO = path.join(HERE, "..");
// The verbs claude/agents/claude-obs.md runs through the stored command.
const OBS_VERBS = ["related", "validate", "create", "stitch", "children"];
const ALL_VERBS = ["get", "related", "validate", "search", "create", "labels", "stitch", "children"];
const WIN_WORKSPACE = "C:\\Users\\example\\Kherep";
const HOSTS = [
  { profile: "win", workspace: WIN_WORKSPACE },
  { profile: "mac", workspace: "/Users/example/Kherep" },
];
// The command form: the resolved workspace with forward slashes. On a Windows
// host that is C:/Users/example/Kherep.
const commandForm = (profile: string, workspace: string): string =>
  resolveProfilePath(profile, workspace).replace(/\\/g, "/");

function tempRoot(t: TestContext): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-broker-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// The settings pair exactly as install.sh renders it, optionally over an
// existing user settings file.
function render(root: string, profile: string, workspace: string, existingUser = "-",
  claudeHome = path.join(root, "claude-home")): { user: Settings; project: Settings } {
  const user = path.join(root, `settings-${profile}.json`);
  const project = path.join(root, `settings-${profile}.local.json`);
  renderSettings([profile, workspace, path.join(root, "credentials"), claudeHome,
    path.join(REPO, "claude", "settings.user.json"), path.join(REPO, "claude", "settings.project.json"),
    existingUser, "-", user, project]);
  const read = (file: string) => JSON.parse(fs.readFileSync(file, "utf8")) as Settings;
  return { user: read(user), project: read(project) };
}

// The Claude allow rules that name the broker.
function renderedBrokerRules(root: string, profile: string, workspace: string): string[] {
  const allow = render(root, profile, workspace).user.permissions?.allow ?? [];
  return allow.filter((rule) => rule.includes("atl-confluence-ccoder.mts"));
}

interface SpaceFixture {
  target: string;
  broker: string;
  run: (profile: string, workspace: string) => void;
  brokerOnly: (profile: string, workspace: string) => ReturnType<typeof spawnSync>;
}

// confluence-space.mts with the arguments install.sh passes, against a stub
// broker and a stub placement read that always fails, so a run keeps the
// stored nodes: nothing leaves the host.
function spaceFixture(root: string): SpaceFixture {
  const bootstrap = path.join(root, "repo", "bootstrap");
  const brokers = path.join(root, "repo", "modules", "atl-jira-brokers");
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.mkdirSync(brokers, { recursive: true });
  for (const file of ["confluence-space.mts", "render-profile-paths.mts", "shape.mts"]) {
    fs.copyFileSync(path.join(HERE, file), path.join(bootstrap, file));
  }
  fs.writeFileSync(path.join(bootstrap, "confluence-nodes.mts"), [
    'export const PLACEMENT_NODES = ["Kherep"];',
    'export async function readSpacePages() { throw new Error("space pages unreadable in this test"); }',
    'export function resolvePlacement() { return { nodes: { Kherep: "stub-parent" }, missing: [] }; }',
  ].join("\n"));
  const broker = path.join(brokers, "atl-confluence-ccoder.mts");
  fs.writeFileSync(broker, 'process.stdout.write("id: space-1\\nkey: KB\\nname: Resolved Name\\n");\n');
  const target = path.join(root, "claude-home", "kherep", "confluence.json");
  const cli = (extra: string[], spaceKey?: string) => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.KHEREP_CONFLUENCE_SPACE_KEY;
    if (spaceKey) env.KHEREP_CONFLUENCE_SPACE_KEY = spaceKey;
    return spawnSync(process.execPath, [path.join(bootstrap, "confluence-space.mts"),
      "--out", target, "--runtime", "claude", ...extra], { encoding: "utf8", env });
  };
  const run = (profile: string, workspace: string): void => {
    const result = cli(["--profile", profile, "--workspace", workspace], "KB");
    assert.equal(result.status, 0, result.stderr);
  };
  // No space key and no terminal: a broker-only run that reached for the
  // space would fail on the prompt.
  const brokerOnly = (profile: string, workspace: string) =>
    cli(["--broker-only", "--profile", profile, "--workspace", workspace]);
  return { target, broker, run, brokerOnly };
}

const stored = (file: string): Record<string, unknown> => JSON.parse(fs.readFileSync(file, "utf8"));

test("the stored broker command is the prefix of every rendered broker allow rule", (t) => {
  for (const { profile, workspace } of HOSTS) {
    const root = tempRoot(t);
    const space = spaceFixture(root);
    space.run(profile, workspace);
    const broker = stored(space.target).broker;
    assert.equal(broker, `node ${commandForm(profile, workspace)}/tools/atl-confluence-ccoder.mts`, profile);
    assert.doesNotMatch(String(broker), /\\|<workspace>|__KHEREP_/, profile);
    if (profile === "win" && process.platform === "win32") {
      assert.equal(broker, "node C:/Users/example/Kherep/tools/atl-confluence-ccoder.mts");
    }

    const rules = renderedBrokerRules(root, profile, workspace);
    assert.deepEqual(rules, ALL_VERBS.map((verb) => `Bash(${broker} ${verb}:*)`), `${profile}: same verbs, same file`);
    for (const verb of OBS_VERBS) assert.ok(rules.includes(`Bash(${broker} ${verb}:*)`), `${profile}: ${verb}`);
  }
});

// Only the Bash command rules take the forward-slash form. The workspace
// directory grant goes through the same substitution and keeps the native path.
test("the workspace directory grant keeps its native form", (t) => {
  for (const { profile, workspace } of HOSTS) {
    const dirs = render(tempRoot(t), profile, workspace).project.permissions?.additionalDirectories ?? [];
    assert.ok(dirs.includes(resolveProfilePath(profile, workspace)), `${profile}: ${JSON.stringify(dirs)}`);
  }
});

// A host installed before the switch carries the backslash rules. They are
// dropped in the merge rather than kept beside the new ones; nothing else is.
test("a re-render replaces the old backslash broker rules and keeps every unrelated rule", (t) => {
  const root = tempRoot(t);
  const native = resolveProfilePath("win", WIN_WORKSPACE);
  const obsolete = ALL_VERBS.map((verb) => `Bash(node ${native}/tools/atl-confluence-ccoder.mts ${verb}:*)`);
  assert.ok(obsolete.every((rule) => rule.includes("\\")), "the fixture must carry the backslash form");
  const unrelated = [
    "Bash(npm run test:*)",
    `Read(${native}/**)`,
    `Bash(node ${native}/tools/operator-helper.mts run:*)`,
    "Bash(node D:\\Elsewhere/tools/atl-confluence-ccoder.mts get:*)",
  ];
  const existing = path.join(root, "existing-settings.json");
  fs.writeFileSync(existing, JSON.stringify({ permissions: { allow: [...obsolete, ...unrelated] } }));

  const allow = render(root, "win", WIN_WORKSPACE, existing).user.permissions?.allow ?? [];
  const broker = `node ${commandForm("win", WIN_WORKSPACE)}/tools/atl-confluence-ccoder.mts`;
  assert.deepEqual(allow.filter((rule) => rule.startsWith(`Bash(${broker} `)),
    ALL_VERBS.map((verb) => `Bash(${broker} ${verb}:*)`));
  for (const rule of obsolete) assert.ok(!allow.includes(rule), `still allowed: ${rule}`);
  for (const rule of unrelated) assert.ok(allow.includes(rule), `lost: ${rule}`);
  // The one non-broker template rule is the confluence.json Read rule (issue #363).
  assert.equal(allow.length, obsolete.length + unrelated.length + 1, "the allowlist does not grow");
});

// Issue #363. claude-obs reads confluence.json with the Read tool. The one Read
// rule names that file in the absolute form `//<path>`, and Claude Code matches
// a Windows path in POSIX form (C:\Users\a is /c/Users/a).
test("the one Read rule renders to the absolute confluence.json path on every host", (t) => {
  const homes: Record<string, string> = { win: "C:\\Users\\example\\.claude", mac: "/Users/example/.claude" };
  for (const { profile, workspace } of HOSTS) {
    const allow = render(tempRoot(t), profile, workspace, "-", homes[profile]).user.permissions?.allow ?? [];
    const reads = allow.filter((rule) => rule.startsWith("Read("));
    assert.equal(reads.length, 1, `${profile}: ${JSON.stringify(reads)}`);
    assert.match(reads[0], /^Read\(\/\/[^\\*]*\/\.claude\/kherep\/confluence\.json\)$/, profile);
    if (profile === "mac") {
      assert.equal(reads[0], "Read(//Users/example/.claude/kherep/confluence.json)");
    }
    if (profile === "win" && process.platform === "win32") {
      assert.equal(reads[0], "Read(//c/Users/example/.claude/kherep/confluence.json)");
    }
  }
});

// The seeded values differ from everything the stubs return: the nodes survive
// only through the stored-nodes path (the placement read always fails here),
// and the unknown key only if the space step merges instead of rebuilding.
test("a re-install keeps stored nodes and unknown keys, and a broker-only run changes only broker", (t) => {
  const space = spaceFixture(tempRoot(t));
  fs.mkdirSync(path.dirname(space.target), { recursive: true });
  const seeded = {
    spaceKey: "KB", spaceId: "space-1", spaceName: "Seeded Name",
    nodes: { Kherep: "seeded-parent", Operations: "seeded-operations" }, operatorNote: "kept by every writer",
  };
  fs.writeFileSync(space.target, JSON.stringify(seeded));

  space.run("mac", "/Users/example/Kherep");
  const first = fs.readFileSync(space.target, "utf8");
  assert.deepEqual(stored(space.target), {
    ...seeded, spaceName: "Resolved Name", broker: "node /Users/example/Kherep/tools/atl-confluence-ccoder.mts",
  });
  space.run("mac", "/Users/example/Kherep");
  assert.equal(fs.readFileSync(space.target, "utf8"), first, "a second run changes nothing");

  // A broker call now fails the run, so broker-only must not make one.
  fs.writeFileSync(space.broker, "process.exit(9);\n");
  const result = space.brokerOnly("mac", "/Users/example/Moved");
  assert.equal(result.status, 0, String(result.stderr));
  const moved = stored(space.target);
  assert.equal(moved.broker, "node /Users/example/Moved/tools/atl-confluence-ccoder.mts");
  const unchanged = `${JSON.stringify({ ...moved, broker: JSON.parse(first).broker }, null, 2)}\n`;
  assert.equal(unchanged, first, "every key but broker is kept byte for byte, in place");
});

test("broker-only creates a missing file with broker alone and never overwrites an unreadable one", (t) => {
  const space = spaceFixture(tempRoot(t));
  const created = space.brokerOnly("win", WIN_WORKSPACE);
  assert.equal(created.status, 0, String(created.stderr));
  assert.deepEqual(stored(space.target), {
    broker: `node ${commandForm("win", WIN_WORKSPACE)}/tools/atl-confluence-ccoder.mts`,
  });

  fs.writeFileSync(space.target, "not json");
  const refused = space.brokerOnly("win", WIN_WORKSPACE);
  assert.notEqual(refused.status, 0);
  assert.equal(withoutTypeStrippingWarning(refused.stderr), "FATAL: Existing Confluence space configuration could not be read.\n");
  assert.equal(fs.readFileSync(space.target, "utf8"), "not json");
});

test("the Claude runtime cannot be configured without the broker inputs", () => {
  const base = ["--out", "target.json", "--runtime", "claude"];
  assert.throws(() => parseArgs(base), /--profile <win\|mac> and --workspace/);
  assert.throws(() => parseArgs([...base, "--profile", "mac"]), /--workspace/);
  assert.throws(() => parseArgs([...base, "--profile", "linux", "--workspace", "/w"]), /--profile <win\|mac>/);
  assert.equal(parseArgs(["--out", "target.json", "--runtime", "codex"]).broker, undefined);
  assert.throws(() => parseArgs(["--out", "target.json", "--runtime", "codex", "--broker-only"]), /Claude-only/);
});
