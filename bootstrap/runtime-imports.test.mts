import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { copyGithubBroker } from "../lib/github-broker-projection.mts";

const repo = path.resolve(import.meta.dirname, "..");

test("projected runtime artifacts import from their installed layouts", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-runtime-imports-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const localInference = path.join(root, "local-inference");
  fs.mkdirSync(localInference);
  fs.copyFileSync(path.join(repo, "modules", "local-inference", "runner.mts"), path.join(localInference, "runner.mts"));
  fs.cpSync(path.join(repo, "modules", "local-inference", "lib"), path.join(localInference, "lib"), { recursive: true });

  const bridge = path.join(root, "mcp-auth-bridge");
  fs.mkdirSync(bridge);
  for (const name of ["registry-http-wrapper.mts", "supergateway-secret-wrapper.mts"]) {
    fs.copyFileSync(path.join(repo, "modules", "mcp-auth-bridge", name), path.join(bridge, name));
  }

  const brokers = path.join(root, "tools");
  fs.cpSync(path.join(repo, "modules", "atl-jira-brokers"), brokers, { recursive: true });

  copyGithubBroker(repo, root, { copyFile(source, target) { fs.mkdirSync(path.dirname(target), {recursive:true}); fs.copyFileSync(source,target); return target; } });

  for (const file of [
    path.join(localInference, "runner.mts"),
    path.join(bridge, "registry-http-wrapper.mts"),
    path.join(bridge, "supergateway-secret-wrapper.mts"),
    path.join(brokers, "atlassian-credentials.mts"),
    path.join(brokers, "atlassian-cli-args.mts"),
    path.join(brokers, "atl-jira.mts"),
    path.join(brokers, "atl-jira-ccoder.mts"),
    // OP-1405. The Confluence brokers import their shared modules through
    // "./confluence-*.mts", which only resolves because the installers project
    // the broker directory flat. Importing them from the projected layout is
    // what proves that, rather than the checkout happening to work.
    path.join(brokers, "atl-confluence.mts"),
    path.join(brokers, "atl-confluence-ccoder.mts"),
    path.join(root, "tools", "github-broker", "github-claude.mts"),
    path.join(root, "tools", "github-broker", "github-codex.mts"),
  ]) {
    const loaded = await import(`${pathToFileURL(file).href}?isolated=${Date.now()}`);
    assert.ok(loaded && typeof loaded === "object", `${path.basename(file)} imports in isolation`);
  }
});
