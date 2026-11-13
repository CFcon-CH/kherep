export interface ParsedToolCall { name: string; input: unknown }

const COMMAND_KEYS = new Set(["cmd", "command"]);

function quoted(source: string): string {
  const value = source.trim();
  if (value.startsWith('"')) {
    try { return JSON.parse(value); } catch { return ""; }
  }
  if ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith("`") && value.endsWith("`"))) {
    if (value.startsWith("`") && value.includes("${")) return "";
    return value.slice(1, -1).replace(/\\(['`\\])/g, "$1").replace(/\\n/g, "\n").replace(/\\r/g, "\r");
  }
  return "";
}

function skipLiteral(source: string, start: number): number {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") { i += 2; continue; }
    if (source[i] === quote) return i + 1;
    i += 1;
  }
  return source.length;
}

function regexStart(source: string, slash: number): boolean {
  let previous = slash - 1;
  while (previous >= 0 && /\s/.test(source[previous])) previous -= 1;
  if (previous < 0 || /[=(:,[!&|?{};]/.test(source[previous])) return true;
  let start = previous;
  while (start >= 0 && /[\w$]/.test(source[start])) start -= 1;
  start += 1;
  while (start <= previous && /\d/.test(source[start])) start += 1;
  return ["return", "throw", "case", "yield", "await", "typeof", "void", "delete", "new"].includes(source.slice(start, previous + 1));
}

function skipRegex(source: string, start: number): number {
  let inClass = false;
  for (let i = start + 1; i < source.length; i += 1) {
    if (source[i] === "\\") { i += 1; continue; }
    if (source[i] === "[") inClass = true;
    else if (source[i] === "]") inClass = false;
    else if (source[i] === "/" && !inClass) {
      while (/[A-Za-z]/.test(source[i + 1] || "")) i += 1;
      return i + 1;
    }
  }
  return source.length;
}

function skipComment(source: string, start: number): number {
  if (source[start + 1] === "/") {
    const end = source.indexOf("\n", start + 2);
    return end < 0 ? source.length : end + 1;
  }
  const end = source.indexOf("*/", start + 2);
  return end < 0 ? source.length : end + 2;
}

function callEnd(source: string, open: number): number {
  let depth = 1;
  for (let i = open + 1; i < source.length;) {
    if ('"\'`'.includes(source[i])) { i = skipLiteral(source, i); continue; }
    if (source[i] === "/" && ["/", "*"].includes(source[i + 1])) { i = skipComment(source, i); continue; }
    if (source[i] === "/" && regexStart(source, i)) { i = skipRegex(source, i); continue; }
    if (source[i] === "(") depth += 1;
    else if (source[i] === ")" && --depth === 0) return i;
    i += 1;
  }
  return -1;
}

export function nestedToolCalls(source: string): ParsedToolCall[] {
  const calls: ParsedToolCall[] = [];
  for (let i = 0; i < source.length;) {
    if ('"\'`'.includes(source[i])) { i = skipLiteral(source, i); continue; }
    if (source[i] === "/" && ["/", "*"].includes(source[i + 1])) { i = skipComment(source, i); continue; }
    if (source[i] === "/" && regexStart(source, i)) { i = skipRegex(source, i); continue; }
    if (source.startsWith("tools.", i) && (i === 0 || !/[\w$]/.test(source[i - 1]))) {
      const nameStart = i + 6;
      const match = /^[A-Za-z_$][\w$]*/.exec(source.slice(nameStart));
      if (match) {
        let open = nameStart + match[0].length;
        while (/\s/.test(source[open] || "")) open += 1;
        if (source[open] === "(") {
          const end = callEnd(source, open);
          if (end >= 0) {
            calls.push({ name: match[0], input: source.slice(open + 1, end) });
            i = end + 1;
            continue;
          }
        }
      }
    }
    i += 1;
  }
  return calls;
}

function commandProperty(raw: string): Record<string, unknown> | null {
  let depth = 0;
  for (let i = 0; i < raw.length;) {
    if ('"\'`'.includes(raw[i])) { i = skipLiteral(raw, i); continue; }
    if (raw[i] === "/" && ["/", "*"].includes(raw[i + 1])) { i = skipComment(raw, i); continue; }
    if (raw[i] === "/" && regexStart(raw, i)) { i = skipRegex(raw, i); continue; }
    if (raw[i] === "{") { depth += 1; i += 1; continue; }
    if (raw[i] === "}") { depth -= 1; i += 1; continue; }
    if (depth === 1 && /[A-Za-z_$]/.test(raw[i])) {
      const match = /^[A-Za-z_$][\w$]*/.exec(raw.slice(i));
      const key = match?.[0] || "";
      let previous = i - 1;
      while (previous >= 0 && /\s/.test(raw[previous])) previous -= 1;
      let value = i + key.length;
      while (/\s/.test(raw[value] || "")) value += 1;
      if (COMMAND_KEYS.has(key) && ["{", ","].includes(raw[previous] || "") && raw[value] === ":") {
        value += 1;
        while (/\s/.test(raw[value] || "")) value += 1;
        if ('"\'`'.includes(raw[value])) {
          const end = skipLiteral(raw, value);
          return { [key]: quoted(raw.slice(value, end)) };
        }
      }
      i += Math.max(key.length, 1);
      continue;
    }
    i += 1;
  }
  return null;
}

export function inputRecord(call: ParsedToolCall): Record<string, unknown> {
  if (call.input && typeof call.input === "object" && !Array.isArray(call.input)) {
    return call.input as Record<string, unknown>;
  }
  const raw = typeof call.input === "string" ? call.input.trim() : "";
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* JavaScript object literals are handled lexically below. */ }
  const property = commandProperty(raw);
  if (property) return property;
  return { input: raw ? quoted(raw) || raw : "" };
}
