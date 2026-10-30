import { defineConfig } from "vitest/config";

// fuse against the real PocketBomb server (built from $POCKETBOMB_SRC, default ../pocketbase
// next to the monorepo, or $POCKETBOMB_BIN)
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 240000,
    hookTimeout: 240000,
  },
});
