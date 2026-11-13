// Issue #736: the neighbour query is the title plus the finding sentence, cut
// on a word boundary, and a candidate snippet is one plain line.
import assert from "node:assert/strict";
import test from "node:test";

import { bodyTopic, capWords, plainText, QUERY_MAX, replaceTags, SNIPPET_MAX, snippetLine, topicQuery } from "./confluence-topic-query.mts";

test("the query is title, a full stop and the topic, whitespace collapsed", () => {
  assert.equal(topicQuery("  Logon task\tworkaround ", "A scheduled task\n\nruns at  logon."),
    "Logon task workaround. A scheduled task runs at logon.");
});

test("without a topic the query is the title alone", () => {
  assert.equal(topicQuery("Logon task workaround"), "Logon task workaround");
  assert.equal(topicQuery("Logon task workaround", "   "), "Logon task workaround");
});

test("the query is capped at 500 characters on a word boundary", () => {
  const topic = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
  const query = topicQuery("Title", topic);
  assert.ok(query.length <= QUERY_MAX, String(query.length));
  assert.ok(query.length > QUERY_MAX - 10, "the cap uses the room it has");
  assert.match(query, /word\d+$/, "the last word is whole");
  assert.ok(`Title. ${topic}`.startsWith(query));
});

test("a single word longer than the cap is cut hard rather than dropped", () => {
  assert.equal(capWords("x".repeat(600), 500), "x".repeat(500));
});

test("tags are stripped and entities decoded or dropped", () => {
  assert.equal(plainText("<p>A &amp; B &lt;tag&gt; &quot;q&quot; &#39;s&#x21; &hellip;end</p>"),
    `A & B <tag> "q" 's! end`);
  assert.equal(plainText("<ac:structured-macro ac:name=\"code\"><ac:plain-text-body>x</ac:plain-text-body></ac:structured-macro>y"),
    "x y");
  assert.equal(plainText("&#0; &#xD800; a"), "a", "control and surrogate code points become spaces");
});

test("a decoded < is not stripped as a tag afterwards", () => {
  assert.equal(topicQuery("T", "&lt;b&gt;bold&lt;/b&gt;"), "T. <b>bold</b>");
});

test("a snippet is one flattened line of at most 240 characters", () => {
  const long = `<p>first\tline</p>\n<p>${"word ".repeat(80)}</p>`;
  const line = snippetLine(long);
  assert.ok(!/[\t\r\n]/.test(line));
  assert.ok(line.length <= SNIPPET_MAX, String(line.length));
  assert.ok(line.startsWith("first line word"));
  assert.match(line, /word$/);
});

test("an orphan's topic is the opening 500 characters of its body as plain text", () => {
  const body = `<h1>Head</h1><p>${"alpha ".repeat(150)}</p>`;
  const topic = bodyTopic(body);
  assert.ok(topic.startsWith("Head alpha"));
  assert.ok(topic.length <= QUERY_MAX);
});

// Issue #906: replaceTags finds the matches of /<[^>]*>/g in one pass.
const timed = (run: () => void): number => { const started = performance.now(); run(); return performance.now() - started; };
test("replaceTags replaces every <...> run and leaves a < without a later > alone", () => {
  const cases: [string, string][] = [["", ""], ["a<b>c", "a c"], ["<a<b>c", " c"], ["a>b<c", "a>b<c"], ["<a\nb>x<>y", " x y"]];
  for (const [text, expected] of cases) assert.equal(replaceTags(text, () => " "), expected, JSON.stringify(text));
  assert.equal(plainText("a<b"), "a<b");
  assert.equal(plainText("x<<p>y"), "x y");
});

test("replaceTags is linear on runs of < and of tags", () => {
  const cases: [string, string][] = [["<".repeat(50_000), "<".repeat(50_000)], ["<a>".repeat(50_000), " ".repeat(50_000)]];
  for (const [text, expected] of cases) {
    let out = "";
    assert.ok(timed(() => { out = replaceTags(text, () => " "); }) < 200, text.slice(0, 3));
    assert.equal(out, expected);
  }
  let prose = "";
  assert.ok(timed(() => { prose = replaceTags('<"'.repeat(50_000), (tag) => tag, (part) => part.replace(/[>"]/g, "&")); }) < 200);
  assert.equal(prose, "<&".repeat(50_000));
  let plain = "";
  assert.ok(timed(() => { plain = plainText(`${"<".repeat(50_000)}a`); }) < 200);
  assert.ok(plain.endsWith("a"));
});
