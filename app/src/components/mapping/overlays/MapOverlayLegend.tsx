"use client";

/**
 * One key for the overlays that are on, laid out as a table: name on the left,
 * its colours on the right, its source at the end. Four separate cards each
 * with its own arrangement read as four notices rather than one legend, and
 * nothing lined up with anything.
 *
 * Each name is its own disclosure where there's more to say — the biomes, the
 * habitat classes, what tree cover loss does and doesn't mean.
 *
 * Renders nothing while no overlay with colours to explain is on.
 */

import { useState } from "react";
import { FaInfoCircle } from "react-icons/fa";
import YearRangeSlider from "@/components/mapping/YearRangeSlider";
import type { MapOverlays } from "@/hooks/mapping/useMapOverlays";
import {
  FOREST_LOSS_CAVEAT,
  FOREST_LOSS_COLOR,
  FOREST_LOSS_DATASET_URL,
  FOREST_LOSS_FIRST_YEAR,
  FOREST_LOSS_LAST_YEAR,
  FOREST_LOSS_SOURCE_NOTE,
  FOREST_LOSS_THRESHOLD_NOTE,
} from "@/lib/mapping/forest-loss";
import {
  FOREST_LOSS_DRIVERS,
  FOREST_LOSS_DRIVERS_CAVEAT,
  FOREST_LOSS_DRIVERS_PAPER_URL,
  type LossDriverClass,
} from "@/lib/mapping/forest-loss-drivers";
import { HABITAT_LEGEND, HABITAT_SCHEME_URL } from "@/lib/mapping/habitat-map";
import { BIOMES, ECOREGIONS_PAPER_URL } from "@/lib/mapping/map-overlays";
import { EFFORT_GROUP_LABELS, EFFORT_LEGEND, EFFORT_PAPER_URL } from "@/lib/mapping/sampling-effort";

/**
 * One driver's colour in the legend, with its name on hover.
 *
 * The same bubble FlagMark uses, for the same reason: these sit over the map,
 * where a native `title` never appears at all. A 10px square makes it worse —
 * the tooltip needs the pointer held still on a target smaller than the
 * pointer, so drifting along the row of seven cancels it every time. The
 * cursor promised something to read and nothing was ever shown.
 */
function DriverSwatch({ driver }: { driver: LossDriverClass }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      className="relative block h-2.5 w-2.5 rounded-sm cursor-help"
      style={{ background: driver.color }}
    >
      {/* Opens rightward: the legend sits against the map's left edge, so a
          bubble anchored the other way runs off the side of the screen. */}
      {open && (
        <span className="absolute bottom-4 left-0 z-[1000] block w-max max-w-[240px] rounded-md bg-zinc-900/95 dark:bg-zinc-700 px-1.5 py-1 text-[10px] leading-snug text-white shadow-lg">
          <span className="font-medium">{driver.label}</span>
          <span className="block text-zinc-300">{driver.description}</span>
        </span>
      )}
    </span>
  );
}

const SourceLink = ({ href, title }: { href: string; title: string }) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer"
    title={title}
    className="shrink-0 text-zinc-300 hover:text-zinc-500 dark:text-zinc-600 dark:hover:text-zinc-400"
  >
    <FaInfoCircle className="w-3 h-3" />
  </a>
);

export default function MapOverlayLegend({ overlays }: { overlays: MapOverlays }) {
  const o = overlays;
  const [habitatOpen, setHabitatOpen] = useState(false);
  /** Whether the tree cover loss entry's two caveats are showing. */
  const [forestLossNotesOpen, setForestLossNotesOpen] = useState(false);
  const [lossDriverNotesOpen, setLossDriverNotesOpen] = useState(false);
  const [biomesOpen, setBiomesOpen] = useState(false);

  if (!(o.showSamplingEffort || o.showEcoregions || o.showForestLoss || o.showLossDrivers || o.showHabitat)) {
    return null;
  }

  return (
    <div className="bg-white dark:bg-zinc-800 rounded-lg shadow-md border border-zinc-200 dark:border-zinc-700 py-1 text-[11px] text-zinc-600 dark:text-zinc-300 max-w-full">
      <div className="px-2 pb-0.5 text-[9px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
        Overlays
      </div>
      {o.showEcoregions && o.ecoregions && (
        <div>
          <div className="flex items-center gap-2 px-2 py-0.5">
            <button
              onClick={() => setBiomesOpen((v) => !v)}
              title={biomesOpen ? "Hide the biomes" : "Show what the ecoregion colours mean"}
              className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-100"
            >
              <span className="truncate">Terrestrial ecoregions</span>
              <span className="text-[9px] text-zinc-400">{biomesOpen ? "▾" : "▸"}</span>
            </button>
            <span className="flex rounded-sm overflow-hidden shrink-0">
              {BIOMES.slice(0, 8).map((biome) => (
                <span key={biome.name} className="w-2 h-2.5" style={{ background: biome.color }} />
              ))}
            </span>
            <SourceLink href={ECOREGIONS_PAPER_URL} title="Dinerstein et al. 2017, RESOLVE Ecoregions 2017 (CC BY 4.0)" />
          </div>
          {biomesOpen && (
            <div className="px-2 pb-1 pl-3 space-y-0.5">
              {BIOMES.map((biome) => (
                <div key={biome.name} className="flex items-center gap-1.5">
                  <span
                    className="w-2.5 h-2.5 rounded-sm shrink-0 border border-black/10"
                    style={{ background: biome.color }}
                  />
                  <span className="truncate text-[10px]">{biome.name}</span>
                </div>
              ))}
              <div className="text-[10px] text-zinc-400 pt-0.5">
                {o.ecoregions.features.length} ecoregions in 14 biomes
              </div>
            </div>
          )}
        </div>
      )}
      {o.showHabitat && (
        <div>
          <div className="flex items-center gap-2 px-2 py-0.5">
            <button
              onClick={() => setHabitatOpen((v) => !v)}
              title={habitatOpen ? "Hide the habitat classes" : "Show what the habitat colours mean"}
              className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-100"
            >
              <span className="truncate">IUCN habitat types</span>
              <span className="text-[9px] text-zinc-400">{habitatOpen ? "▾" : "▸"}</span>
            </button>
            <span className="flex rounded-sm overflow-hidden shrink-0">
              {HABITAT_LEGEND.slice(0, 8).map((entry) => (
                <span key={entry.code} className="w-2 h-2.5" style={{ background: entry.color }} />
              ))}
            </span>
            <SourceLink
              href={HABITAT_SCHEME_URL}
              title="IUCN Habitats Classification Scheme — Jung et al. 2020 (CC BY 4.0). Click the map for the class at a point."
            />
          </div>
          {habitatOpen && (
            <div className="px-2 pb-1 pl-3 space-y-0.5 max-w-xs">
              {HABITAT_LEGEND.map((entry) => (
                <div key={entry.code} className="flex items-center gap-1.5">
                  <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: entry.color }} />
                  <span className="truncate text-[10px]">{entry.name}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {o.showForestLoss && (
        <div>
          <div className="flex items-center gap-2 px-2 py-0.5">
            <button
              onClick={() => setForestLossNotesOpen((v) => !v)}
              title={forestLossNotesOpen ? "Hide what this layer does and doesn't mean" : "What this layer does and doesn't mean"}
              className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-100"
            >
              <span className="truncate">Tree cover loss</span>
              <span className="text-[9px] text-zinc-400">{forestLossNotesOpen ? "▾" : "▸"}</span>
            </button>
            {/* One swatch, not a ramp: the tiles are a single colour whatever
                year the loss is from. The years are set on the track below,
                where a range can be dragged. */}
            <span className="flex items-center gap-1 shrink-0 text-[9px] tabular-nums text-zinc-400">
              <span
                className="h-2.5 w-4 rounded-sm"
                style={{ background: FOREST_LOSS_COLOR }}
                title={`Loss between ${o.lossYears[0]} and ${o.lossYears[1]}`}
              />
            </span>
            <SourceLink href={FOREST_LOSS_DATASET_URL} title={FOREST_LOSS_SOURCE_NOTE} />
          </div>
          {/* Always out, not behind the disclosure: narrowing the years is the
              thing you do with this layer, not a note about it. */}
          <YearRangeSlider
            min={FOREST_LOSS_FIRST_YEAR}
            max={FOREST_LOSS_LAST_YEAR}
            value={o.lossYears}
            onChange={o.setLossYears}
            color={FOREST_LOSS_COLOR}
            label="Years of tree cover loss to show"
          />
          {forestLossNotesOpen && (
            <div className="px-2 pb-1 pl-3 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400 max-w-md">
              <div>
                <span className="font-medium">Loss is disturbance, not deforestation.</span> {FOREST_LOSS_CAVEAT}
              </div>
              <div className="pt-0.5">{FOREST_LOSS_THRESHOLD_NOTE}</div>
            </div>
          )}
        </div>
      )}
      {o.showLossDrivers && (
        <div>
          <div className="flex items-center gap-2 px-2 py-0.5">
            <button
              onClick={() => setLossDriverNotesOpen((v) => !v)}
              title={lossDriverNotesOpen ? "Hide what this layer does and doesn't mean" : "What this layer does and doesn't mean"}
              className="flex-1 min-w-0 flex items-center gap-1 text-left hover:text-zinc-800 dark:hover:text-zinc-100"
            >
              <span className="truncate">Tree cover loss by dominant driver</span>
              <span className="text-[9px] text-zinc-400">{lossDriverNotesOpen ? "▾" : "▸"}</span>
            </button>
            {/* Seven classes, so the swatches carry their names on hover rather
                than in a column that would be taller than the map. Opened, each
                one says what it covers. */}
            <span className="flex items-center gap-0.5 shrink-0">
              {FOREST_LOSS_DRIVERS.map((driver) => (
                <DriverSwatch key={driver.label} driver={driver} />
              ))}
            </span>
            <SourceLink
              href={FOREST_LOSS_DRIVERS_PAPER_URL}
              title="Sims et al. (2025), Global drivers of forest loss at 1 km resolution — the paper this classification comes from."
            />
          </div>
          {lossDriverNotesOpen && (
            <div className="px-2 pb-1 pl-3 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400 max-w-md">
              <div className="grid grid-cols-1 gap-y-0.5 pb-1">
                {FOREST_LOSS_DRIVERS.map((driver) => (
                  <div key={driver.label} className="flex gap-1.5">
                    <span className="mt-[3px] h-2 w-2 shrink-0 rounded-sm" style={{ background: driver.color }} />
                    <span>
                      <span className="font-medium text-zinc-600 dark:text-zinc-300">{driver.label}</span>{" "}
                      {driver.description}
                    </span>
                  </div>
                ))}
              </div>
              <div>{FOREST_LOSS_DRIVERS_CAVEAT}</div>
            </div>
          )}
        </div>
      )}
      {o.showSamplingEffort && o.effortLayer && (
        <div className="flex items-center gap-2 px-2 py-0.5">
          <span
            className="flex-1 min-w-0 truncate"
            title="GBIF records per 10 km cell. A gap here means nobody has looked, which is not the same as the species being absent."
          >
            GBIF sampling effort
            <span className="text-zinc-400"> · {EFFORT_GROUP_LABELS[o.effortLayer.group]}</span>
          </span>
          <span className="flex items-center gap-1 shrink-0 text-[9px] text-zinc-400">
            less
            <span className="flex rounded-sm overflow-hidden">
              {EFFORT_LEGEND.map((step) => (
                <span key={step} className="w-2 h-2.5" style={{ background: step }} />
              ))}
            </span>
            more
          </span>
          <SourceLink
            href={EFFORT_PAPER_URL}
            title="Global sampling effort of GBIF biodiversity data — El-Gabbas 2026, Diversity and Distributions"
          />
        </div>
      )}
    </div>
  );
}
