import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containedFile } from "./coverage-paths.mts";

export const producers = ["unit", "typescript", "probe", "worker"] as const;
export type Manifest = { producer: string; runId: string; attempt: string; checkoutSha: string; testOutcome: string };
export type Identity = Pick<Manifest, "runId" | "attempt" | "checkoutSha">;
export function readNonempty(root: string, filename: string): string {
  const path = containedFile(root, filename);
  if (lstatSync(path).isSymbolicLink()) throw new Error("symlink artifact");
  const bytes = lstatSync(path).size;
  if (!bytes || bytes > 512 * 1024 * 1024) throw new Error("empty or oversized coverage file");
  return readFileSync(path, "utf8");
}
export function validateManifest(value: unknown, identity: Identity): Manifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("malformed manifest");
  const m = value as Manifest;
  if (Object.values(m).some(value => typeof value !== "string") || Object.keys(m).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",") !== "attempt,checkoutSha,producer,runId,testOutcome" || !producers.includes(m.producer as typeof producers[number]) || !/^\d+$/.test(m.runId) || !/^[1-9]\d*$/.test(m.attempt) || !/^[a-f0-9]{40}$/.test(m.checkoutSha) || !["success", "failure", "cancelled", "skipped"].includes(m.testOutcome)) throw new Error("malformed manifest fields");
  for (const key of ["runId", "attempt", "checkoutSha"] as const) if (m[key] !== identity[key]) throw new Error(`manifest ${key} mismatch`);
  return m;
}
export function validateProducers(values: unknown[], identity: Identity): Manifest[] {
  const manifests = values.map(value => validateManifest(value, identity));
  const seen = new Set<string>();
  for (const manifest of manifests) {
    if (seen.has(manifest.producer)) throw new Error("duplicate producer");
    seen.add(manifest.producer);
    if (manifest.testOutcome !== "success") throw new Error(`producer ${manifest.producer} testOutcome is ${manifest.testOutcome}`);
  }
  if (producers.some(producer => !seen.has(producer)) || seen.size !== producers.length) throw new Error("missing producer artifact");
  return manifests;
}
export function rawFiles(artifact: string): string[] {
  const dir = join(artifact, "raw");
  if (lstatSync(dir).isSymbolicLink()) throw new Error("symlink raw directory");
  const names = readdirSync(dir);
  if (!names.length || names.length > 100_000) throw new Error("missing or excessive raw V8 files");
  let total = 0;
  for (const name of names) {
    if (!name.endsWith(".json")) throw new Error("unexpected raw coverage file");
    const path = containedFile(dir, name); const stat = lstatSync(path);
    if (stat.isSymbolicLink() || !stat.size || stat.size > 512 * 1024 * 1024) throw new Error("empty, symlink or oversized raw coverage file");
    total += stat.size;
    if (total > 8 * 1024 ** 3) throw new Error("raw V8 byte limit exceeded");
  }
  return names;
}
export function readArtifacts(root: string, identity: Identity): { manifest: Manifest; directory: string }[] {
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) throw new Error("unexpected artifact entry");
  const artifacts = entries.map(entry => {
    const directory = join(root, entry.name);
    return { directory, manifest: JSON.parse(readNonempty(directory, "manifest.json")) as unknown };
  });
  const manifests = validateProducers(artifacts.map(artifact => artifact.manifest), identity);
  return artifacts.map((artifact, index) => ({ directory: artifact.directory, manifest: manifests[index] }));
}
