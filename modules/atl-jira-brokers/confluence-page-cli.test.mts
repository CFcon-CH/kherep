// Issue #1020 split: the page verbs moved to confluence-page-cli.mts receive
// each entry's own `fail`, so their error text still reaches stderr unchanged
// through both brokers instead of turning into "Internal error.".
import assert from "node:assert/strict";
import test from "node:test";

import { runCli as runClaude, type Injected } from "./atl-confluence-ccoder.mts";
import { runCli as runCodex } from "./atl-confluence.mts";

const CRED_PATH = "/nowhere/credentials-for-tests";

for (const [name, run, credEnv] of [
  ["atl-confluence-ccoder.mts", runClaude, "KHEREP_ATL_CRED_FILE_CLAUDE"],
  ["atl-confluence.mts", runCodex, "KHEREP_ATL_CRED_FILE_CODEX"],
] as const) {
  test(`${name}: a moved verb's own error text reaches stderr unchanged`, async () => {
    const err: string[] = [];
    let fetched = 0;
    const injected: Injected = {
      env: { KHEREP_ATL_SITE: "https://wiki.example.com", [credEnv]: CRED_PATH },
      readFile: async (path) => {
        if (path === CRED_PATH) return "Client ID: client-id-for-tests\nSecret: secret-for-tests-1234\n";
        throw new Error("no such file");
      },
      fetch: async () => { fetched += 1; throw new Error("no network in this test"); },
      log: () => {},
      logError: (line) => err.push(line),
    };
    const code = await run(["update", "--id", "1", "--format", "storage", "--body-file", "/nowhere/body.xml"], injected);
    assert.equal(code, 1);
    assert.deepEqual(err, ["--body-file is not readable."]);
    assert.equal(fetched, 0, "the body is read before anything reaches the network");
  });
}
