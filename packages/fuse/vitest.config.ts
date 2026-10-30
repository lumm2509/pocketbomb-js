import { defineConfig } from "vitest/config";

// unit tests (src/**/*.test.ts); the real server tests are in tests/ (pnpm test:integration)
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    testTimeout: 120000,
  },
});
