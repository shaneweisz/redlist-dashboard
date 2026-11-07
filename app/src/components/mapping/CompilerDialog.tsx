"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { CHART_INPUT_CLASS } from "@/components/redlist/chart-controls";

/** Where the compiler's name is kept between saves, so it's typed once. */
const COMPILER_KEY = "redlist-point-file-compiler:v1";

export function loadCompiler(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(COMPILER_KEY) ?? "";
  } catch {
    return "";
  }
}

export function saveCompiler(name: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(COMPILER_KEY, name);
  } catch {
    // A browser refusing storage is not a reason to refuse the file.
  }
}

interface CompilerDialogProps {
  /** How many records the file will hold, so the button says what it does. */
  count: number;
  scientificName?: string;
  onSave: (compiler: string) => void;
  onClose: () => void;
}

/**
 * Who compiled the point file, asked once before it's written.
 *
 * `compiler` is one of the IUCN file's twenty-four columns and this dashboard
 * was leaving it blank, because it is the one thing in the file that can't be
 * derived from the records — it is a person, and the software doesn't know
 * which one. A point file arriving at the spatial data team with no compiler
 * is a file nobody can be asked about.
 *
 * Asked at the point of saving rather than kept in a settings screen: it is
 * part of writing the file, and it is the moment the answer is obvious. The
 * name is remembered so the second save doesn't ask again — the same person
 * compiles a species' file as compiled the last one — but it stays editable
 * here, because a shared machine and a handover are both real.
 */
export default function CompilerDialog({
  count,
  scientificName,
  onSave,
  onClose,
}: CompilerDialogProps) {
  const [compiler, setCompiler] = useState(loadCompiler);

  const save = () => {
    const name = compiler.trim();
    saveCompiler(name);
    onSave(name);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[10001] flex items-center justify-center p-4 bg-black/40"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-700 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-baseline gap-2 px-4 py-3 border-b border-zinc-200 dark:border-zinc-700">
          <h2 className="text-sm font-medium text-zinc-900 dark:text-zinc-100">Save point file</h2>
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
        <div className="px-4 py-3 space-y-2">
          <label className="block text-xs text-zinc-600 dark:text-zinc-300">
            Compiler
            <input
              autoFocus
              value={compiler}
              onChange={(e) => setCompiler(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  save();
                }
                if (e.key === "Escape") onClose();
              }}
              placeholder="who compiled this file"
              className={`mt-1 w-full ${CHART_INPUT_CLASS}`}
            />
          </label>
          <p className="text-[11px] leading-snug text-zinc-500 dark:text-zinc-400">
            Written into the file&apos;s <code className="text-[10px]">compiler</code> column, which
            is how the spatial data team knows who to ask about it. Remembered for next time.
          </p>
        </div>
        <div className="flex items-center gap-2 px-4 py-3 border-t border-zinc-200 dark:border-zinc-700">
          {/* Saving without a name stays possible: a file that can't be
              attributed is still better than work that never leaves the
              browser, and someone re-exporting a colleague's records may
              genuinely not be the compiler. */}
          <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
            {count.toLocaleString()} record{count === 1 ? "" : "s"}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto text-[11px] leading-[14px] px-2 py-0.5 rounded-md text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            className="text-[11px] leading-[14px] px-2 py-0.5 rounded-md border border-zinc-800 bg-zinc-800 text-white hover:bg-zinc-700 dark:bg-zinc-200 dark:text-zinc-900 dark:border-zinc-200 dark:hover:bg-zinc-300 transition-colors"
          >
            Save CSV
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
