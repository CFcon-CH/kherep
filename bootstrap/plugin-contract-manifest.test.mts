// Issue #965. The manifest and list parsers of plugin-contract.mts refuse
// every shape they do not know, and the HTTPS marketplace form is accepted only
// credential-free. reconcile-plugins.test.mts drives the GitHub form end to
// end; these cases pin the refusals and the git URL form through the exported
// functions, with synthetic names and reserved domains only.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  ReconcileError, assertNoMarketplaceCollision, marketplaceMatches, parseMarketplaceList,
  parseMarketplaceManifest, parsePluginManifest, pluginInstalled, pluginSatisfied, verifyFinalState,
  type ClaudeState, type MarketplaceEntry, type PluginEntry,
} from "./plugin-contract.mts";

const gitSource = (url: unknown) => ({ source: { source: "git", url } });

test("an HTTPS marketplace is canonicalised: host lower-cased, trailing slashes dropped, ref kept", () => {
  assert.deepEqual(parseMarketplaceManifest({ main: gitSource("https://Git.Example.invalid/team/repo.git//") }), [{
    name: "main", source: "git", field: "url",
    canonical: "https://git.example.invalid/team/repo.git", ref: "https://Git.Example.invalid/team/repo.git//",
  }]);
  assert.equal(parseMarketplaceManifest({ root: gitSource("https://git.example.invalid/") })[0].canonical,
    "https://git.example.invalid/");
});

test("an HTTPS marketplace that is not a credential-free https URL is refused", () => {
  for (const url of [
    "not a url", "http://git.example.invalid/repo", "https://user@git.example.invalid/repo",
    "https://user:pass@git.example.invalid/repo", "https://git.example.invalid/repo?token=x",
    "https://git.example.invalid/repo#frag", "", 42, "https://git.example.invalid/re\npo",
  ]) {
    assert.throws(() => parseMarketplaceManifest({ main: gitSource(url) }),
      (error: unknown) => error instanceof ReconcileError && error.message === "invalid HTTPS marketplace source: main",
      JSON.stringify(url));
  }
  assert.throws(() => parseMarketplaceManifest({ main: { source: { source: "github", url: "https://git.example.invalid/r" } } }),
    /invalid HTTPS marketplace source: main/);
});

test("the marketplace manifest refuses every malformed definition by name", () => {
  const cases: Array<[unknown, RegExp]> = [
    [[], /marketplaces manifest must be an object/],
    [null, /marketplaces manifest must be an object/],
    [{ "-bad": gitSource("https://git.example.invalid/r") }, /contains an invalid name/],
    [{ main: "github" }, /invalid marketplace definition: main/],
    [{ main: { source: "github" } }, /invalid marketplace definition: main/],
    [{ main: { source: { source: "github" } } }, /exactly one source: main/],
    [{ main: { source: { source: "git", repo: "a/b", url: "https://git.example.invalid/r" } } }, /exactly one source: main/],
    [{ main: { source: { source: "git", repo: "example/main" } } }, /invalid GitHub marketplace source: main/],
    [{ main: { source: { source: "github", repo: "not-a-repo" } } }, /invalid GitHub marketplace source: main/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parseMarketplaceManifest(raw), (error: unknown) => error instanceof ReconcileError
      && message.test(error.message), JSON.stringify(raw));
  }
});

test("the plugin manifest refuses a missing object, a non-boolean flag, a bad id and an unknown marketplace", () => {
  const names = new Set(["main"]);
  const cases: Array<[unknown, RegExp]> = [
    [null, /must contain an enabledPlugins object/],
    [{ enabledPlugins: [] }, /must contain an enabledPlugins object/],
    [{ enabledPlugins: { "alpha@main": "yes" } }, /non-boolean flag/],
    [{ enabledPlugins: { "alpha-without-marketplace": true } }, /invalid plugin id/],
    [{ enabledPlugins: { "alpha@other": true } }, /unknown marketplace: alpha@other/],
  ];
  for (const [raw, message] of cases) {
    assert.throws(() => parsePluginManifest(raw, names), (error: unknown) => error instanceof ReconcileError
      && message.test(error.message), JSON.stringify(raw));
  }
  assert.deepEqual(parsePluginManifest({ enabledPlugins: { "alpha@main": true, "beta@other": false } }, names), ["alpha@main"]);
});

test("the marketplace list must be an array of well-formed, unique rows", () => {
  const row = { name: "main", source: "github", repo: "example/main" };
  assert.throws(() => parseMarketplaceList({}), /marketplace list JSON must be an array/);
  for (const malformed of [null, { ...row, name: "-bad" }, { ...row, name: 7 }, { ...row, source: "" }]) {
    assert.throws(() => parseMarketplaceList([malformed]), /marketplace list contains a malformed entry/);
  }
  assert.throws(() => parseMarketplaceList([row, { ...row }]), /contains a duplicate: main/);
  assert.equal(parseMarketplaceList([row]).get("main"), row);
});

function state(marketplaces: MarketplaceEntry[], plugins: PluginEntry[]): ClaudeState {
  return {
    marketplaces: new Map(marketplaces.map((entry) => [entry.name, entry])),
    plugins: new Map(plugins.map((entry) => [`${entry.id}\0${entry.scope}`, entry])),
  };
}

test("an HTTPS marketplace matches only the same source kind and canonical URL", () => {
  const [expected] = parseMarketplaceManifest({ main: gitSource("https://git.example.invalid/team/repo") });
  assert.equal(marketplaceMatches({ name: "main", source: "git", url: "https://GIT.example.invalid/team/repo/" }, expected), true);
  assert.equal(marketplaceMatches({ name: "main", source: "git", url: "https://git.example.invalid/team/other" }, expected), false);
  assert.equal(marketplaceMatches({ name: "main", source: "github", repo: "team/repo" }, expected), false);
  assert.equal(marketplaceMatches(undefined, expected), false);
  const collision = state([{ name: "main", source: "git", url: "https://git.example.invalid/team/other" }], []);
  assert.throws(() => assertNoMarketplaceCollision(collision, expected), /marketplace source collision: main/);
  assert.doesNotThrow(() => assertNoMarketplaceCollision(state([], []), expected));
});

test("the final snapshot names a missing marketplace and an unusable plugin", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kherep-plugin-contract-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "a-file");
  fs.writeFileSync(file, "");
  const [expected] = parseMarketplaceManifest({ main: gitSource("https://git.example.invalid/team/repo") });
  const listed: MarketplaceEntry = { name: "main", source: "git", url: "https://git.example.invalid/team/repo" };
  assert.throws(() => verifyFinalState(state([], []), [expected], []), /required marketplace missing: main/);

  const plugin = (installPath: string, enabled = true): PluginEntry => ({ id: "alpha@main", scope: "user", enabled, installPath });
  for (const installPath of ["relative/alpha", file, path.join(root, "absent")]) {
    const current = state([listed], [plugin(installPath)]);
    assert.equal(pluginInstalled(current, "alpha@main"), false, installPath);
    assert.throws(() => verifyFinalState(current, [expected], ["alpha@main"]), /required plugin is not usable: alpha@main/);
  }
  const disabled = state([listed], [plugin(root, false)]);
  assert.equal(pluginInstalled(disabled, "alpha@main"), true);
  assert.equal(pluginSatisfied(disabled, "alpha@main"), false);
  assert.doesNotThrow(() => verifyFinalState(state([listed], [plugin(root)]), [expected], ["alpha@main"]));
});
