// OP-963: shared label and component field logic for both Jira brokers.
//
// WHY THIS EXISTS. The same reason jira-adf.mts exists: both brokers already sit
// above the 250-LOC limit from CLAUDE.md, and two copies of a rule drift apart by
// the second bug fix. Everything here is pure - the caller owns the HTTP, this
// module owns the decisions - so every branch is reachable from a test without a
// network.
//
// THE FIELD SHAPES ARE READ OFF THE SPEC, NOT REMEMBERED (CLAUDE.md rule 5).
// Jira Cloud v3 OpenAPI, pulled 2026-08-24 from
// developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json:
//   - the create-issue example carries fields.labels as ["bugfix","blitz_test"]
//     and fields.components as [{"id":"10000"}],
//   - GET /rest/api/3/project/{projectIdOrKey}/components answers with an array
//     of ProjectComponent, whose id and name are both declared as strings, and
//     whose path parameter is documented as "The project ID or project key".

// OP-1124. The three states of a field plan entry are the reason these types
// exist at all: null means the flag was absent, so the field stays untouched;
// an empty list or a null accountId means the flag was given empty, which is the
// clearing edit. A single optional string would have collapsed the two.
export interface AssigneePlan {
  accountId: string | null;
  error?: undefined;
}

export interface AssigneeFailure {
  error: string;
  accountId?: undefined;
}

export type AssigneeResult = AssigneePlan | AssigneeFailure;

export interface FieldPlan {
  labels?: string[] | null;
  componentIds?: string[] | null;
  assignee?: AssigneeResult | null;
}

// What Jira writes back on a readback, narrowed to the fields this module
// compares. Everything else in the payload stays unread.
export interface IssueFields {
  summary?: unknown;
  // OP-1387. An ADF document, a plain string on an older site, or null when the
  // work item has no body. Left unknown because all three are real answers and
  // jira-adf-text.mts is written to survive every one of them.
  description?: unknown;
  labels?: unknown;
  components?: unknown;
  assignee?: { accountId?: string | null } | null;
}

// ProjectComponent from the catalog above. id is declared as a string, but it is
// stringified anyway so a numeric id cannot slip into the write unnoticed.
export interface ProjectComponent {
  id?: string | number;
  name?: string;
}

export interface ComponentResolution {
  ids?: string[];
  error?: string;
}

// The write body this module contributes to a create or update. Jira accepts
// more fields than these; the brokers add their own on top.
export interface FieldEdits {
  labels?: string[];
  components?: { id: string }[];
  assignee?: { accountId: string | null };
}

// undefined -> null: the flag was not given, so the field stays untouched.
// '' -> []: the flag was given empty, which is how a caller clears the field.
// Those two must never collapse into one value: an absent flag that arrived as
// an empty list would silently wipe labels on every unrelated summary edit.
export function parseFieldList(raw: unknown): string[] | null {
  if (raw === undefined || raw === null) return null;
  return String(raw).split(",").map((part) => part.trim()).filter(Boolean);
}

// OP-1372. The field set a single-issue read asks for. Shared, because the same
// list in two broker files drifts apart by the second bug fix.
//
// OP-1387: description joins it. It was never requested, so `get` did not drop
// the body on the floor - it never asked for it, and a caller who wanted to read
// a work item had to open a browser. Asking for it costs nothing: it is one more
// name in a `fields` parameter the read already sends.
//
// OP-1396: attachment joins it on the same argument. The brokers could upload a
// file and then not tell you it was there, so acceptance had to go around the
// broker twice to see what it had just written. The list is also the only place
// a caller learns the id that `download` takes.
export const DEFAULT_ISSUE_FIELDS = ["summary", "status", "description", "creator", "attachment"] as const;

// A read parameter has no third state to protect: an absent flag and an empty one
// both mean "no choice made", and honouring the empty one would send `fields=`
// and ask the site for nothing. That is the opposite of parseFieldList's contract
// for a WRITE, where an empty flag deliberately clears the field.
export function fieldListOr(raw: unknown, fallback: readonly string[]): string[] {
  const parsed = parseFieldList(raw);
  return parsed && parsed.length > 0 ? parsed : [...fallback];
}

// OP-1049. Same three states as parseFieldList, one shape further: absent flag
// leaves the field alone, an empty flag unassigns, anything else is an accountId.
//
// THE SHAPE IS READ OFF THE SPEC, NOT REMEMBERED (CLAUDE.md rule 5). Same
// swagger as above, pulled 2026-08-30: PUT /rest/api/3/issue/{issueIdOrKey}/assignee
// declares its request body as #/components/schemas/User, and User.accountId is
// documented verbatim as "The account ID of the user, which uniquely identifies
// the user across all Atlassian products [...] Required in requests.", maxLength 128.
//
// A display name is NOT accepted here on purpose. Resolving a name to an account
// is a search with a fuzzy result, and this module exists to be unambiguous: the
// caller resolves the name and hands over the id it decided on.
export function parseAssignee(raw: unknown): AssigneeResult | null {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  if (!value) return { accountId: null };
  if (value.length > 128) {
    return { error: `Assignee-accountId ist ${value.length} Zeichen lang, erlaubt sind hoechstens 128.` };
  }
  return { accountId: value };
}

export const componentCatalogPath = (projectId: string): string => `/project/${encodeURIComponent(projectId)}/components`;

// Names are resolved to ids against the project catalog, and a name the project
// does not know is refused here - before any write leaves the process. Jira would
// answer a bad component with a 400 as well, but its message does not say which
// of several names was the bad one, and by then the other fields are already
// written. Matching is exact: a case-insensitive guess would pick a neighbouring
// component and look like a success.
export function resolveComponentNames(names: string[], catalog: unknown): ComponentResolution {
  const known = new Map<string, string>();
  const entries: ProjectComponent[] = Array.isArray(catalog) ? catalog : [];
  for (const entry of entries) {
    if (typeof entry?.name === "string" && entry?.id !== undefined && entry.id !== null) {
      known.set(entry.name, String(entry.id));
    }
  }
  const wanted = [...new Set(names)];
  const unknown = wanted.filter((name) => !known.has(name));
  if (unknown.length) {
    const available = [...known.keys()].join(", ") || "keine";
    return { error: `Unbekannte Komponente: ${unknown.join(", ")}. Bekannt im Projekt: ${available}.` };
  }
  // Every wanted name is in the catalog by now, so the lookup below cannot miss.
  // It is written as a loop rather than a map with a cast, so the type follows
  // from the check instead of overriding it.
  const ids: string[] = [];
  for (const name of wanted) {
    const id = known.get(name);
    if (id !== undefined) ids.push(id);
  }
  return { ids };
}

// A null plan entry contributes no key at all. An empty array contributes an
// empty value, which is the clearing edit.
export function fieldEdits({ labels, componentIds, assignee }: FieldPlan): FieldEdits {
  const fields: FieldEdits = {};
  if (labels) fields.labels = labels;
  if (componentIds) fields.components = componentIds.map((id) => ({ id }));
  // An object is always contributed, including { accountId: null }: that IS the
  // unassign write. Only a null plan entry, meaning the flag was absent, is skipped.
  // A rejected parse never reaches here - both brokers stop on assignee.error
  // first - so the fallback below only spells that out for the type.
  if (assignee) fields.assignee = { accountId: assignee.accountId ?? null };
  return fields;
}

// The readback asks for exactly the fields this plan writes, plus the summary
// that both brokers compare themselves. The column names come out of fieldEdits,
// so the plan-to-Jira-field mapping is written down once and not twice.
export function readbackColumns(plan: FieldPlan): string {
  return ["summary", ...Object.keys(fieldEdits(plan))].join(",");
}

// Order is deliberately not compared. Jira returns labels sorted and is free to
// reorder components, so only the set is a fact about the write; a list compare
// would fail runs that in truth succeeded.
const asSet = (values: unknown[]): string[] => [...new Set(values.map(String))].sort((left, right) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
});

function difference(kind: string, expected: string[], actual: unknown): string | null {
  if (!Array.isArray(actual)) return `Readback liefert keine ${kind}.`;
  const want = asSet(expected);
  const got = asSet(actual);
  if (JSON.stringify(want) === JSON.stringify(got)) return null;
  return `Readback bestaetigt die neuen ${kind} nicht: erwartet [${want.join(", ")}], gelesen [${got.join(", ")}].`;
}

// Assignee is a single object, not a set, so the set compare above does not fit.
// Jira answers an unassigned issue with assignee: null, which is a legitimate
// read; only an absent key means the readback did not deliver the field at all.
// Those two must not collapse, otherwise a failed read would pass as a proven
// unassign (CLAUDE.md golden rule 12).
function assigneeDifference(expected: AssigneeResult, fields: IssueFields | undefined | null): string | null {
  if (!fields || !Object.hasOwn(fields, "assignee")) return "Readback liefert kein Assignee.";
  const read = fields.assignee === null ? null : fields.assignee?.accountId ?? undefined;
  if (read === expected.accountId) return null;
  const want = expected.accountId === null ? "niemand" : expected.accountId;
  const got = read === null ? "niemand" : read ?? "unlesbar";
  return `Readback bestaetigt das neue Assignee nicht: erwartet ${want}, gelesen ${got}.`;
}

// A 204 says the call was accepted, nothing more (CLAUDE.md golden rule 13), so
// the written value is measured again on the issue itself.
export function verifyReadback(
  { labels, componentIds, assignee }: FieldPlan,
  fields: IssueFields | undefined | null,
): string | null {
  if (assignee) {
    const message = assigneeDifference(assignee, fields);
    if (message) return message;
  }
  if (labels) {
    const message = difference("Labels", labels, fields?.labels);
    if (message) return message;
  }
  if (componentIds) {
    const components: { id?: unknown }[] | undefined = Array.isArray(fields?.components) ? fields.components : undefined;
    const read = components
      ? components.map((entry) => entry?.id).filter((id) => id !== undefined && id !== null)
      : fields?.components;
    const message = difference("Komponenten", componentIds, read);
    if (message) return message;
  }
  return null;
}
