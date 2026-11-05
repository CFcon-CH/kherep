// Local observation-shape preflight only. Generic create deliberately does not call it.
import { createHash } from "node:crypto";
import { DIRTY_LINE, NO_BINDING_LINE, scopedRevision } from './confluence-claim-text.mts';

// XML 1.0 Char and CharRef; references in comments/CDATA/PIs are literal data.
const xmlChar = (n: number): boolean => n === 9 || n === 10 || n === 13 || (n >= 0x20 && n <= 0xd7ff)
  || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);

function characterProblem(value: string): string | null {
  if ([...value].some(character => !xmlChar(character.codePointAt(0)!))) return "Body contains an XML-illegal character.";
  const active = value.replace(/<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>/g, "");
  let invalidReference = false;
  const withoutReferences = active.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (_, digits: string) => {
    const n = digits[0] === "x" ? parseInt(digits.slice(1), 16) : Number(digits);
    if (!xmlChar(n)) invalidReference = true;
    return "";
  });
  if (invalidReference || withoutReferences.includes("&#")) return "Body contains an invalid XML character reference.";
  return null;
}

function labelsProblem(labels: string[], evidence: string[]): string | null {
  if (new Set(labels).size !== labels.length || labels.some(label => !label)
    || !labels.includes("type-observation") || !labels.includes("status-author-model")
    || labels.some(label => label.startsWith("status-author-") && label !== "status-author-model")
    || evidence.length !== 1 || !/^evidence-(confirmed|assumed|refuted|superseded)$/.test(evidence[0])) {
    return "Observation labels require one supported evidence value, type-observation and status-author-model.";
  }
  return null;
}

// Tokenize markup so comments, quoted attributes and pre/code content cannot supply metadata.
const tokens = /<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>|<\/?([A-Za-z][\w:.-]*)(?:"[^"]*"|'[^']*'|[^'"<>])*>/g;
interface Tag { name: string; start: number; metadata: boolean }

function captureTag(match: RegExpExecArray, cursor: number, stack: Tag[], paragraphs: string[], value: string): boolean {
  const name = match[1].toLowerCase(), closing = match[0].startsWith("</");
  if (closing) {
    const open = stack.pop();
    if (!open || open.name !== name) return false;
    if (open.metadata) paragraphs.push(value.slice(open.start, match.index));
  } else if (!match[0].endsWith("/>")) {
    if (name === "p" && stack.some(tag => tag.name === "p")) return false;
    const metadata = name === "p" && !stack.some(tag => /^(p|pre|code|script|style)$/.test(tag.name));
    stack.push({ name, start: cursor, metadata });
  }
  return true;
}

function storageParagraphs(value: string): string[] | null {
  const stack: Tag[] = [], paragraphs: string[] = [];
  let cursor = 0;
  for (const match of value.matchAll(tokens)) {
    if (value.slice(cursor, match.index).includes("<")) return null;
    cursor = match.index + match[0].length;
    if (!match[1]) continue;
    if (!captureTag(match, cursor, stack, paragraphs, value)) return null;
  }
  if (stack.length || value.slice(cursor).includes("<")) return null;
  return paragraphs;
}

const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const decode = (text: string): string => text.replace(/&(?:#(x[0-9a-fA-F]+|[0-9]+)|(nbsp|amp|lt|gt|quot|apos));/g,
  (_, digits: string | undefined, name: string | undefined) => digits
    ? String.fromCodePoint(digits[0] === "x" ? parseInt(digits.slice(1), 16) : Number(digits)) : entities[name!]);

function paragraphText(paragraph: string): string {
  let visible = "", at = 0;
  for (const token of paragraph.matchAll(tokens)) {
    visible += decode(paragraph.slice(at, token.index));
    if (token[0].startsWith("<![CDATA[")) visible += token[0].slice(9, -3);
    else if (/^<br\b/i.test(token[0])) visible += "\n";
    at = token.index + token[0].length;
  }
  return (visible + decode(paragraph.slice(at))).trim();
}

function metadataProblem(text: string[]): string | null {
  for (const field of ["Finding", "Origin", "Source", "Timestamp"]) {
    const entries = text.filter(line => new RegExp(`^${field}\\s*:` , "i").test(line));
    if (entries.length !== 1 || !entries[0].replace(/^[^:]*:/, "").trim()) return `Require exactly one nonempty ${field} paragraph.`;
  }
  return null;
}

function revisionProblem(text: string[], evidence: string): string | null {
  for (const line of text.filter(line => /^Revision\s*:/i.test(line))) {
    const revision = line.replace(/^Revision\s*:\s*/i, ""), bound = scopedRevision(revision);
    if (!bound && !NO_BINDING_LINE.test(revision) && !scopedRevision(DIRTY_LINE.exec(revision)?.[1] ?? "")) return "Malformed Revision paragraph.";
    if (!bound && evidence === "evidence-confirmed") return "Unbound or dirty revisions cannot be evidence-confirmed.";
  }
  return null;
}

export function observationProblem(value: string, csv: string): string | null {
  const characterError = characterProblem(value);
  if (characterError) return characterError;
  const labels = csv.split(",").map(label => label.trim());
  const evidence = labels.filter(label => label.startsWith("evidence-"));
  const labelError = labelsProblem(labels, evidence);
  if (labelError) return labelError;
  const paragraphs = storageParagraphs(value);
  if (!paragraphs) return "Malformed storage markup.";
  const text = paragraphs.map(paragraphText);
  return metadataProblem(text) ?? revisionProblem(text, evidence[0]);
}

export async function validateObservation(
  args: Record<string, string | undefined>,
  ctx: { readBodyBytes: (file: string) => Promise<Uint8Array> },
  fail: (message: string) => never,
): Promise<{ problem: string | null; bytes: Uint8Array; digest: string }> {
  if (args.format !== "storage") fail("validate takes --format storage only.");
  let bytes: Uint8Array;
  try { bytes = await ctx.readBodyBytes(args["body-file"] ?? ""); }
  catch { fail("--body-file is not readable."); }
  const digest = createHash("sha256").update(bytes).digest("hex");
  let problem: string | null;
  try {
    const value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    problem = observationProblem(value, args.labels ?? "");
  } catch { problem = "Body is not valid UTF-8."; }
  return { problem, bytes, digest };
}
