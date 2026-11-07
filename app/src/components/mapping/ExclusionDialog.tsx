"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { chartControlClass } from "@/components/redlist/chart-controls";
import { EXCLUSION_REASONS } from "@/lib/mapping/georeferences";

interface ExclusionDialogProps {
  /** The records being struck out — one, or a set selected together. */
  gbifIDs: number[];
  /**
   * The record itself, as the map panel shows it, when there is only one.
   *
   * The reason for excluding a record is in the record: the duplicate
   * catalogue number, the locality in the wrong country, the date that
   * predates the collector. Asking for that reason with the record out of
   * sight meant remembering it while typing it.
   */
  fields?: { label: string; value: string }[];
  notes?: { label: string; value: string; flag?: boolean }[];
  /** Pre-filled when re-opening an exclusion to edit its reason. */
  existingJustification?: string;
  onConfirm: (justification: string) => void;
  onCancel: () => void;
}

/**
 * Asks why, and won't take an empty answer.
 *
 * Excluding a record is a judgement about the evidence, and the next person to
 * read the assessment — or the same person in six months — needs to know which
 * judgement it was. Duplicates in particular tend to come in runs, which is why
 * this takes a set of records rather than one at a time.
 */
export default function ExclusionDialog({
  gbifIDs,
  fields,
  notes,
  existingJustification,
  onConfirm,
  onCancel,
}: ExclusionDialogProps) {
  const [justification, setJustification] = useState(existingJustification ?? "");
  const [showError, setShowError] = useState(false);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onCancel]);

  const confirm = () => {
    if (justification.trim() === "") {
      setShowError(true);
      return;
    }
    onConfirm(justification.trim());
  };

  return createPortal(
    <div className="fixed inset-0 z-[10001] flex items-center justify-center p-4 bg-black/40" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">
            {existingJustification
              ? gbifIDs.length === 1
                ? "Edit exclusion reason"
                : `Edit reason for ${gbifIDs.length} records`
              : gbifIDs.length === 1
                ? "Exclude this record"
                : `Exclude ${gbifIDs.length} records`}
          </h2>
          {gbifIDs.length === 1 && (
            <p className="text-[11px] text-zinc-400 mt-0.5">
              GBIF record{" "}
              <a
                href={`https://www.gbif.org/occurrence/${gbifIDs[0]}`}
                target="_blank"
                rel="noopener noreferrer"
                className="tabular-nums text-blue-600 dark:text-blue-400 hover:underline"
              >
                {gbifIDs[0]}
              </a>
            </p>
          )}
        </div>

        {fields && fields.length > 0 && (
          <div className="max-h-[220px] overflow-y-auto overscroll-contain px-4 py-2 border-b border-zinc-100 dark:border-zinc-800">
            <table className="w-full border-collapse text-[11px]">
              <tbody>
                {fields.map((field) => (
                  <tr key={field.label} className="align-top">
                    <td className="py-[1px] pr-2 whitespace-nowrap text-zinc-400 dark:text-zinc-500">
                      {field.label}
                    </td>
                    <td className="py-[1px] break-words text-zinc-700 dark:text-zinc-200">{field.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {notes && notes.length > 0 && (
              <div className="pt-1 mt-1 border-t border-zinc-100 dark:border-zinc-800 space-y-0.5 text-[11px]">
                {notes.map((note) => (
                  <div
                    key={note.label}
                    className={`flex gap-1.5 ${
                      note.flag ? "text-amber-700 dark:text-amber-400" : "text-zinc-600 dark:text-zinc-300"
                    }`}
                  >
                    <span className={note.flag ? "text-amber-600 dark:text-amber-500" : "text-zinc-400 dark:text-zinc-500"}>
                      {note.label}
                    </span>
                    <span className="break-words">{note.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="px-4 py-3 space-y-2">
          <div className="flex flex-wrap gap-1">
            {EXCLUSION_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                aria-pressed={justification === reason}
                onClick={() => {
                  setJustification(reason);
                  setShowError(false);
                }}
                className={chartControlClass(justification === reason, "bg-blue-600 text-white border-blue-600")}
              >
                {reason}
              </button>
            ))}
          </div>
          <label className="block text-xs">
            <span className="block mb-1 text-zinc-500 dark:text-zinc-400">
              Reason <span className="text-amber-600 dark:text-amber-400">required</span>
            </span>
            <textarea
              value={justification}
              autoFocus
              rows={2}
              onChange={(e) => {
                setJustification(e.target.value);
                setShowError(false);
              }}
              placeholder="Why should this record be excluded?"
              className="w-full px-2 py-1 rounded border border-zinc-300 dark:border-zinc-600 bg-white dark:bg-zinc-800 text-zinc-800 dark:text-zinc-100"
            />
          </label>
          {showError && (
            <p className="text-[11px] text-red-600 dark:text-red-400">
              Give a reason — an exclusion nobody can audit is just missing data.
            </p>
          )}
        </div>

        <div className="flex items-center gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
          <button
            type="button"
            onClick={onCancel}
            className={`ml-auto ${chartControlClass(false, "")}`}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={confirm}
            className="text-[11px] leading-[14px] px-2 py-0.5 rounded-md border border-zinc-800 bg-zinc-800 text-white hover:bg-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:border-zinc-200 dark:hover:bg-zinc-300 font-medium transition-colors"
          >
            {existingJustification
              ? "Save reason"
              : gbifIDs.length === 1
                ? "Exclude"
                : `Exclude ${gbifIDs.length}`}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
