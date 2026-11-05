import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { containedFile } from "./coverage-paths.mts";

export const copyDeclarationsFile = "coverage-copies.jsonl";
export function readCopyDeclarations(text: string, root: string): Map<string, string> {
  const copies = new Map<string, string>();
  for (const line of text.trimEnd().split("\n")) {
    const value: unknown = JSON.parse(line);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed copy declaration");
    const d = value as { copyUrl: string; original: string; sha256: string };
    if (Object.keys(d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join() !== "copyUrl,original,sha256" || typeof d.copyUrl !== "string" || typeof d.original !== "string" || typeof d.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(d.sha256)) throw new Error("malformed copy declaration fields");
    if (!d.copyUrl.startsWith("file:") || pathToFileURL(fileURLToPath(d.copyUrl)).href !== d.copyUrl) throw new Error("noncanonical copy URL");
    if (isAbsolute(d.original) || d.original.includes("\\") || decodeURIComponent(d.original).split("/").includes("..")) throw new Error("copy declaration path traversal");
    const original = containedFile(root, d.original);
    if (relative(realpathSync(root), original).split(sep).join("/") !== d.original) throw new Error("noncanonical copy original");
    if (createHash("sha256").update(readFileSync(original)).digest("hex") !== d.sha256) throw new Error(`copy declaration sha256 mismatch: ${d.original}`);
    const url = pathToFileURL(original).href;
    if (copies.has(d.copyUrl) && copies.get(d.copyUrl) !== url) throw new Error("conflicting copy declaration");
    copies.set(d.copyUrl, url);
  }
  return copies;
}
