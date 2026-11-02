// Issue #256. A candidate run of install.sh with a temporary CLAUDE_HOME but
// without every skip switch set the account's global core.hooksPath to the
// candidate and verified the real credential file named by an inherited
// KHEREP_ATL_CRED_FILE_CLAUDE. A CLAUDE_HOME other than <HOME>/.claude now
// skips both steps unless the operator allows each one; KHEREP_INSTALL_PREVIEW=1
// skips them, and the knowledge-space step, for any home.
//
// Every case runs the whole install.sh with an environment built from scratch:
// only PATH is inherited, global and system Git configuration are throwaway
// files, and HOME is a throwaway directory, so no case can reach the host's
// real Git configuration, Claude home or credential files.
//
// "Never opens the file" is observed, not inferred from the output: every node
// process the installer starts preloads a tracer that records any file-system
// call naming the sentinel credential file and then throws, so a step that does
// reach the file stops there, before a broker could make a live call.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { pathToFileURL } from "node:url";

const HERE = import.meta.dirname;
const ORIGINAL = "/fixture/original/githooks";
// Git Bash wants /c/... on Windows; install.sh refuses a drive-letter path.
const slash = (value: string): string =>
  value.replace(/\\/g, "/").replace(/^([A-Za-z]):\//, (_match, drive: string) => `/${drive.toLowerCase()}/`);

const TRACER = `
import fs from "node:fs";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
const target = path.resolve(process.env.SENTINEL_TRACE_FILE);
const log = process.env.SENTINEL_TRACE_LOG;
const names = (p) => { try { return path.resolve(p instanceof URL ? fileURLToPath(p) : String(p)) === target; } catch { return false; } };
const wrap = (owner, name) => {
  const original = owner[name];
  if (typeof original !== "function") return;
  owner[name] = function (first, ...rest) {
    if ((typeof first === "string" || first instanceof URL || Buffer.isBuffer(first)) && names(first)) {
      fs.appendFileSync(log, name + " " + process.argv.slice(1).join(" ") + "\\n");
      throw new Error("sentinel credential file touched by " + name);
    }
    return original.call(this, first, ...rest);
  };
};
for (const name of ["openSync", "readFileSync", "statSync", "lstatSync", "existsSync", "accessSync",
  "realpathSync", "createReadStream", "open", "readFile", "stat", "lstat", "access"]) wrap(fs, name);
for (const name of ["open", "readFile", "stat", "lstat", "access"]) wrap(fs.promises, name);
syncBuiltinESMExports();
`;

interface Fixture {
  root: string; home: string; candidate: string; ws: string; creds: string;
  global: string; system: string; sentinel: string; traceLog: string; tracer: string;
}

function fixture(t: TestContext): Fixture {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "kherep-issue256-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const f: Fixture = {
    root, home: path.join(root, "home"), candidate: path.join(root, "candidate", "claude"),
    ws: path.join(root, "workspace"), creds: path.join(root, "integration-config"),
    global: path.join(root, "gitconfig-global"), system: path.join(root, "gitconfig-system"),
    sentinel: path.join(root, "outside", "atl-credential-claude.txt"),
    traceLog: path.join(root, "sentinel-trace.log"), tracer: path.join(root, "sentinel-tracer.mjs"),
  };
  fs.mkdirSync(f.home);
  fs.mkdirSync(f.candidate, { recursive: true });
  fs.mkdirSync(f.ws);
  fs.mkdirSync(path.dirname(f.sentinel));
  fs.writeFileSync(f.sentinel, "sentinel, not a credential\n", { mode: 0o600 });
  fs.writeFileSync(f.global, `[core]\n\thooksPath = ${ORIGINAL}\n`);
  fs.writeFileSync(f.tracer, TRACER);
  return f;
}

function install(f: Fixture, claudeHome: string, extraEnv: Record<string, string> = {}) {
  const run = spawnSync("bash", [path.join(HERE, "install.sh")], {
    encoding: "utf8",
    timeout: 300_000,
    env: {
      PATH: process.env.PATH, HOME: slash(f.home), CLAUDE_HOME: slash(claudeHome), KHEREP_PROFILE: "win",
      KHEREP_WORKSPACE: slash(f.ws), KHEREP_CREDENTIALS_ROOT: slash(f.creds),
      SKIP_SECRETS: "1", SKIP_DEPS: "1",
      GIT_CONFIG_GLOBAL: f.global, GIT_CONFIG_SYSTEM: f.system,
      KHEREP_ATL_CRED_FILE_CLAUDE: f.sentinel,
      NODE_OPTIONS: `--import=${pathToFileURL(f.tracer).href}`,
      SENTINEL_TRACE_FILE: f.sentinel, SENTINEL_TRACE_LOG: f.traceLog,
      ...extraEnv,
    },
  });
  return { status: run.status, out: `${run.stdout}\n${run.stderr}` };
}

const globalHooksPath = (f: Fixture): string => {
  const run = spawnSync("git", ["config", "--file", f.global, "--get", "core.hooksPath"], { encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() : `<exit ${run.status}>`;
};
const sentinelTouched = (f: Fixture): string => (fs.existsSync(f.traceLog) ? fs.readFileSync(f.traceLog, "utf8") : "");
const sameDir = (stored: string, dir: string): boolean => slash(stored) === slash(dir);

test("a non-default CLAUDE_HOME without any switch leaves global Git config and the inherited credential alone", async (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.global);
  const run = install(f, f.candidate);
  assert.deepEqual(fs.readFileSync(f.global), before, `global gitconfig rewritten\n${run.out}`);
  assert.equal(fs.existsSync(f.system), false, "a system gitconfig was created");
  assert.equal(sentinelTouched(f), "", `inherited credential file was touched\n${run.out}`);
  for (const runtime of ["claude", "codex"]) {
    const target = path.join(f.ws, "tools", "github-broker", `github-${runtime}.mts`);
    const staged = await import(pathToFileURL(target).href);
    assert.equal(typeof staged.run, "function");
  }
  assert.equal(fs.existsSync(path.join(f.home, ".kherep", "github-broker")), false,
    "source installation must not provision GitHub policy, keys or receipts");
  // The managed files are still placed; only the account-wide steps are skipped, visibly and with the reason.
  assert.ok(fs.existsSync(path.join(f.candidate, "kherep", "githooks", "commit-msg")), run.out);
  assert.match(run.out, /^install: SKIP_GITCONFIG=1 \(by CLAUDE_HOME .*KHEREP_INSTALL_ALLOW_GITCONFIG=1.*\)$/m);
  assert.match(run.out, /^install: SKIP_ATL_CREDENTIAL=1 \(by CLAUDE_HOME .*KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL=1.*\)$/m);
  // The space step is not skipped by the home; without the credential it is unchecked and the run says so.
  assert.match(run.out, /Confluence knowledge space was not checked because the credential step was skipped/);
  assert.equal(run.status, 1, run.out);
});

test("KHEREP_INSTALL_ALLOW_GITCONFIG=1 binds the global hook path of a non-default home, and only that", (t) => {
  const f = fixture(t);
  const candidateHooks = path.join(f.candidate, "kherep", "githooks");
  const run = install(f, f.candidate, { KHEREP_INSTALL_ALLOW_GITCONFIG: "1" });
  assert.ok(sameDir(globalHooksPath(f), candidateHooks), `global hooksPath ${globalHooksPath(f)}\n${run.out}`);
  assert.equal(fs.existsSync(f.system), false, "a system gitconfig was created");
  assert.equal(sentinelTouched(f), "", `inherited credential file was touched\n${run.out}`);
});

// The positive control for the tracer: the credential step, once allowed, reaches
// the inherited file, so an empty trace above is a real "not opened".
test("KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL=1 runs the credential step of a non-default home, and only that", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.global);
  const run = install(f, f.candidate, { KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL: "1" });
  assert.match(sentinelTouched(f), /atl-credential\.mts/, `credential step did not reach the inherited file\n${run.out}`);
  assert.deepEqual(fs.readFileSync(f.global), before, `global gitconfig rewritten\n${run.out}`);
});

test("KHEREP_INSTALL_PREVIEW=1 skips Git configuration, credential and space for any home, over an allow", (t) => {
  const f = fixture(t);
  const before = fs.readFileSync(f.global);
  for (const claudeHome of [path.join(f.home, ".claude"), f.candidate]) {
    const run = install(f, claudeHome, {
      KHEREP_INSTALL_PREVIEW: "1", KHEREP_INSTALL_ALLOW_GITCONFIG: "1", KHEREP_INSTALL_ALLOW_ATL_CREDENTIAL: "1",
    });
    assert.equal(run.status, 0, run.out);
    assert.deepEqual(fs.readFileSync(f.global), before, `global gitconfig rewritten\n${run.out}`);
    assert.equal(sentinelTouched(f), "", `inherited credential file was touched\n${run.out}`);
    for (const step of ["GITCONFIG", "ATL_CREDENTIAL", "KNOWLEDGE_SPACE"]) {
      assert.match(run.out, new RegExp(`^install: SKIP_${step}=1 \\(by KHEREP_INSTALL_PREVIEW=1[;:].*\\)$`, "m"));
    }
  }
});

// The default-home install keeps its behaviour: it binds the global hook path
// and runs the credential step, which reads the inherited variable's file.
test("the default home <HOME>/.claude still binds global Git config and runs the credential step", (t) => {
  const f = fixture(t);
  const claudeHome = path.join(f.home, ".claude");
  const run = install(f, claudeHome);
  assert.ok(sameDir(globalHooksPath(f), path.join(claudeHome, "kherep", "githooks")),
    `global hooksPath ${globalHooksPath(f)}\n${run.out}`);
  assert.match(run.out, /core\.hooksPath was '\/fixture\/original\/githooks' and is being replaced/);
  assert.match(sentinelTouched(f), /atl-credential\.mts/, run.out);
  assert.doesNotMatch(run.out, /SKIP_(GITCONFIG|ATL_CREDENTIAL)=1/);
});

// The decision itself, for the spellings a real default home can take.
function skipReason(env: Record<string, string>, step: string): string {
  const script = `. '${slash(path.join(HERE, "profile.sh"))}' || exit $?\nkherep_install_skip_reason ${step}`;
  const run = spawnSync("bash", ["-c", script], { encoding: "utf8", env: { PATH: process.env.PATH, ...env } });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim();
}

test("the default home is recognised with a trailing slash, and on the win profile regardless of case", () => {
  const base = { HOME: "/h/user", KHEREP_PROFILE: "mac" };
  assert.equal(skipReason({ ...base, CLAUDE_HOME: "/h/user/.claude" }, "GITCONFIG"), "");
  assert.equal(skipReason({ ...base, CLAUDE_HOME: "/h/user/.claude/" }, "GITCONFIG"), "");
  // lib.sh's own default when HOME ends in a slash, and HOME=/.
  assert.equal(skipReason({ ...base, HOME: "/h/user/", CLAUDE_HOME: "/h/user//.claude" }, "GITCONFIG"), "");
  assert.equal(skipReason({ ...base, HOME: "/", CLAUDE_HOME: "//.claude" }, "GITCONFIG"), "");
  assert.notEqual(skipReason({ ...base, CLAUDE_HOME: "/h/User/.claude" }, "GITCONFIG"), "");
  assert.equal(skipReason({ HOME: "/c/Users/Me", KHEREP_PROFILE: "win", CLAUDE_HOME: "/c/users/me/.claude" }, "GITCONFIG"), "");
  // Git Bash passes a Windows-set CLAUDE_HOME through in drive form (measured on a Windows node).
  for (const drive of ["C:/Users/Me/.claude", "C:\\Users\\Me\\.claude", "c:/users/me/.claude/"]) {
    assert.equal(skipReason({ HOME: "/c/Users/Me", KHEREP_PROFILE: "win", CLAUDE_HOME: drive }, "GITCONFIG"), "", drive);
    assert.equal(skipReason({ HOME: "/c/Users/Me", KHEREP_PROFILE: "win", CLAUDE_HOME: drive }, "ATL_CREDENTIAL"), "", drive);
  }
  assert.notEqual(skipReason({ HOME: "/c/Users/Me", KHEREP_PROFILE: "win", CLAUDE_HOME: "D:/other/.claude" }, "GITCONFIG"), "");
  assert.notEqual(skipReason({ ...base, CLAUDE_HOME: "/tmp/candidate" }, "ATL_CREDENTIAL"), "");
  // The home never skips the space step; only the exact value 1 counts for every switch.
  assert.equal(skipReason({ ...base, CLAUDE_HOME: "/tmp/candidate" }, "KNOWLEDGE_SPACE"), "");
  for (const value of ["0", "", "yes", " 1"]) {
    assert.notEqual(skipReason({ ...base, CLAUDE_HOME: "/tmp/c", KHEREP_INSTALL_ALLOW_GITCONFIG: value }, "GITCONFIG"), "");
    assert.equal(skipReason({ ...base, CLAUDE_HOME: "/h/user/.claude", KHEREP_INSTALL_PREVIEW: value }, "GITCONFIG"), "");
  }
});
