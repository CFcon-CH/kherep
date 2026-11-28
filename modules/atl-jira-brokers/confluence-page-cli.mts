// The page verbs both Confluence brokers share byte for byte, moved out of
// atl-confluence.mts and atl-confluence-ccoder.mts to keep each entry below the
// file-size limit (issue #1020). `fail` is passed in: CliFailure is local to
// each entry and its runCli tests `instanceof` against its own class, so a
// shared copy would turn every message into "Internal error.".
import { deletePage, getPage, purgePage, representationFor, updatePage, type Page } from "./confluence-content.mts";
import { cmdGetBody, type NeighbourCliContext } from "./confluence-neighbour-cli.mts";
import { requireResolvableAnchors } from "./confluence-related.mts";
import { authenticationReport, cloudId, createSession, currentUser } from "./confluence-session.mts";

import { parseExpectedVersion } from './confluence-pagination.mts';

type CliContext = NeighbourCliContext;
type Args = Record<string, string | undefined>;
export type Fail = (message: string) => never;

// An absent value is UNKNOWN and says so. A blank line here would read like an
// answer, and an unverifiable author is the one thing this broker exists for.
export const UNKNOWN = "UNKNOWN - not reported by the API";

export async function bodyOf(ctx: CliContext, args: Args, fail: Fail): Promise<string> {
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

export function printPage(ctx: CliContext, page: Page): void {
  ctx.log(`id: ${page.id}`);
  ctx.log(`title: ${page.title}`);
  ctx.log(`status: ${page.status}`);
  ctx.log(`version: ${page.version}`);
  ctx.log(`authorId: ${page.authorId || UNKNOWN}`);
  if (page.link) ctx.log(`link: ${page.link}`);
}

export async function cmdUpdate(ctx: CliContext, args: Args, fail: Fail): Promise<number> {
  const expectedVersion = parseExpectedVersion(args["expected-version"]);
  const representation = representationFor(args.format);
  const value = await bodyOf(ctx, args, fail);
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

export async function cmdGet(ctx: CliContext, args: Args): Promise<number> {
  if ("body-only" in args || "format" in args) return cmdGetBody(ctx, args);
  printPage(ctx, await getPage(createSession(ctx), args.id ?? ""));
  return 0;
}

export async function cmdDelete(ctx: CliContext, args: Args): Promise<number> {
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

export async function cmdPurge(ctx: CliContext, args: Args): Promise<number> {
  await purgePage(createSession(ctx), args.id ?? "");
  ctx.log("purged: the page is permanently removed.");
  return 0;
}

// Proves the credential and the site binding and touches no content: no space
// and no page are required, so a broken credential cannot surface as a failed
// page lookup.
export async function cmdSelftest(ctx: CliContext): Promise<number> {
  const report = await authenticationReport(ctx);
  for (const line of report.lines) ctx.log(line);
  ctx.log(`cloudId: ${await cloudId(ctx)}`);
  const who = await currentUser(createSession(ctx));
  ctx.log(who
    ? `account: ${who.accountId}${who.displayName ? ` (${who.displayName})` : ""}`
    : "account: not reported - this binding cannot read the identity endpoint");
  return report.ok ? 0 : 1;
}
