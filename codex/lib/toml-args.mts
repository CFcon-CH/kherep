interface StringToken {
  end: number;
  quote: "basic" | "literal";
  raw: string;
  value?: string;
}

interface RewriteResult {
  text: string;
  migrated: boolean;
}

function readString(text: string, start: number): StringToken | undefined {
  const marker = text[start];
  if (marker !== '"' && marker !== "'") return undefined;
  if (text.slice(start, start + 3) === marker.repeat(3)) {
    const end = text.indexOf(marker.repeat(3), start + 3);
    if (end < 0) return undefined;
    const raw = text.slice(start, end + 3);
    return { end: end + 3, quote: marker === "'" ? "literal" : "basic", raw };
  }
  let escaped = false;
  for (let index = start + 1; index < text.length; index += 1) {
    const char = text[index];
    if (marker === '"' && escaped) escaped = false;
    else if (marker === '"' && char === "\\") escaped = true;
    else if (char === marker) {
      const raw = text.slice(start, index + 1);
      try {
        const value = marker === "'" ? raw.slice(1, -1) : JSON.parse(raw);
        return { end: index + 1, quote: marker === "'" ? "literal" : "basic", raw, value };
      } catch {
        return { end: index + 1, quote: "basic", raw };
      }
    }
  }
  return undefined;
}

function windowsPath(value: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(value);
}

function comparable(value: string, target: string): string {
  return windowsPath(target) ? value.replaceAll("\\", "/").toLowerCase() : value;
}

function containsTarget(value: string, target: string): boolean {
  return comparable(value, target).includes(comparable(target, target));
}

function exactTarget(value: string, target: string): boolean {
  return comparable(value, target) === comparable(target, target);
}

function targetName(target: string): string {
  return target.split(/[\\/]/).at(-1) || target;
}

function arrayEnd(text: string, start: number): number | undefined {
  let depth = 0;
  let comment = false;
  let index = start - 1;
  while (++index < text.length) {
    const char = text[index];
    if (comment) {
      if (char === "\n" || char === "\r") comment = false;
      continue;
    }
    if (char === "#") comment = true;
    else if (char === '"' || char === "'") {
      const token = readString(text, index);
      if (!token) return undefined;
      index = token.end - 1;
    } else if (char === "[") depth += 1;
    else if (char === "]" && --depth === 0) return index + 1;
  }
  return undefined;
}

function rewriteArray(value: string, oldArg: string, newArg: string): RewriteResult {
  const edits: Array<{ start: number; end: number; text: string }> = [];
  let depth = 0;
  let braces = 0;
  let comment = false;
  let index = -1;
  while (++index < value.length) {
    const char = value[index];
    if (comment) {
      if (char === "\n" || char === "\r") comment = false;
      continue;
    }
    if (char === "#") { comment = true; continue; }
    if (char === "[") { depth += 1; continue; }
    if (char === "]") { depth -= 1; continue; }
    if (char === "{") { braces += 1; continue; }
    if (char === "}") { braces -= 1; continue; }
    if (char !== '"' && char !== "'") continue;
    const token = readString(value, index);
    if (!token) throw new Error("Unparseable TOML string in args array");
    if (token.value !== undefined && containsTarget(token.value, oldArg)) {
      if (depth !== 1 || braces !== 0 || !exactTarget(token.value, oldArg)) {
        throw new Error("Retired bridge is not a standalone args string");
      }
      const replacement = windowsPath(oldArg) && token.value.includes("/")
        ? newArg.replaceAll("\\", "/") : newArg;
      const text = token.quote === "literal" ? `'${replacement}'` : JSON.stringify(replacement);
      edits.push({ start: index, end: token.end, text });
    } else if (token.value === undefined && token.raw.includes(targetName(oldArg))) {
      throw new Error("Unparseable retired bridge string in args array");
    }
    index = token.end - 1;
  }
  let text = value;
  for (const edit of edits.reverse()) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return { text, migrated: edits.length > 0 };
}

export function hasTomlStringReference(text: string, target: string): boolean {
  let comment = false;
  let index = -1;
  while (++index < text.length) {
    const char = text[index];
    if (comment) {
      if (char === "\n" || char === "\r") comment = false;
      continue;
    }
    if (char === "#") { comment = true; continue; }
    if (char !== '"' && char !== "'") continue;
    const token = readString(text, index);
    if (!token) return text.slice(index).includes(targetName(target));
    if (token.value !== undefined && containsTarget(token.value, target)) return true;
    if (token.value === undefined && token.raw.includes(targetName(target))) return true;
    index = token.end - 1;
  }
  return false;
}

export function rewriteExactTomlStringArgs(text: string, oldArg: string, newArg: string): RewriteResult {
  const assignments = /^[\t ]*args[\t ]*=[\t ]*/gm;
  const edits: Array<{ start: number; end: number; text: string }> = [];
  for (let match = assignments.exec(text); match; match = assignments.exec(text)) {
    const start = match.index + match[0].length;
    if (text[start] !== "[") continue;
    const end = arrayEnd(text, start);
    if (end === undefined) continue;
    const rewritten = rewriteArray(text.slice(start, end), oldArg, newArg);
    if (rewritten.migrated) edits.push({ start, end, text: rewritten.text });
  }
  let updated = text;
  for (const edit of edits.reverse()) updated = updated.slice(0, edit.start) + edit.text + updated.slice(edit.end);
  return { text: updated, migrated: edits.length > 0 };
}
