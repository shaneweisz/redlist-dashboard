"use client";

import { useCallback, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDistance } from "@/lib/mapping/geo-distance";
import {
  biggestDisagreements,
  POINT_FILE_COLOR,
  decodeUploadedText,
  parseIucnPointFile,
  type PointFileComparison,
  type PointFileImport,
} from "@/lib/mapping/iucn-point-file";
import { chartControlClass } from "@/components/redlist/chart-controls";

interface PointFileDialogProps {
  /** The file loaded for this species, if one has been. */
  imported: PointFileImport | null;
  /** Where each of its points sits relative to GBIF and to the assessor's own. */
  comparison: PointFileComparison | null;
  onImported: (imported: PointFileImport) => void;
  onRemove: () => void;
  scientificName?: string;
  onClose: () => void;
}

/**
 * Loading a CSV of point records for a species, and what it says next to the map.
 *
 * The file is the assessment's finished answer — the sheet that goes to IUCN —
 * so the useful thing isn't that it can be displayed but that it can be
 * disagreed with. The summary below leads on the two numbers that carry that:
 * how many of its points sit somewhere GBIF didn't put them, and how many
 * differ from what the assessor has georeferenced here.
 *
 * It only ever reads. Nothing loaded here becomes a georeference, an exclusion,
 * or part of an export — the file stays a reference layer, kept in its own
 * store, and removing it leaves the assessor's own work untouched.
 */
export default function PointFileDialog({
  imported,
  comparison,
  onImported,
  onRemove,
  scientificName,
  onClose,
}: PointFileDialogProps) {
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const read = useCallback(
    async (file: File) => {
      setReading(true);
      setFailure(null);
      try {
        // Not file.text(), which assumes UTF-8 — see decodeUploadedText.
        const parsed = parseIucnPointFile(decodeUploadedText(await file.arrayBuffer()), file.name);
        if (parsed.points.length === 0) {
          setFailure(parsed.errors[0] ?? "No points could be read from that file.");
          return;
        }
        onImported(parsed);
      } catch {
        setFailure("That file couldn't be read.");
      } finally {
        setReading(false);
      }
    },
    [onImported]
  );

  const disagreements = comparison ? biggestDisagreements(comparison, 8) : [];

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Import CSV records</h2>
          {scientificName && (
            <span className="text-xs italic text-zinc-500 dark:text-zinc-400">{scientificName}</span>
          )}
          <button
            onClick={onClose}
            className="ml-auto text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
            title="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-4 py-3 space-y-3">
          {!imported && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              A CSV with one row per record and decimal latitude/longitude columns. The IUCN
              point-file columns are read as they stand; so are plain <code>decimalLatitude</code> and
              <code>decimalLongitude</code>. It goes onto the map as its own layer, in its own colour —
              it is never merged into your georeferences, and nothing in it is changed here.
            </p>
          )}

          {/* Drop target. Kept present after a file is loaded, so replacing one
              is the same gesture as loading the first. */}
          <label
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              const file = e.dataTransfer.files[0];
              if (file) void read(file);
            }}
            className={`flex flex-col items-center justify-center gap-1 px-4 py-5 rounded border border-dashed cursor-pointer transition-colors ${
              dragging
                ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
                : "border-zinc-300 dark:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-zinc-800"
            }`}
          >
            <input
              ref={inputRef}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/plain"
              className="sr-only"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void read(file);
                // Cleared so choosing the same file again still fires a change.
                e.target.value = "";
              }}
            />
            <svg className="w-5 h-5 text-zinc-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L7 9m5-5l5 5M4 17v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
            </svg>
            <span className="text-xs text-zinc-600 dark:text-zinc-300">
              {reading ? "Reading…" : imported ? "Replace with another file" : "Choose a CSV, or drop one here"}
            </span>
          </label>

          {failure && (
            <p className="text-xs text-red-600 dark:text-red-400">{failure}</p>
          )}

          {imported && comparison && (
            <>
              <div className="flex items-center gap-2 text-xs text-zinc-600 dark:text-zinc-300">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: POINT_FILE_COLOR }} />
                <span className="font-medium truncate">{imported.fileName}</span>
                <span className="tabular-nums text-zinc-400">
                  {imported.points.length.toLocaleString()} point
                  {imported.points.length === 1 ? "" : "s"}
                </span>
                <button
                  onClick={onRemove}
                  className={`ml-auto shrink-0 ${chartControlClass(false, "")}`}
                  title="Take this file off the map. Your own georeferences are untouched."
                >
                  Remove
                </button>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
                <Stat
                  label="Placed by hand"
                  value={comparison.placed}
                  hint="Points sitting somewhere GBIF didn't put them — either moved off a published coordinate, or given one for a record GBIF never located. This is the georeferencing work the file carries."
                />
                <Stat
                  label="You've also georeferenced"
                  value={comparison.alsoMine}
                  hint="Records with both a point in this file and one of your own, so the two can be compared."
                />
                <Stat
                  label="Matched to a loaded record"
                  value={comparison.matched}
                  hint={
                    comparison.matchedByCatalogNo > 0
                      ? `Tied back to a record on the map. ${comparison.matchedByCatalogNo} of them matched on catalogue number rather than GBIF id — GBIF reissues occurrence ids when a dataset is re-indexed, so the ids in an older file often no longer resolve.`
                      : "Tied back to a record on the map, by GBIF occurrence id or catalogue number."
                  }
                />
                <Stat
                  label="No match on the map"
                  value={comparison.notFound + comparison.unsourced}
                  hint="Either sourced from literature or a herbarium catalogue rather than GBIF, or naming a record that isn't among the ones loaded here. They still draw on the map; there's just nothing to compare them against."
                />
              </dl>

              {imported.errors.length > 0 && (
                <details className="text-xs">
                  <summary className="cursor-pointer text-amber-700 dark:text-amber-500">
                    {imported.errors.length} row{imported.errors.length === 1 ? "" : "s"} couldn&apos;t be read
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-zinc-500 dark:text-zinc-400">
                    {imported.errors.slice(0, 20).map((e) => (
                      <li key={e}>{e}</li>
                    ))}
                  </ul>
                </details>
              )}

              {imported.extraColumns.length > 0 && (
                <p className="text-[11px] text-zinc-400">
                  Columns kept but not part of the IUCN specification: {imported.extraColumns.join(", ")}.
                </p>
              )}

              {/* Where the file and the assessor's own work disagree, widest
                  first. This is the reason for loading it at all. */}
              {disagreements.length > 0 && (
                <div className="space-y-1">
                  <h3 className="text-xs font-medium text-zinc-700 dark:text-zinc-200">
                    Where this file and your georeferences differ
                  </h3>
                  <table className="w-full text-[11px] tabular-nums">
                    <thead className="text-zinc-400">
                      <tr className="text-left">
                        <th className="font-normal py-0.5">Record</th>
                        <th className="font-normal py-0.5">Catalogue no.</th>
                        <th className="font-normal py-0.5 text-right">From yours</th>
                        <th className="font-normal py-0.5 text-right">From GBIF</th>
                      </tr>
                    </thead>
                    <tbody className="text-zinc-600 dark:text-zinc-300">
                      {disagreements.map((d) => (
                        <tr key={d.point.row} className="border-t border-zinc-100 dark:border-zinc-800">
                          <td className="py-0.5">
                            {d.matched ? (
                              <a
                                href={`https://www.gbif.org/occurrence/${d.matched.gbifID}`}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 dark:text-blue-400 hover:underline"
                              >
                                {d.matched.gbifID}
                              </a>
                            ) : (
                              <span className="text-zinc-400">row {d.point.row}</span>
                            )}
                          </td>
                          <td className="py-0.5 truncate max-w-[10rem]">{d.point.fields.catalog_no || "—"}</td>
                          <td className="py-0.5 text-right">
                            {d.fromMine == null ? "—" : formatDistance(d.fromMine)}
                          </td>
                          <td className="py-0.5 text-right text-zinc-400">
                            {d.fromGbif == null ? "—" : formatDistance(d.fromGbif)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <div className="flex items-baseline gap-2" title={hint}>
      <dt className="text-zinc-500 dark:text-zinc-400 flex-1 min-w-0">{label}</dt>
      <dd className="tabular-nums font-medium text-zinc-800 dark:text-zinc-100">{value.toLocaleString()}</dd>
    </div>
  );
}
