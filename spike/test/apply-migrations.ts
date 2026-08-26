import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";

// TEST_MIGRATIONS is injected via miniflare.bindings in vitest.config.ts
// (readD1Migrations() reading migrations/0001_init.sql at Node.js
// config-load time); it isn't part of the Worker's own Env, so it's read
// off `env` loosely rather than through src/types.ts's Env interface.
const testEnv = env as unknown as { DB: D1Database; TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(testEnv.DB, testEnv.TEST_MIGRATIONS);
