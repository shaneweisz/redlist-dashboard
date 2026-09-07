import { NextRequest, NextResponse } from "next/server";
import { CACHE_1H } from "@/lib/cache-headers";

// Cache for assessment details (1 hour)
const assessmentCache = new Map<
  number,
  { data: object; timestamp: number }
>();
const CACHE_DURATION = 60 * 60 * 1000;

async function fetchWithAuth(url: string): Promise<Response> {
  const apiKey = process.env.RED_LIST_API_KEY;
  if (!apiKey) {
    throw new Error("RED_LIST_API_KEY environment variable not set");
  }
  return fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
}

// IUCN API v4 uses { en: "text" } for description fields
function getLocalizedText(
  desc: { en?: string } | string | null | undefined
): string | null {
  if (!desc) return null;
  if (typeof desc === "string") return desc;
  return desc.en || null;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const assessmentId = parseInt(id, 10);

  if (isNaN(assessmentId)) {
    return NextResponse.json(
      { error: "Invalid assessment ID" },
      { status: 400 }
    );
  }

  // Check cache
  const cached = assessmentCache.get(assessmentId);
  if (cached && Date.now() - cached.timestamp < CACHE_DURATION) {
    return NextResponse.json({ ...cached.data, cached: true }, { headers: CACHE_1H });
  }

  try {
    const response = await fetchWithAuth(
      `https://api.iucnredlist.org/api/v4/assessment/${assessmentId}`
    );

    if (!response.ok) {
      if (response.status === 404) {
        return NextResponse.json(
          { error: "Assessment not found" },
          { status: 404 }
        );
      }
      return NextResponse.json(
        { error: `IUCN API error: ${response.status}` },
        { status: response.status }
      );
    }

    const data = await response.json();
    const doc = data.documentation || {};

    // Extract the fields we need, normalizing the IUCN API v4 structure
    const result = {
      assessment_id: data.assessment_id,
      sis_taxon_id: data.sis_taxon_id,
      url: data.url,
      // Category & criteria - normalize { code, description: { en } } to { code, description }
      red_list_category: data.red_list_category
        ? {
            code: data.red_list_category.code,
            description: getLocalizedText(data.red_list_category.description),
          }
        : null,
      criteria: data.criteria || null,
      assessment_date: data.assessment_date || null,
      year_published: data.year_published || null,
      possibly_extinct: data.possibly_extinct || false,
      possibly_extinct_in_the_wild: data.possibly_extinct_in_the_wild || false,
      // Narratives are under documentation.*
      rationale: doc.rationale || null,
      population: doc.population || null,
      habitat: doc.habitats || null,
      threats: doc.threats || null,
      /**
       * The assessment's bibliography, so the in-text citations in those
       * narratives can be resolved to what they cite. Passed through as the API
       * gives it (citation, author, year, title) — the matching is the reader's
       * side of the problem, in lib/mapping/nearby-citations.
       */
      references: Array.isArray(data.references)
        ? data.references.map((r: { citation?: string; author?: string; year?: string; title?: string }) => ({
            citation: r.citation ?? "",
            author: r.author ?? null,
            year: r.year ?? null,
            title: r.title ?? null,
          }))
        : [],
      conservation_actions: doc.measures || null,
      use_trade: doc.use_trade || null,
      range: doc.range || null,
      // Population trend - normalize { code, description: { en } }
      population_trend: data.population_trend
        ? {
            code: data.population_trend.code,
            description: getLocalizedText(data.population_trend.description),
          }
        : null,
      // Structured data: habitats array
      habitats: Array.isArray(data.habitats)
        ? data.habitats.map(
            (h: {
              code?: string;
              description?: { en?: string } | string;
              suitability?: string;
              majorImportance?: string;
            }) => ({
              code: h.code || "",
              name: getLocalizedText(h.description) || h.code || "",
              suitability: h.suitability || null,
              major_importance: h.majorImportance === "Yes",
            })
          )
        : null,
      // Structured data: threats array
      // IUCN v4: threats have `title` (threat name) and `description` (classification level)
      threat_classification: Array.isArray(data.threats)
        ? data.threats.map(
            (t: {
              code?: string;
              title?: { en?: string } | string;
              description?: { en?: string } | string;
              timing?: string;
              scope?: string;
              severity?: string;
              score?: string;
              ias?: string;
              virus?: string;
              stresses?: { code?: string; description?: { en?: string } | string }[];
            }) => ({
              code: t.code || "",
              name:
                getLocalizedText(t.title) ||
                getLocalizedText(t.description) ||
                t.code ||
                "",
              timing: t.timing || null,
              scope: t.scope || null,
              severity: t.severity || null,
              score: t.score || null,
              // The species or pathogen named on an invasive-species threat —
              // "Hymenoscyphus fraxineus" on an ash. Only 8.1/8.2 carry one.
              named: t.ias || t.virus || null,
              stresses: Array.isArray(t.stresses)
                ? t.stresses
                    .map(
                      (s) => getLocalizedText(s.description) || s.code || ""
                    )
                    .filter(Boolean)
                : null,
            })
          )
        : null,
      // Structured data: conservation actions array
      // IUCN v4: conservation actions may use `title` or `description`
      conservation_actions_classification: Array.isArray(
        data.conservation_actions
      )
        ? data.conservation_actions.map(
            (c: {
              code?: string;
              title?: { en?: string } | string;
              description?: { en?: string } | string;
            }) => ({
              code: c.code || "",
              name:
                getLocalizedText(c.title) ||
                getLocalizedText(c.description) ||
                c.code ||
                "",
            })
          )
        : null,
      // Systems (terrestrial, marine, freshwater)
      systems: Array.isArray(data.systems)
        ? data.systems.map(
            (s: {
              code?: string;
              description?: { en?: string } | string;
            }) => ({
              code: s.code || "",
              description: getLocalizedText(s.description) || s.code || "",
            })
          )
        : null,
      // Scopes
      scopes: Array.isArray(data.scopes)
        ? data.scopes.map(
            (s: {
              code?: string;
              description?: { en?: string } | string;
            }) => ({
              code: s.code || "",
              description: getLocalizedText(s.description) || s.code || "",
            })
          )
        : null,
      // Supplementary info: quantitative metrics
      supplementary_info: data.supplementary_info
        ? {
            estimated_extent_of_occurence:
              data.supplementary_info.estimated_extent_of_occurence ?? null,
            estimated_area_of_occupancy:
              data.supplementary_info.estimated_area_of_occupancy ?? null,
            population_size:
              data.supplementary_info.population_size ?? null,
            number_of_locations:
              data.supplementary_info.number_of_locations ?? null,
            no_of_subpopulations:
              data.supplementary_info.no_of_subpopulations ?? null,
            generational_length:
              data.supplementary_info.generational_length ?? null,
            upper_elevation_limit:
              data.supplementary_info.upper_elevation_limit ?? null,
            lower_elevation_limit:
              data.supplementary_info.lower_elevation_limit ?? null,
            upper_depth_limit:
              data.supplementary_info.upper_depth_limit ?? null,
            lower_depth_limit:
              data.supplementary_info.lower_depth_limit ?? null,
            movement_patterns:
              data.supplementary_info.movement_patterns ?? null,
            congregatory:
              data.supplementary_info.congregatory ?? null,
            population_severely_fragmented:
              data.supplementary_info.population_severely_fragmented ?? null,
            population_continuing_decline:
              data.supplementary_info.population_continuing_decline ?? null,
            continuing_decline_in_extent_of_occurence:
              data.supplementary_info
                .continuing_decline_in_extent_of_occurence ?? null,
            continuing_decline_in_area_of_occupancy:
              data.supplementary_info
                .continuing_decline_in_area_of_occupancy ?? null,
            continuing_decline_in_number_of_locations:
              data.supplementary_info
                .continuing_decline_in_number_of_locations ?? null,
          }
        : null,
    };

    // Cache the result
    assessmentCache.set(assessmentId, {
      data: result,
      timestamp: Date.now(),
    });

    return NextResponse.json(result, { headers: CACHE_1H });
  } catch (error) {
    console.error("Error fetching assessment:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Unknown error" },
      { status: 500 }
    );
  }
}
