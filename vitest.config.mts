import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git for Windows turns on core.autocrlf system-wide.
    env: { GIT_CONFIG_NOSYSTEM: "1" },
    // Starting git is several times slower on Windows.
    ...(process.platform === "win32" && { testTimeout: 60_000 }),
  },
});
