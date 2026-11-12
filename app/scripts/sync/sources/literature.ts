/**
 * literature_mentions: one row per literature work and CoL binomial it
 * mentions, from OpenAlex and the Biodiversity Heritage Library.
 *
 * Built from: the local OpenAlex works (inputs/openalex-snapshot.ts), BHL's
 * monthly export reduced to its names (inputs/bhl.ts), taxa (the binomials).
 *
 * Columns:
 *   source            'openalex' | 'bhl'
 *   work_id           OpenAlex's work id; BHL's 'part:<id>' or 'item:<id>'
 *   publication_date  the work's full date, where it has one
 *   publication_year
 *   paper             which paper the work is: OpenAlex can hold one paper as
 *                     several records (a repository copy, a second DOI), and
 *                     works with the same paper count once (below)
 *   name              the binomial, exactly as a CoL species-rank name spells it
 *
 * Which species a name counts for is decided in count/paper_counts.sql.
 *
 * Decisions:
 *   - OpenAlex: a binomial is two consecutive words of the title or abstract
 *     (punctuation stripped) that are a CoL species-rank name. Only literature
 *     types count, not retracted works (LITERATURE_TYPES).
 *   - BHL: the names its own name-finding confirmed on a page, credited to the
 *     article the page is in, else to the volume.
 *   - The same paper: OpenAlex records with the same title (letters and digits,
 *     lowercased) and year, for a title of five words or more; else the same
 *     DOI; else the record alone. A short title ("Mus musculus", "Book
 *     reviews") is shared by different works, so it never merges records. A
 *     BHL work is its own paper.
 *   - The OpenAlex works are the newest release already read in full: reading
 *     a new one takes days (npm run sync:openalex), so a sync never starts it.
 */
import * as fs from "fs";
import * as path from "path";
import { CACHE_ROOT, output } from "../paths";
import { lit, openDuckDB } from "../sql";
import { finishedWorks, openAlexMentions } from "../inputs/openalex-snapshot";

/** The newest OpenAlex release whose works were read in full, if any. */
export function localOpenAlexWorks(): { release: string; files: string[] } | null {
  const root = path.join(CACHE_ROOT, "openalex");
  if (!fs.existsSync(root)) return null;
  const release = fs.readdirSync(root).filter((r) => fs.existsSync(path.join(root, r, "complete.json"))).sort().at(-1);
  return release ? { release, files: finishedWorks(path.join(root, release, "works")) } : null;
}

export async function buildLiteratureMentions(
  inputs: { taxa: string; openalex: { release: string; files: string[] }; bhlMentions: string },
  mentionsFile: string,
): Promise<{ openalex: number; bhl: number }> {
  const oaDir = path.join(path.dirname(mentionsFile), "openalex_mentions");
  await openAlexMentions({ works: inputs.openalex.files, taxa: inputs.taxa }, oaDir);
  const conn = await openDuckDB();
  // BHL's names are kept as its name-finding spelled them; only those CoL holds are kept here, as for OpenAlex.
  await conn.run(`COPY (
    SELECT 'openalex' AS source, work_id, TRY_CAST(publication_date AS DATE) AS publication_date,
           CAST(publication_year AS INTEGER) AS publication_year,
           CASE WHEN len(string_split(trim(coalesce(title, '')), ' ')) >= 5 AND publication_year IS NOT NULL
                  THEN 'title:' || lower(regexp_replace(title, '[^\\p{L}\\p{N}]', '', 'g')) || ':' || publication_year
                WHEN doi IS NOT NULL THEN 'doi:' || lower(doi)
                ELSE work_id END AS paper,
           name
    FROM read_parquet(${lit(path.join(oaDir, "*.parquet"))})
    UNION ALL
    SELECT 'bhl', b.work_id, TRY_CAST(b.publication_date AS DATE), CAST(b.publication_year AS INTEGER), b.work_id, b.name
    FROM read_parquet(${lit(inputs.bhlMentions)}) b
    SEMI JOIN (SELECT DISTINCT scientific_name AS name FROM read_parquet(${lit(inputs.taxa)}) WHERE rank = 'species') USING (name)
  ) TO ${lit(output(mentionsFile))} (FORMAT parquet, COMPRESSION zstd)`);
  fs.rmSync(oaDir, { recursive: true, force: true });
  const r = (await conn.runAndReadAll(`SELECT source, count(*) AS n FROM read_parquet(${lit(mentionsFile)}) GROUP BY 1`)).getRowObjects();
  const n = (s: string) => Number(r.find((x) => x.source === s)?.n ?? 0);
  return { openalex: n("openalex"), bhl: n("bhl") };
}
