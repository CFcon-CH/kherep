import assert from "node:assert/strict";
import { test } from "node:test";

import { prepareManagedConfig } from "./config-preservation.mts";
import { legacyForm } from "./legacy-control-plane-form.mts";
import {
  BEFORE, END, FRESH, HEAD, OPTIONS, REFUSAL, START, TAIL, managedBlock, tomlDocument,
} from "./managed-block-split.fixture.mts";
import { render } from "./parity-config.mts";

// Issue #274. Measured on a Windows host: the Codex app, storing hook trust,
// rewrote config.toml so that its trust tables sit inside the managed block,
// the managed tail sits after the end marker, and the end marker separates the
// keys of one trust table. The TOML is the same document as a normal install.

const STATE_INSIDE = [
  "[hooks.state]", "",
  "[hooks.state.'fixture-a.toml:pre_tool_use:0:0']", 'trusted_hash = "sha256:fixture-a"', "",
  "[hooks.state.'fixture-b.json:stop:0:0']", 'trusted_hash = "sha256:fixture-b"',
].join("\n");
const SEPARATED_KEY = "enabled = false";
const STATE_BETWEEN = "[hooks.state.'fixture-c.toml:session_start:0:0']\ntrusted_hash = \"sha256:fixture-c\"";
const OPERATOR = '[operator_fixture]\nkeep = "operator-owned"';
const trust = (config: string) => Object.entries(tomlDocument(config).tables).filter(([address]) => address.startsWith("hooks.state"));

function split(tail: string, between = STATE_BETWEEN): string {
  return [BEFORE + START, HEAD, "", STATE_INSIDE, END, SEPARATED_KEY, "", between, "", tail, "", OPERATOR, ""].join("\n");
}

test("the split fixture holds the measured layout", () => {
  assert.match(TAIL, /^\[\[hooks\.SessionStart\]\]\nmatcher = "startup\|resume\|clear\|compact"/);
  assert.match(TAIL, /codex-control-plane-hook\.mts\\" \\"deliver/);
  assert.match(TAIL, /\[mcp_servers\.kherep_messaging\][^]*tool_timeout_sec = 60\.0$/);
  assert.match(HEAD, /\[\[hooks\.SubagentStart\.hooks\]\][^[]*$/);
  const config = split(TAIL);
  assert.deepEqual(tomlDocument(config).arrays, tomlDocument(FRESH).arrays);
  assert.deepEqual(tomlDocument(config).tables['hooks.state."fixture-b.json:stop:0:0"'],
    ['trusted_hash = "sha256:fixture-b"', SEPARATED_KEY]);
});

test("re-anchors a block whose tail the Codex app moved behind the end marker", () => {
  for (const between of [STATE_BETWEEN, ""]) {
    const config = split(TAIL, between);

    const result = prepareManagedConfig(config, OPTIONS);

    assert.equal(result.managedFragment, "replaced");
    assert.equal(managedBlock(result.config), managedBlock(FRESH));
    assert.deepEqual(tomlDocument(result.config), tomlDocument(config));
    // The tail went back into the block and left no copy behind.
    assert.equal(result.config.split("[mcp_servers.kherep_messaging]").length, FRESH.split("[mcp_servers.kherep_messaging]").length);
    assert.equal(result.config.split("codex-control-plane-hook.mts").length, FRESH.split("codex-control-plane-hook.mts").length);
    const after = result.config.slice(result.config.indexOf(END));
    assert.ok(after.includes(`${STATE_INSIDE}\n${SEPARATED_KEY}\n`));
    if (between) assert.ok(after.includes(between));
    assert.ok(result.config.endsWith(`\n\n${OPERATOR}\n`));

    const again = prepareManagedConfig(result.config, OPTIONS);
    assert.equal(again.managedFragment, "current");
    assert.equal(again.config, result.config);
  }
});

test("re-anchors a tail behind the end marker without trust tables", () => {
  const config = [BEFORE + START, HEAD, END, "", TAIL, ""].join("\n");

  const result = prepareManagedConfig(config, OPTIONS);

  assert.equal(result.managedFragment, "replaced");
  assert.equal(result.config, FRESH);
});

test("still keeps trust tables inside a block that holds the whole fragment", () => {
  for (const windowsHookCommands of [true, false]) {
    const fragment = render({ ...OPTIONS, mcpServers: [], windowsHookCommands }).trim();
    const config = [BEFORE + START, fragment, "", STATE_INSIDE, END, SEPARATED_KEY, ""].join("\n");

    const result = prepareManagedConfig(config, OPTIONS);

    assert.equal(result.managedFragment, windowsHookCommands ? "current" : "replaced");
    assert.ok(result.config.includes(render({ ...OPTIONS, mcpServers: [] }).trim()));
    assert.ok(result.config.includes(`${STATE_INSIDE}\n${END}\n${SEPARATED_KEY}\n`));
    assert.deepEqual(trust(result.config), trust(config));
    assert.equal(prepareManagedConfig(result.config, OPTIONS).managedFragment, "current");
  }
});

test("refuses a split block whose tail differs in one line", () => {
  const altered = TAIL.replace("startup_timeout_sec = 30.0", "startup_timeout_sec = 31.0");
  assert.notEqual(altered, TAIL);

  assert.throws(() => prepareManagedConfig(split(altered), OPTIONS), REFUSAL);
});

test("refuses a split block with an unknown table between the end marker and the tail", () => {
  assert.throws(() => prepareManagedConfig(split(TAIL, `${STATE_BETWEEN}\n\n${OPERATOR}`), OPTIONS), REFUSAL);
});

test("moves a key after the end marker only along with a trust table that ends the block", () => {
  // Trust tables in the middle of the block, a managed table last: in TOML a key
  // after the marker belongs to that managed table, so it must not move.
  const last = HEAD.lastIndexOf("[[hooks.SubagentStart]]");
  const middle = `${HEAD.slice(0, last)}${STATE_INSIDE}\n\n${HEAD.slice(last)}`;
  const layout = (key: string) =>
    [BEFORE + START, middle, END, ...(key ? [key] : []), "", STATE_BETWEEN, "", TAIL, ""].join("\n");

  assert.equal(prepareManagedConfig(layout(""), OPTIONS).managedFragment, "replaced");
  assert.throws(() => prepareManagedConfig(layout(SEPARATED_KEY), OPTIONS), REFUSAL);
});

test("refuses a split block whose head differs in one line", () => {
  const altered = HEAD.replace(/timeout = (\d+)/, (_, seconds) => `timeout = ${Number(seconds) + 1}`);
  assert.notEqual(altered, HEAD);

  assert.throws(() => prepareManagedConfig(split(TAIL).replace(HEAD, altered), OPTIONS), REFUSAL);
});

test("refuses a split block with CRLF line endings", () => {
  assert.throws(() => prepareManagedConfig(split(TAIL).replace(/\n/g, "\r\n"), OPTIONS), REFUSAL);
});

test("refuses a split block with unknown content left inside the block", () => {
  const config = split(TAIL).replace(`${HEAD}\n`, `${HEAD}\n\n${OPERATOR}\n`);

  assert.throws(() => prepareManagedConfig(config, OPTIONS), REFUSAL);
});

// Issue #397. A block written from an earlier source pin names that pin before
// the checkout hooks. The Codex app splits such a block as well, so the
// re-anchor has to know it; any other difference still refuses.
const PIN = String.raw`C:\\Synthetic\\.codex\\orchestra\\source-pins\\0123456789abcdef0123456789abcdef01234567`;
// Issue #503. An installer before the stable entry point wrote the pin into the hook commands.
const fromPin = (text: string): string =>
  legacyForm(text, String.raw`C:\Synthetic\.codex\orchestra\source-pins\0123456789abcdef0123456789abcdef01234567`);
const fromNode = (text: string): string =>
  text.replaceAll(String.raw`C:\\Program Files\\nodejs\\node.exe`, String.raw`D:\\Previous\\nodejs\\node.exe`);

test("re-anchors a split block written from an earlier source pin", () => {
  for (const earlier of [fromPin, (text: string) => fromNode(fromPin(text))]) {
    const config = earlier(split(TAIL));
    assert.ok(fromPin(HEAD) !== HEAD && fromPin(TAIL) !== TAIL, "the pin names both parts");

    const result = prepareManagedConfig(config, OPTIONS);

    assert.equal(result.managedFragment, "replaced");
    assert.equal(managedBlock(result.config), managedBlock(FRESH));
    assert.equal(result.config.includes(PIN), false, "no command names the earlier pin");
    assert.ok(result.config.endsWith(`\n\n${OPERATOR}\n`));
    assert.equal(prepareManagedConfig(result.config, OPTIONS).managedFragment, "current");
  }
});

test("refuses a split block from an earlier source pin with any other difference", () => {
  const timeout = (text: string) => text.replace(/timeout = (\d+)/, (_, seconds) => `timeout = ${Number(seconds) + 1}`);
  // No trailing separator: the fixture joins the next segment with "/" on POSIX hosts.
  const hookDir = (text: string) => text.replace(String.raw`C:\\Synthetic\\.codex\\hooks\\kherep-maestro`,
    String.raw`C:\\Synthetic\\other\\hooks\\kherep-maestro`);
  for (const edit of [timeout, hookDir]) {
    const config = fromPin(split(TAIL)).replace(fromPin(HEAD), edit(fromPin(HEAD)));
    assert.notEqual(config, fromPin(split(TAIL)));
    assert.throws(() => prepareManagedConfig(config, OPTIONS),
      REFUSAL);
  }
  const tail = fromPin(TAIL).replace("startup_timeout_sec = 30.0", "startup_timeout_sec = 31.0");
  assert.throws(() => prepareManagedConfig(fromPin(split(tail)), OPTIONS), REFUSAL);
});

// Issue #684 changed how the re-anchor finds the tables it moves. Every layout
// above that it accepts still yields the bytes it yielded before (b9a84e53).
test("re-anchors every #274 layout to the same bytes as before issue #684", () => {
  const last = HEAD.lastIndexOf("[[hooks.SubagentStart]]");
  const middle = `${HEAD.slice(0, last)}${STATE_INSIDE}\n\n${HEAD.slice(last)}`;
  const split274 = `${FRESH}\n${STATE_INSIDE}\n${SEPARATED_KEY}\n\n${STATE_BETWEEN}\n\n${OPERATOR}\n`;
  const cases: [string, string][] = [
    [split(TAIL), split274],
    [split(TAIL, ""), `${FRESH}\n${STATE_INSIDE}\n${SEPARATED_KEY}\n\n${OPERATOR}\n`],
    [[BEFORE + START, HEAD, END, "", TAIL, ""].join("\n"), FRESH],
    // The blank line after the end marker stays between the moved trust tables.
    [[BEFORE + START, middle, END, "", STATE_BETWEEN, "", TAIL, ""].join("\n"),
      `${FRESH}\n${STATE_INSIDE}\n\n\n${STATE_BETWEEN}\n`],
    [fromPin(split(TAIL)), split274],
    [fromNode(fromPin(split(TAIL))), split274],
  ];
  for (const [config, expected] of cases) assert.equal(prepareManagedConfig(config, OPTIONS).config, expected);
});

// Issue #906: a header path is parsed key by key instead of by a backtracking expression.
test("fixture headers take quoted and dotted keys and refuse anything else", () => {
  assert.deepEqual(tomlDocument("[a . \"b c\" . 'd.e']\nx = 1\n").tables, { 'a."b c"."d.e"': ["x = 1"] });
  for (const header of ["[a b]", "[a. ]"]) assert.throws(() => tomlDocument(`${header}\n`), /Not a fixture header/, header);
  const started = performance.now();
  assert.throws(() => tomlDocument(`[${" ".repeat(50_000)}]\n`), /Not a fixture header/);
  assert.ok(performance.now() - started < 200, "linear on a long blank header");
});
