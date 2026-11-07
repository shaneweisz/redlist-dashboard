"use client";

import { useMemo, useState } from "react";
import {
  IUCN_POINT_FILE_COLUMNS,
  type PointComparison,
  type PointFileComparison,
} from "@/lib/mapping/iucn-point-file";
import { CHART_INPUT_CLASS } from "@/components/redlist/chart-controls";

/**
 * The imported point file as a table of its own.
 *
 * The rows the assessment delivers are not GBIF records and don't belong in a
 * table of them: they have their own columns (compiler, presence, seasonality),
 * several of them have no GBIF record at all, and the ones that do are already
 * folded into that record's panel on the map. What they need instead is to be
 * readable as what they are — the file, as filled in — with this dashboard's
 * one contribution beside each row: which record it was tied to, and how far
 * from GBIF's own coordinate it was put.
 */
interface PointFileTableProps {
  comparison: PointFileComparison;
  fileName: string;
  /** Extra headers the file carried that aren't in the IUCN specification. */
  extraColumns?: string[];
  /** Scales the table, so more of it fits without shrinking the controls. */
  zoom?: number;
  fillHeight?: boolean;
}

/** The columns worth a place before the file's own, in reading order. */
const LEAD_COLUMNS = ["sci_name", "event_year", "basisofrec", "catalog_no", "recordedby"] as const;

const COLUMN_LABELS: Record<string, string> = {
  sci_name: "Species",
  presence: "Presence",
  origin: "Origin",
  seasonal: "Seasonal",
  compiler: "Compiler",
  yrcompiled: "Compiled",
  citation: "Citation",
  dec_lat: "dec_lat",
  dec_long: "dec_long",
  latitude: "Latitude",
  longitude: "Longitude",
  spatialref: "Spatial ref.",
  subspecies: "Subspecies",
  subpop: "Subpopulation",
  data_sens: "Sensitive",
  sens_comm: "Sensitivity comment",
  event_year: "Year",
  source: "Source",
  basisofrec: "Basis of record",
  catalog_no: "Catalogue no.",
  recordedby: "Recorded by",
  recordno: "Record no.",
  dist_comm: "Distribution comment",
  tax_comm: "Taxonomic comment",
};

function formatDistance(metres: number) {
  return metres >= 1000 ? `${(metres / 1000).toFixed(1)} km` : `${Math.round(metres)} m`;
}

/** What this dashboard could tie the row to, as a phrase. */
function matchLabel(row: PointComparison) {
  if (!row.matched) return row.point.gbifID ? "not in the loaded sample" : "no GBIF record cited";
  return row.matched.via === "gbif-id" ? "by GBIF id" : "by catalogue no.";
}

export default function PointFileTable({
  comparison,
  fileName,
  extraColumns = [],
  zoom = 1,
  fillHeight,
}: PointFileTableProps) {
  const [search, setSearch] = useState("");
  // The file's own columns, minus the ones already given a place of their own
  // and the two pairs of coordinate columns, which are one column here.
  const restColumns = useMemo(
    () =>
      [...IUCN_POINT_FILE_COLUMNS, ...extraColumns].filter(
        (key) =>
          !LEAD_COLUMNS.includes(key as (typeof LEAD_COLUMNS)[number]) &&
          !["dec_lat", "dec_long", "latitude", "longitude"].includes(key)
      ),
    [extraColumns]
  );

  const rows = useMemo(() => {
    const needle = search.trim().toLowerCase();
    if (!needle) return comparison.rows;
    return comparison.rows.filter((r) =>
      Object.values(r.point.fields).some((v) => v.toLowerCase().includes(needle))
    );
  }, [comparison.rows, search]);

  return (
    <div
      className={`flex flex-col rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 overflow-hidden${
        fillHeight ? " flex-1 min-h-0" : ""
      }`}
    >
      <div className="flex-1 min-h-0 overflow-auto">
        <table
          className="w-full border-collapse text-[11px]"
          style={zoom === 1 ? undefined : { zoom }}
        >
          <thead className="sticky top-0 z-10 bg-zinc-50 dark:bg-zinc-800">
            <tr className="text-left text-[11px] font-medium text-zinc-500 dark:text-zinc-400">
              <th className="px-2 py-1.5 whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700" title="Which point in the file this is, counting from the first one — one less than the spreadsheet row, which counts the header">
                Row
              </th>
              {LEAD_COLUMNS.map((key) => (
                <th
                  key={key}
                  title={key}
                  className="px-2 py-1.5 whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700"
                >
                  {COLUMN_LABELS[key] ?? key}
                </th>
              ))}
              <th className="px-2 py-1.5 whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700" title="dec_lat, dec_long">
                Coordinates
              </th>
              <th
                className="px-2 py-1.5 whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700"
                title="The GBIF record this row was tied to, and how it was found"
              >
                Matched
              </th>
              <th
                className="px-2 py-1.5 whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700"
                title="How far this point sits from GBIF's own coordinate for that record — the georeferencing the file carries"
              >
                From GBIF&apos;s
              </th>
              {restColumns.map((key) => (
                <th
                  key={key}
                  title={key}
                  className="px-2 py-1.5 whitespace-nowrap border-b border-zinc-200 dark:border-zinc-700"
                >
                  {COLUMN_LABELS[key] ?? key}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.point.row}
                className="border-b border-zinc-100 dark:border-zinc-800 hover:bg-zinc-50 dark:hover:bg-zinc-800/60"
              >
                <td className="px-2 py-1 tabular-nums text-zinc-400">{r.point.row - 1}</td>
                {LEAD_COLUMNS.map((key) => (
                  <td key={key} className="px-2 py-1 max-w-[16rem]">
                    <span className="block truncate" title={r.point.fields[key] || undefined}>
                      {r.point.fields[key] || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                    </span>
                  </td>
                ))}
                <td className="px-2 py-1 whitespace-nowrap tabular-nums">
                  {r.point.latitude.toFixed(4)}, {r.point.longitude.toFixed(4)}
                </td>
                <td className="px-2 py-1 whitespace-nowrap">
                  {r.matched ? (
                    <a
                      href={`https://www.gbif.org/occurrence/${r.matched.gbifID}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      title={`Matched ${matchLabel(r)}`}
                      className="tabular-nums text-blue-600 dark:text-blue-400 hover:underline"
                    >
                      {r.matched.gbifID}
                    </a>
                  ) : (
                    <span className="text-zinc-400" title={matchLabel(r)}>
                      {matchLabel(r)}
                    </span>
                  )}
                </td>
                <td className="px-2 py-1 whitespace-nowrap tabular-nums">
                  {r.fromGbif == null ? (
                    <span className="text-zinc-300 dark:text-zinc-600">—</span>
                  ) : r.fromGbif < 100 ? (
                    <span className="text-zinc-400">same position</span>
                  ) : (
                    <span className="text-amber-600 dark:text-amber-400">{formatDistance(r.fromGbif)}</span>
                  )}
                </td>
                {restColumns.map((key) => (
                  <td key={key} className="px-2 py-1 max-w-[16rem]">
                    <span className="block truncate" title={r.point.fields[key] || undefined}>
                      {r.point.fields[key] || <span className="text-zinc-300 dark:text-zinc-600">—</span>}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] text-zinc-400">
            Nothing in {fileName} matches “{search}”.
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 px-2 py-1 border-t border-zinc-200 dark:border-zinc-700 text-[11px] text-zinc-500 dark:text-zinc-400">
        <span className="tabular-nums">
          {comparison.rows.length.toLocaleString()} point{comparison.rows.length === 1 ? "" : "s"}
        </span>
        <span className="truncate" title={fileName}>
          from {fileName}
        </span>
        <span className="tabular-nums text-zinc-400">
          · {comparison.matched.toLocaleString()} tied to a loaded GBIF record
        </span>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Find in file…"
          className={`ml-auto w-40 ${CHART_INPUT_CLASS}`}
        />
      </div>
    </div>
  );
}
