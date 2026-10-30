import { reactRouter } from "@react-router/dev/vite";
import { dynamite } from "@pocketbomb/dynamite/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    // env (the public URL/key for the browser, the private key stays server-only),
    // the dev proxy and the GraphQL codegen; `dynamite dev` starts fuse
    dynamite({ fuse: { seed: "./fuse.seed.ts" } }),
    reactRouter(),
  ],
});
