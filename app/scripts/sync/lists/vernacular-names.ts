/**
 * taxonomy/vernacular-names.json: one common name per class, order, family and
 * genus name, for the taxonomy tree's labels ("Browse Adansonia (Baobabs)").
 *
 * Built from: common_names (CoL's display names above species rank).
 *
 * Shape: { "<lowercased scientific name>": "<common name>" }
 *
 * One name per scientific name, chosen in sources/common-names.ts.
 */
import * as fs from "fs";
import { openDuckDB } from "../sql";
import { output, parquet } from "../paths";

export async function buildVernacularNames(inputs: { commonNames: string }, vernacularFile: string): Promise<void> {
  const conn = await openDuckDB();
  const rows = (await conn.runAndReadAll(`
    SELECT lower(scientific_name) AS key, name FROM ${parquet(inputs.commonNames)}
    WHERE source = 'col' AND kind = 'display' AND rank IN ('class', 'order', 'family', 'genus')`)).getRowObjects();
  const names: Record<string, string> = {};
  for (const r of rows) names[String(r.key)] = String(r.name);
  fs.writeFileSync(output(vernacularFile), JSON.stringify(names, null, 0));
  console.log(`   vernacular-names.json: ${rows.length.toLocaleString()} class/order/family/genus names`);
}
