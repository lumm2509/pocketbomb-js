import { defineConfig } from "vite";

// The browser page reads its configuration from the VITE_POCKETBOMB_* env variables
// (e.g. `VITE_POCKETBOMB_URL=http://127.0.0.1:8090 VITE_POCKETBOMB_PUBLIC_KEY=pb_pk_... pnpm dev`).
export default defineConfig({
  server: { port: 5173, strictPort: true },
  build: { target: "es2022" },
});
