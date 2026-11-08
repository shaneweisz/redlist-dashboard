/**
 * lineage: dbt's docs for the SQL stages (count, lists, the precomputed SQL
 * tables): each model's columns, SQL and lineage graph, built from the models and
 * the build, served locally and opened in the browser. Generated on demand rather
 * than kept in the repo: it is derived from the code, so a copy would go stale
 * with the next model change.
 *
 * The TypeScript stages around dbt are in docs/sync.md's overview diagram.
 *
 * Usage:  npm run sync:lineage [-- --no-open]   (after a sync, so the build has
 *         dbt's tables; Ctrl-C stops the server)
 */
import * as fs from "fs";
import * as path from "path";
import { spawn, execFileSync } from "child_process";
import { BUILD_DIR } from "./paths";
import { DBT_DIR, dbtInvocation } from "./dbt";

const PORT = Number(process.env.LINEAGE_PORT ?? 8432);
const URL = `http://127.0.0.1:${PORT}/`;

if (!fs.existsSync(path.join(BUILD_DIR, "core", "sync.duckdb"))) {
  throw new Error(`lineage: no dbt build at ${BUILD_DIR} (run npm run sync first)`);
}
const { args, env } = dbtInvocation(BUILD_DIR, new Date().toISOString().slice(0, 10),
  ["docs", "serve", "--host", "127.0.0.1", "--port", String(PORT)]);
const server = spawn("uv", args, { cwd: DBT_DIR, env, stdio: "inherit" });
server.on("exit", (code) => process.exit(code ?? 0));

// Open the page once the server answers (dbt generates the site first).
(async () => {
  for (let i = 0; i < 120; i++) {
    try { await fetch(URL); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
  }
  console.log(`\nLineage: ${URL}  (Ctrl-C to stop)`);
  if (process.platform === "darwin" && !process.argv.includes("--no-open")) execFileSync("open", [URL]);
})();
