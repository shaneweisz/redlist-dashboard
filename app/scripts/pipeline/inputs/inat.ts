/**
 * iNaturalist's English common names, cached per month.
 *
 * iNaturalist curates one preferred English name per species (CoL never marks
 * one preferred), published as a weekly taxonomy export. The sync is monthly,
 * so one download per calendar month is plenty; fetch-inat-vernaculars does the
 * download and reduction. Lands in ~/.cache/redlist-dashboard/inat/<YYYY-MM>/.
 */

import * as fs from "fs";
import * as path from "path";
import { run as fetchInat } from "../../fetch-inat-vernaculars";
import { CACHE_ROOT } from "../paths";

export async function ensureInatNames(month = new Date().toISOString().slice(0, 7)): Promise<string> {
  const dir = path.join(CACHE_ROOT, "inat", month);
  const out = path.join(dir, "inat-vernaculars.parquet");
  if (fs.existsSync(path.join(dir, ".complete"))) return out;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  await fetchInat({ dataDir: dir });
  if (!fs.existsSync(out)) throw new Error(`inat: ${out} not written`);
  fs.writeFileSync(path.join(dir, ".complete"), new Date().toISOString() + "\n");
  return out;
}
