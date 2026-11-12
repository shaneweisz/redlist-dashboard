/**
 * The Biodiversity Heritage Library's monthly data export, reduced to the
 * species names each work mentions.
 *
 * BHL publishes its whole catalogue as tab-separated tables once a month
 * (https://www.biodiversitylibrary.org/Data/TSV/data.zip, about 2.5 GB),
 * including every scientific name its name-finding found on each scanned page
 * (pagename.txt). The export is downloaded to ~/Data/bhl/ and reduced once per
 * month to ~/.cache/redlist-dashboard/bhl/<month>/mentions.parquet:
 *
 *   work_id            'part:<id>' for an article BHL has segmented, else
 *                      'item:<id>' for the volume the page is in
 *   publication_date   the article's date where it gives a full one
 *   publication_year   its year, else the volume's
 *   name               the binomial BHL confirmed on one of its pages
 *
 * Only binomials are kept (two words, a capitalised genus); trinomials and
 * names above species rank are left out, as for OpenAlex.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import { CACHE_ROOT, output } from "../paths";
import { lit, openDuckDB } from "../sql";

const EXPORT_URL = "https://www.biodiversitylibrary.org/Data/TSV/data.zip";
const DOWNLOADS = path.join(os.homedir(), "Data", "bhl");
const TABLES = ["pagename", "page", "item", "part", "partpage"];

const tsv = (file: string) =>
  `read_csv(${lit(file)}, delim='\t', header=true, quote='', escape='', all_varchar=true, ignore_errors=true, null_padding=true)`;

/** The export's mentions, reduced once per month. Downloads it if it isn't there. */
export async function ensureBhlMentions(): Promise<{ month: string; mentions: string }> {
  const zip = path.join(DOWNLOADS, "data.zip");
  if (!fs.existsSync(zip)) {
    fs.mkdirSync(DOWNLOADS, { recursive: true });
    execFileSync("curl", ["-sSfLR", "--retry", "5", "-o", zip, EXPORT_URL], { stdio: "inherit" });
  }
  const month = fs.statSync(zip).mtime.toISOString().slice(0, 7);
  const out = path.join(CACHE_ROOT, "bhl", month, "mentions.parquet");
  if (fs.existsSync(out)) return { month, mentions: out };
  const dir = path.join(DOWNLOADS, "Data");
  if (!TABLES.every((t) => fs.existsSync(path.join(dir, `${t}.txt`)))) {
    execFileSync("unzip", ["-oq", zip, ...TABLES.map((t) => `Data/${t}.txt`), "-d", DOWNLOADS], { stdio: "inherit" });
  }
  const f = (t: string) => tsv(path.join(dir, `${t}.txt`));
  const conn = await openDuckDB();
  await conn.run(`CREATE TEMP TABLE page AS SELECT PageID AS page_id, ItemID AS item_id FROM ${f("page")}`);
  await conn.run(`CREATE TEMP TABLE partpage AS SELECT PartID AS part_id, PageID AS page_id FROM ${f("partpage")}`);
  await conn.run(`CREATE TEMP TABLE part AS SELECT PartID AS part_id, "Date" AS d FROM ${f("part")}`);
  await conn.run(`CREATE TEMP TABLE item AS SELECT ItemID AS item_id, "Year" AS y FROM ${f("item")}`);
  await conn.run(`COPY (
    WITH names AS (
      SELECT DISTINCT PageID AS page_id, trim(NameConfirmed) AS name FROM ${f("pagename")}
      WHERE regexp_full_match(trim(NameConfirmed), '[A-Z][a-z]+ [a-z-]+')),
    located AS (
      SELECT n.name, coalesce('part:' || pp.part_id, 'item:' || p.item_id) AS work_id, pp.part_id, p.item_id
      FROM names n JOIN page p USING (page_id) LEFT JOIN partpage pp USING (page_id))
    SELECT DISTINCT l.work_id,
           CASE WHEN regexp_full_match(pt.d, '\\d{4}-\\d{2}-\\d{2}') THEN TRY_CAST(pt.d AS DATE) END AS publication_date,
           coalesce(TRY_CAST(regexp_extract(pt.d, '(\\d{4})', 1) AS INTEGER), TRY_CAST(regexp_extract(i.y, '(\\d{4})', 1) AS INTEGER)) AS publication_year,
           l.name
    FROM located l LEFT JOIN part pt USING (part_id) LEFT JOIN item i ON i.item_id = l.item_id
  ) TO ${lit(output(out))} (FORMAT parquet, COMPRESSION zstd)`);
  const [s] = (await conn.runAndReadAll(`SELECT count(*) AS n, count(DISTINCT work_id) AS works, count(DISTINCT name) AS names
    FROM read_parquet(${lit(out)})`)).getRowObjects();
  console.log(`   BHL ${month}: ${Number(s.n).toLocaleString()} mentions of ${Number(s.names).toLocaleString()} binomials in ${Number(s.works).toLocaleString()} works`);
  return { month, mentions: out };
}

const isDirectRun = process.argv[1]?.endsWith("inputs/bhl.ts");
if (isDirectRun) {
  ensureBhlMentions().then((r) => console.log(r)).catch((e) => { console.error(e); process.exit(1); });
}
