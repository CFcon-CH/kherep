// Issue #1020: every file the installed Confluence brokers import must be in
// every per-file install and drift registry. A file missing from one of them
// installs a broker that imports an absent module and fails entirely.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const REPO = path.resolve(import.meta.dirname, "..");
const BROKERS = path.join(REPO, "modules", "atl-jira-brokers");
const read = (relative: string) => fs.readFileSync(path.join(REPO, relative), "utf8");

// The same import pattern as observationFiles in codex/lib/observation-projection.mts.
export function closure(entries: readonly string[], readBroker = (name: string) => fs.readFileSync(path.join(BROKERS, name), "utf8")): string[] {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    for (const [, specifier] of readBroker(name).matchAll(/(?:from\s*|import\s*)['"]\.\/([^'"]+\.mts)['"]/g)) queue.push(specifier);
  }
  return [...seen].sort();
}

// What each registry names, read as text. A registry is a set of file names.
export function registries(text: (relative: string) => string = read): Record<string, Set<string>> {
  const words = (source: string) => new Set(source.match(/[a-z0-9-]+\.mts/g) ?? []);
  const between = (source: string, start: string, end: string) => {
    const at = source.indexOf(start);
    assert.ok(at >= 0, `registry anchor missing: ${start}`);
    return source.slice(at, source.indexOf(end, at + start.length));
  };
  const install = text("bootstrap/install.sh");
  const smoke = text("bootstrap/smoke-test.sh");
  const transaction = text("bootstrap/install-transaction.test.sh");
  const codexInstall = text("codex/install.mts");
  const codexTest = text("codex/install.test.mts");
  const camel = (source: string) => new Set([...source.matchAll(/"atl-jira-brokers", "([a-z0-9-]+\.mts)"/g)].map((m) => m[1]));
  const sourceMap = between(codexInstall, "const sources = {", "\n  };");
  const targetMap = between(codexInstall, "const targets = {", "\n  };");
  const targetNames = new Set([...targetMap.matchAll(/"tools", "([a-z0-9-]+\.mts)"/g)].map((m) => m[1]));
  const keyOf = (map: string) => new Map([...map.matchAll(/(\w+): path\.join\([^"]*"[^)]*"([a-z0-9-]+\.mts)"\)/g)].map((m) => [m[2], m[1]]));
  const sourceKeys = keyOf(sourceMap);
  const copyPairs = between(codexInstall, "for (const [source, target] of [", "] as const)");
  const copied = new Set([...sourceKeys].filter(([, key]) => copyPairs.includes(`[sources.${key}, targets.${key}]`)).map(([name]) => name));
  const expectedList = between(codexTest, "const brokerNames = [", "];");
  return {
    "R1 install.sh CONFLUENCE_TOOLS": words(between(install, "CONFLUENCE_TOOLS=\"", "\"\n")),
    "R2 drift-check.sh cmp_file": new Set([...text("bootstrap/drift-check.sh").matchAll(/cmp_file "project\/tools\/([a-z0-9-]+\.mts)"/g)].map((m) => m[1])),
    "R3 smoke-test.sh confluence_tools": words(between(smoke, "local confluence_tools=(", ")")),
    "R4 install-transaction.test.sh tool loop": words(between(transaction, "for tool in atlassian-credentials.mts", "; do")),
    "R5 drift-managed-pairs.mts": new Set([...text("claude/hooks/drift-managed-pairs.mts").matchAll(/"modules\/atl-jira-brokers\/([a-z0-9-]+\.mts)"/g)].map((m) => m[1])),
    "R6 codex/install.mts source map": camel(sourceMap),
    "R6 codex/install.mts target map": targetNames,
    "R6 codex/install.mts copy pairs": copied,
    "R7 codex/install.test.mts broker list": new Set([...expectedList.matchAll(/"([a-z0-9-]+)"/g)].map((m) => `${m[1]}.mts`)),
  };
}

const ENTRIES = ["atl-confluence.mts", "atl-confluence-ccoder.mts"];

test("every file of the Confluence broker import closure is in every registry", () => {
  const files = closure(ENTRIES);
  assert.ok(files.includes("confluence-semantic-model.mts") && files.includes("confluence-page-cli.mts"), files.join(","));
  const missing: string[] = [];
  for (const [name, set] of Object.entries(registries())) {
    // The Codex CLI broker installs only the Codex entry; the Claude entry is the Claude installer's.
    const expected = name.startsWith("R6") || name.startsWith("R7") ? closure(["atl-confluence.mts"]) : files;
    for (const file of expected) if (!set.has(file)) missing.push(`${name}: ${file}`);
  }
  assert.deepEqual(missing, []);
});

test("removing one new file from one registry is caught", () => {
  const original = (relative: string) => read(relative);
  const pruned = (relative: string) => (relative === "bootstrap/smoke-test.sh"
    ? original(relative).replace(" confluence-semantic-pool.mts", "") : original(relative));
  const set = registries(pruned)["R3 smoke-test.sh confluence_tools"];
  assert.equal(set.has("confluence-semantic-pool.mts"), false);
  assert.equal(registries()["R3 smoke-test.sh confluence_tools"].has("confluence-semantic-pool.mts"), true);
});
