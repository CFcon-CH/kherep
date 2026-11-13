// Issue #906. Trailing slashes of the Access team domain are removed from the
// first slash of the trailing run only, so a long run of slashes is not
// rescanned from each of its positions.
import { describe, expect, it } from "vitest";

import { accessConfig } from "../src/access.mts";
import type { Env } from "../src/env.mts";

const config = (domain: string) => accessConfig({ ACCESS_TEAM_DOMAIN: domain, ACCESS_AUD: "aud" } as Env);

describe("accessConfig team domain", () => {
  it("drops a trailing slash run and surrounding blanks", () => {
    expect(config("https://t.example///")?.teamDomain).toBe("https://t.example");
    expect(config(" https://t.example/ ")?.teamDomain).toBe("https://t.example");
  });

  it("refuses a path or a domain of slashes only", () => {
    expect(config("https://t.example/a/")).toBeNull();
    expect(config("///")).toBeNull();
  });

  it("handles a long slash run in linear time", () => {
    const started = performance.now();
    expect(config(`https://t.example${"/".repeat(50_000)}x`)).toBeNull();
    expect(performance.now() - started).toBeLessThan(200);
  });
});
