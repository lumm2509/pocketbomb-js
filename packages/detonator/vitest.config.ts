import { defineConfig } from "vitest/config";

// unit tests (src/**/*.test.ts[x]); the real server tests are in tests/ (pnpm test:integration)
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    environment: "node",
  },
});
