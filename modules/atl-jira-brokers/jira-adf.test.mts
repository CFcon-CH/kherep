// OP-928: contract for the shared Markdown-block-to-ADF renderer. Every node shape
// asserted here was read off the Atlassian ADF node reference, one page per node,
// not from memory: heading needs attrs.level, bulletList/orderedList hold listItem,
// listItem holds a paragraph, codeBlock holds bare text nodes.
import test from "node:test";
import assert from "node:assert/strict";

import { renderAdf, type AdfDocument, type AdfNode } from "./jira-adf.mts";

const doc = (...content: AdfNode[]): AdfDocument => ({ type: "doc", version: 1, content });
const para = (text: string): AdfNode => ({ type: "paragraph", content: [{ type: "text", text }] });
const item = (text: string): AdfNode => ({ type: "listItem", content: [para(text)] });

test("a single line stays one paragraph and keeps its UTF-8 text", () => {
  assert.deepEqual(renderAdf("Prüfung mit Ä, Ö, Ü und ß"), doc(para("Prüfung mit Ä, Ö, Ü und ß")));
});

test("a hard-wrapped paragraph joins to one line", () => {
  // Editors wrap prose at some column. Those breaks are typographic, not semantic,
  // so they must not become separate paragraphs.
  assert.deepEqual(renderAdf("erste Zeile\nzweite Zeile"), doc(para("erste Zeile zweite Zeile")));
});

test("a blank line separates paragraphs", () => {
  assert.deepEqual(renderAdf("eins\n\nzwei"), doc(para("eins"), para("zwei")));
});

test("hash prefixes become headings and carry their level", () => {
  assert.deepEqual(renderAdf("# Eins\n\n### Drei"), doc(
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Eins" }] },
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Drei" }] },
  ));
});

test("seven hashes are not a heading - ADF stops at level 6", () => {
  assert.deepEqual(renderAdf("####### zu tief"), doc(para("####### zu tief")));
});

test("dash and asterisk lines become one bulletList", () => {
  assert.deepEqual(renderAdf("- eins\n- zwei\n* drei"), doc({
    type: "bulletList",
    content: [item("eins"), item("zwei"), item("drei")],
  }));
});

test("numbered lines become an orderedList and the rendered numbers are dropped", () => {
  // The list numbers itself; carrying "1." into the text would print it twice.
  assert.deepEqual(renderAdf("1. eins\n2. zwei"), doc({
    type: "orderedList",
    content: [item("eins"), item("zwei")],
  }));
});

test("an ordered list that does not start at one keeps its start number", () => {
  assert.deepEqual(renderAdf("3. drei\n4. vier"), doc({
    type: "orderedList",
    attrs: { order: 3 },
    content: [item("drei"), item("vier")],
  }));
});

test("a list ends at the next non-list line without needing a blank line", () => {
  assert.deepEqual(renderAdf("- eins\nDanach Fliesstext"), doc(
    { type: "bulletList", content: [item("eins")] },
    para("Danach Fliesstext"),
  ));
});

test("a fenced block becomes a codeBlock and keeps its line breaks verbatim", () => {
  assert.deepEqual(renderAdf("```\nzeile eins\n  eingerueckt\n```"), doc({
    type: "codeBlock",
    content: [{ type: "text", text: "zeile eins\n  eingerueckt" }],
  }));
});

test("a fence with an info string records the language", () => {
  assert.deepEqual(renderAdf("```js\nconst a = 1;\n```"), doc({
    type: "codeBlock",
    attrs: { language: "js" },
    content: [{ type: "text", text: "const a = 1;" }],
  }));
});

test("a blank line inside a fence stays inside the code block", () => {
  // Outside a fence a blank line separates blocks. Inside it is data.
  assert.deepEqual(renderAdf("```\na\n\nb\n```"), doc({
    type: "codeBlock",
    content: [{ type: "text", text: "a\n\nb" }],
  }));
});

test("an unclosed fence still yields a code block rather than losing the text", () => {
  assert.deepEqual(renderAdf("```\nabgeschnitten"), doc({
    type: "codeBlock",
    content: [{ type: "text", text: "abgeschnitten" }],
  }));
});

test("an empty fence yields a codeBlock with no content - ADF forbids an empty text node", () => {
  assert.deepEqual(renderAdf("```\n```"), doc({ type: "codeBlock" }));
});

test("empty input yields one empty paragraph, never an empty document", () => {
  // Jira rejects a doc with no content, and a text node may not be the empty string.
  assert.deepEqual(renderAdf(""), doc({ type: "paragraph" }));
  assert.deepEqual(renderAdf("   \n  "), doc({ type: "paragraph" }));
});

test('null and undefined are treated as empty, not as the word "null"', () => {
  assert.deepEqual(renderAdf(null), doc({ type: "paragraph" }));
  assert.deepEqual(renderAdf(undefined), doc({ type: "paragraph" }));
});

test("CRLF input renders the same as LF input", () => {
  assert.deepEqual(renderAdf("# Titel\r\n\r\n- eins\r\n- zwei"), renderAdf("# Titel\n\n- eins\n- zwei"));
});

// --- inline code spans (added to OP-928 after the first live proof) -----------
// The first rendered OP-927 came out with literal backticks around every file
// path. Structure was right, the paths read as noise. `code` is a documented mark
// on the text node, so a span costs one mark and no new block type.
const code = (text: string): AdfNode => ({ type: "text", text, marks: [{ type: "code" }] });

test("a backtick pair becomes a text node carrying the code mark", () => {
  assert.deepEqual(renderAdf("siehe `manifest.yml` dort"), doc({
    type: "paragraph",
    content: [{ type: "text", text: "siehe " }, code("manifest.yml"), { type: "text", text: " dort" }],
  }));
});

test("several spans in one line are each marked", () => {
  assert.deepEqual(renderAdf("`a` und `b`"), doc({
    type: "paragraph",
    content: [code("a"), { type: "text", text: " und " }, code("b")],
  }));
});

test("an unpaired backtick stays literal rather than swallowing the rest", () => {
  assert.deepEqual(renderAdf("ein ` einzelner"), doc(para("ein ` einzelner")));
});

test("an empty pair stays literal - a text node may not be empty", () => {
  assert.deepEqual(renderAdf("leer `` hier"), doc(para("leer `` hier")));
});

test("spans work in headings and in list items", () => {
  assert.deepEqual(renderAdf("# `x`\n\n- `y`"), doc(
    { type: "heading", attrs: { level: 1 }, content: [code("x")] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [code("y")] }] }] },
  ));
});

test("backticks inside a fenced block are data, not markup", () => {
  assert.deepEqual(renderAdf("```\necho `date`\n```"), doc({
    type: "codeBlock",
    content: [{ type: "text", text: "echo `date`" }],
  }));
});

// Issue #906: a marker line is the marker, blanks, and the rest from its first non-blank.
test("headings and list items take the text after their blanks; a marker without a blank stays prose", () => {
  const heading = (level: number, text: string): AdfNode => ({ type: "heading", attrs: { level }, content: [{ type: "text", text }] });
  assert.deepEqual(renderAdf("# Title"), doc(heading(1, "Title")));
  assert.deepEqual(renderAdf("###### six"), doc(heading(6, "six")));
  assert.deepEqual(renderAdf("#   spaced  "), doc(heading(1, "spaced")));
  for (const text of ["####### seven", "#Title", "-a", "1.x"]) assert.deepEqual(renderAdf(text), doc(para(text)), text);
  assert.deepEqual(renderAdf("- a"), doc({ type: "bulletList", content: [item("a")] }));
  assert.deepEqual(renderAdf("*   b "), doc({ type: "bulletList", content: [item("b")] }));
  assert.deepEqual(renderAdf("1. x"), doc({ type: "orderedList", content: [item("x")] }));
  assert.deepEqual(renderAdf("12) y"), doc({ type: "orderedList", attrs: { order: 12 }, content: [item("y")] }));
  const empty: AdfNode = { type: "listItem", content: [{ type: "paragraph", content: [] }] };
  assert.deepEqual(renderAdf("# "), doc({ type: "heading", attrs: { level: 1 }, content: [] }));
  assert.deepEqual(renderAdf("- "), doc({ type: "bulletList", content: [empty] }));
  assert.deepEqual(renderAdf("1. "), doc({ type: "orderedList", content: [empty] }));
});

test("a marker before a long blank run and a U+2028 converts to prose in linear time", () => {
  for (const marker of ["#", "-", "1."]) {
    const started = performance.now();
    const content = renderAdf(`${marker}${" ".repeat(50_000)}\u2028x\u2028y`).content;
    assert.ok(performance.now() - started < 200, marker);
    assert.deepEqual(content.map((node) => node.type), ["paragraph"], marker);
  }
});
