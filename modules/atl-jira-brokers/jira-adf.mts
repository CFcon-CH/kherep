// OP-928: shared Markdown-block-to-ADF renderer for both Jira brokers.
//
// WHY THIS EXISTS. Both brokers used to wrap the whole body in paragraphs and
// nothing else: split on blank lines, replace every single newline with a space.
// A numbered list written as four lines arrived in Jira as one sentence reading
// "1. ... 2. ... 3. ...". The structure was not lost in transport, it was never
// built. OP-927 is the visible case.
//
// WHY A SEPARATE MODULE. Both brokers already sit above the 250-LOC limit from
// CLAUDE.md, and two copies of a parser drift apart by the second bug fix. One
// module, imported twice.
//
// SCOPE IS BLOCK STRUCTURE ONLY. No bold, italics, links or inline code. Those
// need escaping rules that deserve their own tests, and the damage being repaired
// here is the lost outline, not missing emphasis.
//
// Every node shape below was read off the Atlassian ADF node reference, one page
// per node: heading requires attrs.level (1-6); bulletList and orderedList hold
// listItem nodes; a listItem holds a paragraph; codeBlock holds bare text nodes
// and takes an optional attrs.language; paragraph holds inline nodes.

// OP-1124: one open node type for every block and inline node. ADF is a tree of
// heterogeneous nodes and a discriminated union per node type would have to be
// kept in step with the Atlassian reference by hand; what the callers actually
// need from this module is that a document comes out, not that a codeBlock is
// distinguishable from a heading at compile time.
export interface AdfNode {
  type: string;
  text?: string;
  attrs?: Record<string, unknown>;
  // OP-1387: a mark may carry attributes - the link mark's href is the one that
  // matters - because jira-adf-text.mts reads this same node shape back. The
  // renderer below only ever writes `code`, which has none.
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  content?: AdfNode[];
}

export interface AdfDocument {
  type: "doc";
  version: number;
  content: AdfNode[];
}

const FENCE = /^```(.*)$/;
// Greedy 1-6 hashes followed by whitespace. Seven hashes cannot match at any
// backtrack position, so "####### x" stays prose - ADF has no level 7.
const HEADING = /^(#{1,6})\s+((?:\S.*)?)$/;
const BULLET = /^[-*]\s+((?:\S.*)?)$/;
const ORDERED = /^(\d+)[.)]\s+((?:\S.*)?)$/;

// A backtick pair, non-greedy and never spanning a backtick, so an unpaired tick
// cannot swallow the rest of the line. The pair must enclose something: ADF
// forbids an empty text node, so `` stays two literal characters.
const CODE_SPAN = /(`[^`]+`)/;
const IS_SPAN = /^`[^`]+`$/;

const textNode = (text: string): AdfNode => ({ type: "text", text });

// The only inline markup handled here. `code` is a documented mark on the text
// node, so a span costs a mark and no new node type. Bold, italics and links stay
// out: they need escaping rules that deserve their own tests.
function inline(text: string): AdfNode[] {
  // Splitting on a capturing group returns the delimiters as their own parts, so a
  // span arrives whole and an anchored match tells it apart from surrounding prose.
  return text
    .split(CODE_SPAN)
    .filter(Boolean)
    .map((part) => (IS_SPAN.test(part)
      ? { ...textNode(part.slice(1, -1)), marks: [{ type: "code" }] }
      : textNode(part)));
}

const paragraph = (text: string): AdfNode => ({ type: "paragraph", content: inline(text) });
const listItem = (text: string): AdfNode => ({ type: "listItem", content: [paragraph(text)] });

// A code fence swallows blank lines and every other marker until it closes. An
// unclosed fence runs to the end of the input rather than dropping the text: a
// truncated body is still evidence, a silently discarded one is not.
function readFence(lines: string[], start: number): [AdfNode, number] {
  // The caller has already matched FENCE on this line; the fallback keeps the
  // language empty instead of asserting the match a second time.
  const language = (lines[start].match(FENCE)?.[1] ?? "").trim();
  const body: string[] = [];
  let i = start + 1;
  while (i < lines.length && !FENCE.test(lines[i])) {
    body.push(lines[i]);
    i += 1;
  }
  const code = body.join("\n");
  const node: AdfNode = { type: "codeBlock" };
  if (language) node.attrs = { language };
  // ADF forbids an empty text node, so an empty fence yields a bare codeBlock.
  if (code) node.content = [textNode(code)];
  // Skip the closing fence when there was one; at EOF i is already past the end.
  return [node, i + 1];
}

// One run of adjacent list lines of the same kind. Mixed bullet markers (- and *)
// are the same kind on purpose: the marker is typing habit, not meaning.
function readList(lines: string[], start: number, pattern: RegExp, type: string): [AdfNode, number] {
  const items: AdfNode[] = [];
  let i = start;
  let first: number | null = null;
  while (i < lines.length) {
    const match = lines[i].match(pattern);
    if (!match) break;
    if (type === "orderedList") {
      if (first === null) first = Number(match[1]);
      items.push(listItem(match[2].trim()));
    } else {
      items.push(listItem(match[1].trim()));
    }
    i += 1;
  }
  // attrs.order is the START number. Omitted for a list beginning at 1, which is
  // what ADF assumes anyway - writing it out would be noise in every document.
  if (type === "orderedList" && first !== null && first !== 1) {
    return [{ type, attrs: { order: first }, content: items }, i];
  }
  return [{ type, content: items }, i];
}

// Prose runs until a blank line or the start of any other block. Single newlines
// inside it are where the author's editor wrapped, not sentence boundaries, so
// they collapse to spaces.
function readParagraph(lines: string[], start: number): [AdfNode, number] {
  const parts: string[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) break;
    if (FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || ORDERED.test(line)) break;
    parts.push(line.trim());
    i += 1;
  }
  return [paragraph(parts.join(" ")), i];
}

// The argument is unknown on purpose: a body reaches this from argv or from a
// file read, and both brokers pass it through without a shape of their own.
export function renderAdf(text: unknown): AdfDocument {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const content: AdfNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (FENCE.test(line)) {
      const [node, next] = readFence(lines, i);
      content.push(node);
      i = next;
      continue;
    }
    const heading = line.match(HEADING);
    if (heading) {
      content.push({
        type: "heading",
        attrs: { level: heading[1].length },
        content: inline(heading[2].trim()),
      });
      i += 1;
      continue;
    }
    if (BULLET.test(line)) {
      const [node, next] = readList(lines, i, BULLET, "bulletList");
      content.push(node);
      i = next;
      continue;
    }
    if (ORDERED.test(line)) {
      const [node, next] = readList(lines, i, ORDERED, "orderedList");
      content.push(node);
      i = next;
      continue;
    }
    const [node, next] = readParagraph(lines, i);
    content.push(node);
    i = next;
  }
  // Jira rejects a document with no content. An input that carried nothing but
  // whitespace becomes one empty paragraph - and an empty paragraph has no
  // content array, because a text node may not hold the empty string.
  if (!content.length) content.push({ type: "paragraph" });
  return { type: "doc", version: 1, content };
}
