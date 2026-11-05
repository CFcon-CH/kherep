#!/usr/bin/env node
// Codex Confluence broker. Credential values are read only through
// KHEREP_ATL_CRED_FILE_CODEX; the Claude broker beside it reads its own
// variable and neither can reach the other's. Paths, credentials and access
// tokens are never printed.
//
// The placement of these files in a directory named after Jira is deliberate
// and explained at the top of confluence-session.mts.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile as nodeReadFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { CliArgsError, EN, helpText, isHelp, parseVerbArgs, type VerbTable } from "./atlassian-cli-args.mts";
import { ConfluenceError } from "./confluence-contract.mts";
import {
  createPage,
  deletePage,
  findSpace,
  getPage,
  purgePage,
  representationFor,
  updatePage,
  type Page,
} from "./confluence-content.mts";
import {
  cmdChildren,
  cmdContext,
  cmdGetBody,
  cmdMove,
  cmdOrphans,
  cmdRelated,
  cmdSearch,
  cmdSpace,
  cmdStitch,
  type NeighbourCliContext,
} from "./confluence-neighbour-cli.mts";
import { cmdLabels, ensureRuntimeLabel } from "./confluence-label-cli.mts";
import { cmdList } from "./confluence-list-cli.mts";
import { requireResolvableAnchors } from "./confluence-related.mts";
import { semanticProposals } from "./confluence-semantic.mts";
import {
  authenticationReport,
  cloudId,
  createSession,
  currentUser,
} from "./confluence-session.mts";

import { parseExpectedVersion } from './confluence-pagination.mts';
import { cmdDrainage } from './confluence-drainage-cli.mts';
import { cmdEvidence } from './confluence-evidence-cli.mts';
import { DIRTY_LINE, NO_BINDING_LINE, scopedRevision } from './confluence-claim-text.mts';

const CRED_ENV = "KHEREP_ATL_CRED_FILE_CODEX";
// An absent value is UNKNOWN and says so. A blank line here would read like an
// answer, and an unverifiable author is the one thing this broker exists for.
const UNKNOWN = "UNKNOWN - not reported by the API";

// The neighbour verbs define the widest context, so the CLI adopts theirs
// rather than keeping a second copy that can drift away from it.
export type CliContext = NeighbourCliContext & { readBodyBytes: (file: string) => Promise<Uint8Array> };

// credEnv is omitted on purpose: which credential variable this CLI reads is
// not injectable, or a caller could point the Codex broker at the Claude file.
export type Injected = Partial<Omit<CliContext, "credEnv">>;

export type Args = Record<string, string | undefined>;

// Abort throws instead of ending the process, so every failure path stays
// testable. The exit code is set only at the CLI boundary below.
class CliFailure extends Error {
  cliMessage: string;

  constructor(message: string) {
    super(message);
    this.cliMessage = message;
  }
}

function fail(message: string): never {
  throw new CliFailure(message);
}

// What each verb reads, and nothing else. The parser and the help text are
// both generated from this table, so neither can drift from the other.
const BODY = { body: "<text>", "body-file": "<path>" };
export const FLAGS = {
  create: {
    required: { space: "<key>", title: "<title>", format: "<storage|wiki|adf>" },
    oneOf: [BODY],
    optional: { parent: "<id>", labels: "<a,b>" },
  },
  update: { required: { id: "<id>", format: "<storage|wiki|adf>" }, oneOf: [BODY], optional: { title: "<title>", message: "<text>", "expected-version": "<n>" } },
  get: { required: { id: "<id>" }, optional: { format: "<storage|adf>" }, valueless: ["body-only"] },
  delete: { required: { id: "<id>" } },
  purge: { required: { id: "<id>" } },
  labels: { required: { id: "<id>" }, optional: { labels: "<a,b>", remove: "<a,b>", "keep-runtime": "<runtime-label>" } },
  move: { required: { id: "<id>", parent: "<id>" } },
  space: { required: { space: "<key>" } },
  children: { required: { id: "<id>" } },
  related: { required: { space: "<key>", title: "<title>" }, optional: { topic: "<text>", id: "<id>", limit: "<n>" } },
  search: { required: { space: "<key>", query: "<terms>" }, optional: { limit: "<n>" } },
  list: { required: { space: "<key>" }, optional: { "title-contains": "<text>", label: "<name>", limit: "<n>" } },
  context: { required: { space: "<key>", id: "<id>" } },
  orphans: { required: { space: "<key>" } },
  stitch: { required: { space: "<key>" }, optional: { id: "<id>", topic: "<text>", out: "<receipt>", candidates: "<receipt>", decisions: "<file>", limit: "<n>", "per-orphan": "<n>" } },
  drainage: { required: { space: "<key>" }, optional: { ids: "<id,id>", "exclude-ids": "<id,id>", "repo-root": "<path>", ref: "<ref>" }, valueless: ["metadata-approved"] },
  evidence: { required: { mode: "<prepare|decide|verify|report|record>" }, optional: { id: "<id>", space: "<key>", out: "<path>", record: "<path>", measurement: "<path>", "out-body": "<path>", "body-file": "<path>",
    records: "<path,path>", "repo-root": "<path>", "superseded-by": "<id>", kind: "<code|tracker|live|doc>", excluded: "<private|unavailable>", reason: "<slug>", "max-age-days": "<n>" }, valueless: ["body-approved"] },
  validate: { required: { format: "<storage>", "body-file": "<path>", labels: "<a,b>" } },
  selftest: {},
} satisfies VerbTable;

type Verb = keyof typeof FLAGS;

async function bodyOf(ctx: CliContext, args: Args): Promise<string> {
  const file = args["body-file"];
  if (file) {
    try {
      return await ctx.readFile(file, "utf8");
    } catch {
      fail("--body-file is not readable.");
    }
  }
  if (args.body === undefined) fail("--body or --body-file is missing.");
  return args.body;
}

function printPage(ctx: CliContext, page: Page): void {
  ctx.log(`id: ${page.id}`);
  ctx.log(`title: ${page.title}`);
  ctx.log(`status: ${page.status}`);
  ctx.log(`version: ${page.version}`);
  ctx.log(`authorId: ${page.authorId || UNKNOWN}`);
  if (page.link) ctx.log(`link: ${page.link}`);
}

// Local observation-shape preflight only. Generic create deliberately does not call it.
function observationProblem(value: string, csv: string): string | null {
  // XML 1.0 Char and CharRef; references in comments/CDATA/PIs are literal data.
  const xmlChar = (n: number): boolean => n === 9 || n === 10 || n === 13 || (n >= 0x20 && n <= 0xd7ff)
    || (n >= 0xe000 && n <= 0xfffd) || (n >= 0x10000 && n <= 0x10ffff);
  if ([...value].some(character => !xmlChar(character.codePointAt(0)!))) return "Body contains an XML-illegal character.";
  const active = value.replace(/<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>/g, "");
  let invalidReference = false;
  const withoutReferences = active.replace(/&#(x[0-9a-fA-F]+|[0-9]+);/g, (_, digits: string) => {
    const n = digits[0] === "x" ? parseInt(digits.slice(1), 16) : Number(digits);
    if (!xmlChar(n)) invalidReference = true;
    return "";
  });
  if (invalidReference || withoutReferences.includes("&#")) return "Body contains an invalid XML character reference.";
  const labels = csv.split(",").map(label => label.trim());
  const evidence = labels.filter(label => label.startsWith("evidence-"));
  if (new Set(labels).size !== labels.length || labels.some(label => !label)
    || !labels.includes("type-observation") || !labels.includes("status-author-model")
    || labels.some(label => label.startsWith("status-author-") && label !== "status-author-model")
    || evidence.length !== 1 || !/^evidence-(confirmed|assumed|refuted|superseded)$/.test(evidence[0])) {
    return "Observation labels require one supported evidence value, type-observation and status-author-model.";
  }
  // Tokenize markup so comments, quoted attributes and pre/code content cannot supply metadata.
  const stack: { name: string; start: number; metadata: boolean }[] = [], paragraphs: string[] = [];
  const tokens = /<!--[^]*?-->|<!\[CDATA\[[^]*?\]\]>|<\?[^]*?\?>|<\/?([A-Za-z][\w:.-]*)(?:"[^"]*"|'[^']*'|[^'"<>])*>/g;
  let cursor = 0;
  for (const match of value.matchAll(tokens)) {
    if (value.slice(cursor, match.index).includes("<")) return "Malformed storage markup.";
    cursor = match.index + match[0].length;
    if (!match[1]) continue;
    const name = match[1].toLowerCase(), closing = match[0].startsWith("</");
    if (closing) {
      const open = stack.pop();
      if (!open || open.name !== name) return "Malformed storage markup.";
      if (open.metadata) paragraphs.push(value.slice(open.start, match.index));
    } else if (!match[0].endsWith("/>")) {
      if (name === "p" && stack.some(tag => tag.name === "p")) return "Malformed storage markup.";
      const metadata = name === "p" && !stack.some(tag => /^(p|pre|code|script|style)$/.test(tag.name));
      stack.push({ name, start: cursor, metadata });
    }
  }
  if (stack.length || value.slice(cursor).includes("<")) return "Malformed storage markup.";
  const entities: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  const decode = (text: string): string => text.replace(/&(?:#(x[0-9a-fA-F]+|[0-9]+)|(nbsp|amp|lt|gt|quot|apos));/g,
    (_, digits: string | undefined, name: string | undefined) => digits
      ? String.fromCodePoint(digits[0] === "x" ? parseInt(digits.slice(1), 16) : Number(digits)) : entities[name!]);
  const text = paragraphs.map(paragraph => {
    let visible = "", at = 0;
    for (const token of paragraph.matchAll(tokens)) {
      visible += decode(paragraph.slice(at, token.index));
      if (token[0].startsWith("<![CDATA[")) visible += token[0].slice(9, -3);
      else if (/^<br\b/i.test(token[0])) visible += "\n";
      at = token.index + token[0].length;
    }
    return (visible + decode(paragraph.slice(at))).trim();
  });
  for (const field of ["Finding", "Origin", "Source", "Timestamp"]) {
    const entries = text.filter(line => new RegExp(`^${field}\\s*:` , "i").test(line));
    if (entries.length !== 1 || !entries[0].replace(/^[^:]*:/, "").trim()) return `Require exactly one nonempty ${field} paragraph.`;
  }
  for (const line of text.filter(line => /^Revision\s*:/i.test(line))) {
    const revision = line.replace(/^Revision\s*:\s*/i, ""), bound = scopedRevision(revision);
    if (!bound && !NO_BINDING_LINE.test(revision) && !scopedRevision(DIRTY_LINE.exec(revision)?.[1] ?? "")) return "Malformed Revision paragraph.";
    if (!bound && evidence[0] === "evidence-confirmed") return "Unbound or dirty revisions cannot be evidence-confirmed.";
  }
  return null;
}

async function cmdValidate(ctx: CliContext, args: Args): Promise<number> {
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
  ctx.log(`valid: ${problem === null}`);
  ctx.log(`bytes: ${bytes.byteLength}`);
  ctx.log(`sha256: ${digest}`);
  ctx.log("target/authentication: not validated");
  if (problem) fail(problem);
  return 0;
}

async function cmdCreate(ctx: CliContext, args: Args): Promise<number> {
  // Before anything reaches the network: an unsupported representation is a
  // caller error, not a site error.
  const representation = representationFor(args.format);
  const title = (args.title ?? "").trim();
  if (!title) fail("--title is missing.");
  const value = await bodyOf(ctx, args);
  const session = createSession(ctx);
  const space = await findSpace(session, args.space ?? "");
  if (!space) fail("No space with that key is visible to the service account.");
  // Before the write, not after.
  await requireResolvableAnchors(session, value, space.id);
  const page = await createPage(session, {
    spaceId: space.id, title, representation, value, parentId: args.parent,
  });
  if (!page.id) fail("create returned no page id, so nothing about it can be verified.");
  printPage(ctx, page);
  // Every page gets a runtime label, with or without --labels (issue #318).
  const labelled = await ensureRuntimeLabel(session, page.id, (args.labels ?? "").split(","), CRED_ENV, ctx.env)
    .catch((error: unknown) => {
      ctx.logError(`Page ${page.id} exists, but its runtime label could not be written.`);
      throw error;
    });
  for (const line of labelled.lines) ctx.log(line);
  // Golden rule 13: the broker's own report is not evidence. The authorship
  // this broker exists to fix is proven by READING THE PAGE BACK.
  const readback = await getPage(session, page.id);
  ctx.log(`readback authorId: ${readback.authorId || UNKNOWN}`);
  if (readback.authorId) return 0;
  ctx.logError("The page was created, but its author could not be read back. Authorship is UNVERIFIED.");
  return 1;
}

async function cmdUpdate(ctx: CliContext, args: Args): Promise<number> {
  const expectedVersion = parseExpectedVersion(args["expected-version"]);
  const representation = representationFor(args.format);
  const value = await bodyOf(ctx, args);
  const session = createSession(ctx);
  // The space comes from the page, never from a flag a caller could get wrong.
  const current = await getPage(session, args.id ?? "");
  await requireResolvableAnchors(session, value, current.spaceId);
  const result = await updatePage(session, {
    id: args.id ?? "", representation, value, title: args.title, message: args.message, expectedVersion,
  });
  ctx.log(`version read: ${result.readVersion}`);
  ctx.log(`version sent: ${result.sentVersion}`);
  printPage(ctx, result.page);
  return 0;
}

async function cmdGet(ctx: CliContext, args: Args): Promise<number> {
  if ("body-only" in args || "format" in args) return cmdGetBody(ctx, args);
  printPage(ctx, await getPage(createSession(ctx), args.id ?? ""));
  return 0;
}

async function cmdDelete(ctx: CliContext, args: Args): Promise<number> {
  const session = createSession(ctx);
  await deletePage(session, args.id ?? "");
  ctx.log("deleted: the page moved to the trash. Permanent removal is the separate purge verb.");
  // Read back WITH the trashed status, otherwise a successful delete reports
  // "no longer readable", which reads like a failure and hides the state the
  // separate purge verb depends on.
  const after = await getPage(session, args.id ?? "", ["current", "trashed"]).catch(() => null);
  ctx.log(`readback status: ${after ? after.status || UNKNOWN : "the page is no longer readable"}`);
  return 0;
}

async function cmdPurge(ctx: CliContext, args: Args): Promise<number> {
  await purgePage(createSession(ctx), args.id ?? "");
  ctx.log("purged: the page is permanently removed.");
  return 0;
}

// Proves the credential and the site binding and touches no content: no space
// and no page are required, so a broken credential cannot surface as a failed
// page lookup.
async function cmdSelftest(ctx: CliContext): Promise<number> {
  const report = await authenticationReport(ctx);
  for (const line of report.lines) ctx.log(line);
  ctx.log(`cloudId: ${await cloudId(ctx)}`);
  const who = await currentUser(createSession(ctx));
  ctx.log(who
    ? `account: ${who.accountId}${who.displayName ? ` (${who.displayName})` : ""}`
    : "account: not reported - this binding cannot read the identity endpoint");
  return report.ok ? 0 : 1;
}

const COMMANDS: Record<Verb, (ctx: CliContext, args: Args) => Promise<number>> = {
  create: cmdCreate,
  update: cmdUpdate,
  get: cmdGet,
  delete: cmdDelete,
  purge: cmdPurge,
  labels: cmdLabels,
  move: cmdMove,
  space: cmdSpace,
  children: cmdChildren,
  related: cmdRelated,
  search: cmdSearch,
  list: cmdList,
  context: cmdContext,
  orphans: cmdOrphans,
  stitch: cmdStitch,
  drainage: cmdDrainage,
  evidence: cmdEvidence,
  validate: cmdValidate,
  selftest: cmdSelftest,
};

export async function runCli(argv: string[], injected: Injected = {}): Promise<number> {
  const ctx: CliContext = {
    readBodyBytes: injected.readBodyBytes ?? ((file) => nodeReadFile(file)),
    env: injected.env ?? process.env,
    credEnv: CRED_ENV,
    readFile: injected.readFile ?? nodeReadFile,
    fetch: injected.fetch ?? globalThis.fetch,
    log: injected.log ?? ((line) => console.log(line)),
    logError: injected.logError ?? ((line) => console.error(line)),
    now: injected.now ?? (() => Date.now()),
    semantic: injected.semantic ?? semanticProposals,
    writeOut: injected.writeOut ?? ((chunk) => { process.stdout.write(chunk); }),
    // Fresh per run. That binding is what makes the token cache safe.
    session: {},
  };
  const [command, ...rest] = argv;
  if (isHelp(command)) {
    for (const line of helpText(FLAGS, EN)) ctx.log(line);
    return 0;
  }
  try {
    // One line on purpose: the contract test reads this source and requires the
    // verbs of this usage string to be exactly the keys of FLAGS.
    if (!Object.hasOwn(FLAGS, command)) fail("Usage: create | update | get | delete | purge | labels | move | space | children | related | search | list | context | orphans | stitch | drainage | evidence | validate | selftest. Run help for the flags of each verb.");
    const verb = command as Verb;
    return await COMMANDS[verb](ctx, parseVerbArgs(verb, FLAGS[verb], rest, EN));
  } catch (error) {
    let message = "Internal error.";
    if (error instanceof CliFailure || error instanceof ConfluenceError) message = error.cliMessage;
    else if (error instanceof CliArgsError) message = error.message;
    ctx.logError(message);
    // search keeps its research contract: exit 1 is a measured "no match", so a
    // call that never searched is unavailable (2), not a zero.
    if (command === "search" && error instanceof CliArgsError) {
      ctx.log("status: unavailable");
      return 2;
    }
    return 1;
  }
}

// Node loads the main module from its real path, so a script started through a
// symlinked directory (macOS /var -> /private/var) matches only after realpath;
// under --preserve-symlinks-main it keeps the path as given, so both count.
// It needs no main flag on import.meta, which Node 23 and 24.0-24.1 lack.
function isMainModule(): boolean {
  const entry = process.argv[1] || "";
  try {
    return import.meta.url === pathToFileURL(path.resolve(entry)).href
      || import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

// Only on a direct call. Without this guard every import - and therefore every
// test - would execute the command.
if (isMainModule()) {
  process.exitCode = await runCli(process.argv.slice(2));
}
