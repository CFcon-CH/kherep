// Test fixture, issues #274 and #684: the synthetic install the re-anchor tests
// split, and two oracles written independently of toml-block-structure.mts.

import { prepareManagedConfig, type ManagedConfigOptions } from "./config-preservation.mts";

export const START = "# >>> Kherep Codex Maestro >>>";
export const END = "# <<< Kherep Codex Maestro <<<";
export const REFUSAL = /Refusing to overwrite a managed block without an exact known managed fragment/;

export const OPTIONS: ManagedConfigOptions = {
  startMarker: START,
  endMarker: END,
  retiredMcpServerNames: [],
  registryProjections: [],
  pluginMcpServers: {},
  contextHook: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro-context.mts`,
  hookDir: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro`,
  memoryNotifyHook: String.raw`C:\Synthetic\.codex\hooks\kherep-maestro\codex-memory-notify.mts`,
  node: String.raw`C:\Program Files\nodejs\node.exe`,
  registry: String.raw`C:\Synthetic\.codex\orchestra\mcp-registry.json`,
  registryBridge: String.raw`C:\Synthetic\.codex\orchestra\registry-http-bridge.mts`,
  registryRuntime: String.raw`C:\Synthetic\.codex\orchestra\supergateway-secret-wrapper.mts`,
  controlPlaneHook: String.raw`C:\Synthetic\repo\modules\control-plane\node\deliver-hook.mts`,
  messagingClient: {
    enabled: true,
    bridge: String.raw`C:\Synthetic\repo\modules\control-plane\node\mcp-stdio-bridge.mts`,
    intentHook: String.raw`C:\Synthetic\repo\modules\control-plane\node\mcp-intent-hook.mts`,
    configRoot: String.raw`C:\Synthetic\kherep`,
  },
};

export const FRESH = prepareManagedConfig("", OPTIONS).config;
export const BEFORE = FRESH.slice(0, FRESH.indexOf(START));
export const BLOCK = FRESH.slice(FRESH.indexOf(START) + START.length, FRESH.indexOf(END));
// The tail opens with the deliver hooks: the last SessionStart group of the block.
export const HEAD = BLOCK.slice(0, BLOCK.lastIndexOf("[[hooks.SessionStart]]")).trim();
export const TAIL = BLOCK.slice(BLOCK.lastIndexOf("[[hooks.SessionStart]]")).trim();

export function managedBlock(config: string): string {
  return config.slice(config.indexOf(START), config.indexOf(END) + END.length);
}

export interface TomlDocument {
  top: string[];
  tables: Record<string, string[]>;
  arrays: [string, string[]][];
  blockPreamble: string[];
}

const BARE = /^[A-Za-z0-9_-]+$/;
const HEADER_KEY = /^(?:"([^"\\]*)"|'([^']*)'|([A-Za-z0-9_-]+))/;

// The keys of a dotted header path, or null when the text is not exactly such a path.
function headerKeys(text: string): string[] | null {
  const keys: string[] = [];
  let rest = text;
  while (rest) {
    const key = HEADER_KEY.exec(rest.trimStart());
    if (!key) return null;
    rest = rest.trimStart().slice(key[0].length).trimStart();
    if (rest.startsWith(".")) rest = rest.slice(1);
    else if (rest) return null;
    keys.push(key[1] ?? key[2] ?? key[3]);
  }
  return keys;
}

// The table a header line opens, by instance address: each prefix seen as
// `[[…]]` takes the ordinal of its latest element under the current parent.
function headerAddress(line: string, latest: Map<string, number>): { address: string; array: boolean } {
  const match = /^(\[\[?)(.*?)(\]\]?)$/.exec(line);
  if (!match || match[1].length !== match[3].length) throw new Error(`Not a fixture header: ${line}`);
  const keys = headerKeys(match[2]);
  if (!keys) throw new Error(`Not a fixture header: ${line}`);
  const array = match[1] === "[[";
  let address = "";
  keys.forEach((key, index) => {
    address += (index ? "." : "") + (BARE.test(key) ? key : JSON.stringify(key));
    if (array && index === keys.length - 1) {
      latest.set(address, (latest.get(address) ?? -1) + 1);
      address += `[${latest.get(address)}]`;
    } else if (latest.has(address)) address += `[${latest.get(address)}]`;
  });
  return { address, array };
}

// What a TOML parser reports for the documents these tests write: line based,
// so it throws on anything outside that grammar. Comments end no table.
export function tomlDocument(config: string): TomlDocument {
  const doc: TomlDocument = { top: [], tables: {}, arrays: [], blockPreamble: [] };
  const latest = new Map<string, number>();
  let current = doc.top, preamble = false;
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line === START) preamble = true;
    if (!line || line.startsWith("#")) continue;
    if (/"""|'''/.test(line) || /[[,]$/.test(line)) throw new Error(`Outside the fixture grammar: ${line}`);
    if (line.startsWith("[")) {
      if (!raw.startsWith("[")) throw new Error(`Indented header: ${line}`);
      const { address, array } = headerAddress(line, latest);
      if (address in doc.tables || doc.arrays.some(([known]) => known === address)) throw new Error(`Duplicate ${address}`);
      current = [];
      if (array) doc.arrays.push([address, current]);
      else doc.tables[address] = current;
      preamble = false;
      continue;
    }
    if (!/^[^\s=#][^=]*=\s*\S/.test(line)) throw new Error(`Outside the fixture grammar: ${line}`);
    current.push(line);
    if (preamble) doc.blockPreamble.push(line);
  }
  return doc;
}

const counted = (text: string, removed: string): Map<string, number> | undefined => {
  const counts = new Map<string, number>();
  for (const line of text.split("\n").filter((value) => value.trim())) counts.set(line, (counts.get(line) ?? 0) + 1);
  for (const line of removed.split("\n").filter((value) => value.trim())) {
    const count = counts.get(line);
    if (!count) return undefined;
    if (count === 1) counts.delete(line);
    else counts.set(line, count - 1);
  }
  return counts;
};

// Comments are outside tomlDocument: every non-blank line of the original but
// the managed ones it held stands in the result besides the fragment written.
export function conserved(original: string, result: string, managedBefore = BLOCK, managedAfter = BLOCK): boolean {
  const before = counted(original, managedBefore), after = counted(result, managedAfter);
  const sorted = (counts: Map<string, number>) => [...counts].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return Boolean(before && after) && JSON.stringify(sorted(before!)) === JSON.stringify(sorted(after!));
}
