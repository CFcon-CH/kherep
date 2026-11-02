// OP-1432. The observation agent definition is loaded by two runtimes, and on
// 2026-09-24 the Claude one followed the Codex worker branch (returned a JSON
// candidate, wrote nothing) and once picked the Codex broker. Each runtime now
// gets its own text; this test pins what each one is allowed to say.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { renderAgent } from "../codex/lib/component-render.mts";
import type { Capabilities } from "../codex/lib/contracts.mts";
import { agentSourcePath } from "../codex/lib/parity-projection.mts";
import { OBS_BRIEF_FORMAT, OBS_BRIEF_REVISION } from "../claude/hooks/lib/obs-brief-policy.mts";

const REPO = path.resolve(import.meta.dirname, "..");
const CLAUDE_OBS = fs.readFileSync(path.join(REPO, "claude", "agents", "claude-obs.md"), "utf8");
const capabilities = JSON.parse(
  fs.readFileSync(path.join(REPO, "codex", "parity", "capabilities.json"), "utf8"),
) as Capabilities;

function codexProjection(): string {
  const options = capabilities.agents["claude-obs"];
  const source = fs.readFileSync(agentSourcePath(REPO, "claude-obs", options), "utf8");
  const toml = renderAgent(options.as || "claude-obs", source, options);
  const line = toml.split("\n").find((entry) => entry.startsWith("developer_instructions = "))!;
  return JSON.parse(line.slice("developer_instructions = ".length)) as string;
}

test("the Claude text names exactly the ccoder broker invocation", () => {
  assert.match(CLAUDE_OBS, /<confluence\.json broker> <verb>/);
  for (const verb of ["related", "create", "stitch", "children"]) {
    assert.match(CLAUDE_OBS, new RegExp(`^ +<confluence\\.json broker> ${verb} `, "m"), verb);
  }
  assert.match(CLAUDE_OBS, /`broker`[\s\S]{0,300}atl-confluence-ccoder\.mts/);
  assert.doesNotMatch(CLAUDE_OBS, /<broker>/, "a placeholder broker name lets the model pick one");
});

// Issue #13. The installed text kept a literal <workspace>, the model guessed
// the checkout instead of the workspace root and reported a missing broker.
test("the Claude text takes the broker only from confluence.json, verbatim", () => {
  assert.doesNotMatch(CLAUDE_OBS, /<workspace>/);
  const composed = CLAUDE_OBS.split(/\r?\n/).filter((line) => /^ {4}node /.test(line));
  assert.deepEqual(composed, [], "a command line composes the broker itself");
  assert.match(CLAUDE_OBS, /exactly as stored/i);
  assert.match(CLAUDE_OBS, /never derive[\s\S]{0,200}working\s+directory[\s\S]{0,200}repository/i);
  assert.match(CLAUDE_OBS, /`OBS-RESULT: failed missing broker <[^>]*path[^>]*>`/);
  // The installer writes broker on every install and the space only once it
  // resolved, so a file with broker alone is a host without a space.
  assert.match(CLAUDE_OBS, /`broker` but no\s+`spaceKey`[\s\S]{0,120}`OBS-RESULT: failed no space configured`/);
});

// Issue #363. A shell read of confluence.json was denied by the auto-mode
// classifier; the host allows exactly a Read of that file.
test("the Claude text reads confluence.json with the Read tool, never a shell command", () => {
  assert.match(CLAUDE_OBS, /`<Claude home>\/kherep\/`/);
  assert.match(CLAUDE_OBS, /with the Read tool at that fixed absolute path[\s\S]{0,120}never with `cat` or any other shell command/);
});

test("the Claude text mentions the Codex broker only to prohibit it", () => {
  const lines = CLAUDE_OBS.split(/\r?\n/).filter((line) => line.includes("atl-confluence.mts"));
  assert.ok(lines.length >= 1, "the prohibition of atl-confluence.mts is missing");
  for (const line of lines) assert.match(line, /\bnever\b|\bnot\b/i, line);
  assert.doesNotMatch(CLAUDE_OBS, /KHEREP_ATL_CRED_FILE_CODEX/);
});

test("the Claude text carries no Codex worker mode", () => {
  for (const forbidden of [
    /candidate-only/i, /one strict JSON document/i, /"observations"/, /bodyStorage/,
    /perform(?:s)? no configuration or broker I\/O/i, /observationPublishingAuthorized/, /running as Codex/i,
  ]) {
    assert.doesNotMatch(CLAUDE_OBS, forbidden, String(forbidden));
  }
});

test("the Claude text defines the one status line and when each status applies", () => {
  assert.match(CLAUDE_OBS, /`OBS-RESULT: wrote <n> <page ids>`/);
  assert.match(CLAUDE_OBS, /`OBS-RESULT: empty <reason>`/);
  assert.match(CLAUDE_OBS, /`OBS-RESULT: failed <reason>`/);
  assert.match(CLAUDE_OBS, /first line[\s\S]{0,200}exactly one/i);
  assert.match(CLAUDE_OBS, /missing broker, missing credential[\s\S]{0,200}`failed`, never `empty`/);
  assert.match(CLAUDE_OBS, /title states the finding as it stands/i);
});

test("the Claude text files under a node the brief names", () => {
  assert.match(CLAUDE_OBS, /brief names a node[\s\S]{0,300}you use it/i);
  assert.match(CLAUDE_OBS, /unresolved scope[\s\S]{0,200}only when/i);
});

// OP-1436. With the broker removed, a run searched the workspace for another
// copy; a brief without a session id got an invented session label; a work
// item describing an earlier measurement was filed as confirmed.
test("the Claude text checks one broker path and never searches for another copy", () => {
  assert.match(CLAUDE_OBS, /check exactly that one path[\s\S]{0,300}never search/i);
});

test("the Claude text takes the session label only from the brief", () => {
  assert.match(CLAUDE_OBS, /session id[\s\S]{0,200}only from the brief/i);
  assert.match(CLAUDE_OBS, /brief gives no session id[\s\S]{0,200}leave the\s+session label out/i);
});

test("both texts treat a second-hand measurement as assumed", () => {
  for (const text of [CLAUDE_OBS, codexProjection()]) {
    assert.match(text, /second-hand[\s\S]{0,300}`assumed`/i);
  }
});

// Issue #309. Pages 276858041, 277054539 and 277054566 were filed as assumed
// and "(operator-reported)" although the dispatching session had measured the
// finding in the same turn. The brief now marks each finding.
const ROUTING_FILES = [path.join(REPO, "claude", "teams", "kherep", "ROUTING.md"), path.join(REPO, "codex", "ROUTING.md")];

test("both texts label a brief finding by its measured: or relayed: marker", () => {
  for (const [name, text] of [["claude-obs", CLAUDE_OBS], ["codex-obs", codexProjection()]]) {
    assert.match(text, /`measured:`[^.]{0,200}command[^.]{0,200}excerpt[\s\S]{0,200}`confirmed`/i, name);
    assert.match(text, /`relayed:`[^.]{0,120}`assumed`/i, name);
    assert.match(text, /never upgrade a label/i, name);
    assert.match(text, /`measured:` without[^.]{0,120}(command|excerpt)[\s\S]{0,200}`assumed`/i, name);
    assert.match(text, /dispatching session is never[^.]{0,40}operator/i, name);
    assert.match(text, /actual reporter/i, name);
  }
});

test("the Claude text calls a finding operator-reported only when the operator is the source", () => {
  assert.match(CLAUDE_OBS, /"\(operator-reported\)"[^.]{0,120}only when the operator is the source/i);
});

test("both routing files define the brief markers and the actual reporter", () => {
  for (const file of ROUTING_FILES) {
    const text = fs.readFileSync(file, "utf8");
    const section = text.slice(text.indexOf("## Session observations"), text.indexOf("## Linking"));
    assert.match(section, /`measured:`[\s\S]{0,400}`relayed:`/, file);
    assert.match(section, /`relayed:`[^.]{0,120}`assumed`/, file);
    assert.match(section, /actual reporter/i, file);
    assert.match(section, /276858041[\s\S]{0,80}277054539[\s\S]{0,80}277054566/, file);
  }
});

// Issue #331. The hooks state the exact syntax the dispatch guards enforce.
test("every observation hook reason states the brief format the dispatch guards check", () => {
  for (const hook of ["claude/hooks/observation-stop.mts", "codex/hooks/observation-stop.mts", "codex/hooks/observation-turn-completion.mts"]) {
    const source = fs.readFileSync(path.join(REPO, hook), "utf8");
    assert.ok(source.includes(OBS_BRIEF_FORMAT) && source.includes(OBS_BRIEF_REVISION), hook);
  }
});

test("both routing files state that the dispatch guard checks the brief format", () => {
  for (const file of ROUTING_FILES) {
    const text = fs.readFileSync(file, "utf8");
    const section = text.slice(text.indexOf("## Session observations"), text.indexOf("## Linking"));
    assert.ok(section.includes("`` measured: `<command>` -> <deciding output excerpt> ``"), file);
    assert.ok(section.includes("`` relayed: <source> ``"), file);
    assert.match(section, /dispatch\s+guard[\s\S]{0,300}denies a brief/, file);
  }
});

// OP-1437. A brief headed "Scope: Kherep" got two of three pages placed by
// content instead. The named node now binds every finding of the run.
test("the Claude text binds every finding to the node the brief names", () => {
  assert.match(CLAUDE_OBS, /`Scope: <node>`[\s\S]{0,200}names the node/);
  assert.match(CLAUDE_OBS, /every finding[\s\S]{0,200}content/i);
  assert.match(CLAUDE_OBS, /before each `create`[\s\S]{0,200}`--parent`/i);
});

test("both routing files let a node named in the brief override the content", () => {
  for (const file of [path.join(REPO, "claude", "teams", "kherep", "ROUTING.md"), path.join(REPO, "codex", "ROUTING.md")]) {
    const text = fs.readFileSync(file, "utf8");
    assert.match(text, /node named in the brief[\s\S]{0,200}every finding/i, file);
  }
});

test("the Codex projection keeps its own worker contract and no Claude broker", () => {
  const options = capabilities.agents["claude-obs"];
  assert.equal(options.as, "codex-obs");
  assert.equal(options.source, "codex/agents/codex-obs.md");
  const text = codexProjection();
  assert.match(text, /## Codex publication mode/);
  assert.match(text, /mcp__kherep_observations__publish_observations/);
  assert.match(text, /NO further publication/);
  assert.match(text, /Maestro independently validates/);
  for (const pattern of [/dispatching MAIN turn[^.]{0,100}never[^.]{0,100}worker/i, /\^\[a-z0-9\]\[a-z0-9\._-\]\{0,79\}\$/, /missing or invalid[\s\S]{0,200}`OBS-ATTEMPT: failed missing-turn-identity detail=none publication=not-attempted created=none`[\s\S]{0,100}no tool calls/i]) assert.match(text, pattern);
  assert.doesNotMatch(text, /atl-confluence-ccoder|KHEREP_ATL_CRED_FILE_CLAUDE/);
});
test("both routing files treat OBS-RESULT: failed as a failure, not an empty result", () => {
  for (const file of [path.join(REPO, "claude", "teams", "kherep", "ROUTING.md"), path.join(REPO, "codex", "ROUTING.md")]) {
    const text = fs.readFileSync(file, "utf8");
    const section = text.slice(text.indexOf("## Session observations"), text.indexOf("## Linking"));
    assert.match(section, /`OBS-RESULT: failed[^`]*`[\s\S]{0,200}same turn/, file);
    assert.match(section, /never[\s\S]{0,40}valid empty result/, file);
  }
});

// Issue #326. A SubagentStop hook checks the status line; both texts name it.
test("the Claude text and the Claude routing name the hook that checks the status line", () => {
  assert.match(CLAUDE_OBS, /SubagentStop hook `obs-result-check`/);
  const routing = fs.readFileSync(path.join(REPO, "claude", "teams", "kherep", "ROUTING.md"), "utf8");
  const section = routing.slice(routing.indexOf("## Session observations"), routing.indexOf("## Linking"));
  assert.match(section, /SubagentStop hook\s+`obs-result-check`/);
});

// Issue #280. On Windows the agent wrote its body file to the backslash
// scratchpad path from Bash; Bash ate the backslashes, MSYS mapped the colon
// to U+F03A, and the page body landed in the caller's checkout. Every text
// that asks for --body-file must create it with mktemp and ban such paths.
test("a text that asks for --body-file creates it with mktemp and bans backslash paths", () => {
  assert.match(CLAUDE_OBS, /--body-file/, "the Claude text no longer files through --body-file");
  for (const [name, text] of [["claude-obs", CLAUDE_OBS], ["codex-obs", codexProjection()]]) {
    if (!/--body-file/.test(text)) continue;
    assert.match(text, /f="\$\(mktemp\)"/, name);
    assert.doesNotMatch(text, /--body-file <[^>]*>/, `${name}: a placeholder lets the model pick a path`);
    assert.match(text, /--body-file "\$f"/, name);
    assert.match(text, /rm -f "\$f"/, name);
    assert.match(text, /never[^.]{0,80}Windows backslash path[^.]{0,40}Bash/i, name);
    assert.doesNotMatch(text, /[A-Za-z]:\\/, `${name}: carries a Windows backslash path itself`);
  }
});

// Issue #505. A code-bound finding is `confirmed` only with an exact binding.
test("both texts bind a code-bound finding to <name>@<sha> and file the rest as assumed", () => {
  for (const [name, text] of [["claude-obs", CLAUDE_OBS], ["codex-obs", codexProjection()]]) {
    for (const pattern of [/`code`[^.]{0,120}after `measured:`/, /<name>@<sha>/, /no exact binding/, /-dirty[\s\S]{0,200}`assumed`/,
      /Revision: <name>@<sha>/, /repository code, tests or a build[\s\S]{0,200}code-bound/i, /never guess[^.]{0,60}(repository|SHA)/i,
      /never copied[\s\S]{0,120}(page|title|notice)/i]) assert.match(text, pattern, `${name}: ${pattern}`);
  }
  assert.match(codexProjection(), /tool result about repository code, tests or a build is code-bound[\s\S]{0,300}supplied turn/);
  for (const text of [CLAUDE_OBS, codexProjection()]) { // the dirty suffix only for a token that carried -dirty
    assert.match(text, /dirty tree\)[^.]{0,120}(only|on a dirty one|carried `-dirty`)/);
    assert.doesNotMatch(text, /dirty tree\)<\/p>` when both tokens validated/);
  } // and no wrapped prose line starts with "- ", which would render as a list item
  CLAUDE_OBS.split(/\r?\n/).forEach((line, i, all) => { if (/^[-*+] /.test(line)) assert.match(all[i - 1], /^(\s|[-*+] |$)/, line); });
});

test("both routing files state the code marker and that the guard reports what it cannot deny", () => {
  for (const file of ROUTING_FILES) {
    const text = fs.readFileSync(file, "utf8");
    const section = text.slice(text.indexOf("## Session observations"), text.indexOf("## Linking"));
    for (const pattern of [/`` measured: code <name>@<sha> `<command>` -> <deciding output excerpt> ``/, /`-dirty`/, /no exact binding/,
      /reports, and never denies/, /conditional notice/, /declarations only[^.]{0,120}no completeness/]) assert.match(section, pattern, `${file}: ${pattern}`);
  }
});

test("both definitions stay under the size cap", () => {
  for (const file of [
    path.join(REPO, "claude", "agents", "claude-obs.md"),
    path.join(REPO, "codex", "agents", "codex-obs.md"),
    import.meta.filename,
  ]) {
    const lines = fs.readFileSync(file, "utf8").replace(/\n$/, "").split(/\r?\n/).length;
    assert.ok(lines <= 250, `${path.basename(file)} is ${lines} lines`);
  }
});
