/**
 * derive-gbif-taxon-keys: Red List group definitions → GBIF taxon keys
 *
 * Each Table 1a group is defined by the IUCN class or order names in TAXA[].redlist.
 * The GBIF side of the same group used to be a hand-maintained list of GBIF keys,
 * and hand-maintained lists drift from the definition they are supposed to mirror:
 *
 *   - Corals are defined as Scleractinia + Alcyonacea + Pennatulacea, but the GBIF
 *     side was a single class key (Anthozoa). That held while GBIF's Backbone put
 *     octocorals inside Anthozoa; Catalogue of Life raises them to a class of their
 *     own, so two of the three orders silently stopped being fetched.
 *   - Gymnosperms listed both Pinopsida and Gnetidae, and Gnetidae sits *inside*
 *     Pinopsida in CoL — so those species were counted twice, which is how 43
 *     species ended up with more records since assessment than in total.
 *
 * So the keys are derived from the group definition instead, and checked:
 *
 *   1. COVERAGE  — every class/order the Red List assigns to a group resolves to a
 *                  key. An unresolved name is a group silently missing species.
 *   2. NO OVERLAP — no key in a group is an ancestor of another in the same group.
 *                  Overlapping keys double-count in the year-bucketed count phase.
 *
 * Keys come from GBIF, never from a local copy of the checklist. The reason is NOT
 * that GBIF holds usages our export lacks — every one of the 140,482 GBIF keys our
 * assessed data carries is present in backbone.parquet. It is that GBIF's matcher
 * answers a different question: it returns the key for the NAME as the Red List
 * wrote it, where a CoL join returns the accepted CONCEPT that name folds into.
 * Those differ for 3,215 assessed species, and counting the concept attributes a
 * broader taxon's records to a narrower assessment (Octolobus angustatus: 62
 * occurrences under its own name, 702 under CoL's accepted concept).
 *
 * Usage:
 *   npx tsx scripts/sync/outputs/derive-gbif-taxon-keys.ts            # report only
 *   npx tsx scripts/sync/outputs/derive-gbif-taxon-keys.ts --write    # also write the config
 */

import * as fs from "fs";
import * as path from "path";
import { TAXA_DEFINITIONS, type Taxon } from "../../lib/taxa";
import { loadEnvFiles, delay } from "../../lib/utils";
import { COL_XR_CHECKLIST_KEY } from "../../../src/lib/gbif";

const OUT_PATH = path.join(__dirname, "..", "..", "..", "src", "config", "gbif-taxon-keys.json");
const REQUEST_DELAY = 120;
const MAX_RETRIES = 4;

/** GBIF kingdom names, keyed by the kingdomKey each group carries. */
const KINGDOM_NAME: Record<string, string> = {
  N: "Animalia",
  C: "Chromista",
  F: "Fungi",
  P: "Plantae",
};

/**
 * IUCN names Catalogue of Life has retired.
 *
 * Every entry was settled by asking where the affected species actually sit in
 * CoL, not by picking a plausible-looking replacement — the count is how many
 * assessed species carry the name in the Red List data, and the placement comes
 * from matching those species. An entry asserts "these species are still
 * fetched", so it must never be used to wave away a name that is simply missing.
 *
 * Two forms: `resolveAs` names a different taxon to resolve instead; `coveredBy`
 * says another key already in the group contains it.
 */
const RETIRED_NAMES: Record<string, { resolveAs?: string; coveredBy?: string; why: string }> = {
  ISOPTERA: {
    coveredBy: "BLATTODEA",
    why: "CoL folds termites into Blattodea, which this group already lists",
  },
  GNETOPSIDA: {
    coveredBy: "PINOPSIDA",
    why: "CoL has no Gnetopsida; its Gnetidae sits inside Pinopsida, already listed",
  },
  MAXILLOPODA: {
    resolveAs: "Copepoda",
    why: "obsolete class; all 74 assessed species carrying it match to class Copepoda in CoL",
  },
  HEXANAUPLIA: {
    resolveAs: "Copepoda",
    why: "obsolete class; all 36 assessed species carrying it match to class Copepoda in CoL",
  },
  TURBELLARIA: {
    resolveAs: "Tricladida",
    why:
      "Turbellaria is paraphyletic and CoL keeps it only as a near-empty husk — 13 species, " +
      "against 1,938 in Tricladida, where both assessed species (Romankenkius pedderensis NT, " +
      "Sphalloplana coreana DD) actually sit. Resolving the class name gave a key that matched " +
      "13,998 occurrences but no species-rank taxa at all, so the group silently had no flatworms",
  },
  PENICILLARIA: {
    resolveAs: "Ceriantharia",
    why: "the one assessed species carrying it (Arachnanthus oligopodus) is order Ceriantharia in CoL",
  },
  HETEROKONTOPHYTA: {
    resolveAs: "Phaeophyceae",
    why: "IUCN's phylum for brown algae; CoL's equivalent is Ochrophyta, but every assessed species in this group is class Phaeophyceae, which is what the group actually means",
  },
};

export interface DerivedKey {
  /** The IUCN name this key was derived from, as it appears in the Red List data. */
  redlistName: string;
  rank: "kingdom" | "phylum" | "class" | "order";
  /** GBIF taxon key, or null when the name could not be resolved. */
  taxonKey: string | null;
  /** What GBIF matched it to, for review. */
  matchedName?: string;
  matchType?: string;
  /** Ancestor keys, used for the overlap check and kept for auditability. */
  ancestors?: string[];
}

interface MatchResult {
  usage?: { key?: string; canonicalName?: string; rank?: string; status?: string };
  acceptedUsage?: { key?: string; canonicalName?: string };
  classification?: Array<{ key: string; name: string; rank: string }>;
  diagnostics?: { matchType?: string };
}

async function gbifMatch(params: URLSearchParams): Promise<MatchResult | null> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`https://api.gbif.org/v2/species/match?${params}`);
      if (res.status === 429 || (res.status >= 500 && res.status < 600)) {
        await delay(Math.pow(2, attempt + 1) * 1000);
        continue;
      }
      if (!res.ok) return null;
      return (await res.json()) as MatchResult;
    } catch {
      if (attempt < MAX_RETRIES) {
        await delay(Math.pow(2, attempt + 1) * 1000);
        continue;
      }
      return null;
    }
  }
  return null;
}

/** IUCN writes names in caps ("MAMMALIA"); GBIF wants them capitalised. */
function toTaxonName(iucnName: string): string {
  const lower = iucnName.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export async function resolveName(
  iucnName: string,
  rank: "kingdom" | "phylum" | "class" | "order",
  kingdom: string,
): Promise<DerivedKey> {
  const retired = RETIRED_NAMES[iucnName];
  // A retired name is resolved under its CoL replacement, but keeps reporting the
  // IUCN name it came from so the config stays traceable to the group definition.
  const name = retired?.resolveAs ?? toTaxonName(iucnName);
  const params = new URLSearchParams({
    checklistKey: COL_XR_CHECKLIST_KEY,
    scientificName: name,
    kingdom,
  });
  const data = await gbifMatch(params);
  const usage = data?.acceptedUsage ?? data?.usage;
  const matchType = data?.diagnostics?.matchType;

  // Two signals, because neither alone is sufficient.
  //
  // matchType alone over-rejects: GBIF reports HIGHERRANK both when it genuinely
  // fell back up the tree (Plecoptera → Insecta) and when it found the exact name
  // but read the rank differently (Mantodea → Mantodea).
  //
  // Name equality alone over-rejects too: IUCN and CoL disagree about plenty of
  // higher taxa, and the disagreement is usually the answer rather than an error —
  // Alcyonacea is Octocorallia in CoL, Udeonychophora is Onychophora, Isoetopsida
  // is the order Isoetales. Those are the keys the group needs.
  //
  // So: accept when the name comes back unchanged, whatever the matchType; accept
  // a changed name when GBIF resolved it confidently (EXACT/VARIANT/FUZZY, i.e. it
  // followed a synonym); reject only a changed name reached by climbing the tree.
  const sameName = usage?.canonicalName?.toLowerCase() === name.toLowerCase();
  const resolvedConfidently = matchType === "EXACT" || matchType === "VARIANT" || matchType === "FUZZY";
  if (usage?.key && (sameName || resolvedConfidently)) {
    return {
      redlistName: iucnName,
      rank,
      taxonKey: usage.key,
      matchedName: usage.canonicalName,
      matchType,
      ancestors: (data?.classification ?? []).map((c) => c.key).filter((k) => k !== usage.key),
    };
  }

  // The matcher gives up on homonyms — Plecoptera and Collembola are each both an
  // order/class and a genus, and it returns the common ancestor rather than pick.
  // Searching the checklist by rank does disambiguate, and the species record
  // carries the CoL id in taxonID.
  const viaSearch = await resolveViaSearch(name, rank);
  if (viaSearch) {
    return { redlistName: iucnName, rank, taxonKey: viaSearch.key, matchedName: name, matchType: "SEARCH", ancestors: viaSearch.ancestors };
  }

  // Genuinely not in CoL — the name is one IUCN still uses and CoL has retired
  // (Polychaeta, Maxillopoda, Gnetopsida). Reported so it can be checked against
  // the group's other keys rather than silently dropped.
  return {
    redlistName: iucnName,
    rank,
    taxonKey: null,
    matchedName: usage?.canonicalName,
    matchType: matchType ?? "NONE",
  };
}

/** Resolve a name GBIF's matcher refuses to disambiguate, via the checklist search. */
async function resolveViaSearch(
  name: string,
  rank: string,
): Promise<{ key: string; ancestors: string[] } | null> {
  const params = new URLSearchParams({
    datasetKey: COL_XR_CHECKLIST_KEY,
    q: name,
    rank: rank.toUpperCase(),
    status: "ACCEPTED",
    limit: "20",
  });
  try {
    const res = await fetch(`https://api.gbif.org/v1/species/search?${params}`);
    if (!res.ok) return null;
    const data = (await res.json()) as { results?: Array<{ key: number; canonicalName?: string; rank?: string }> };
    const hit = (data.results ?? []).find(
      (r) => r.canonicalName?.toLowerCase() === name.toLowerCase() && r.rank?.toLowerCase() === rank.toLowerCase()
    );
    if (!hit) return null;

    // The search returns GBIF's own numeric key for the checklist row; taxonID is
    // the CoL id the occurrence index is keyed by.
    const detail = await fetch(`https://api.gbif.org/v1/species/${hit.key}`);
    if (!detail.ok) return null;
    const rec = (await detail.json()) as { taxonID?: string };
    if (!rec.taxonID) return null;

    const back = await gbifMatch(new URLSearchParams({ checklistKey: COL_XR_CHECKLIST_KEY, usageKey: rec.taxonID }));
    return {
      key: rec.taxonID,
      ancestors: (back?.classification ?? []).map((c) => c.key).filter((k) => k !== rec.taxonID),
    };
  } catch {
    return null;
  }
}

export async function deriveForTaxon(taxon: Omit<Taxon, "gbif">): Promise<DerivedKey[]> {
  const kingdom = KINGDOM_NAME[taxon.kingdomKey] ?? "Animalia";
  const out: DerivedKey[] = [];
  for (const query of taxon.redlist) {
    const rank = ({ kingdom_name: "kingdom", phylum_name: "phylum", class_name: "class", order_name: "order" } as const)[query.filterColumn];
    for (const value of query.filterValues) {
      out.push(await resolveForValue(value, rank, kingdom));
      await delay(REQUEST_DELAY);
    }
  }
  return out;
}

async function resolveForValue(
  value: string,
  rank: "kingdom" | "phylum" | "class" | "order",
  kingdom: string,
) {
  return resolveName(value, rank, kingdom);
}

/**
 * A key must not be an ancestor of another key in the same group: the count phase
 * runs one query per key and sums, so an ancestor/descendant pair counts its
 * overlap twice.
 */
export function pruneDescendants(keys: DerivedKey[]): { kept: DerivedKey[]; pruned: Array<{ key: DerivedKey; insideOf: DerivedKey }> } {
  const pruned: Array<{ key: DerivedKey; insideOf: DerivedKey }> = [];
  const kept = keys.filter((k) => {
    if (!k.taxonKey) return true;
    const ancestor = keys.find((other) => other.taxonKey && other !== k && k.ancestors?.includes(other.taxonKey));
    if (ancestor) {
      pruned.push({ key: k, insideOf: ancestor });
      return false;
    }
    return true;
  });
  return { kept, pruned };
}

/**
 * Post-condition on pruneDescendants, not an independent search.
 *
 * It runs on the already-pruned list and looks for exactly what pruning removes,
 * so in a working build it always returns empty — which is the point. It is here
 * to fail if pruneDescendants ever stops doing its job, not to find overlaps the
 * pruner missed. Do not read a clean run of this as evidence that overlaps were
 * searched for and none existed; the cross-group pass below is what actually
 * finds them, and it found two.
 */
export function findOverlaps(keys: DerivedKey[]): Array<{ ancestor: string; descendant: string }> {
  const overlaps: Array<{ ancestor: string; descendant: string }> = [];
  for (const a of keys) {
    if (!a.taxonKey) continue;
    for (const b of keys) {
      if (!b.taxonKey || a === b) continue;
      if (b.ancestors?.includes(a.taxonKey)) {
        overlaps.push({ ancestor: `${a.matchedName} [${a.taxonKey}]`, descendant: `${b.matchedName} [${b.taxonKey}]` });
      }
    }
  }
  return overlaps;
}

export async function run(write: boolean = false): Promise<void> {
  const config: Record<string, DerivedKey[]> = {};
  let unresolved = 0;
  let overlapping = 0;

  for (const taxon of TAXA_DEFINITIONS) {
    const derived = await deriveForTaxon(taxon);

    // A key inside another key in the same group is redundant, and worse than
    // redundant: the count phase queries each key and sums, so the overlap gets
    // counted twice. IUCN's classes are often CoL's orders (Isoetopsida is the
    // order Isoetales inside Lycopodiopsida), so this is common, not exceptional.
    const { kept, pruned } = pruneDescendants(derived);
    // Two IUCN names can resolve to one CoL taxon (Maxillopoda and Hexanauplia are
    // both Copepoda). Querying it twice would double-count in the year buckets.
    const seen = new Set<string>();
    const deduped = kept.filter((k) => {
      if (!k.taxonKey) return true;
      if (seen.has(k.taxonKey)) return false;
      seen.add(k.taxonKey);
      return true;
    });
    config[taxon.id] = deduped;

    const missing = deduped.filter((k) => {
      if (k.taxonKey) return false;
      const retired = RETIRED_NAMES[k.redlistName];
      // An exemption only holds if the covering name actually resolved in this group.
      return !(retired?.coveredBy && deduped.some((o) => o.redlistName === retired.coveredBy && o.taxonKey));
    });
    const overlaps = findOverlaps(deduped);
    unresolved += missing.length;
    overlapping += overlaps.length;

    const resolved = deduped.filter((k) => k.taxonKey).length;
    console.log(`${taxon.id.padEnd(30)} ${resolved}/${deduped.length} resolved`);
    for (const m of missing) console.log(`   UNRESOLVED  ${m.redlistName} (${m.rank}) — ${m.matchType}`);
    for (const k of deduped.filter((k) => !k.taxonKey && !missing.includes(k))) {
      console.log(`   RETIRED     ${k.redlistName} — ${RETIRED_NAMES[k.redlistName].why}`);
    }
    for (const pr of pruned) console.log(`   PRUNED      ${pr.key.matchedName} [${pr.key.taxonKey}] is inside ${pr.insideOf.matchedName}`);
    for (const o of overlaps) console.log(`   OVERLAP     ${o.descendant} is inside ${o.ancestor}`);
    for (const k of deduped.filter((k) => k.taxonKey && k.matchedName?.toLowerCase() !== toTaxonName(k.redlistName).toLowerCase())) {
      console.log(`   RENAMED     ${k.redlistName} → ${k.matchedName} [${k.taxonKey}]`);
    }
  }

  // Overlap between groups, not just within one.
  //
  // The within-group check runs per taxon and cannot see that corals derives
  // Octocorallia while other_invertebrates separately names two orders inside it.
  // 1,879 species were fetched by both, and the only thing that noticed was an id
  // collision three phases downstream. Which group keeps such a species is then
  // decided by whichever CSV happens to be smaller — stable today, and silently
  // reversible the moment those sizes cross.
  const crossGroup: string[] = [];
  const entries = Object.entries(config);
  for (const [groupA, keysA] of entries) {
    for (const [groupB, keysB] of entries) {
      if (groupA >= groupB) continue;
      for (const a of keysA) {
        if (!a.taxonKey) continue;
        for (const b of keysB) {
          if (!b.taxonKey) continue;
          if (b.ancestors?.includes(a.taxonKey)) {
            crossGroup.push(`${groupA}/${a.matchedName} contains ${groupB}/${b.matchedName}`);
          } else if (a.ancestors?.includes(b.taxonKey)) {
            crossGroup.push(`${groupB}/${b.matchedName} contains ${groupA}/${a.matchedName}`);
          }
        }
      }
    }
  }
  // Resolve rather than only report: the group holding the ancestor keeps it, and
  // the descendant keys are dropped, so no species is fetched twice. The assessed
  // species of the losing group are unaffected — their counts come through the
  // mapping join on the key, which no longer cares which group's file it landed
  // in. For corals this is also what the Red List data says: 25 of the 26 assessed
  // octocorals are filed under corals.
  for (const c of crossGroup) console.log(`   CROSS-GROUP  ${c} — descendant dropped`);
  //
  // Collected first, then applied once. Assigning inside the loop reassigned
  // config[groupB] from the pre-loop `entries` snapshot every time, so each outer
  // iteration discarded the previous one's filtering and only the last groupA
  // survived — the script printed "descendant dropped" for corals/Octocorallia
  // containing other_invertebrates' Malacalcyonacea and Scleralcyonacea, and then
  // wrote a config that still contained both. A guard that reports a fix it did
  // not apply is worse than no guard.
  const drop = new Map<string, Set<string>>();
  for (const [groupA, keysA] of entries) {
    for (const [groupB, keysB] of entries) {
      if (groupA === groupB) continue;
      for (const b of keysB) {
        if (!b.taxonKey) continue;
        if (keysA.some((a) => a.taxonKey && b.ancestors?.includes(a.taxonKey))) {
          if (!drop.has(groupB)) drop.set(groupB, new Set());
          drop.get(groupB)!.add(b.taxonKey);
        }
      }
    }
  }
  for (const [group, keys] of drop) {
    config[group] = config[group].filter((k) => !k.taxonKey || !keys.has(k.taxonKey));
  }

  console.log(`\n${unresolved} unresolved, ${overlapping} overlapping, ${crossGroup.length} cross-group`);

  if (write) {
    fs.writeFileSync(OUT_PATH, JSON.stringify(config, null, 2) + "\n");
    console.log(`Wrote ${OUT_PATH}`);
  } else {
    console.log("(report only — pass --write to update the config)");
  }

  if (unresolved > 0 || overlapping > 0) {
    // Thrown, not just an exit code, so that running inside sync.ts fails the
    // sync rather than quietly setting a status nobody reads.
    throw new Error(
      `derive-gbif-taxon-keys: ${unresolved} unresolved, ${overlapping} overlapping. ` +
      `Both are failures, not warnings: an unresolved name is a group missing species, ` +
      `and an overlap double-counts them.`
    );
  }
}

const isDirectRun =
  process.argv[1]?.endsWith("outputs/derive-gbif-taxon-keys.ts") ||
  process.argv[1]?.endsWith("outputs/derive-gbif-taxon-keys.js");
if (isDirectRun) {
  loadEnvFiles();
  run(process.argv.includes("--write")).catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
