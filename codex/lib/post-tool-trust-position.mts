// Codex trust keys include the event's group index. A managed upgrade must not
// silently move operator-owned PostToolUse definitions to another trust key.
interface Header { start: number; path: string[]; array: boolean }

function structuralLineStarts(config: string): Set<number> {
  const starts = new Set<number>([0]);
  let quote = "", multiline = false;
  let at = -1;
  while (++at < config.length) {
    const char = config[at];
    if (char === "\n") { if (!quote) starts.add(at + 1); continue; }
    if (quote) {
      if (quote === '"' && char === "\\") { at++; continue; }
      if (char === quote) {
        let count = 1;
        if (multiline) {
          while (config[at + count] === quote) count++;
          if (count > 5) throw new Error("Cannot verify Hook table positions safely");
        }
        if (!multiline || count >= 3) { quote = ""; multiline = false; }
        at += count - 1;
      }
    } else if (char === "#") {
      const newline = config.indexOf("\n", at);
      if (newline < 0) break;
      at = newline - 1;
    } else if (char === '"' || char === "'") {
      quote = char; multiline = config.startsWith(char.repeat(3), at);
      if (multiline) at += 2;
    }
  }
  return starts;
}

function headers(config: string): Header[] {
  const structural = structuralLineStarts(config);
  return [...config.matchAll(/^[ \t]*(\[\[?)(.*?)\]\]?[ \t]*(?:#.*)?$/gm)]
    .filter((match) => structural.has(match.index)).map((match) => {
    const body = match[2], tokens = [...body.matchAll(/"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+/g)];
    let end = 0;
    const path = tokens.map((token, index) => {
      if (body.slice(end, token.index).trim() !== (index ? "." : "")) throw new Error("Cannot verify Hook table positions safely");
      end = token.index + token[0].length;
      return token[0].startsWith('"') ? JSON.parse(token[0]) as string
        : token[0].startsWith("'") ? token[0].slice(1, -1) : token[0];
    });
    if (path.length === 0 || body.slice(end).trim()) throw new Error("Cannot verify Hook table positions safely");
    return { start: match.index, path, array: match[1] === "[[" };
  });
}

function externalGroups(config: string, startMarker: string, endMarker: string): { text: string; index: number }[] {
  const tables = headers(config), start = config.indexOf(startMarker), end = config.indexOf(endMarker, start);
  let index = 0;
  return tables.flatMap((table, at) => {
    if (!table.array || table.path.length !== 2 || table.path[0] !== "hooks" || table.path[1] !== "PostToolUse") return [];
    const position = index++;
    if (start >= 0 && table.start >= start && table.start < end) return [];
    let next = at + 1;
    while (next < tables.length && tables[next].path.length > 2
      && tables[next].path[0] === "hooks" && tables[next].path[1] === "PostToolUse") next++;
    return [{ text: config.slice(table.start, tables[next]?.start ?? config.length).trim(), index: position }];
  });
}

export function preserveExternalPostToolPositions(before: string, after: string, startMarker: string, endMarker: string): void {
  const previous = externalGroups(before, startMarker, endMarker), next = externalGroups(after, startMarker, endMarker);
  for (const group of previous) {
    const found = next.findIndex((candidate) => candidate.text === group.text);
    if (found < 0 || next[found].index !== group.index) {
      throw new Error("Automatic migration stopped: an external PostToolUse Hook's trust position would change. "
        + "A separately authorized migration and subsequent native review are required; existing trust hashes were not changed.");
    }
    next.splice(found, 1);
  }
}
