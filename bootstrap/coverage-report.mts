import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { normalizeLcovPaths, relocateV8Report, validateLcov } from "./coverage-paths.mts";
import { rawFiles, readArtifacts, readNonempty, validateManifest, validateProducers } from "./coverage-artifacts.mts";
import type { Identity, Manifest } from "./coverage-artifacts.mts";
import { copyDeclarationsFile, readCopyDeclarations } from "./coverage-copies.mts";

const here = dirname(fileURLToPath(import.meta.url));
async function main(args: string[]): Promise<void> {
  const command = args.shift(); const options: Record<string, string> = {};
  while (args.length) {
    const key = args.shift()!, value = args.shift();
    if (!key.startsWith("--") || !value || value.startsWith("--") || key in options) throw new Error("invalid CLI argument");
    options[key] = value;
  }
  const required = (key: string) => { if (!options[key]) throw new Error(`missing ${key}`); return options[key]; };
  const identity: Identity = { runId: required("--run-id"), attempt: required("--attempt"), checkoutSha: required("--checkout-sha") };
  const root = resolve(options["--root"] ?? process.cwd());
  if (command === "manifest") {
    const artifact = resolve(required("--artifact")); mkdirSync(artifact, { recursive: true });
    const manifest: Manifest = { producer: required("--producer"), ...identity, testOutcome: required("--test-outcome") };
    validateManifest(manifest, identity);
    if (manifest.producer === "worker") {
      const input = resolve(required("--input"));
      readNonempty(dirname(input), input);
      if (input !== join(artifact, "lcov.info")) copyFileSync(input, join(artifact, "lcov.info"));
    } else rawFiles(artifact);
    writeFileSync(join(artifact, "manifest.json"), JSON.stringify(manifest) + "\n");
    console.log(`coverage: manifest ${manifest.producer} ${manifest.testOutcome}`); return;
  }
  const output = resolve(options["--output"] ?? join(root, "coverage"));
  if (command === "assemble") {
    const artifacts = readArtifacts(resolve(required("--artifacts")), identity);
    const union = mkdtempSync(join(tmpdir(), "kherep-v8-union-"));
    let ignored = 0, raw = 0;
    try {
      for (const { manifest, directory } of artifacts) {
        if (manifest.producer === "worker") continue;
        const names = rawFiles(directory), declarationFile = join("raw", copyDeclarationsFile);
        const copies = existsSync(join(directory, declarationFile)) ? readCopyDeclarations(readNonempty(directory, declarationFile), root) : new Map<string, string>();
        const usedCopies = new Set<string>();
        for (const name of names) {
          const value: unknown = JSON.parse(readNonempty(directory, join("raw", name)));
          const result = relocateV8Report(value, options["--source-root"] ?? root, root, copies, usedCopies);
          ignored += result.ignored; raw++;
          writeFileSync(join(union, `${manifest.producer}-${name}`), JSON.stringify(result.report));
        }
        if (usedCopies.size !== copies.size) console.log(`coverage: ${copies.size - usedCopies.size} declared copies without a report in ${manifest.producer}`);
      }
      const nodeDir = join(output, "node"); mkdirSync(nodeDir, { recursive: true });
      const c8 = resolve(here, "../node_modules/c8/bin/c8.js");
      const result = spawnSync(process.execPath, [c8, "report", "--config", join(here, "coverage-config.json"), "--all", "--reporter=lcovonly", `--temp-directory=${union}`, `--reports-dir=${nodeDir}`], { cwd: root, stdio: "inherit" });
      if (result.error || result.status !== 0) throw new Error(`c8 conversion failed (${result.status})`);
      const worker = artifacts.find(artifact => artifact.manifest.producer === "worker")!;
      const workerDir = join(output, "worker"); mkdirSync(workerDir, { recursive: true });
      writeFileSync(join(workerDir, "lcov.info"), normalizeLcovPaths(readNonempty(worker.directory, "lcov.info"), root, join(root, "modules/control-plane/worker")));
      const { dropErasedTypes } = await import("./coverage-erased-types.mts");
      const corrected = dropErasedTypes(normalizeLcovPaths(readFileSync(join(nodeDir, "lcov.info"), "utf8"), root), root);
      writeFileSync(join(nodeDir, "lcov.info"), corrected.lcov);
      writeFileSync(join(output, "summary.json"), JSON.stringify({ erasedTypeOnlyFiles: corrected.dropped }) + "\n");
      console.log(`coverage: dropped erased type-only files: ${corrected.dropped.join(", ") || "none"}`);
      writeFileSync(join(output, "manifest.json"), JSON.stringify({ producers: artifacts.map(artifact => artifact.manifest) }) + "\n");
      verify(output, root, identity);
      console.log(`coverage: union ${raw} V8 files, ignored ${ignored} internal/dependency/external scripts`);
    } finally { rmSync(union, { recursive: true, force: true }); }
    return;
  }
  if (command === "verify") { verify(output, root, identity); return; }
  throw new Error("expected manifest, assemble or verify");
}
function verify(output: string, root: string, identity: Identity): void {
  const value: unknown = JSON.parse(readNonempty(output, "manifest.json"));
  if (!value || typeof value !== "object" || Object.keys(value).join() !== "producers" || !Array.isArray((value as { producers: unknown }).producers)) throw new Error("malformed final manifest");
  validateProducers((value as { producers: unknown[] }).producers, identity);
  for (const family of ["node", "worker"]) {
    const text = readNonempty(output, `${family}/lcov.info`); const summary = validateLcov(text, root);
    const sources = text.split("\n").filter(line => line.startsWith("SF:"));
    const workerSource = (source: string) => source.startsWith("SF:modules/control-plane/worker/src/");
    if (family === "worker" ? sources.some(source => !workerSource(source)) : sources.some(workerSource)) throw new Error("LCOV source ownership mismatch");
    console.log(`coverage: ${family} ${summary.files} files, ${summary.hit}/${summary.lines} lines hit`);
  }
  console.log(`coverage: verified checkout ${identity.checkoutSha}, run ${identity.runId}, attempt ${identity.attempt}`);
}
try { await main(process.argv.slice(2)); } catch (error) { console.error(`coverage: ${error instanceof Error ? error.message : "invalid report"}`); process.exitCode = 1; }
