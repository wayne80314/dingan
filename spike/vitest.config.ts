import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      // Resolved relative to process.cwd(), which is spike/ when running
      // via `npm run test` / `npm run typecheck`.
      const migrations = await readD1Migrations("migrations");

      return {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          bindings: {
            // Consumed by test/apply-migrations.ts via applyD1Migrations().
            TEST_MIGRATIONS: migrations,
            // Fixtures in test/fixtures/*.json are pre-signed against this
            // exact secret -- keep in sync with test/fixtures.ts if this
            // changes.
            LINE_CHANNEL_SECRET: "test_channel_secret",
            LINE_CHANNEL_ACCESS_TOKEN: "test_channel_access_token",
            PANEL_TOKEN: "test_panel_token",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
