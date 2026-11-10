/**
 * The ids to ask GBIF's live API with, for a species or group the lists key by
 * the sync's CoL release.
 *
 * In one sentence: when GBIF's matcher runs a newer CoL release than our data,
 * ask GBIF for records under both our id and the id its matcher gives our name
 * in that release, when that answer really is our name.
 *
 * Why: GBIF re-indexes against a newer CoL release a few times a year, and CoL
 * renumbers about 2% of ids per release. Between that and our next sync, our
 * ids can find few or no records live (the American wigeon's 3.4M records went
 * from 3Y3C6 to VJFB9 on 10 November 2026). Counts come from the snapshot and
 * are unaffected; this is for the live panels and gbif.org links.
 *
 * Decisions:
 *   - Both ids, not one: GBIF re-files over days, so a species' records can sit
 *     partly under each. GBIF ORs repeated taxonKeys, and each record has one
 *     key, so nothing is counted twice.
 *   - Our name, not the Red List's: the link already chose this CoL usage (by
 *     the matcher, a rule or a person); this only translates it to the newer
 *     release, by its own name, authorship and rank.
 *   - The matcher's answer is taken when it is our name: exactly, or
 *     respelled (a gender ending, obovatifolia / obovatifolius; or one letter,
 *     by the same authors). Not a fuzzy or genus-only answer, and not another
 *     word (Tritoma bipustulata answered with T. bipustula, another beetle).
 *   - Then a synonym is taken whoever's it is: GBIF files records by the name
 *     they carry, so a synonym of our name holds our name's records (COL26.10
 *     dropped Alopecurus pratensis L., and GBIF filed meadow foxtail's records
 *     under "A. pratensis Bourg. ex Lange"). An accepted species has records of
 *     its own, so it is taken only if its authors aren't other authors
 *     (authors.ts): a plant and an animal can share a binomial.
 *   - Our own id is always kept. CoL keeps an id through a respelling, and
 *     doesn't give it to another organism: of the 183 assessed species' ids
 *     that name something else in COL26.10, every one is the same name respelt
 *     (biocellatus / biocellata, a subgenus added or dropped).
 *   - Anything unreachable falls back to our id alone, which is what the app
 *     did before this existed.
 */
import COL_RELEASE from "@/config/col-release.json";
import { compareAuthors, oneTypo, type AuthorVerdict } from "@/lib/authors";
import { canonicalEpithet } from "@/lib/name-parts";
import { gbifJson } from "@/lib/gbif-fetch";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const RETRY = 10 * 60 * 1000;

interface Usage { name: string; authorship: string; rank: string }

const cache = new Map<string, { at: number; ttl: number; value: Promise<unknown> }>();

/** One cached answer per key: for `ttl` when it worked, ten minutes when it threw. */
function cached<T>(key: string, load: () => Promise<T>, ttl = DAY): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.value as Promise<T>;
  const entry = { at: Date.now(), ttl, value: load() as Promise<unknown> };
  entry.value.catch(() => { entry.ttl = RETRY; });
  cache.set(key, entry);
  return entry.value as Promise<T>;
}

/** The CoL release GBIF's matcher, and so its re-indexing, runs. Asked hourly, so a switch shows within the hour. */
function gbifRelease(): Promise<string | null> {
  return cached("release", async () => {
    const m = (await gbifJson("https://api.gbif.org/v2/species/match/metadata?checklistKey=xcol")) as
      { mainIndex?: { clbDatasetKey?: string | number } };
    return m.mainIndex?.clbDatasetKey != null ? String(m.mainIndex.clbDatasetKey) : null;
  }, HOUR);
}

/** Our id's name, authorship and rank in our release, or null if it doesn't have the id (a group key from another release). */
function usage(release: string, id: string): Promise<Usage | null> {
  return cached(`usage|${release}|${id}`, async () => {
    const res = await fetch(`https://api.checklistbank.org/dataset/${release}/nameusage/${encodeURIComponent(id)}`,
      { headers: { Accept: "application/json" }, cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`ChecklistBank returned HTTP ${res.status}`);
    const u = (await res.json()) as { name?: { scientificName?: string; authorship?: string; rank?: string } };
    return u.name?.scientificName ? { name: u.name.scientificName, authorship: u.name.authorship ?? "", rank: u.name.rank ?? "" } : null;
  });
}

/** A name's words, without a subgenus or rank markers: "Copris (Copris) warneri" is "copris warneri". */
const words = (name: string) => name.toLowerCase().replace(/\([^)]*\)/g, " ").replace(/×/g, " ")
  .split(/\s+/).filter((w) => w && !/^(subsp|ssp|var|f|forma|subvar)\.?$/.test(w));

/** Is `theirs` our name, allowing a respelt last word (a gender ending, or one letter by the same authors)? */
export function sameName(ours: string, theirs: string, authors: AuthorVerdict): boolean {
  const a = words(ours), b = words(theirs);
  if (a.length !== b.length || a.length === 0) return false;
  if (a.slice(0, -1).join(" ") !== b.slice(0, -1).join(" ")) return false;
  const [x, y] = [a.at(-1)!, b.at(-1)!];
  return x === y || (a.length > 1 && canonicalEpithet(x) === canonicalEpithet(y)) || (authors === "same" && oneTypo(x, y));
}

const SYNONYM = new Set(["SYNONYM", "AMBIGUOUS_SYNONYM", "HOMOTYPIC_SYNONYM", "HETEROTYPIC_SYNONYM", "PROPARTE_SYNONYM", "MISAPPLIED"]);

interface MatchAnswer {
  usage?: { key?: string; name?: string; canonicalName?: string; authorship?: string; status?: string };
  diagnostics?: { matchType?: string };
}

/** The id GBIF's matcher gives this name in the release it runs, if its answer can be taken (see Decisions). */
export function takeMatch(ours: Usage, m: MatchAnswer): string | null {
  const u = m.usage;
  if (!u?.key || !["EXACT", "VARIANT"].includes(m.diagnostics?.matchType ?? "")) return null;
  const authors = compareAuthors(ours.authorship, u.authorship ?? "");
  if (!sameName(ours.name, u.canonicalName ?? u.name ?? "", authors)) return null;
  if (SYNONYM.has(u.status ?? "")) return u.key;
  return authors === "other" ? null : u.key;
}

function liveMatch(u: Usage): Promise<string | null> {
  return cached(`match|${u.name}|${u.authorship}|${u.rank}`, async () => {
    const params = new URLSearchParams({ checklistKey: "xcol", scientificName: u.name });
    if (u.authorship) params.set("scientificNameAuthorship", u.authorship);
    if (u.rank) params.set("taxonRank", u.rank);
    return takeMatch(u, (await gbifJson(`https://api.gbif.org/v2/species/match?${params}`)) as MatchAnswer);
  });
}

/** The ids to ask GBIF's live API with for `key` (one of our CoL ids): ours, and the live release's where it differs. */
export async function liveGbifKeys(key: string, ourRelease: string = COL_RELEASE.key): Promise<string[]> {
  try {
    const live = await gbifRelease();
    if (!live || live === ourRelease) return [key];
    const ours = await usage(ourRelease, key);
    if (!ours) return [key];
    const theirs = await liveMatch(ours);
    return theirs && theirs !== key ? [key, theirs] : [key];
  } catch {
    return [key];
  }
}

/** Replace `param` in `params` with one entry per id (GBIF ORs repeated taxon parameters). */
export function setKeys(params: URLSearchParams, param: string, keys: string[]): URLSearchParams {
  params.delete(param);
  for (const k of keys) params.append(param, k);
  return params;
}

/** For tests. */
export function clearLiveKeyCache(): void {
  cache.clear();
}
