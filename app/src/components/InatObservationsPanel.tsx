"use client";

import { useState, useEffect, useCallback } from "react";
import dynamic from "next/dynamic";
import { InatObservation, InatPhotoWithPreview } from "./InatPhotoCard";
import { ChartPager } from "@/components/redlist/chart-controls";

const InatContributorsChart = dynamic(() => import("./InatContributorsChart"), {
  ssr: false,
});
const InatObservationMap = dynamic(() => import("./InatObservationMap"), {
  ssr: false,
});

// 5 columns x 2 rows, matching the GBIF-path iNat grid.
const PAGE_SIZE = 10;
// Number of georeferenced observations to plot on the map (iNat caps at 200).
const MAP_POINTS = 200;

interface InatObservationsPanelProps {
  scientificName: string;
  mounted: boolean;
  /** Called once both feeds have loaded and iNaturalist has no observations either,
   * letting the parent fall back to another tab (e.g. Catalogue of Life). */
  onEmpty?: () => void;
}

/**
 * iNaturalist observations for a species GBIF's backbone doesn't know
 * (CoL-only / not-yet-assessed). The rest of the app fetches iNat photos via
 * GBIF's iNat-dataset occurrence search keyed by a GBIF taxonKey; that returns
 * nothing here, so this panel queries iNaturalist directly by scientific name.
 */
export default function InatObservationsPanel({ scientificName, mounted, onEmpty }: InatObservationsPanelProps) {
  const [observations, setObservations] = useState<InatObservation[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [inatTaxonId, setInatTaxonId] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loaded, setLoaded] = useState(false);

  // Map points are fetched once (georeferenced, photos not required).
  const [mapObs, setMapObs] = useState<InatObservation[]>([]);
  const [mapLoaded, setMapLoaded] = useState(false);

  const fetchObservations = useCallback(
    (p: number) => {
      setLoading(true);
      const params = new URLSearchParams({
        name: scientificName,
        page: p.toString(),
        per_page: PAGE_SIZE.toString(),
      });
      fetch(`/api/inat/observations?${params}`)
        .then((res) => res.json())
        .then((data) => {
          setObservations(data.observations || []);
          setTotalCount(data.totalCount || 0);
          setInatTaxonId(data.inatTaxonId ?? null);
        })
        .catch(console.error)
        .finally(() => {
          setLoading(false);
          setLoaded(true);
        });
    },
    [scientificName]
  );

  useEffect(() => {
    setPage(0); // eslint-disable-line react-hooks/set-state-in-effect -- reset pagination when species changes
    fetchObservations(0);
  }, [fetchObservations]);

  // Fetch the georeferenced points for the map (independent of grid pagination).
  useEffect(() => {
    setMapLoaded(false); // eslint-disable-line react-hooks/set-state-in-effect -- reset when species changes
    const params = new URLSearchParams({
      name: scientificName,
      per_page: MAP_POINTS.toString(),
      geo: "true",
    });
    fetch(`/api/inat/observations?${params}`)
      .then((res) => res.json())
      .then((data) => setMapObs(data.observations || []))
      .catch(console.error)
      .finally(() => setMapLoaded(true));
  }, [scientificName]);

  const totalPages = Math.ceil(totalCount / PAGE_SIZE);

  // Both feeds loaded and neither turned up anything: no occurrence data at all.
  const noRecords = loaded && mapLoaded && observations.length === 0 && mapObs.length === 0;

  // Notify the parent when there's nothing to show, so an unevaluated species can
  // fall back to another tab (e.g. Catalogue of Life). The parent guards against
  // acting more than once.
  useEffect(() => {
    if (noRecords) onEmpty?.();
  }, [noRecords, onEmpty]);

  // Once both feeds have loaded, if iNaturalist has nothing either, say so plainly.
  if (noRecords) {
    return (
      <div className="p-6 text-sm text-zinc-500 dark:text-zinc-400">
        No GBIF match found for <span className="italic">{scientificName}</span>, and no iNaturalist
        observations were found either. Occurrence data is unavailable.
      </div>
    );
  }

  return (
    <div className="p-3 sm:p-4">
      <div className="mb-3 text-sm text-zinc-500 dark:text-zinc-400">
        No GBIF backbone match for <span className="italic">{scientificName}</span> — showing
        iNaturalist observations directly.
      </div>
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="sm:w-1/3 shrink-0 flex flex-col gap-2">
          <div className="flex flex-col bg-white dark:bg-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-700 overflow-hidden relative z-10">
            {/* Header */}
            <div className="px-2 py-1.5 text-xs sm:text-[10px] font-medium text-zinc-500 dark:text-zinc-400 text-center border-b border-zinc-100 dark:border-zinc-800 flex items-center justify-between gap-2">
              <span>
                iNaturalist Photos{" "}
                {totalCount > 0 && (
                  <span className="tabular-nums">— {totalCount.toLocaleString()} observations</span>
                )}
              </span>
              {inatTaxonId && (
                <a
                  href={`https://www.inaturalist.org/observations?taxon_id=${inatTaxonId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-green-600 hover:text-green-500 transition-colors whitespace-nowrap"
                >
                  View on iNaturalist →
                </a>
              )}
            </div>
            {observations.length > 0 ? (
              <>
                {/* Photos — 5-col grid */}
                <div className={`grid grid-cols-5 gap-1 p-1.5 ${loading ? "opacity-50" : ""}`}>
                  {observations.slice(0, PAGE_SIZE).map((obs, idx) => (
                    <div key={`${page}-${idx}`} className="aspect-square">
                      <InatPhotoWithPreview obs={obs} idx={idx} />
                    </div>
                  ))}
                </div>
                {/* Pagination */}
                {totalCount > PAGE_SIZE && (
                  <div className="flex items-center justify-center px-1.5 py-1 border-t border-zinc-100 dark:border-zinc-800">
                    <ChartPager
                      label={`${page + 1}/${totalPages}`}
                      canPrev={page > 0 && !loading}
                      canNext={(page + 1) * PAGE_SIZE < totalCount && !loading}
                      onPrev={() => {
                        const newPage = page - 1;
                        setPage(newPage);
                        fetchObservations(newPage);
                      }}
                      onNext={() => {
                        const newPage = page + 1;
                        setPage(newPage);
                        fetchObservations(newPage);
                      }}
                    />
                  </div>
                )}
              </>
            ) : (
              <div className="flex items-center justify-center py-6">
                <svg className="w-4 h-4 animate-spin text-zinc-400" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                </svg>
              </div>
            )}
          </div>

          {/* Top contributors — resolves the iNat taxon by name (no GBIF key needed) */}
          <InatContributorsChart speciesKey={0} scientificName={scientificName} />
        </div>

        {/* Map — observation points, takes the remaining width */}
        <div className="flex-1 min-w-0 flex flex-col">
          <InatObservationMap observations={mapObs} scientificName={scientificName} mounted={mounted} />
        </div>
      </div>
    </div>
  );
}
