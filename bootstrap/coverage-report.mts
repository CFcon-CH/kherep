import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { byCodeUnit, normalizeLcovPaths, relocateV8Report, validateLcov } from "./coverage-paths.mts";
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
    const manifest: Manifest = { producer: required("--producer"), ...identity, testOutcome: required("--test-outcome"), sourceRootUrl: pathToFileURL(realpathSync(root) + "/").href };
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
    if (options["--source-root"]) {
      const expected = pathToFileURL(realpathSync(options["--source-root"]) + "/").href;
      for (const { manifest } of artifacts) if (manifest.sourceRootUrl !== expected) throw new Error(`per-producer source root mismatch: ${manifest.producer}`);
    }
    const provenance: { producer: string; attempt: string; name: string; retained: number; ignored: number }[] = [];
    const union = mkdtempSync(join(tmpdir(), "kherep-v8-union-"));
    let ignored = 0, raw = 0;
    try {
      for (const { manifest, directory, name: artifactName } of artifacts) {
        if (manifest.producer === "worker") { provenance.push({ producer: manifest.producer, attempt: manifest.attempt, name: artifactName, retained: 0, ignored: 0 }); continue; }
        let retained = 0, producerIgnored = 0;
        const names = rawFiles(directory), declarationFile = join("raw", copyDeclarationsFile);
        const copies = existsSync(join(directory, declarationFile)) ? readCopyDeclarations(readNonempty(directory, declarationFile), root) : new Map<string, string>();
        const usedCopies = new Set<string>();
        for (const name of names) {
          const value: unknown = JSON.parse(readNonempty(directory, join("raw", name)));
          const result = relocateV8Report(value, manifest.sourceRootUrl, root, copies, usedCopies);
          ignored += result.ignored; producerIgnored += result.ignored; retained += result.report.result.length; raw++;
          writeFileSync(join(union, `${manifest.producer}-${name}`), JSON.stringify(result.report));
        }
        if (retained === 0) throw new Error("no retained V8 scripts for producer: " + manifest.producer);
        provenance.push({ producer: manifest.producer, attempt: manifest.attempt, name: artifactName, retained, ignored: producerIgnored });
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
      writeFileSync(join(output, "summary.json"), JSON.stringify({ erasedTypeOnlyFiles: corrected.dropped, producers: provenance }) + "\n");
      console.log(`coverage: dropped erased type-only files: ${corrected.dropped.join(", ") || "none"}`);
      writeFileSync(join(output, "manifest.json"), JSON.stringify({ ...identity, producers: artifacts.map(artifact => artifact.manifest) }) + "\n");
      verify(output, root, identity);
      console.log(`coverage: union ${raw} V8 files, ignored ${ignored} internal/dependency/external scripts`);
    } finally { rmSync(union, { recursive: true, force: true }); }
    return;
  }
  if (command === "verify") {
    const consumer = options["--consumer-attempt"];
    if (consumer && (!/^[1-9]\d*$/.test(consumer) || !/^[1-9]\d*$/.test(identity.attempt) || BigInt(identity.attempt) > BigInt(consumer))) throw new Error("future assembly attempt");
    if (options["--artifact-name"] && options["--artifact-name"] !== ("sonar-coverage-" + identity.runId + "-" + identity.attempt)) throw new Error("coverage artifact name mismatch");
    verify(output, root, identity); return;
  }
  throw new Error("expected manifest, assemble or verify");
}
function verify(output: string, root: string, identity: Identity): void {
  const value: unknown = JSON.parse(readNonempty(output, "manifest.json"));
  if (!value || typeof value !== "object" || Object.keys(value).sort(byCodeUnit).join() !== "attempt,checkoutSha,producers,runId" || !Array.isArray((value as { producers: unknown }).producers)) throw new Error("malformed final manifest");
  for (const key of ["runId", "attempt", "checkoutSha"] as const) if ((value as Identity)[key] !== identity[key]) throw new Error(`final manifest ${key} mismatch`);
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
