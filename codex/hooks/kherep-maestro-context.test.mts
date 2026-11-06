import assert from "node:assert";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { test } from "node:test";
import { turnContext } from "./kherep-maestro-context.mts";


const hook = path.join(import.meta.dirname, "kherep-maestro-context.mts");

test("trailing separator runs preserve context scope", () => {
  assert.match(run({ hook_event_name: "SessionStart", cwd: "D:/Work/app///" }, { KHEREP_WORKSPACE: "D:/Work///" }).stdout, /KHEREP CODEX ORCHESTRA ACTIVE/);
  assert.strictEqual(run({ hook_event_name: "SessionStart", cwd: "D:/Work-copy///" }, { KHEREP_WORKSPACE: "D:/Work///" }).stdout, "");
});

function run(input: unknown, env: NodeJS.ProcessEnv = {}, args: string[] = []) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env, KHEREP_WORKSPACE: "", ...env };
  if (!Object.hasOwn(env, "KHEREP_WORKSPACE")) delete childEnv.KHEREP_WORKSPACE;
  return spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", hook, ...args], {
    input: typeof input === "string" ? input : JSON.stringify(input),
    encoding: "utf8",
    env: childEnv,
  });
}

{
  const result = run({
    hook_event_name: "SessionStart",
    cwd: "D:\\Work\\ForgeApps\\Alchemist-for-Jira",
  }, { KHEREP_WORKSPACE: "D:\\Work" });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /KHEREP CODEX ORCHESTRA ACTIVE/);
  assert.match(result.stdout, /\[Maestro on \| routing loaded \| evidence-first\]/);
  assert.match(result.stdout, /ROUTING\.md/);
  assert.match(result.stdout, /Astra for the main designer, SOL for builders and root/);
}

{
  const result = run({
    hook_event_name: "UserPromptSubmit",
    cwd: "/Users/example/Kherep/ForgeApps/Aegis-Pro",
  }, { KHEREP_WORKSPACE: "/Users/example/Kherep" });
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /MAESTRO TURN CHECK/);
  assert.match(result.stdout, /C1 correctness/);
  assert.match(result.stdout, /Never overlap writes/i);
  assert.match(result.stdout, /dispatch codex-obs once.*installed agent TOML.*fork_turns none/);
  assert.match(result.stdout, /the exact model and model_reasoning_effort from its installed agent TOML/);
  assert.doesNotMatch(result.stdout, /reasoning_effort low/);
  assert.match(result.stdout, /Luna extracts and publishes only through mcp__kherep_observations__publish_observations/);
  assert.doesNotMatch(result.stdout, /Before the final response, dispatch the codex-obs agent/);
}

{
  const result = run({
    hook_event_name: "SessionStart",
    cwd: "C:\\unrelated\\project",
  });
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
}

{
  const result = run(
    { hook_event_name: "SessionStart", cwd: "C:\\work\\private-repos\\app" },
    { KHEREP_WORKSPACE: "C:\\work\\private-repos" },
  );
  assert.strictEqual(result.status, 0);
  assert.match(result.stdout, /KHEREP CODEX ORCHESTRA ACTIVE/);
}

{
  const result = run(
    { hook_event_name: "SessionStart", cwd: "/Users/example/Kherep/project" },
    { HOME: "/Users/example", USERPROFILE: "" },
  );
  assert.match(result.stdout, /KHEREP CODEX ORCHESTRA ACTIVE/);
}

{
  const result = run(
    { hook_event_name: "SessionStart", cwd: "/work/worker/project" },
    { HOME: "/Users/example", KHEREP_WORKSPACE: "/Users/example/Kherep" },
  );
  assert.strictEqual(result.stdout, "");
}

{
  const result = run("not json");
  assert.strictEqual(result.status, 0);
  assert.strictEqual(result.stdout, "");
}

const payload = { hook_event_name: "UserPromptSubmit", cwd: "/synthetic/work/project" };
const workspaceEnv = { KHEREP_WORKSPACE: "/synthetic/work" };
const unavailable = "Observation turn identity unavailable. Maestro: continue the user task and its tools; pass this unavailable-identity condition to codex-obs. The observation WORKER must return OBS-ATTEMPT: failed missing-turn-identity detail=none publication=not-attempted created=none with no WORKER tool calls.";
const header = (sessionId: string, turnId: string) => JSON.stringify({ sessionId, turnId });

test("native stdin supplies exact bounded main-turn identity for the Luna brief", () => {
  for (const [sessionId, turnId] of [["main-session_1.2", "native-turn_3.4"], ["s".repeat(80), "t".repeat(80)]]) {
    const result = run({ ...payload, session_id: sessionId, turn_id: turnId }, workspaceEnv);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /MAESTRO TURN CHECK/);
    assert.ok(result.stdout.includes(header(sessionId, turnId)));
    assert.match(result.stdout, /copy.*verbatim.*Luna brief/i);
    assert.match(result.stdout, /dispatching MAIN turn.*not worker/i);
    assert.doesNotMatch(result.stdout, /identity unavailable/);
  }
});

for (const key of ["session_id", "turn_id"] as const) {
  test(`${key}: missing and invalid native identities fail safely without echo or repair`, () => {
    for (const value of [undefined, null, 42, {}, [], "", " ", " bad", "bad ", "bad\n", "bad\r", "bad\r\n", "bad\u2028", "bad\u2029", "<canary>", "UPPER", "a".repeat(81)]) {
      const result = run({ ...payload, session_id: "valid-session", turn_id: "valid-turn", [key]: value,
        prompt: "PROMPT_CANARY", transcript_path: "/TRANSCRIPT_CANARY", cwd: "/synthetic/work/CWD_CANARY" }, {
        ...workspaceEnv, CODEX_THREAD_ID: "environment-session", CODEX_TURN_ID: "environment-turn",
        session_id: "env-session", turn_id: "env-turn",
      });
      assert.strictEqual(result.status, 0);
      assert.ok(result.stdout.includes(unavailable));
      assert.match(result.stdout, /C1 correctness/);
      assert.doesNotMatch(result.stdout, /"sessionId"|"turnId"|CANARY|environment-|env-session|env-turn|valid-session|valid-turn|<canary>|UPPER/);
    }
  });
}

test("payloads never recover identity from history, aliases or nested input", () => {
  const first = turnContext({ session_id: "first-session", turn_id: "first-turn" });
  assert.ok(first.includes(header("first-session", "first-turn")));
  const next = turnContext({ session_id: "next-session", turnId: "alias-turn", input: { turn_id: "nested-turn" } });
  assert.ok(next.includes(unavailable));
  assert.doesNotMatch(next, /first-session|first-turn|next-session|alias-turn|nested-turn/);
  const processResult = run({ ...payload, sessionId: "alias-session", turnId: "alias-turn" }, workspaceEnv);
  assert.ok(processResult.stdout.includes(unavailable));
});

test("only the identity is copied from scoped native input; malformed and out-of-scope input stays quiet", () => {
  const valid = { ...payload, session_id: "main-session", turn_id: "main-turn", prompt: "PROMPT_CANARY",
    transcript_path: "/TRANSCRIPT_CANARY", cwd: "/synthetic/work/CWD_CANARY" };
  const result = run(valid, workspaceEnv);
  assert.ok(result.stdout.includes(header("main-session", "main-turn")));
  assert.doesNotMatch(result.stdout, /CANARY/);
  for (const input of ["{bad json", null, [], { ...valid, cwd: "/unrelated" }]) {
    const quiet = run(input, workspaceEnv);
    assert.strictEqual(quiet.status, 0);
    assert.strictEqual(quiet.stdout, "");
    assert.strictEqual(quiet.stderr, "");
  }
});

const explicitWorkspace = path.resolve("/synthetic/bound space ' $() `tick/Ünicode");
const binding = ["--workspace-b64", Buffer.from(explicitWorkspace).toString("base64url")];
test("explicit binding overrides missing, empty and conflicting ambient workspace for both context events", () => {
  for (const event of ["SessionStart", "UserPromptSubmit"]) for (const env of [{}, { KHEREP_WORKSPACE: "" }, { KHEREP_WORKSPACE: path.resolve("/conflicting") }]) {
    for (const cwd of [explicitWorkspace, path.join(explicitWorkspace, "child")]) {
      const result = run({ hook_event_name: event, cwd, session_id: "native-main", turn_id: "native-turn", prompt: "PROMPT_CANARY", extra: "EXTRA_CANARY" }, env, binding);
      assert.strictEqual(result.status, 0);
      assert.strictEqual(result.stderr, "");
      assert.match(result.stdout, event === "SessionStart" ? /KHEREP CODEX ORCHESTRA ACTIVE/ : /MAESTRO TURN CHECK/);
      assert.doesNotMatch(result.stdout, /CANARY|bound space|workspace-b64|Ünicode/);
      if (event === "UserPromptSubmit") assert.ok(result.stdout.includes(header("native-main", "native-turn")));
    }
    for (const cwd of [explicitWorkspace + "-sibling", path.resolve("/conflicting/child"), undefined])
      assert.strictEqual(run({ hook_event_name: event, cwd }, env, binding).stdout, "");
  }
});
test("malformed explicit binding is quiet with no ambient fallback", () => {
  const encode = (value: string) => Buffer.from(value).toString("base64url");
  const malformed = [["--workspace-b64"], ["--unknown", binding[1]], [...binding, "extra"], [...binding, ...binding],
    ["--workspace-b64", ""], ["--workspace-b64", binding[1] + "="], ["--workspace-b64", "%%%"], ["--workspace-b64", "L3h"],
    ...["relative", "", explicitWorkspace + "\n", explicitWorkspace + "\r", explicitWorkspace + "\0"].map(value => ["--workspace-b64", encode(value)]),
    ["--workspace-b64", Buffer.from([0xff]).toString("base64url")]];
  for (const args of malformed) {
    const result = run({ hook_event_name: "SessionStart", cwd: explicitWorkspace }, { KHEREP_WORKSPACE: explicitWorkspace }, args);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout, "", JSON.stringify(args));
    assert.strictEqual(result.stderr, "");
  }
});
