#!/usr/bin/env node
// Render coverage/coverage-summary.json as a Markdown table.
// Appends to $GITHUB_STEP_SUMMARY when set (so it shows on the CI run /
// PR checks page), otherwise prints to stdout. Dependency-free on purpose.

import { readFileSync, appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const summaryPath = resolve(here, "..", "coverage", "coverage-summary.json");

let summary;
try {
  summary = JSON.parse(readFileSync(summaryPath, "utf8"));
} catch {
  console.error(
    `No coverage summary at ${summaryPath}. Run \`npm run test:coverage\` first.`,
  );
  process.exit(1);
}

const { total } = summary;
const pct = (m) => `${m.pct.toFixed(2)}% (${m.covered}/${m.total})`;

const md = [
  "## Test coverage (logic layer)",
  "",
  "| Metric | Coverage |",
  "| --- | --- |",
  `| Statements | ${pct(total.statements)} |`,
  `| Branches | ${pct(total.branches)} |`,
  `| Functions | ${pct(total.functions)} |`,
  `| Lines | ${pct(total.lines)} |`,
  "",
].join("\n");

const out = process.env.GITHUB_STEP_SUMMARY;
if (out) {
  appendFileSync(out, md + "\n");
} else {
  process.stdout.write(md + "\n");
}
