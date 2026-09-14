// Runs every *.test.js under tests/unit in-process (no external test
// framework - matches wiring-guardian's/ui-judge's own convention: plain
// Node scripts with a non-zero exit code on failure).
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

function findTests(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith(".test.js")).map((f) => path.join(dir, f));
}

const files = findTests(path.join(ROOT, "unit"));

let passed = 0, failed = 0;
for (const file of files) {
  const label = path.relative(ROOT, file);
  process.stdout.write(`RUN  ${label}\n`);
  try {
    const mod = await import(`file://${file}`);
    const summary = await mod.default();
    passed++;
    console.log(`PASS ${label} ${summary ? JSON.stringify(summary) : ""}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${label}\n${err.stack || err}`);
  }
}

console.log(`\n${passed} passed, ${failed} failed (of ${files.length})`);
process.exit(failed > 0 ? 1 : 0);
