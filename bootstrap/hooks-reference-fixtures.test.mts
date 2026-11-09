// Issues #587 and #588. Fixtures for the rules of bootstrap/hooks-reference.mts:
// the command classifier, the singleCommand copy, the docs/HOOKS.md table parser
// and the README link rule. bootstrap/hooks-reference.test.mts applies them to
// the repository.
import assert from "node:assert/strict";
import { test } from "node:test";

import { sameEntryPath } from "../claude/hooks/lib/hook-inventory.mts";
import {
  cellProblems, cellsOf, classify, type Classified, HEADER, HOME, readmeLinkProblems, referenceRows, REPO, type Row,
  singleCommand, templateCommands, wiredAlone,
} from "./hooks-reference.mts";

const WRAPPER = `node "${HOME}/kherep/hook-runtime/entry.mts"`;
const LOC = `"${HOME}/hooks/loc-watch.mts"`;
const CP = `${REPO}/modules/control-plane/node`;
const stemsOf = (result: Classified): string[] | undefined => ("stems" in result ? result.stems : undefined);
const errorOf = (result: Classified): string => ("error" in result ? result.error : "");

test("the classifier accepts the coordinated wrapper and a direct Control Plane script", () => {
  assert.deepEqual(stemsOf(classify("PostToolUse", `${WRAPPER} reader ${LOC}`)), ["loc-watch"]);
  const guards = ["guard-dispatch", "privacy-boundary-guard", "secret-output-guard", "playwright-file-guard"];
  assert.deepEqual(stemsOf(classify("PreToolUse", `${WRAPPER} pretool ${guards.map((g) => `"${HOME}/hooks/${g}.mts"`).join(" ")}`)), guards);
  assert.deepEqual(stemsOf(classify("SessionStart", `${WRAPPER} writer "${HOME}/hooks/live-hook-integrity.mts"`)), ["live-hook-integrity"]);
  assert.deepEqual(classify("Stop", `node "${CP}/wake-hook.mts" --timeout 86400`), { stems: ["wake-hook"], controlPlane: true });
  // Issue #592. The stable entry under the Claude home, named with the hook it runs.
  assert.deepEqual(classify("Stop", 'node "/synthetic/claude/kherep/control-plane/claude-control-plane-hook.mts" wake --timeout 86400'),
    { stems: ["claude-control-plane-hook", "wake-hook"], controlPlane: true });
  const stable = templateCommands("claude/settings.user.json").filter(({ command }) => command.includes("/kherep/control-plane/claude-control-plane-hook.mts"));
  assert.equal(stable.length, 9, "the template wires the stable entry nine times");
  const expansion = stable.filter(({ event }) => event === "UserPromptExpansion");
  assert.equal(expansion.length, 1);
  assert.deepEqual(classify(expansion[0].event, expansion[0].command),
    { stems: ["claude-control-plane-hook", "deliver-hook"], controlPlane: true });
  for (const { event, command } of stable) {
    assert.equal((classify(event, command) as { controlPlane?: boolean }).controlPlane, true, command);
  }
});

test("the classifier rejects uncoordinated managed hook commands and foreign wrappers", () => {
  for (const command of [
    `node "${HOME}/kherep/other/entry.mts" reader ${LOC}`, `node ${LOC}`, `${WRAPPER} run ${LOC}`, `${WRAPPER} reader ${LOC} && echo x`,
    `node "/synthetic/workspace/tools/entry.mts" reader ${LOC}`, `node "${HOME}/hooks/lib/entry.mts" reader ${LOC}`,
  ]) {
    const result = classify("PostToolUse", command);
    assert.equal(stemsOf(result), undefined, command);
    assert.equal(errorOf(result), `uncoordinated managed hook command under PostToolUse: ${command}`);
  }
});

test("the classifier rejects commands that are neither form", () => {
  for (const command of [
    `${WRAPPER} reader`, `${WRAPPER} reader "${HOME}/kherep/x.mts"`, `node "${REPO}/modules/other/x.mts"`, WRAPPER,
    `node ${REPO}/modules/other/new-hook.mts ${CP}/wake-hook.mts`, `"${CP}/wake-hook.mts"`,
    `node "${CP}/wake-hook.mts".js`, `node "${CP}/wake-hook.mts"x --timeout 86400`, `node"" "${CP}/wake-hook.mts"`,
    `node "${HOME}/kherep/control-plane/claude-control-plane-hook.mts"`, `node "${HOME}/kherep/control-plane/claude-control-plane-hook.mts" other`,
    `node "${HOME}/kherep/control-plane/claude-control-plane-hook.mts" deliver && echo x`,
  ]) assert.equal(errorOf(classify("Stop", command)), `unclassified wired command under Stop: ${command}`);
  for (const command of [`node "${CP}/wake-hook.mts" --timeout 86400 && node x.mts`, `node "${CP}/deliver-hook.mts"; rm -rf /`]) {
    assert.equal(errorOf(classify("Stop", command)), `unclassified wired command under Stop: ${command} (runs more than one shell command)`);
  }
});

test("the singleCommand copy agrees with the original through wiredFiles", () => {
  const cases: [string, boolean][] = [["", true], [" --timeout 86400", true], [' "R&D"', true], [" && echo x", false],
    ["; echo x", false], [" | cat", false], [" > out", false], ["\n echo x", false], ["`", false], [" $(x)", false], [' \\"', false]];
  for (const [suffix, single] of cases) {
    const command = `${WRAPPER} reader ${LOC}${suffix}`;
    assert.equal(singleCommand(command), single, JSON.stringify(suffix));
    assert.equal(wiredAlone("PostToolUse", command).uncoordinated.length > 0, !single, JSON.stringify(suffix));
  }
});

test("the entry path is case-folded on win32 only", () => {
  const entry = `${HOME}/kherep/hook-runtime/entry.mts`;
  assert.equal(sameEntryPath(`${HOME}/kherep/hook-runtime/Entry.mts`, entry, "linux"), false);
  assert.equal(sameEntryPath(`${HOME}/kherep/hook-runtime/Entry.mts`, entry, "win32"), true);
});

const SEPARATOR = "|---|---|---|---|---|";
const ROW = "| `loc-watch` | Claude, Codex | PostToolUse | watcher (warns) | Warns about long files. |";
const TABLE = `${HEADER}\n${SEPARATOR}\n${ROW}\n`;
const FAKE = "| `fake-hook` | Claude | Stop | gate | x |";
const stems = (text: string): string[] => referenceRows(text).map((row) => row.stem);

test("a reference row claims a stem only in its first cell, inside the one table", () => {
  assert.deepEqual(stems(`The \`fake-hook\` hook is prose.\n\n${TABLE}`), ["loc-watch"]);
  assert.deepEqual(stems(`${TABLE}| \`a\` \`b\` | Claude | Stop | gate | x |\n| \`a\` hook | Claude | Stop | gate | x |\n`), ["loc-watch"]);
  assert.deepEqual(referenceRows(TABLE.replace(/\n/g, "\r\n")), [{ stem: "loc-watch", cells: cellsOf(ROW) }]);
  assert.deepEqual(stems(`\`\`\`\n${FAKE}\n\`\`\`\n${TABLE}`), ["loc-watch"]);
  assert.deepEqual(stems(`${TABLE}\n${FAKE}\n`), ["loc-watch"]);
  assert.throws(() => referenceRows(`${TABLE}\n${TABLE}`), /found 2/);
  assert.throws(() => referenceRows("no table"), /found 0/);
});

test("fences follow CommonMark: same character, at least as long, nothing after it", () => {
  const fakeTable = `${HEADER}\n${SEPARATOR}\n${FAKE}`;
  assert.deepEqual(stems(`\`\`\`\`\n\`\`\`\n${fakeTable}\n\`\`\`\`\n${TABLE}`), ["loc-watch"]);
  assert.deepEqual(stems(`~~~\n\`\`\`\n${fakeTable}\n~~~\n${TABLE}`), ["loc-watch"]);
  assert.deepEqual(stems(`\`\`\`\nx\n\`\`\`   \n${TABLE}`), ["loc-watch"]);
  assert.throws(() => referenceRows(`\`\`\`\nx\n\`\`\`x\n${TABLE}`), /found 0/);
});

test("cells split on unescaped pipes and follow the vocabulary", () => {
  const escaped = referenceRows(`${HEADER}\n${SEPARATOR}\n| \`main-checkout-guard\` | Claude, Codex | PreToolUse Bash\\|PowerShell, shell dispatcher | blocking guard | Blocks. |\n`)[0]!;
  assert.equal(escaped.cells.length, 5);
  assert.equal(escaped.cells[2], "PreToolUse Bash|PowerShell, shell dispatcher");
  assert.deepEqual(cellProblems(escaped, ["Claude", "Codex"]), []);
  const unescaped = referenceRows(`${HEADER}\n${SEPARATOR}\n| \`main-checkout-guard\` | Claude | PreToolUse Bash|PowerShell | blocking guard | Blocks. |\n`)[0]!;
  assert.equal(unescaped.cells.length, 6);
  assert.match(cellProblems(unescaped).join("\n"), /row main-checkout-guard: 6 cells/);
  const row = (cells: string): Row => referenceRows(`${HEADER}\n${SEPARATOR}\n| \`x\` | ${cells} |\n`)[0]!;
  assert.match(cellProblems(row("Claude | Stop | guard | x")).join(), /Kind "guard"/);
  assert.match(cellProblems(row("Claude, Jira | Stop | gate | x")).join(), /Runtime "Claude, Jira"/);
  assert.match(cellProblems(row("Claude | Stop | gate | x"), ["Codex"]).join(), /must contain Codex/);
  assert.match(cellProblems(row("Claude |  | gate | ")).join("\n"), /Event is empty[\s\S]*What it does is empty/);
});

test("the README links must target docs/HOOKS.md itself, an anchor allowed", () => {
  const readme = (doc: string, security: string): string =>
    `# K\n\n## Security model\n\n- Guards. The list is in the ${security}.\n\n## Documentation\n\n| Guide | Purpose |\n| --- | --- |\n${doc}\n`;
  const DOC = "| [Hook reference](docs/HOOKS.md) | Every hook |";
  assert.deepEqual(readmeLinkProblems(readme(DOC, "[hook reference](docs/HOOKS.md)")), []);
  assert.deepEqual(readmeLinkProblems(readme(DOC, "[hook reference](docs/HOOKS.md#top)").replace(/\n/g, "\r\n")), []);
  assert.deepEqual(readmeLinkProblems(readme(DOC, "[hook reference](docs/HOOKS.md.bak)")),
    ["README.md: the Security model section needs a link to docs/HOOKS.md"]);
  assert.deepEqual(readmeLinkProblems(readme("| [Hook reference](docs/HOOKS.md.bak) | Every hook |", "[hook reference](docs/HOOKS.md)")),
    ["README.md: the Documentation table needs a row linking docs/HOOKS.md"]);
  assert.deepEqual(readmeLinkProblems(readme(DOC, "hook reference")), ["README.md: the Security model section needs a link to docs/HOOKS.md"]);
});
