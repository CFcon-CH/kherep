import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { declareCopy } from "./coverage-copy-fixture.mts";

import {
  brokerPath,
  parseArgs,
  resolveSpace,
  selectSpaceKey,
  type BrokerIO,
} from "./confluence-space.mts";

// Some Node releases the engines range admits, 24.1.0 among them, print this
// warning when a child loads a .mts file. Only this exact pair of lines is
// dropped; any other stderr still fails the assertion.
const TYPE_STRIPPING_WARNING = new RegExp("^\\(node:\\d+\\) ExperimentalWarning: Type Stripping is an experimental "
  + "feature and might change at any time\\r?\\n\\(Use `node --trace-warnings \\.\\.\\.` to show where the warning was "
  + "created\\)\\r?\\n", "gm");
const withoutTypeStrippingWarning = (stderr: string | Buffer): string =>
  String(stderr).replace(TYPE_STRIPPING_WARNING, "");

const here = import.meta.dirname;
const repoRoot = path.join(here, "..");
const privateSpace = {
  id: "private-space-id",
  key: "PRIVATEKEY",
  name: "Private Space Name",
};
const privateBrokerDetail = "private broker execution detail";

function createCliFixture(): {
  root: string;
  script: string;
  broker: string;
  target: string;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-confluence-cli-"));
  const bootstrap = path.join(root, "bootstrap");
  const brokers = path.join(root, "modules", "atl-jira-brokers");
  const script = path.join(bootstrap, "confluence-space.mts");
  fs.mkdirSync(bootstrap, { recursive: true });
  fs.mkdirSync(brokers, { recursive: true });
  fs.copyFileSync(path.join(here, "confluence-space.mts"), script);
  declareCopy(path.join(here, "confluence-space.mts"), script);
  for (const file of ["render-profile-paths.mts", "shape.mts"]) {
    fs.copyFileSync(path.join(here, file), path.join(bootstrap, file));
    declareCopy(path.join(here, file), path.join(bootstrap, file));
  }
  fs.writeFileSync(path.join(bootstrap, "confluence-nodes.mts"), [
    'export const PLACEMENT_NODES = ["Kherep"];',
    'export async function readSpacePages(credential) {',
    '  if (credential !== "KHEREP_ATL_CRED_FILE_CODEX") throw new Error("wrong runtime");',
    '  if (process.env.KHEREP_TEST_NODE_READ_FAIL === "1") throw new Error("private node read detail");',
    '  return [];',
    '}',
    'export function resolvePlacement() {',
    '  return process.env.KHEREP_TEST_MISSING_NODE === "1"',
    '    ? { nodes: {}, missing: ["Kherep"] }',
    '    : { nodes: { Kherep: "parent-1" }, missing: [] };',
    '}',
  ].join("\n"));
  return {
    root,
    script,
    broker: path.join(brokers, "atl-confluence.mts"),
    target: path.join(root, "private-target.json"),
  };
}

function runCli(
  fixture: ReturnType<typeof createCliFixture>,
  options: {
    authorizeObservationPublishing?: boolean;
    existing?: string;
    spaceKey?: string;
    nodeReadFail?: boolean;
    missingNode?: boolean;
  } = {},
): ReturnType<typeof spawnSync> {
  const args = [
    fixture.script,
    "--out", fixture.target,
    "--runtime", "codex",
  ];
  if (options.existing) args.push("--existing", options.existing);
  if (options.authorizeObservationPublishing) {
    args.push("--authorize-observation-publishing");
  }
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: {
      ...process.env,
      KHEREP_CONFLUENCE_SPACE_KEY: options.spaceKey ?? privateSpace.key,
      KHEREP_TEST_NODE_READ_FAIL: options.nodeReadFail ? "1" : "0",
      KHEREP_TEST_MISSING_NODE: options.missingNode ? "1" : "0",
    },
  });
}

function assertNoPrivateFailureDetail(
  stderr: string,
  fixture: ReturnType<typeof createCliFixture>,
  extra: string[] = [],
): void {
  for (const detail of [
    privateSpace.key,
    privateSpace.id,
    privateSpace.name,
    fixture.target,
    fixture.broker,
    privateBrokerDetail,
    ...extra,
  ]) {
    assert.ok(!stderr.includes(detail), `stderr exposed private detail: ${detail}`);
  }
}

test("selects the runtime-specific Confluence broker", () => {
  assert.ok(brokerPath("codex").endsWith(path.join("modules", "atl-jira-brokers", "atl-confluence.mts")));
  assert.ok(brokerPath("claude").endsWith(path.join("modules", "atl-jira-brokers", "atl-confluence-ccoder.mts")));
});

test("parses the required runtime and optional legacy file", () => {
  assert.deepEqual(parseArgs(["--out", "target.json", "--runtime", "codex"]), {
    out: "target.json",
    runtime: "codex",
    existing: undefined,
    authorizeObservationPublishing: false,
  });
  assert.deepEqual(parseArgs([
    "--out", "target.json", "--runtime", "claude", "--existing", "legacy.json",
    "--authorize-observation-publishing", "--profile", "mac", "--workspace", "/w",
  ]), {
    out: "target.json",
    runtime: "claude",
    existing: "legacy.json",
    authorizeObservationPublishing: true,
    broker: "node /w/tools/atl-confluence-ccoder.mts",
  });
  assert.throws(() => parseArgs(["--out", "target.json"]), /claude or codex/);
  assert.throws(
    () => parseArgs(["--out", "target.json", "--runtime", "other"]),
    /claude or codex/,
  );
});

test("selects a space key from env, canonical target, legacy file, then prompt", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-confluence-space-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, "canonical.json");
  const existing = path.join(root, "legacy.json");
  fs.writeFileSync(target, JSON.stringify({ spaceKey: "TARGET" }));
  fs.writeFileSync(existing, JSON.stringify({ spaceKey: "LEGACY" }));

  assert.equal(
    selectSpaceKey({ target, existing }, { KHEREP_CONFLUENCE_SPACE_KEY: " ENV " }),
    "ENV",
  );
  assert.equal(selectSpaceKey({ target, existing }, {}), "TARGET");
  fs.rmSync(target);
  assert.equal(selectSpaceKey({ target, existing }, {}), "LEGACY");

  fs.rmSync(existing);
  const result = spawnSync(process.execPath, [
    path.join(here, "confluence-space.mts"),
    "--out", target,
    "--runtime", "codex",
  ], {
    encoding: "utf8",
    env: { ...process.env, KHEREP_CONFLUENCE_SPACE_KEY: "" },
    input: "",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /KHEREP_CONFLUENCE_SPACE_KEY is required/);
});

test("resolves a Codex space only through the Codex broker", () => {
  const calls: Array<{ broker: string; args: string[] }> = [];
  const io: BrokerIO = {
    exists: () => true,
    run: (broker, args) => {
      calls.push({ broker, args: [...args] });
      return "id: 123\nkey: KB\nname: Knowledge Base\n";
    },
  };

  assert.deepEqual(resolveSpace("KB", "codex", io), {
    id: "123",
    key: "KB",
    name: "Knowledge Base",
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].broker.endsWith(path.join("modules", "atl-jira-brokers", "atl-confluence.mts")));
  assert.deepEqual(calls[0].args, ["space", "--space", "KB"]);
});

test("reports successful setup without exposing the Confluence target identity", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    'process.stdout.write("id: private-space-id\\nkey: PRIVATEKEY\\nname: Private Space Name\\n");\n',
  );

  const result = runCli(fixture);

  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout, "confluence space: configured\nplacement nodes: 1 of 1 resolved\n");
  assert.doesNotMatch(result.stdout, /private-space-id|PRIVATEKEY|Private Space Name/);
  assert.ok(!result.stdout.includes(fixture.target));
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.target, "utf8")), {
    spaceKey: "PRIVATEKEY",
    spaceId: "private-space-id",
    spaceName: "Private Space Name",
    nodes: { Kherep: "parent-1" },
  });
  assert.equal(
    Object.hasOwn(JSON.parse(fs.readFileSync(fixture.target, "utf8")), "observationPublishingAuthorized"),
    false,
  );
});

// The CLI entry once compared import.meta.url with pathToFileURL(argv[1]).
// Node resolves the entry module to its real path, argv[1] keeps the symlink,
// so a script reached through any symlinked component (macOS /var ->
// /private/var) did nothing and exited 0. The fixture root is resolved first,
// so the only symlink on the invoked path is the one this test creates.
test("runs as a CLI when invoked through a symlinked directory", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    'process.stdout.write("id: private-space-id\\nkey: PRIVATEKEY\\nname: Private Space Name\\n");\n',
  );
  const realRoot = fs.realpathSync(fixture.root);
  const link = path.join(realRoot, "linked-bootstrap");
  try {
    fs.symlinkSync(path.join(realRoot, "bootstrap"), link, "dir");
  } catch (error) {
    if ((error as { code?: string }).code === "EPERM") {
      t.skip("directory symlink creation is not permitted on this host");
      return;
    }
    throw error;
  }

  const result = runCli({ ...fixture, script: path.join(link, "confluence-space.mts") });

  assert.equal(result.status, 0, String(result.stderr));
  assert.equal(result.stdout, "confluence space: configured\nplacement nodes: 1 of 1 resolved\n");
  assert.equal(JSON.parse(fs.readFileSync(fixture.target, "utf8")).spaceId, privateSpace.id);
});

test("persists explicit observation publication authority", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    'process.stdout.write("id: private-space-id\\nkey: PRIVATEKEY\\nname: Private Space Name\\n");\n',
  );

  const result = runCli(fixture, { authorizeObservationPublishing: true });

  assert.equal(result.status, 0, String(result.stderr));
  const config = JSON.parse(fs.readFileSync(fixture.target, "utf8"));
  assert.equal(config.observationPublishingAuthorized, true);
});

test("preserves existing literal observation publication authority without the flag", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    'process.stdout.write("id: private-space-id\\nkey: PRIVATEKEY\\nname: Private Space Name\\n");\n',
  );
  fs.writeFileSync(fixture.target, JSON.stringify({
    spaceKey: privateSpace.key,
    spaceId: privateSpace.id,
    observationPublishingAuthorized: true,
    operatorNote: "a key this script does not know",
  }));

  const result = runCli(fixture);

  assert.equal(result.status, 0, String(result.stderr));
  const config = JSON.parse(fs.readFileSync(fixture.target, "utf8"));
  assert.equal(config.observationPublishingAuthorized, true);
  assert.equal(config.operatorNote, "a key this script does not know", "the merge keeps unknown keys");
});

test("keeps prior placement nodes only when the same space cannot be read", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(fixture.broker,
    'process.stdout.write("id: private-space-id\\nkey: PRIVATEKEY\\nname: Private Space Name\\n");\n');
  fs.writeFileSync(fixture.target, JSON.stringify({
    spaceKey: privateSpace.key,
    spaceId: privateSpace.id,
    nodes: { Kherep: "previous-parent" },
  }));

  const same = runCli(fixture, { nodeReadFail: true });
  assert.equal(same.status, 0, String(same.stderr));
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.target, "utf8")).nodes,
    { Kherep: "previous-parent" });
  assert.doesNotMatch(String(same.stderr), /private node read detail/);

  fs.writeFileSync(fixture.broker,
    'process.stdout.write("id: replacement-space-id\\nkey: PRIVATEKEY\\nname: Replacement Space\\n");\n');
  const changed = runCli(fixture, { nodeReadFail: true });
  assert.equal(changed.status, 0, String(changed.stderr));
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.target, "utf8")).nodes, {});
});

test("names missing placement nodes without exposing the space identity", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(fixture.broker,
    'process.stdout.write("id: private-space-id\\nkey: PRIVATEKEY\\nname: Private Space Name\\n");\n');

  const result = runCli(fixture, { missingNode: true });

  assert.equal(result.status, 0, String(result.stderr));
  assert.match(String(result.stderr), /placement node NOT FOUND: Kherep/);
  assertNoPrivateFailureDetail(String(result.stderr), fixture);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.target, "utf8")).nodes, {});
});

test("does not carry observation publication authority to an environment-selected space", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    'process.stdout.write("id: new-space-id\\nkey: NEWKEY\\nname: New Space\\n");\n',
  );
  fs.writeFileSync(fixture.target, JSON.stringify({
    spaceKey: privateSpace.key,
    spaceId: privateSpace.id,
    observationPublishingAuthorized: true,
  }));

  const result = runCli(fixture, { spaceKey: "NEWKEY" });

  assert.equal(result.status, 0, String(result.stderr));
  const config = JSON.parse(fs.readFileSync(fixture.target, "utf8"));
  assert.equal(config.spaceId, "new-space-id");
  assert.equal(Object.hasOwn(config, "observationPublishingAuthorized"), false);
});

test("does not carry observation publication authority to a new id with the same key", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    'process.stdout.write("id: replacement-space-id\\nkey: PRIVATEKEY\\nname: Replacement Space\\n");\n',
  );
  fs.writeFileSync(fixture.target, JSON.stringify({
    spaceKey: privateSpace.key,
    spaceId: privateSpace.id,
    observationPublishingAuthorized: true,
  }));

  const result = runCli(fixture);

  assert.equal(result.status, 0, String(result.stderr));
  const config = JSON.parse(fs.readFileSync(fixture.target, "utf8"));
  assert.equal(config.spaceKey, privateSpace.key);
  assert.equal(config.spaceId, "replacement-space-id");
  assert.equal(Object.hasOwn(config, "observationPublishingAuthorized"), false);
});

test("does not adopt observation publication authority from a legacy file", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    'process.stdout.write("id: private-space-id\\nkey: PRIVATEKEY\\nname: Private Space Name\\n");\n',
  );
  const legacy = path.join(fixture.root, "legacy.json");
  fs.writeFileSync(legacy, JSON.stringify({
    spaceKey: privateSpace.key,
    observationPublishingAuthorized: true,
  }));

  const result = runCli(fixture, { existing: legacy });

  assert.equal(result.status, 0, String(result.stderr));
  const config = JSON.parse(fs.readFileSync(fixture.target, "utf8"));
  assert.equal(Object.hasOwn(config, "observationPublishingAuthorized"), false);
});

test("reports a missing broker without exposing setup identifiers", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));

  const result = runCli(fixture);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(withoutTypeStrippingWarning(result.stderr), "FATAL: Confluence broker is unavailable.\n");
  assertNoPrivateFailureDetail(String(result.stderr), fixture);
});

test("reports broker execution failure without exposing setup identifiers", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    `process.stderr.write(${JSON.stringify(`${privateBrokerDetail}\n`)}); process.exit(17);\n`,
  );

  const result = runCli(fixture);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(withoutTypeStrippingWarning(result.stderr), "FATAL: Confluence space is unreadable by the service account.\n");
  assertNoPrivateFailureDetail(String(result.stderr), fixture);
});

test("reports an invalid broker response without exposing setup identifiers", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    `process.stdout.write(${JSON.stringify(
      `key: ${privateSpace.key}\nname: ${privateSpace.name}\n`,
    )});\n`,
  );

  const result = runCli(fixture);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(withoutTypeStrippingWarning(result.stderr), "FATAL: Confluence broker returned an invalid space response.\n");
  assertNoPrivateFailureDetail(String(result.stderr), fixture);
});

test("reports persistence failure without exposing setup identifiers", (t) => {
  const fixture = createCliFixture();
  t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
  fs.writeFileSync(
    fixture.broker,
    `process.stdout.write(${JSON.stringify(
      `id: ${privateSpace.id}\nkey: ${privateSpace.key}\nname: ${privateSpace.name}\n`,
    )});\n`,
  );
  fs.mkdirSync(fixture.target);

  const result = runCli(fixture);

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, "");
  assert.equal(withoutTypeStrippingWarning(result.stderr), "FATAL: Confluence space configuration could not be written.\n");
  assertNoPrivateFailureDetail(String(result.stderr), fixture);
});

for (const source of ["canonical", "legacy"] as const) {
  for (const failure of ["unreadable", "invalid"] as const) {
    test(`reports ${failure} ${source} configuration without exposing setup identifiers`, (t) => {
      const fixture = createCliFixture();
      t.after(() => fs.rmSync(fixture.root, { recursive: true, force: true }));
      const configuration = source === "canonical"
        ? fixture.target
        : path.join(fixture.root, "private-legacy.json");
      if (failure === "unreadable") {
        fs.mkdirSync(configuration);
      } else {
        fs.writeFileSync(
          configuration,
          `${privateSpace.key} ${privateSpace.id} ${privateSpace.name}`,
        );
      }

      const result = runCli(fixture, {
        existing: source === "legacy" ? configuration : undefined,
        spaceKey: "",
      });

      assert.notEqual(result.status, 0);
      assert.equal(result.stdout, "");
      assert.equal(
        withoutTypeStrippingWarning(result.stderr),
        "FATAL: Existing Confluence space configuration could not be read.\n",
      );
      assertNoPrivateFailureDetail(String(result.stderr), fixture, [configuration]);
    });
  }
}

test("wires Claude bootstrap setup to the Claude runtime", () => {
  const installer = fs.readFileSync(path.join(here, "install.sh"), "utf8");
  assert.match(
    installer,
    /confluence-space\.mts" --out "\$CLAUDE_HOME\/kherep\/confluence\.json"[\s\\]*--runtime claude/,
  );
});

test("wires Codex setup to the canonical target without masking installer status", () => {
  const installer = fs.readFileSync(path.join(repoRoot, "codex", "install.ps1"), "utf8");
  const core = fs.readFileSync(path.join(repoRoot, "codex", "install.mts"), "utf8");
  assert.match(installer, /\[switch\]\$AuthorizeObservationPublishing/);
  assert.match(installer, /if \(\$AuthorizeObservationPublishing\) \{ \$arguments \+= "--authorize-observation-publishing" \}/);
  assert.match(core, /"--out", path\.join\(result\.codexHome, "kherep", "confluence\.json"\)/);
  assert.match(core, /"--runtime", "codex"/);
  assert.match(core, /"--existing", path\.join\(result\.codexHome, "orchestra", "confluence\.json"\)/);
  assert.match(core, /if \(cliOptions\.authorizeObservationPublishing\) spaceArgs\.push\("--authorize-observation-publishing"\)/);

  const coreInstall = installer.indexOf("& $node.Source @arguments");
  const capturedStatus = installer.indexOf("$installExitCode = $LASTEXITCODE");
  const coreFailure = installer.indexOf("if ($installExitCode -ne 0)");
  assert.ok(coreInstall >= 0 && coreInstall < capturedStatus);
  assert.ok(capturedStatus < coreFailure);
  assert.doesNotMatch(installer, /@spaceArguments/);
});
