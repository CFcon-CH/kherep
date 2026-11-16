import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { parseModelPolicy, resolveModels } from "./model-policy.mts";

export const policyText = fs.readFileSync(new URL("../parity/model-policy.toml", import.meta.url), "utf8");
export const fixtureModels = ["gpt-6-astra", "gpt-6.9-sol", "gpt-6.10-sol", "gpt-5.6-terra", "gpt-6-luna"].map((model) => ({
  id: model, model, hidden: false,
  supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((reasoningEffort) => ({ reasoningEffort })),
}));
export function fixtureResolution() { return resolveModels(parseModelPolicy(policyText), { complete: true, models: fixtureModels }); }

// Every programmatic install test supplies its own offline catalog. Cloning
// prevents refresh or malformed-catalog cases from mutating another fixture.
export function fixtureModelCatalog() { return { complete: true as const, models: structuredClone(fixtureModels) }; }
export function fixtureModelOptions() { return { modelCatalog: fixtureModelCatalog() }; }

// Issue #737. Turns a fresh anchored installation into the anchor-less V1 shape
// an earlier installer left: the V1 resolution in the parity receipt and the
// dispatch snapshot, the observer pin flag, and no anchor or selection receipt.
// Predecessor upgrade tests start from this shape, as a real older host does.
export function legacyModelHome(codexHome: string): void {
  const resolution = fixtureResolution();
  const file = (relative: string) => new URL(relative, pathToFileURL(`${codexHome}/`));
  const receipt = JSON.parse(fs.readFileSync(file("orchestra/parity-receipt.json"), "utf8"));
  receipt.modelResolution = resolution;
  fs.writeFileSync(file("orchestra/parity-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
  const snapshot = JSON.parse(fs.readFileSync(file("hooks/parity/capabilities.json"), "utf8"));
  snapshot.modelResolution = resolution;
  snapshot.agents["claude-obs"].enforcePin = true;
  fs.writeFileSync(file("hooks/parity/capabilities.json"), `${JSON.stringify(snapshot, null, 2)}\n`);
  for (const name of ["orchestra/model-selection-anchor.json", "orchestra/model-selection-receipt.json"]) fs.rmSync(file(name));
}
