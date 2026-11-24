/**
 * The OpenAlex ids a set of works has now. Between our snapshot and today
 * OpenAlex merges duplicate records into one, and its id filter doesn't follow
 * a merge (a merged id finds nothing), while fetching that one work does. So the
 * ids the filter doesn't return are looked up one by one and replaced by the
 * record they became; one that's gone is dropped.
 *
 * Best effort, inside `timeoutMs`: on any failure the ids come back unchanged,
 * and the link still shows every work OpenAlex hasn't merged.
 */
import { CONTACT_EMAIL, fetchJson } from "./sources/http";

const API = "https://api.openalex.org/works";
/** Merged records looked up per link at most; beyond it they're left as they are. */
const MAX_LOOKUPS = 20;
const num = (id: string): bigint | null => {
  const m = /W(\d+)$/.exec(id);
  return m ? BigInt(m[1]) : null;
};

export async function currentWorks(works: readonly bigint[], timeoutMs = 3000): Promise<bigint[]> {
  if (works.length === 0) return [];
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    const filter = encodeURIComponent(`openalex:${works.map((w) => `W${w}`).join("|")}`);
    const found = await fetchJson<{ results: { id: string }[] }>(
      `${API}?filter=${filter}&select=id&per_page=100&mailto=${CONTACT_EMAIL}`, { signal });
    const present = new Set(found.results.map((r) => num(r.id)?.toString()));
    const missing = works.filter((w) => !present.has(w.toString()));
    const replaced = new Map<string, bigint | null>();
    await Promise.all(missing.slice(0, MAX_LOOKUPS).map(async (w) => {
      try {
        // Fetching a merged id answers with the record it became.
        const r = await fetchJson<{ id: string }>(`${API}/W${w}?select=id&mailto=${CONTACT_EMAIL}`, { signal });
        replaced.set(w.toString(), num(r.id));
      } catch {
        replaced.set(w.toString(), null);
      }
    }));
    const out: bigint[] = [];
    const seen = new Set<string>();
    for (const w of works) {
      const now = replaced.has(w.toString()) ? replaced.get(w.toString())! : w;
      if (now != null && !seen.has(now.toString())) { seen.add(now.toString()); out.push(now); }
    }
    return out.length > 0 ? out : [...works];
  } catch {
    return [...works];
  }
}
