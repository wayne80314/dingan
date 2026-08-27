import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrations = await readD1Migrations("migrations");
      return {
        wrangler: { configPath: "./wrangler.hook.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            LINE_CHANNEL_SECRET: "test_channel_secret",
            LINE_CHANNEL_ACCESS_TOKEN: "test_channel_access_token",
            LINE_PROVIDER_ID: "test_provider",
            LINE_CHANNEL_ID: "test_channel",
          },
        },
      };
    }),
  ],
  test: { setupFiles: ["./test/apply-migrations.ts"] },
});
