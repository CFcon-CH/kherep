import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Workers Vitest integration: tests run inside workerd with the Durable
// Objects from wrangler.jsonc. The miniflare bindings replace the empty Access
// placeholders with test-only values; no real team domain is ever contacted
// because the tests stub the JWKS fetch.
// https://developers.cloudflare.com/workers/testing/vitest-integration/configuration/
export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Test-only: lets test/interop.test.mts load the node client, which
        // signs with node:crypto. The Worker itself uses WebCrypto only and is
        // bundled without this flag (see wrangler.jsonc and the dry run).
        compatibilityFlags: ["nodejs_compat"],
        bindings: {
          ACCESS_TEAM_DOMAIN: "https://team.example.com",
          ACCESS_AUD: "test-audience",
        },
      },
    }),
  ],
  test: {
    coverage: {
      provider: "istanbul",
      reporter: ["lcovonly"],
      reportsDirectory: "coverage",
      reportOnFailure: true,
      include: ["src/**/*.mts", "src/**/*.ts"],
    },
    include: ["test/**/*.test.mts"],
    setupFiles: ["./test/quiet-sql-log.mts"],
    // Issue #607: the node harness tests wait up to 5 s per event (WAIT in
    // task-helpers.mts and mcp-two-chat-fixture.mts, the inline bound at
    // interop.test.mts:48, and task-refusal-e2e.test.mts); the default 5 s
    // test bound left them no headroom. A passing test's duration is unchanged.
    testTimeout: 30_000,
  },
});
