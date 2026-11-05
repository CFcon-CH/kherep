import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("the compatibility alias negative assertion rejects direct LAN HTTP and HTTPS", () => {
  const smoke = fs.readFileSync(new URL("./smoke-test.sh", import.meta.url), "utf8");
  const line = smoke.split("\n").find((row) => row.includes("COMPAT alias leaked direct LAN/curl"));
  assert.ok(line);
  const expression = /grep -Eq '([^']+)'/.exec(line)?.[1];
  assert.ok(expression);
  const rejected = new RegExp(expression);
  for (const value of ["http://192.168.1.2:1234", "https://192.168.1.2:1234", "curl https://example.invalid"]) {
    assert.equal(rejected.test(value), true, value);
  }
  assert.equal(rejected.test("https://example.invalid"), false);
});
