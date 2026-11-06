import path from "node:path";

import { starlarkString } from "./control-plane-rules.mts";

// Issue #812. One managed rule for the Codex broker's read-only knowledge
// lookup. Keep write verbs and the Claude broker outside this allowlist.
export const KNOWLEDGE_READ_RULES_FILE = "kherep-knowledge-read.rules";

export function knowledgeReadRulesPath(codexHome: string): string {
  return path.join(codexHome, "rules", KNOWLEDGE_READ_RULES_FILE);
}

export function renderKnowledgeReadRules(workspace: string): string {
  const root = workspace.replace(/\\/g, "/").replace(/\/$/, "");
  const broker = `${root}/tools/atl-confluence.mts`;
  const example = (verb: string): string => starlarkString(`node ${JSON.stringify(broker)} ${verb}`);
  const notMatch = ["create", "update", "delete", "purge", "labels", "move", "stitch", "related"].map(example);
  notMatch.push(starlarkString(`node ${JSON.stringify(`${root}/tools/atl-confluence-ccoder.mts`)} search`));
  return [
    "# Managed by Kherep (codex/install.mts). Rewritten on every install; put your own rules in another file.",
    "# Read-only knowledge lookup through the installed Codex broker: search and get only.",
    "prefix_rule(",
    `    pattern = ["node", ${starlarkString(broker)}, ["search", "get"]],`,
    '    decision = "allow",',
    `    justification = ${starlarkString("Kherep read-only knowledge lookup: Codex broker search and get only")},`,
    "    match = [",
    `        ${example("search")},`,
    `        ${example("get")},`,
    "    ],",
    "    not_match = [",
    ...notMatch.map((entry) => `        ${entry},`),
    "    ],",
    ")",
    "",
  ].join("\n");
}
