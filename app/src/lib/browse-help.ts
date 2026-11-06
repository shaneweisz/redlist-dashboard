/**
 * The complete, self-describing query vocabulary for the agent/human data
 * surface — the SINGLE source for BOTH the /browse index help and the
 * get_vocabulary MCP tool, so the two can never advertise different filter sets.
 *
 * The categorical filters come straight from the shared-filter registry
 * (SHARED_FILTER_VOCAB), so a filter added there shows up here automatically;
 * the bespoke params (taxa, region, country, name/people search, numeric bounds)
 * are listed alongside.
 */
import { taxonLabel, FEATURED_TAXA } from "@/lib/filter-vocab";
import { IUCN_REGION_ORDER } from "@/lib/regions";
import { SHARED_FILTER_VOCAB, type FilterVocab } from "@/lib/shared-filters";

export interface Vocabulary {
  description: string;
  taxa: { id: string; label: string }[];
  taxaNote: string;
  /** Categorical filters, registry-driven (categories, threats, …, endemic). */
  filters: FilterVocab[];
  region: readonly string[];
  /** Bespoke (non-registry) params, each a short usage note. */
  params: Record<string, string>;
}

export function buildVocabulary(): Vocabulary {
  return {
    description:
      "Query the Red List dashboard from a URL. Two modes: browse a taxon (taxa=…, with optional filters) or look up a species by name (search=…, synonym-aware). Within one filter, comma-separated values are OR; across filters they are AND.",
    taxa: FEATURED_TAXA.map((id) => ({ id, label: taxonLabel(id) })),
    taxaNote: "taxa accepts any rank — a curated group (birds, corals), a sub-group (sharks-rays), or a scientific class/order/family/genus name (felidae, odonata, panthera).",
    filters: SHARED_FILTER_VOCAB,
    region: IUCN_REGION_ORDER,
    params: {
      countries: "ISO code or name.",
      assessors: "latest-assessment assessor name (substring match, e.g. Smith).",
      reviewers: "latest-assessment reviewer name (substring match).",
      facilitators: "latest-assessment facilitator name (substring match) — the person behind an organisational assessor, e.g. bird assessments are all assessed by BirdLife International.",
      contributors: "latest-assessment contributor name (substring match) — credited for data or expertise without being assessor or reviewer.",
      institutions: "latest-assessment institution (substring match) — the organisation behind the assessment, e.g. BirdLife International, Royal Botanic Gardens Kew, NatureServe.",
      outdated: "yes | no (assessment >10 years old).",
      search: "free-text scientific or common name (incl. synonyms / old names).",
      minObs: "min GBIF occurrence count (e.g. 100).",
      maxObs: "max GBIF occurrence count.",
      records: "all = minObs/maxObs count every GBIF record, with or without coordinates (default: georeferenced only).",
      minAssessmentYear: "earliest assessment year (e.g. 2015).",
      maxAssessmentYear: "latest assessment year.",
      minDescribedYear: "earliest CoL year-described (NE species).",
      maxDescribedYear: "latest CoL year-described.",
    },
  };
}
