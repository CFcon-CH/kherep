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
