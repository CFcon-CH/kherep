import { SHARDS } from "./ci-shard.mts";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { containedFile } from "./coverage-paths.mts";
import { copyDeclarationsFile } from "./coverage-copies.mts";
import { canonicalFileUrl } from "./coverage-source-urls.mts";

export const producers = ["unit", "unit-macos", ...["hooks", "control-plane", ...SHARDS, "codex"].map(s => `unit-windows-${s}`), "typescript", "probe", "worker"];
export type Manifest = { producer: string; runId: string; attempt: string; checkoutSha: string; testOutcome: string; sourceRootUrl: string };
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
  if (Object.values(m).some(value => typeof value !== "string") || Object.keys(m).sort().join(",") !== "attempt,checkoutSha,producer,runId,sourceRootUrl,testOutcome" || !producers.includes(m.producer) || !/^\d+$/.test(m.runId) || !/^[1-9]\d*$/.test(m.attempt) || !/^[a-f0-9]{40}$/.test(m.checkoutSha) || !["success", "failure", "cancelled", "skipped"].includes(m.testOutcome)) throw new Error("malformed manifest fields");
  canonicalFileUrl(m.sourceRootUrl);
  if (!m.sourceRootUrl.endsWith("/")) throw new Error("noncanonical sourceRootUrl directory");
  for (const key of ["runId", "attempt", "checkoutSha"] as const) if (m[key] !== identity[key]) throw new Error(`manifest ${key} mismatch`);
  return m;
}
export function validateProducers(values: unknown[], identity: Identity): Manifest[] {
  const manifests = values.map(value => {
    const m = value as Manifest;
    const validated = validateManifest(value, { ...identity, attempt: m?.attempt });
    if (!/^[1-9]\d*$/.test(identity.attempt) || BigInt(validated.attempt) > BigInt(identity.attempt)) throw new Error("manifest future attempt mismatch");
    return validated;
  });
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
    if (!name.endsWith(".json") && name !== copyDeclarationsFile) throw new Error("unexpected raw coverage file");
    containedFile(dir, name); const stat = lstatSync(join(dir, name));
    if (stat.isSymbolicLink() || !stat.isFile() || !stat.size || stat.size > 512 * 1024 * 1024) throw new Error("empty, symlink or oversized raw coverage file");
    total += stat.size;
    if (total > 8 * 1024 ** 3) throw new Error("raw V8 byte limit exceeded");
  }
  const reports = names.filter(name => name !== copyDeclarationsFile);
  if (!reports.length) throw new Error("missing raw V8 files");
  return reports;
}
export function readArtifacts(root: string, identity: Identity): { manifest: Manifest; directory: string; name: string }[] {
  if (!/^[1-9]\d*$/.test(identity.attempt)) throw new Error("invalid assembly attempt");
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some(entry => !entry.isDirectory() || entry.isSymbolicLink())) throw new Error("unexpected artifact entry");
  const selected = new Map<string, { manifest: Manifest; directory: string; name: string }>();
  const seen = new Set<string>();
  for (const entry of entries) {
    const match = /^coverage-(.+)-(\d+)-([1-9]\d*)$/.exec(entry.name);
    if (!match || !producers.includes(match[1])) throw new Error("unexpected artifact name");
    const [, producer, runId, attempt] = match;
    if (runId !== identity.runId || BigInt(attempt) > BigInt(identity.attempt)) throw new Error("artifact runId or future attempt mismatch");
    const key = `${producer}:${attempt}`;
    if (seen.has(key)) throw new Error("duplicate producer attempt"); seen.add(key);
    const directory = join(root, entry.name);
    if (lstatSync(join(directory, "manifest.json")).isSymbolicLink()) throw new Error("symlink manifest");
    const manifest = validateManifest(JSON.parse(readNonempty(directory, "manifest.json")), { ...identity, attempt });
    if (manifest.producer !== producer) throw new Error("artifact name/manifest producer mismatch");
    const current = selected.get(producer);
    if (!current || BigInt(attempt) > BigInt(current.manifest.attempt)) selected.set(producer, { directory, manifest, name: entry.name });
  }
  const artifacts = [...selected.values()];
  validateProducers(artifacts.map(a => a.manifest), identity);
  for (const { directory, manifest } of artifacts) {
    const expected = manifest.producer === "worker" ? ["lcov.info", "manifest.json"] : ["manifest.json", "raw"];
    const entries = readdirSync(directory, { withFileTypes: true });
    if (entries.length !== expected.length || entries.some(entry => !expected.includes(entry.name) || entry.isSymbolicLink() || (entry.name === "raw" ? !entry.isDirectory() : !entry.isFile()))) throw new Error("unexpected artifact content");
  }
  return artifacts;
}
