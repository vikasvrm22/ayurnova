#!/usr/bin/env node
import { main } from "../src/cli.js";

main().then((code) => process.exit(code || 0)).catch((err) => {
  console.error("UI Judge failed:", err);
  process.exit(1);
});
