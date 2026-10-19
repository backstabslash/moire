import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/warmup.ts",
  timeout: 60_000,
  workers: 1,
});
