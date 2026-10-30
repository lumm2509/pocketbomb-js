import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  ignorePatterns: [
    "dist/**",
    "**/dist/**",
    "node_modules/**",
    "**/node_modules/**",
    ".turbo/**",
    "pnpm-lock.yaml",
    "*.md",
    "**/build/**",
    "**/.next/**",
    "**/.react-router/**",
    "**/.dynamite/**",
    "**/.test-tmp/**",
    "**/pocketbomb-env.d.ts",
    "**/next-env.d.ts",
  ],
});
