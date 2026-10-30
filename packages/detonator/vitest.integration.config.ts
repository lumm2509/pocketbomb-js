import { defineConfig } from "vitest/config";

// detonator against a real PocketBomb server (fuse; $POCKETBOMB_BIN or $POCKETBOMB_SRC,
// default ../pocketbase next to the monorepo)
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    fileParallelism: false,
    testTimeout: 60000,
    hookTimeout: 240000,
  },
});
