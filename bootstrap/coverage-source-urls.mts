// Interpret producer file URLs without using the consumer operating system's paths.
export function canonicalFileUrl(value: string): string {
  if (typeof value !== "string" || !value.startsWith("file:///") || value.startsWith("file:////") || /[\\\0?#]/.test(value) || /%(?:2f|5c|00)/i.test(value)) throw new Error("invalid file URL");
  const path = value.slice("file:///".length);
  for (const segment of path.split("/")) {
    const decoded = decodeURIComponent(segment);
    if (decoded === "." || decoded === ".." || /[\\/\0]/.test(decoded)) throw new Error("file URL path traversal");
  }
  const parsed = new URL(value);
  if (parsed.protocol !== "file:" || parsed.host || parsed.search || parsed.hash || parsed.href !== value) throw new Error("noncanonical file URL");
  return parsed.href;
}
function segments(value: string): string[] {
  return new URL(canonicalFileUrl(value)).pathname.split("/").map(decodeURIComponent);
}
export function repositoryRelativeUrlPath(scriptUrl: string, sourceRootUrl: string): string | null {
  const root = segments(sourceRootUrl);
  if (!sourceRootUrl.endsWith("/")) throw new Error("source root must be a directory URL");
  root.pop();
  if (!scriptUrl.startsWith("file:")) return null;
  const source = segments(scriptUrl);
  const drive = (parts: string[]) => /^[a-zA-Z]:$/.test(parts[1] ?? "");
  if (drive(root) !== drive(source)) return null;
  for (let i = 0; i < root.length; i++) {
    const equal = i === 1 && drive(root) ? root[i].toUpperCase() === source[i]?.toUpperCase() : root[i] === source[i];
    if (!equal) return null;
  }
  const suffix = source.slice(root.length);
  if (!suffix.length || suffix.includes("") || suffix.includes("node_modules")) return null;
  return suffix.join("/");
}
export function repositoryPathFromUrl(scriptUrl: string, sourceRootUrl: string): string | null {
  const path = repositoryRelativeUrlPath(scriptUrl, sourceRootUrl);
  return path && /\.(mts|ts|js|mjs|cjs|cts)$/.test(path) ? path : null;
}

function scriptRootMembership(baseUrl: string, sourceRootUrl: string): "inside" | "outside" | "ambiguous" {
  const root = segments(sourceRootUrl), source = segments(baseUrl);
  if (!sourceRootUrl.endsWith("/")) throw new Error("source root must be a directory URL");
  root.pop();
  if (root.slice(1).includes("") || source.slice(1).includes("")) throw new Error("ambiguous script path");
  const windows = (parts: string[]) => /^[a-zA-Z]:$/.test(parts[1] ?? "");
  if (windows(root) !== windows(source)) throw new Error("mixed script path dialect");
  const inside = root.every((part, i) => i === 1 && windows(root) ? part.toUpperCase() === source[i]?.toUpperCase() : part === source[i]);
  if (inside) {
    if (source.length === root.length) throw new Error("script path has no filename");
    return "inside";
  }
  return root.every((part, i) => part.toLowerCase() === source[i]?.toLowerCase()) ? "ambiguous" : "outside";
}
export function classifyV8ScriptUrl(value: string, sourceRootUrl: string): { kind: "ordinary" } | { kind: "external-isolated"; baseUrl: string } | { kind: "reserved-in-root-query"; baseUrl: string } {
  if (!value.startsWith("file:") || !value.includes("?")) return { kind: "ordinary" };
  const queryAt = value.indexOf("?"), query = value.slice(queryAt);
  const match = /^\?(isolated|node-test-mock)=[0-9]+$/.exec(query);
  if (!match || match[0] !== query) throw new Error("unsupported V8 script query");
  const baseUrl = canonicalFileUrl(value.slice(0, queryAt)), membership = scriptRootMembership(baseUrl, sourceRootUrl);
  if (membership !== (match[1] === "isolated" ? "outside" : "inside")) throw new Error("script query violates root membership policy");
  return match[1] === "isolated" ? { kind: "external-isolated", baseUrl } : { kind: "reserved-in-root-query", baseUrl };
}
