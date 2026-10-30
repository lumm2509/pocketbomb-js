#!/usr/bin/env node
import { run } from "../dist/cli/index.js";

run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
