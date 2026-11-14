import assert from "node:assert/strict";
import { test } from "node:test";

import { isToolApprovalTable, restoreToolApprovals } from "./tool-approval-tables.mts";
import { scanDocument, TomlStructureError } from "./toml-block-structure.mts";

// Issue #921. The shape of a tool approval table and how the operator's text
// takes the place of the one the managed block renders. Synthetic TOML only.

const last = (toml: string): boolean => isToolApprovalTable(scanDocument(toml).tables.at(-1)!);

test("a tool approval table holds at most approval_mode and output_token_limit, once each, on one line", () => {
  for (const toml of ["[mcp_servers.s.tools.t]", '[mcp_servers.s.tools.t]\napproval_mode = "approve"',
    "[mcp_servers.s.tools.t]\noutput_token_limit = 4_000", "[mcp_servers.s.tools.t] # header note\napproval_mode = 'prompt' # why",
    '[mcp_servers.s.tools.t]\n# a comment\n  approval_mode = "a-mode-codex-adds-later"\noutput_token_limit = 1\n',
    '[mcp_servers."server name".tools."tool.name"]\napproval_mode = "writes"', "[ mcp_servers . 's' . tools . 't' ]\napproval_mode = \"auto\""]) {
    assert.equal(last(toml), true, toml);
  }
  for (const toml of ['[mcp_servers.s.tools.t]\nenabled = false', '[mcp_servers.s.tools.t]\napproval_mode = "a"\napproval_mode = "b"',
    '[[mcp_servers.s.tools.t]]\napproval_mode = "approve"', '[[mcp_servers.s.tools]]\n[mcp_servers.s.tools.t]\napproval_mode = "approve"',
    '[mcp_servers.s.tools]\napproval_mode = "approve"', '[mcp_servers.s.tools.t.x]\napproval_mode = "approve"',
    '[mcp_servers.s.env]\nKEY = "value"', '[mcp_servers.s.tool.t]\napproval_mode = "approve"', '[other.s.tools.t]\napproval_mode = "approve"',
    '[mcp_servers.s.tools.t]\n"approval_mode" = "approve"', "[mcp_servers.s.tools.t]\napproval_mode.x = 1",
    "[mcp_servers.s.tools.t]\napproval_mode = { mode = 1 }", "[mcp_servers.s.tools.t]\noutput_token_limit = [1]",
    "[mcp_servers.s.tools.t]\noutput_token_limit = 1.5", "[mcp_servers.s.tools.t]\napproval_mode = '''\nprompt\n'''"]) {
    assert.equal(last(toml), false, toml);
  }
});

const START = "# >>> fixture >>>", END = "# <<< fixture <<<";
const RENDERED = '[mcp_servers.s.tools.t]\napproval_mode = "approve"';
const OPERATOR = '[mcp_servers.s.tools.t]\napproval_mode = "prompt"';
const BLOCK = [START, '[mcp_servers.s]\ncommand = "s"', "", RENDERED, "", '[mcp_servers.m]\ncommand = "m"', END, ""].join("\n");
const HELD = { path: ["mcp_servers", "s", "tools", "t"], text: OPERATOR };
const GONE = '[mcp_servers.gone.tools.x]\napproval_mode = "approve"';
const restore = (config: string, held = [HELD]) => restoreToolApprovals(config, START, END, held);

test("leaves a config without a block or without an operator copy as it is", () => {
  for (const config of ["a = 1\n", BLOCK, `${BLOCK}\n${GONE}\n`]) assert.equal(restore(config, []), config);
});

test("puts held text in the place of the table the block renders", () => {
  assert.equal(restore(BLOCK), BLOCK.replace(RENDERED, OPERATOR));
  assert.equal(restore(BLOCK.replace(RENDERED, OPERATOR)), BLOCK.replace(RENDERED, OPERATOR));
});

test("takes an operator copy before the start marker into the block and keeps its comment", () => {
  const config = `top = 1\n\n${OPERATOR} # mine\n# operator note\n\n${BLOCK}`;

  const result = restore(config, []);

  assert.equal(result, `top = 1\n\n# operator note\n\n${BLOCK.replace(RENDERED, `${OPERATOR} # mine`)}`);
});

test("appends held text behind the end marker when the block renders its server but not its table", () => {
  const text = '[mcp_servers.m.tools.y]\napproval_mode = "prompt"';
  const held = [{ path: ["mcp_servers", "m", "tools", "y"], text }];
  assert.equal(restore(BLOCK, held), `${BLOCK}\n${text}\n`);
  assert.equal(restore(`${BLOCK}\n\n[operator]\nkeep = 1\n\n`, held), `${BLOCK}\n${text}\n\n[operator]\nkeep = 1\n`);
  const outside = `${BLOCK}\n[mcp_servers.gone]\ncommand = "gone"\n`;
  assert.equal(restore(outside, [{ path: ["mcp_servers", "gone", "tools", "x"], text: GONE }]),
    `${BLOCK}\n${GONE}\n\n[mcp_servers.gone]\ncommand = "gone"\n`);
});

// A3: Codex refuses to start on a tools table whose server table is absent.
test("drops held text whose server the config no longer defines", () => {
  const held = [{ path: ["mcp_servers", "gone", "tools", "x"], text: GONE }];
  assert.equal(restore(BLOCK, held), BLOCK);
  assert.equal(restore(`${BLOCK}\n[operator]\nkeep = 1\n`, held), `${BLOCK}\n[operator]\nkeep = 1\n`);
});

test("drops a lifted table whose server the config defines nowhere, and only that one", () => {
  const lifted = [["mcp_servers", "gone", "tools", "x"]];
  const other = '[mcp_servers.other.tools.x]\napproval_mode = "approve"';
  assert.equal(restoreToolApprovals(`${BLOCK}\n${GONE}\n# operator note\n`, START, END, [], lifted), `${BLOCK}\n# operator note\n`);
  assert.equal(restoreToolApprovals(`${BLOCK}\n${GONE}\n\n${other}\n`, START, END, [], lifted), `${BLOCK}\n${other}\n`);
  assert.equal(restoreToolApprovals(`${BLOCK}\n${other}\n`, START, END, [], [["mcp_servers", "other", "tools", "y"]]), `${BLOCK}\n${other}\n`);
  const defined = `${BLOCK}\n${GONE}\n\n[mcp_servers.gone]\ncommand = "gone"\n`;
  assert.equal(restoreToolApprovals(defined, START, END, [], lifted), defined);
  assert.throws(() => restoreToolApprovals(`${BLOCK}\n${GONE}\n\n${GONE}\n`, START, END, [], lifted),
    /more than one copy of a tool approval table/);
});

test("refuses two operator copies of one table", () => {
  assert.throws(() => restore(`${BLOCK}\n${OPERATOR}\n`), /more than one copy of a tool approval table/);
  assert.throws(() => restore(`${BLOCK}\n${OPERATOR}\n\n${OPERATOR}\n`, []), /more than one copy of a tool approval table/);
});

test("leaves a document the scanner cannot follow as it is unless text is held", () => {
  const config = `${BLOCK}\n${OPERATOR}\nnote = "unterminated\n`;
  assert.equal(restore(config, []), config);
  assert.throws(() => restore(config), TomlStructureError);
});
