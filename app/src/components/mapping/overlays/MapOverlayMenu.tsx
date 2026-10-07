"use client";

/**
 * The overlays' rows in a map's Overlays dropdown — one checkbox each, with the
 * source it is drawn from.
 *
 * Only the layers about the ground. A map with layers of its own (the species
 * map's range, AOH and native countries) puts its rows around these: before
 * them, or in `beforeEffort`, which keeps sampling effort last.
 */

import type { ReactNode } from "react";
import type { MapOverlays } from "@/hooks/mapping/useMapOverlays";
import SourceCitation from "./SourceCitation";
import {
  FOREST_LOSS_CAVEAT,
  FOREST_LOSS_DATASET_URL,
  FOREST_LOSS_SOURCE_NOTE,
  FOREST_LOSS_THRESHOLD_NOTE,
} from "@/lib/mapping/forest-loss";
import {
  DRIVERS_CANOPY_THRESHOLD,
  FOREST_LOSS_DRIVERS_CAVEAT,
  FOREST_LOSS_DRIVERS_FIRST_YEAR,
  FOREST_LOSS_DRIVERS_LAST_YEAR,
  FOREST_LOSS_DRIVERS_PAPER_URL,
} from "@/lib/mapping/forest-loss-drivers";
import { ECOREGIONS_PAPER_URL } from "@/lib/mapping/map-overlays";
import {
  EFFORT_GROUP_LABELS,
  EFFORT_GROUPS,
  EFFORT_PAPER_URL,
  type EffortGroup,
} from "@/lib/mapping/sampling-effort";

const Spinner = () => (
  <svg className="w-3 h-3 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
  </svg>
);

export default function MapOverlayMenu({
  overlays,
  beforeEffort,
  effortDefaultNote,
}: {
  overlays: MapOverlays;
  /** The map's own rows, drawn between the ecoregions and sampling effort. */
  beforeEffort?: ReactNode;
  /** Said after the default effort group in its list — "this species". */
  effortDefaultNote?: string;
}) {
  const o = overlays;
  return (
    <>
      <label
        className="flex items-center gap-2 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]"
        title="Overlay the World Database on Protected Areas (WDPA) — UNEP-WCMC & IUCN. With it on, clicking the map names the areas covering that point and links each to Protected Planet."
      >
        <input
          type="checkbox"
          checked={o.showProtectedAreas}
          onChange={o.toggleProtectedAreas}
          className="w-3 h-3 rounded accent-emerald-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">Protected areas</span>
        {/* Said where the layer is switched on, because the blank map it
            leaves behind reads as "nothing here is protected". */}
        {o.protectedAreasDown && (
          <span
            title="UNEP-WCMC's map service isn't answering, so this layer can't be drawn and clicking the map won't name any sites. A blank map here doesn't mean the area is unprotected. Their outage, not yours — try again later."
            className="shrink-0 cursor-help text-[10px] text-amber-600 dark:text-amber-500"
          >
            source unavailable
          </span>
        )}
        <SourceCitation
          href="https://www.protectedplanet.net"
          cite="WDPA"
          title="World Database on Protected Areas — UNEP-WCMC & IUCN, via Protected Planet"
        />
      </label>
      <label
        className="flex items-center gap-2 px-2 py-0.5 text-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
        title={`${FOREST_LOSS_SOURCE_NOTE} Showing ${o.lossYears[0]}–${o.lossYears[1]}; narrow the years in the legend. ${FOREST_LOSS_CAVEAT} ${FOREST_LOSS_THRESHOLD_NOTE} Click the map with this on to read the loss year and canopy cover at a point.`}
      >
        <input
          type="checkbox"
          checked={o.showForestLoss}
          onChange={() => o.setShowForestLoss((v) => !v)}
          className="w-3 h-3 rounded accent-emerald-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">Tree cover loss</span>
        <SourceCitation
          href={FOREST_LOSS_DATASET_URL}
          cite="Hansen et al. 2013"
          title="High-Resolution Global Maps of 21st-Century Forest Cover Change — Hansen et al. 2013, Science. The Global Forest Change dataset these tiles are drawn from."
        />
      </label>
      {/* Next to the loss layer, because it answers the question that one
          raises: a cleared block means something different if it is a soy
          field, a logging rotation or a fire. */}
      <label
        className="flex items-center gap-2 px-2 py-0.5 text-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
        title={`Why the trees went, at 1 km: Sims et al. (2025), via Global Nature Watch. Loss ${FOREST_LOSS_DRIVERS_FIRST_YEAR}–${FOREST_LOSS_DRIVERS_LAST_YEAR}, cut at ${DRIVERS_CANOPY_THRESHOLD}% canopy cover. ${FOREST_LOSS_DRIVERS_CAVEAT}`}
      >
        <input
          type="checkbox"
          checked={o.showLossDrivers}
          onChange={() => o.setShowLossDrivers((v) => !v)}
          className="w-3 h-3 rounded accent-emerald-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">Tree cover loss by dominant driver</span>
        <SourceCitation
          href={FOREST_LOSS_DRIVERS_PAPER_URL}
          cite="Sims et al. 2025"
          title="Global drivers of forest loss at 1 km resolution — Sims et al. 2025, Environmental Research Letters."
        />
      </label>
      <label
        className="flex items-center gap-2 px-2 py-0.5 text-[11px] hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer"
        title="IUCN habitat classes from Jung et al. (2020), the 100m map behind Area of Habitat. Coloured by level 1; click the map for the exact class."
      >
        <input
          type="checkbox"
          checked={o.showHabitat}
          onChange={o.toggleHabitat}
          className="w-3 h-3 rounded accent-emerald-500 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200">IUCN habitat types</span>
        <SourceCitation
          href="https://zenodo.org/records/4058819"
          cite="Jung et al. 2020"
          title="A global map of terrestrial habitat types — Jung et al. 2020. The 100 m map behind Area of Habitat."
        />
      </label>
      <label
        className="flex items-center gap-2 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]"
        title="Terrestrial ecoregions and biomes (Dinerstein et al. 2017) — the ecosystem a point sits in. Click anywhere to name it."
      >
        <input
          type="checkbox"
          checked={o.showEcoregions}
          onChange={o.toggleEcoregions}
          className="w-3 h-3 rounded accent-emerald-600 shrink-0"
        />
        <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 flex items-center gap-1">
          Terrestrial ecoregions
          {o.ecoregionsLoading && <Spinner />}
        </span>
        {o.ecoregionsFailed && <span className="text-[10px] text-red-500 shrink-0">unavailable</span>}
        <SourceCitation
          href={ECOREGIONS_PAPER_URL}
          cite="Dinerstein et al. 2017"
          title="An Ecoregion-Based Approach to Protecting Half the Terrestrial Realm — Dinerstein et al. 2017, BioScience. The RESOLVE Ecoregions 2017 layer, CC BY 4.0."
        />
      </label>
      {beforeEffort}
      {/* Withheld entirely where the dataset has no matching taxon — see
          lib/mapping/sampling-effort.ts. A fish judged against seabird effort
          is worse than no layer. */}
      {o.defaultEffortGroup && (
        <div>
          <label
            className="flex items-center gap-2 px-2 py-0.5 hover:bg-zinc-50 dark:hover:bg-zinc-700 cursor-pointer text-[11px]"
            title="GBIF records per 10 km cell (El-Gabbas 2026). Shows whether a gap in the records is genuinely empty or merely unvisited — the caveat behind a record-based AOO."
          >
            <input
              type="checkbox"
              checked={o.showSamplingEffort}
              onChange={() => o.setShowSamplingEffort((v) => !v)}
              className="w-3 h-3 rounded accent-yellow-500 shrink-0"
            />
            <span className="flex-1 min-w-0 text-zinc-700 dark:text-zinc-200 flex items-center gap-1">
              GBIF sampling effort
              {o.effortLoading && <Spinner />}
            </span>
            <SourceCitation
              href={EFFORT_PAPER_URL}
              cite="El-Gabbas 2026"
              title="Global sampling effort of GBIF biodiversity data — El-Gabbas 2026, Diversity and Distributions."
            />
          </label>
          {/* One taxon at a time, not several: two effort surfaces drawn over
              each other give a colour that can't be read back to either. */}
          {o.showSamplingEffort && (
            <select
              value={o.effortGroup ?? o.defaultEffortGroup}
              onChange={(e) => o.setEffortGroup(e.target.value as EffortGroup)}
              className="mx-2 mb-1 w-[calc(100%-1rem)] rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 px-1.5 py-1 text-[11px] text-zinc-700 dark:text-zinc-200"
              title="Which taxon's collecting effort to show. All taxa is dominated by birds and casual observation, so the matching group is usually the honest comparison."
            >
              {EFFORT_GROUPS.map((g) => (
                <option key={g} value={g}>
                  {EFFORT_GROUP_LABELS[g]}
                  {effortDefaultNote && g === o.defaultEffortGroup ? ` (${effortDefaultNote})` : ""}
                </option>
              ))}
            </select>
          )}
        </div>
      )}
    </>
  );
}
