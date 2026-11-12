import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { readLeadDirective, isLeadAppointment } from "./codex-lead-directive.mts";
import { findAssignmentRollout } from "./codex-app.mts";

const ID = "11111111-1111-4111-8111-111111111111", TURN = "22222222-2222-4222-8222-222222222222";
const command = "du bist absofort Kherep-Lead";
const header = { type: "session_meta", payload: { id: ID, originator: "Codex Desktop", source: "vscode" } };
const start = () => ({ type: "event_msg", payload: { type: "task_started", turn_id: TURN, root_turn_id: TURN,
  turn_attribution: { turn_id: TURN, turn_trigger: "user" } } });
const user = (text = command, order = 1) => ({ type: "response_item", metadata: { user_input_order: order },
  payload: { type: "message", role: "user", content: [{ type: "input_text", text }],
    internal_chat_message_metadata_passthrough: { turn_id: TURN, content_item_kinds: ["user.text"], content_item_metadata: [{ provenance: { type: "user" } }] } } });

function syntheticHome(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-lead-identity-")), home = path.join(root, "home");
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "2026", "11", "08");fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-synthetic-${ID}.jsonl`);
  fs.writeFileSync(file, [header, start(), user()].map(row => JSON.stringify(row)).join("\n") + "\n");
  return { root, home, file, read: () => readLeadDirective(home, ID, TURN) };
}

test("Lead identity snapshots preserve stable witnesses and accepted home aliases", t => {
  const { root, home, read } = syntheticHome(t), witness = read();assert.ok(witness);assert.equal(read(), witness);
  const alias = path.join(root, "alias");fs.symlinkSync(home, alias, "dir");
  assert.equal(readLeadDirective(alias, ID, TURN), null, "plain final home symlink already refuses");
  const ancestor = path.join(root, "ancestor");fs.symlinkSync(root, ancestor, "dir");
  assert.equal(readLeadDirective(path.join(ancestor, "home"), ID, TURN), witness);
});

// Trailing-separator lstat alias semantics are measured only for the Mac route.
test("Lead identity snapshots preserve Mac trailing home aliases", { skip: process.platform !== "darwin" ? "Mac alias semantics only" : false }, t => {
  const { root, home, read } = syntheticHome(t), witness = read();assert.ok(witness);
  const alias = path.join(root, "alias");fs.symlinkSync(home, alias, "dir");
  assert.equal(readLeadDirective(alias + path.sep, ID, TURN), witness);
  assert.equal(readLeadDirective(alias + path.sep + ".", ID, TURN), witness);
});

function directoryExchange(t: TestContext, level: "sessions" | "year" | "home", phase: "before-open" | "after-read") {
  const { home, file, read } = syntheticHome(t), originalOpen = fs.openSync, originalRead = fs.readSync;
  assert.ok(read(), "fixture starts with a valid witness");
  const parent = level === "home" ? home : path.join(home, "sessions", ...(level === "year" ? ["2026"] : []));
  const child = level === "home" ? "sessions" : level === "sessions" ? "2026" : "11";
  const canonical = fs.realpathSync(file);
  const beforeFile = fs.statSync(file, { bigint: true }), beforeParent = fs.statSync(parent, { bigint: true });
  let attempts = 0, completed = false, stage = "rename-parent";
  let fixtureError: { stage: string; code: string | null; syscall: string | null } | null = null;
  const exchange = () => {
    if (attempts > 0) return;
    attempts++;
    try {
      fs.renameSync(parent, parent + ".saved");
      stage = "mkdir-parent";fs.mkdirSync(parent);
      stage = "move-child";
      fs.renameSync(path.join(parent + ".saved", child), path.join(parent, child));
      completed = true;
    } catch (error) {
      const failure = error as NodeJS.ErrnoException;
      fixtureError = { stage, code: typeof failure.code === "string" ? failure.code : null,
        syscall: typeof failure.syscall === "string" ? failure.syscall : null };
      throw error;
    }
  };
  if (phase === "before-open") t.mock.method(fs, "openSync", (...args: any[]) => {
    if (args[0] === file) exchange();
    return (originalOpen as (...args: any[]) => number)(...args);
  });
  else t.mock.method(fs, "readSync", (...args: any[]) => {
    const result = (originalRead as (...args: any[]) => number)(...args);
    exchange();
    return result;
  });
  const result = read();t.mock.restoreAll();
  // The reader catches filesystem exceptions, so fixture failures must surface here.
  assert.deepEqual(fixtureError, null, "directory exchange fixture failed (stage/code/syscall)");
  assert.equal(attempts, 1);assert.equal(completed, true);
  const afterFile = fs.statSync(file, { bigint: true }), afterParent = fs.statSync(parent, { bigint: true });
  const identity = (stat: fs.BigIntStats) => [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs, stat.nlink];
  assert.deepEqual(identity(afterFile), identity(beforeFile));assert.equal(afterFile.nlink, 1n);
  assert.notDeepEqual([afterParent.dev, afterParent.ino], [beforeParent.dev, beforeParent.ino]);
  assert.equal(fs.realpathSync(file), canonical);assert.equal(findAssignmentRollout(home, ID), file);
  assert.equal(result, null, "reader must refuse the completed directory exchange");
}

for (const level of ["sessions", "year", "home"] as const) {
  test(`Lead reader refuses ${level} directory exchange with surviving file identity`, t => directoryExchange(t, level, "before-open"));
  test(`Lead reader refuses Mac ${level} directory exchange while the file is open`,
    { skip: process.platform !== "darwin" ? "Mac read-while-open semantics only" : false }, t => directoryExchange(t, level, "after-read"));
}

const invalidIdentities = [
  { label: "missing inode", fields: { ino: undefined } },
  { label: "zero inode", fields: { ino: 0n } },
  { label: "negative inode", fields: { ino: -1n } },
  { label: "non-bigint inode", fields: { ino: 1 } },
  { label: "missing device", fields: { dev: undefined } },
  { label: "non-bigint device", fields: { dev: 1 } },
];
for (const phase of ["initial", "final"] as const) for (const fault of invalidIdentities)
  test(`Lead reader refuses ${phase} parent ${fault.label}`, t => {
    const { home, read } = syntheticHome(t), originalLstat = fs.lstatSync;
    let snapshots = 0;
    t.mock.method(fs, "lstatSync", (...args: any[]) => {
      const stat = (originalLstat as (...args: any[]) => any)(...args);
      if (args[0] === path.join(home, "sessions") && args[1]?.bigint) {
        snapshots++;
        if (phase === "initial" || snapshots > 1) return Object.assign(Object.create(stat), fault.fields);
      }
      return stat;
    });
    assert.equal(read(), null);assert.ok(snapshots > 0);
  });

test("Lead reader refuses a parent identity change observed only at the final snapshot", t => {
  const { home, read } = syntheticHome(t), originalLstat = fs.lstatSync;
  let snapshots = 0;
  t.mock.method(fs, "lstatSync", (...args: any[]) => {
    const stat = (originalLstat as (...args: any[]) => any)(...args);
    if (args[0] === path.join(home, "sessions") && args[1]?.bigint && ++snapshots > 1)
      return Object.assign(Object.create(stat), { ino: stat.ino + 1n });
    return stat;
  });
  assert.equal(read(), null);assert.equal(snapshots, 2);
});

for (const fault of invalidIdentities) test(`Lead reader refuses matching file stats with ${fault.label}`, t => {
  const { file, read } = syntheticHome(t), originalFstat = fs.fstatSync, originalLstat = fs.lstatSync;
  t.mock.method(fs, "fstatSync", (...args: any[]) => {
    const stat = (originalFstat as (...args: any[]) => any)(...args);
    return args[1]?.bigint ? Object.assign(Object.create(stat), fault.fields) : stat;
  });
  t.mock.method(fs, "lstatSync", (...args: any[]) => {
    const stat = (originalLstat as (...args: any[]) => any)(...args);
    return args[0] === file && args[1]?.bigint ? Object.assign(Object.create(stat), fault.fields) : stat;
  });
  assert.equal(read(), null);
});

test("Lead reader accepts device zero with available positive inode identities", t => {
  const { read } = syntheticHome(t), originalFstat = fs.fstatSync, originalLstat = fs.lstatSync;
  for (const [method, original] of [["fstatSync", originalFstat], ["lstatSync", originalLstat]] as const)
    t.mock.method(fs, method, (...args: any[]) => {
      const stat = (original as (...args: any[]) => any)(...args);
      return args[1]?.bigint ? Object.assign(Object.create(stat), { dev: 0n }) : stat;
    });
  assert.ok(read());
});

for (const scenario of [
  { days: 62, duplicate: false, allowed: true },
  { days: 62, duplicate: true, allowed: false },
  { days: 63, duplicate: false, allowed: false },
  { days: 63, duplicate: true, allowed: false },
]) test(`Lead locator budget: ${scenario.days} date directories, ${scenario.duplicate ? "conflicting duplicate" : "one candidate"}`, t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-lead-locator-budget-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dirs = Array.from({ length: scenario.days }, (_, i) => {
    const date = new Date(Date.UTC(2026, 10, 8 - i)).toISOString().slice(0, 10).split("-");
    const dir = path.join(home, "sessions", ...date);fs.mkdirSync(dir, { recursive: true });return dir;
  });
  const write = (dir: string, rows: unknown[]) => fs.writeFileSync(path.join(dir, `rollout-synthetic-${ID}.jsonl`), rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  write(dirs[0]!, [header, start(), user()]);
  if (scenario.duplicate) write(dirs.at(-1)!, [header, start(), user(), user("Please check tests.", 2)]);
  const locatorFound = findAssignmentRollout(home, ID) !== null;
  const readerAllowed = readLeadDirective(home, ID, TURN) !== null;
  assert.deepEqual({ locatorFound, readerAllowed }, { locatorFound: scenario.allowed, readerAllowed: scenario.allowed });
});

test("whole-message appointment grammar accepts only documented direct forms", () => {
  for (const text of [command, "Du bist ab sofort Kherep-Lead.", "Übernimm jetzt die Rolle Kherep-Lead.", "You are now Kherep-Lead!", "DU BIST AB SOFORT KHEREP-LEAD"])
    assert.equal(isLeadAppointment(text), true, text);
  for (const text of [`\"${command}\"`, `\`${command}\``, `> ${command}`, `\`\`\`\n${command}\n\`\`\``, `${command}?`, `${command}\n`, `If ${command}`, `Nicht ${command}`, `${command}, aber nicht jetzt`, "Du bist ab sofort codex-mac.", "Alice ist ab sofort Kherep-Lead.", `Example: ${command}`, `${command}!!`])
    assert.equal(isLeadAppointment(text), false, text);
});

test("bounded native reader uses positive original/current/direct provenance and local witness", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-lead-reader-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "2026", "11", "08");fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-synthetic-${ID}.jsonl`);
  const write = (rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const read = () => readLeadDirective(home, ID, TURN);
  write([header, start(), user()]);const allowed = read();assert.ok(allowed);
  write([header, start(), user(), { type: "response_item", payload: { type: "function_call_output", output: command } }]);
  assert.equal(read(), allowed);
  const mutate = (fn: (rows: any[]) => void) => { const rows = [header, start(), user()];fn(rows);write(rows);assert.equal(read(), null); };
  mutate(rows => { rows[1].payload.turn_attribution.turn_trigger = "queue"; });
  mutate(rows => { rows[1].payload.turn_attribution.turn_id = "other"; });
  mutate(rows => { rows[1].payload.root_turn_id = "other"; });
  mutate(rows => { rows[1].payload.turn_attribution.parent_turn_id = "other"; });
  mutate(rows => { delete rows[1].payload.turn_attribution; });
  mutate(rows => { rows[2].payload.content[0].text = "Please check tests."; });
  mutate(rows => { rows.push(user("Stop.", 2)); });
  mutate(rows => { rows.push(user(command, 2)); });
  mutate(rows => { rows.push(user(command, 1)); });
  mutate(rows => { rows[2].metadata.user_input_order = Number.MAX_SAFE_INTEGER + 1; });
  mutate(rows => { rows[2].metadata.user_input_order = -1; });
  mutate(rows => { rows[2].payload.content[0] = { type: "input_image", image_url: "https://example.invalid/synthetic" }; });
  mutate(rows => { rows[2].payload.internal_chat_message_metadata_passthrough.content_item_kinds = ["tool.text"]; });
  mutate(rows => { rows[2].payload.internal_chat_message_metadata_passthrough.content_item_metadata[0].provenance.type = "unknown"; });
  mutate(rows => { rows[2].metadata.inherited_user_message = true; });
  mutate(rows => { rows[2].metadata.sender_user_messages = {}; });
  mutate(rows => { rows[2].payload.internal_chat_message_metadata_passthrough.turn_id = "other"; });
  mutate(rows => { rows[2].payload.internal_chat_message_metadata_passthrough.content_item_metadata[0].provenance.type = "tool"; });
  mutate(rows => { delete rows[2].payload.internal_chat_message_metadata_passthrough.content_item_metadata; });
  mutate(rows => { rows.push({ type: "event_msg", payload: { type: "user_message", message: "New input pending." } }); });
  mutate(rows => { rows.push({ type: "event_msg", payload: { type: "user_message", message: command } }); });
  mutate(rows => { rows.push({ type: "event_msg", payload: { type: "task_complete", turn_id: TURN } }); });
  mutate(rows => { rows.push({ type: "compacted", payload: {} }); });
  mutate(rows => { rows.push({ type: "future_user_input", payload: { text: command } }); });
  mutate(rows => { rows.push({ type: "response_item", payload: { type: "future_user_message", role: "user" } }); });
  mutate(rows => { rows.push({ type: "event_msg", payload: { ...start().payload, turn_id: "newer" } }); });
  write([header, start(), user(), { ...user(command, 100), payload: { ...user().payload,
    internal_chat_message_metadata_passthrough: { turn_id: TURN, content_item_kinds: ["tool.text"], content_item_metadata: [{ provenance: { type: "tool" } }] } } }]);
  assert.ok(read(), "explicit tool provenance with a larger host order is not another human command");
  write([header, start(), user(command, 100), user("Neutral later human", 1)]);assert.equal(read(), null, "physical row order cannot authorize an ambiguous steer");
  write([header, start(), { type: "event_msg", payload: { type: "user_message", message: command } }, user()]);assert.ok(read());
  fs.appendFileSync(file, '{"type":');assert.equal(read(), null);
  write([header, start(), user()]);fs.appendFileSync(file, Buffer.from([0xff, 0x0a]));assert.equal(read(), null);
  write([header, start(), user()]);fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace('"role":"user"', '"role":"tool","role":"user"'));assert.equal(read(), null);
  write([header, start(), user()]);fs.writeFileSync(path.join(dir, `rollout-duplicate-${ID}.jsonl`), fs.readFileSync(file));assert.equal(read(), null);
  fs.unlinkSync(path.join(dir, `rollout-duplicate-${ID}.jsonl`));
  fs.renameSync(file, file + ".saved");fs.symlinkSync(file + ".saved", file);assert.equal(read(), null);
  fs.unlinkSync(file);fs.renameSync(file + ".saved", file);
  fs.renameSync(dir, dir + "-saved");fs.symlinkSync(dir + "-saved", dir);assert.equal(read(), null);
});

test("Lead reader refuses descriptor mutation, path replacement, read bounds and absent boundaries", t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-lead-fs-"));t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, "sessions", "2026", "11", "08");fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-synthetic-${ID}.jsonl`), saved = file + ".saved";
  const write = (rows: unknown[]) => fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
  const read = () => readLeadDirective(home, ID, TURN);
  const originalRead = fs.readSync;
  for (const fault of ["append", "replace", "truncate", "symlink"] as const) {
    write([header, start(), user()]);let once = true;
    t.mock.method(fs, "readSync", (...args: any[]) => {
      const result = (originalRead as (...args: any[]) => number)(...args);
      if (once) {
        once = false;
        if (fault === "append") fs.appendFileSync(file, JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "Newer pending input" } }) + "\n");
        if (fault === "truncate") fs.truncateSync(file, 0);
        if (fault === "replace" || fault === "symlink") { fs.renameSync(file, saved);if (fault === "symlink") fs.symlinkSync(saved, file);else write([header, start(), user()]); }
      }
      return result;
    });
    assert.equal(read(), null);t.mock.restoreAll();
    if (fs.existsSync(saved)) { fs.unlinkSync(file);fs.renameSync(saved, file); }
  }
  write([header, user()]);assert.equal(read(), null);
  write([header, start(), user(), ...Array.from({ length: 4200 }, () => ({ type: "response_item", payload: { type: "function_call_output", output: "synthetic" } }))]);assert.equal(read(), null);
  write([header, start(), user(), ...Array.from({ length: 40 }, () => ({ type: "response_item", payload: { type: "function_call_output", output: "x".repeat(64 * 1024) } }))]);assert.equal(read(), null);
  write([header, { type: "response_item", payload: { type: "function_call_output", output: "x".repeat(3 * 1024 * 1024) } }, start(), user()]);assert.ok(read(), "older megabytes need not enter the selected tail");
});
