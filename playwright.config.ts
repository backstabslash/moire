import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/warmup.ts",
  timeout: 60_000,
  // CI runners have 4 CPUs, where a fourth worker gains nothing.
  workers: process.env.CI ? 3 : 4,
});
