import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

const sourceRoot = path.join(import.meta.dirname, "..", "modules", "atl-jira-brokers");
const brokers = [
  { name: "atl-jira.mts", ownEnv: "KHEREP_ATL_CRED_FILE_CODEX", foreignEnv: "KHEREP_ATL_CRED_FILE_CLAUDE" },
  { name: "atl-jira-ccoder.mts", ownEnv: "KHEREP_ATL_CRED_FILE_CLAUDE", foreignEnv: "KHEREP_ATL_CRED_FILE_CODEX" },
];
const SHARED_CREDENTIAL_MODULE = "atlassian-credentials.mts";
// #299. The strict argument parser both broker families share, installed with
// the default Confluence set for the same reason as the credential parser.
const SHARED_CLI_ARGS_MODULE = "atlassian-cli-args.mts";

// A source with its line comments removed. These files carry long explanatory
// comments by design, so an assertion about what the CODE does must not be
// satisfiable - or breakable - by prose.
function codeOnly(source: string): string {
  return source.split("\n").filter((line) => !line.trim().startsWith("//")).join("\n");
}

for (const broker of brokers) {
  test(`${broker.name} is versioned with only its own credential variable`, () => {
    const sourcePath = path.join(sourceRoot, broker.name);
    assert.ok(fs.existsSync(sourcePath), `${broker.name} canonical source is missing`);
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.match(source, new RegExp(broker.ownEnv));
    assert.doesNotMatch(source, new RegExp(broker.foreignEnv));
    assert.doesNotMatch(source, /[A-Za-z0-9._-]+\.txt\b/);
  });

  test(`${broker.name} uses the shared fail-closed transition guard`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /from ['"]\.\/jira-transition-guard\.mts['"]/);
    assert.match(source, /validateTransitionIntent/);
    assert.match(source, /doneAuditText/);
  });

  // OP-1396. Parity is a condition of the work, not a follow-up: a verb that
  // exists in one broker and not the other means the two runtimes can do
  // different things to the same Jira site, which is the drift these files keep
  // producing. The upload is checked down to its two load-bearing details,
  // because both are invisible in a passing unit test that forgot them: without
  // the XSRF header Jira blocks the request, and with the wrong part name it
  // accepts the request and stores nothing.
  test(`${broker.name} uploads attachments through the shared module`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /from ['"]\.\/jira-attach\.mts['"]/);
    assert.match(source, /uploadRequest/);
    assert.match(source, /attachmentPath/);
    assert.match(source, /readAttachments/);
    assert.match(source, /confirmAttachments/);
    // The wire details live in the shared module, so neither broker may spell
    // them out for itself.
    assert.doesNotMatch(source, /X-Atlassian-Token|multipart\/form-data|form-data; name=/);
  });

  test(`${broker.name} offers attach beside the other write verbs`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    // Both brokers dispatch through one COMMANDS table and print one usage line;
    // a verb missing from either is a verb the caller cannot reach.
    assert.match(source, /^\s+attach: /m, "attach is not registered in the command table");
    assert.match(source, /Nutzung: [^\n]*\battach\b/, "attach is missing from the usage line");
  });

  // OP-1396. The readback half. Both brokers could write an attachment and
  // neither could read one, so acceptance had to go around the broker to see a
  // file it had just uploaded - the detour this work item exists to remove.
  test(`${broker.name} reads attachments back through the shared module`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /from ['"]\.\/jira-download\.mts['"]/);
    assert.match(source, /attachmentListPath/);
    assert.match(source, /attachmentContentPath/);
    assert.match(source, /decideOutput/);
    assert.match(source, /verifyDownload/);
    // The route and the printable rule live in the shared module, so neither
    // broker may BUILD them for itself. `redirect=false` in particular is the
    // difference between the documented 200 and a 303 nobody followed.
    //
    // Checked against the code with its comments removed: a comment that
    // explains why the query parameter matters is documentation worth having,
    // and a guard that forbids naming a thing only teaches people to stop
    // explaining it.
    assert.doesNotMatch(codeOnly(source), /redirect=false|\/attachment\/content|octet-stream/);
  });

  test(`${broker.name} offers download beside the other read verbs`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /^\s+download[:,]/m, "download is not registered in the command table");
    assert.match(source, /Nutzung: [^\n]*\bdownload\b/, "download is missing from the usage line");
  });

  // OP-1396 follow-up, from live acceptance. The Claude broker accepted a --key
  // on download and never read it, so a typo returned a FOREIGN work item's
  // attachment with exit 0. The Codex broker happened to reject the flag through
  // its option allowlist - the same one-sided protection as the no-write
  // assertion, and the same reason it belongs here: a property that holds on one
  // broker by accident is not a property.
  test(`${broker.name} binds download to --key by reading the work item's own list`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    // The cross-check, both halves: start at the work item, then prove the id is
    // on it. Either one alone is decoration.
    assert.match(source, /attachmentListPath/, "download does not read the work item's attachment list");
    assert.match(source, /selectAttachment/, "download does not prove the id belongs to that work item");
    // NOT asserted here: that the broker never spells `?fields=attachment` for
    // itself. attach has inlined exactly that literal for its own readback since
    // before this module existed, in both brokers, so the check would fail on
    // pre-existing code rather than on anything download did. Folding attach's
    // readback onto attachmentListPath is a separate change to a verb this work
    // item does not own.
  });

  test(`${broker.name} lists attachments on get through the shared reader`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /readAttachmentList/);
  });

  // OP-1396, and golden rule 16. This assertion existed only in the Claude
  // broker's own test file, so the invariant it protects bound exactly one of
  // two runtimes; the Codex broker happened to honour it and nothing said it
  // had to. A guard that binds one runtime is not built for the other, so it
  // moves here, where both are held to it.
  //
  // WHY IT IS THIS BLUNT. The token cache must never reach disk: a token file
  // would sit outside the privacy-boundary-guard, which covers only the
  // credentials path, and stay valid for up to an hour. "No write API at all"
  // is checkable; "no write API except the well-behaved ones" is not. It is
  // also why `download` writes to stdout and lets the shell name the file
  // rather than taking an --out path of its own (OP-1396, decided 2026-09-18).
  test(`${broker.name} imports no write API and can therefore not persist a token`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /import \{ readFile as nodeReadFile \} from "node:fs\/promises";/);
    for (const forbidden of ["writeFile", "appendFile", "createWriteStream", "writeFileSync", "mkdir"]) {
      assert.equal(source.includes(forbidden), false, `${broker.name} references ${forbidden}`);
    }
  });

  // OP-1387. Same parity argument as attach: a body the one runtime can read and
  // the other cannot is a difference nobody chose. Both brokers must go through
  // the shared reader rather than grow a private one.
  test(`${broker.name} renders descriptions through the shared ADF reader`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /from ['"]\.\/jira-adf-text\.mts['"]/);
    assert.match(source, /adfToText/);
    assert.match(source, /description/);
  });

  test(`${broker.name} resolves issue link types through the shared module`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /from ['"]\.\/jira-links\.mts['"]/);
    assert.match(source, /resolveLinkType/);
    assert.match(source, /confirmLinkCreated/);
    assert.match(source, /confirmLinkRemoved/);
    assert.doesNotMatch(source, /["']Duplicate["']|["']Blocks["']|["']Relates["']/);
  });
}

test("the shared transition guard is versioned beside both brokers", () => {
  assert.ok(fs.existsSync(path.join(sourceRoot, "jira-transition-guard.mts")));
});

// OP-1372. This check used to name jira-links.mts and jira-config.mts literally,
// so it could only catch a module that was already known to it. A new shared
// module, jira-search.mts, was added and projected nowhere: the brokers imported
// a file the installers never copied, which breaks every verb at import time on
// any host that installs rather than runs from the checkout. A literal list
// cannot see that, so the list is now derived from what is actually on disk.
const SHARED_BROKER_MODULES = fs.readdirSync(sourceRoot)
  .filter((name) => name.startsWith("jira-") && name.endsWith(".mts") && !name.endsWith(".test.mts"))
  .sort();

// Every place that copies or compares the broker set. A module missing from any
// one of them is a module that arrives incomplete or drifts unobserved.
const PROJECTION_SITES = [
  path.join(import.meta.dirname, "install.sh"),
  path.join(import.meta.dirname, "drift-check.sh"),
  path.join(import.meta.dirname, "smoke-test.sh"),
  path.join(import.meta.dirname, "..", "codex", "install.mts"),
  path.join(import.meta.dirname, "..", "claude", "hooks", "drift-managed-pairs.mts"),
];

test("every shared broker module is covered by every projection site", () => {
  assert.ok(SHARED_BROKER_MODULES.length >= 5, `found only ${SHARED_BROKER_MODULES.join(", ")}`);
  for (const site of PROJECTION_SITES) {
    const source = fs.readFileSync(site, "utf8");
    for (const module of SHARED_BROKER_MODULES) {
      assert.ok(source.includes(module), `${path.basename(site)} must project ${module}`);
    }
  }
});

test("both brokers import only shared modules that exist beside them", () => {
  for (const broker of brokers) {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    for (const [, imported] of source.matchAll(/from ["']\.\/(jira-[a-z-]+\.mts)["']/g)) {
      assert.ok(fs.existsSync(path.join(sourceRoot, imported)), `${broker.name} imports missing ${imported}`);
      assert.ok(SHARED_BROKER_MODULES.includes(imported), `${imported} is not projected`);
    }
  }
});

test("both Jira brokers re-export one fail-closed credential parser", async () => {
  const modules = await Promise.all(brokers.map(({ name }) => import(pathToFileURL(path.join(sourceRoot, name)).href)));
  assert.equal(modules[0].parseCredentialText, modules[1].parseCredentialText);
  const expected = { clientId: "fixture-client", clientSecret: "fixture-secret" };
  for (const credentials of [
    "Client ID: fixture-client\nClient Secret: fixture-secret\n",
    "Client Secret: fixture-secret\nClient ID: fixture-client\n",
  ]) {
    for (const broker of modules) assert.deepEqual(broker.parseCredentialText(credentials), expected);
  }

  for (const malformed of [
    "Client ID: fixture-client\n",
    "Client ID: fixture-client\nClient Secret: fixture-secret\nExtra: value\n",
    "Client Secret: first\nOther Secret: second\n",
  ]) {
    const failures = modules.map((broker) => {
      try {
        broker.parseCredentialText(malformed);
        return null;
      } catch (error) {
        return error;
      }
    });
    assert.ok(failures.every((error) => error instanceof Error));
    assert.equal((failures[0] as Error).constructor, (failures[1] as Error).constructor);
    assert.equal((failures[0] as Error).message, (failures[1] as Error).message);
  }

  for (const broker of brokers) {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /import \{[^}]*\bparseCredentialText\b[^}]*\} from ["']\.\/atlassian-credentials\.mts["'];/s);
    assert.match(source, /export \{ parseCredentialText \};/);
  }
});

// OP-1405. The Confluence brokers. Same contract, same reason: the two runtimes
// must be able to do the same things to the same site, and neither may reach
// the other's credential file. The 164 objects this work item exists to prevent
// a repeat of were created under a personal account because no service-account
// path existed for Confluence at all.
const confluenceBrokers = [
  { name: "atl-confluence.mts", ownEnv: "KHEREP_ATL_CRED_FILE_CODEX", foreignEnv: "KHEREP_ATL_CRED_FILE_CLAUDE" },
  { name: "atl-confluence-ccoder.mts", ownEnv: "KHEREP_ATL_CRED_FILE_CLAUDE", foreignEnv: "KHEREP_ATL_CRED_FILE_CODEX" },
];

const SHARED_CONFLUENCE_MODULES = fs.readdirSync(sourceRoot)
  .filter((name) => name.startsWith("confluence-") && name.endsWith(".mts") && !name.endsWith(".test.mts"))
  .sort();

for (const broker of confluenceBrokers) {
  test(`${broker.name} is versioned with only its own credential variable`, () => {
    const sourcePath = path.join(sourceRoot, broker.name);
    assert.ok(fs.existsSync(sourcePath), `${broker.name} canonical source is missing`);
    const source = fs.readFileSync(sourcePath, "utf8");
    assert.match(source, new RegExp(broker.ownEnv));
    assert.doesNotMatch(source, new RegExp(broker.foreignEnv));
    assert.doesNotMatch(source, /[A-Za-z0-9._-]+\.txt\b/);
  });

  test(`${broker.name} owns no transport of its own`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /from ['"]\.\/confluence-session\.mts['"]/);
    assert.match(source, /from ['"]\.\/confluence-content\.mts['"]/);
    assert.match(source, /createSession/);
    // Endpoints, hosts, the bearer header and the credential parser live in the
    // shared modules. A CLI that spells any of them for itself is a second
    // identity, and separate credential variables only mean something while
    // there is exactly one.
    assert.doesNotMatch(codeOnly(source), /auth\.atlassian\.com|api\.atlassian\.com|tenant_info/);
    assert.doesNotMatch(codeOnly(source), /Bearer|parseCredentialText|\/wiki\/(api|rest)\//);
  });

  // OP-1419. `move` joins the list rather than being checked apart from it: the
  // re-parenting function existed, tested, since OP-1409 and no caller could
  // reach it from either broker, which is the same one-sided gap this loop was
  // written for. A verb only exists once both command tables carry it.
  test(`${broker.name} offers every verb through one command table and one usage line`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    for (const verb of ["create", "update", "get", "delete", "purge", "labels", "move", "space", "children", "selftest"]) {
      assert.match(source, new RegExp(`^\\s+${verb}: `, "m"), `${verb} is not registered in the command table`);
      assert.match(source, new RegExp(`Usage: [^\\n]*\\b${verb}\\b`), `${verb} is missing from the usage line`);
    }
  });

  test(`${broker.name} imports no write API and can therefore not persist a token`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(source, /import \{ readFile as nodeReadFile \} from "node:fs\/promises";/);
    for (const forbidden of ["writeFile", "appendFile", "createWriteStream", "writeFileSync", "mkdir"]) {
      assert.equal(source.includes(forbidden), false, `${broker.name} references ${forbidden}`);
    }
  });

  test(`${broker.name} builds its session cache per run`, () => {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    assert.match(codeOnly(source), /session: \{\},/, "the per-run session cache is not built inside runCli");
  });
}

// #760 contract A: the Claude broker's create is observation-only, the Codex
// broker's stays generic. Exactly three line regions may differ for that: the
// validator import, the FLAGS.create row and the cmdCreate prologue up to the
// session; everything from createSession on stays parity-checked.
function withoutCreateGate(source: string): { rest: string; regions: string[] } {
  const lines = source.split("\n"), regions: string[] = [];
  const cut = (start: (line: string) => boolean, end: (line: string) => boolean): void => {
    const from = lines.findIndex(start);
    assert.ok(from >= 0, "a #760 create region is missing");
    let to = from + 1;
    while (to < lines.length && !end(lines[to])) to += 1;
    regions.push(lines.splice(from, to - from, "<#760 create region>").join("\n"));
  };
  cut((line) => line.startsWith("import { cmdValidate") && line.endsWith(" from './confluence-observation-validate.mts';"), () => true);
  cut((line) => line.startsWith("  create: {"), (line) => line.startsWith("  update: {"));
  cut((line) => line.startsWith("async function cmdCreate("), (line) => line === "  const session = createSession(ctx);");
  return { rest: lines.join("\n"), regions };
}

// The parity assertion in its strongest form: after neutralising which runtime
// a file belongs to and the #760 create regions, the two sources must be
// byte-identical. A verb, a guard or a readback added to one and forgotten in
// the other fails here.
test("the two Confluence brokers differ only in which runtime they belong to", () => {
  const neutral = (name: string): string => fs.readFileSync(path.join(sourceRoot, name), "utf8")
    .replace(/KHEREP_ATL_CRED_FILE_(?:CLAUDE|CODEX)/g, "KHEREP_ATL_CRED_FILE")
    .replace(/\b(?:Claude|Codex)\b/g, "RUNTIME");
  const claude = withoutCreateGate(neutral("atl-confluence-ccoder.mts"));
  const codex = withoutCreateGate(neutral("atl-confluence.mts"));
  assert.equal(claude.rest, codex.rest);
  // The divergence is exactly the #760 gate: Claude's create calls the
  // observation gate and requires its flags; Codex's create does neither.
  const [claudeImport, claudeFlags, claudeCreate] = claude.regions;
  const [codexImport, codexFlags, codexCreate] = codex.regions;
  assert.match(claudeImport, /\bobservationCreateBody\b/);
  assert.match(claudeFlags, /format: "<storage>", "body-file": "<path>", labels: "<a,b>"/);
  assert.doesNotMatch(claudeFlags, /oneOf|wiki|adf/);
  assert.match(codeOnly(claudeCreate), /const value = await observationCreateBody\(ctx, args, fail\);/);
  assert.doesNotMatch(codeOnly(claudeCreate), /bodyOf\(/);
  assert.doesNotMatch([codexImport, codexFlags, codexCreate, codex.rest].join("\n"), /observationCreateBody/);
  assert.match(codexFlags, /oneOf: \[BODY\]/);
  assert.match(codeOnly(codexCreate), /const value = await bodyOf\(ctx, args\);/);
});

test("the Confluence transport uses the shared credential parser without a Jira broker dependency", () => {
  const source = fs.readFileSync(path.join(sourceRoot, "confluence-session.mts"), "utf8");
  assert.match(source, /import \{ parseCredentialText \} from "\.\/atlassian-credentials\.mts";/);
  const reached = [...source.matchAll(/from ["']\.\/((?:atl-)?jira[a-z-]*\.mts)["']/g)].map(([, name]) => name);
  assert.deepEqual(reached, [], "the transport must not depend on either Jira broker");
  // No credential variable is hardcoded in the transport: each CLI names its
  // own, which is what keeps one runtime out of the other's credential file.
  assert.doesNotMatch(codeOnly(source), /KHEREP_ATL_CRED_FILE_(?:CLAUDE|CODEX)/);
});

test("every Confluence module and broker is covered by every projection site", () => {
  assert.ok(
    SHARED_CONFLUENCE_MODULES.length >= 3,
    `found only ${SHARED_CONFLUENCE_MODULES.join(", ")}`,
  );
  const projected = [
    SHARED_CREDENTIAL_MODULE,
    SHARED_CLI_ARGS_MODULE,
    ...SHARED_CONFLUENCE_MODULES,
    ...confluenceBrokers.map((broker) => broker.name),
  ];
  for (const site of PROJECTION_SITES) {
    const source = fs.readFileSync(site, "utf8");
    for (const module of projected) {
      assert.ok(source.includes(module), `${path.basename(site)} must project ${module}`);
    }
  }
});

test("both Confluence brokers import only shared modules that exist beside them", () => {
  for (const broker of confluenceBrokers) {
    const source = fs.readFileSync(path.join(sourceRoot, broker.name), "utf8");
    for (const [, imported] of source.matchAll(/from ["']\.\/(confluence-[a-z-]+\.mts)["']/g)) {
      assert.ok(fs.existsSync(path.join(sourceRoot, imported)), `${broker.name} imports missing ${imported}`);
      assert.ok(SHARED_CONFLUENCE_MODULES.includes(imported), `${imported} is not projected`);
    }
  }
});

test("the documented scope per verb is the one the contract declares", async () => {
  const { SCOPES } = await import("../modules/atl-jira-brokers/confluence-contract.mts");
  assert.deepEqual({ ...SCOPES }, {
    create: "write:page:confluence",
    update: "write:page:confluence",
    get: "read:page:confluence",
    delete: "delete:page:confluence",
    purge: "delete:page:confluence",
    labels: "write:confluence-content",
    space: "read:space:confluence",
    children: "read:page:confluence",
  });
});

// #299. Every broker parses its arguments through the one strict parser, from a
// per-verb FLAGS table, and the literal one-line usage string above stays the
// exact verb list of that table. A verb added to the table and forgotten in the
// usage line, or the other way round, fails here rather than in a caller.
const ALL_BROKERS = [...brokers, ...confluenceBrokers].map((broker) => broker.name);

test("every broker parses arguments through the shared strict parser", () => {
  for (const name of ALL_BROKERS) {
    const source = fs.readFileSync(path.join(sourceRoot, name), "utf8");
    assert.match(source, /import \{[^}]*\bparseVerbArgs\b[^}]*\} from "\.\/atlassian-cli-args\.mts";/s, name);
    assert.match(codeOnly(source), /parseVerbArgs\(verb, FLAGS\[verb\], rest, (?:EN|DE)\)/, name);
    assert.doesNotMatch(codeOnly(source), /function parse(?:Args|Options)\b|rejectUnknownOptions|VALUELESS/, name);
  }
});

test("each broker's usage line names exactly the verbs of its FLAGS table", async () => {
  for (const name of ALL_BROKERS) {
    const source = fs.readFileSync(path.join(sourceRoot, name), "utf8");
    const lines = [...codeOnly(source).matchAll(/(?:Usage|Nutzung): ((?:[a-z]+ \| )+[a-z]+)/g)];
    assert.equal(lines.length, 1, `${name} must carry exactly one usage line`);
    const { FLAGS } = await import(pathToFileURL(path.join(sourceRoot, name)).href) as { FLAGS: Record<string, unknown> };
    assert.deepEqual(lines[0][1].split(" | ").sort(), Object.keys(FLAGS).sort(), name);
  }
});
