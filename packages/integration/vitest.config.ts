import { defineConfig } from "vitest/config";

// Integration suite against a real PocketBomb server built from the Go repository
// started with fuse (pocketbomb-fuse, see tests/global-setup.ts). The packages are tested
// through their built `exports` (run `pnpm build` first; turbo does it for test:integration).
//
// Env: POCKETBOMB_BIN or POCKETBOMB_SRC (default ../pocketbase next to the monorepo), POCKETBOMB_FUSE_KEEP=1
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    // a single server is shared by the files (each file creates its own fixtures)
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 240000,
  },
});
