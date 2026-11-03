"use client";

/**
 * A protected area's full WDPA record, behind a toggle under its summary line.
 *
 * The summary answers "what is this" — designation, IUCN category, year. An
 * assessor deciding whether a record really sits under protection often needs
 * more: who governs it, whether the country verified it, whether a marine site
 * is no-take. Rather than pick which of WDPA's thirty-odd fields matter, the
 * whole record is here, labelled as WDPA labels it, one click away.
 */

import type { ProtectedAreaDetail } from "@/lib/mapping/protected-areas";

export function ProtectedAreaDetailsToggle({
  open,
  count,
  onToggle,
}: {
  open: boolean;
  count: number;
  onToggle: () => void;
}) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
    >
      <svg
        className={`w-2.5 h-2.5 transition-transform ${open ? "rotate-90" : ""}`}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2.5}
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
      </svg>
      {open ? "Hide fields" : `All fields (${count})`}
    </button>
  );
}

export default function ProtectedAreaDetails({ details }: { details: ProtectedAreaDetail[] }) {
  return (
    // Scrolls inside the popup rather than growing it past the map's edge.
    <dl className="mt-1 max-h-56 overflow-y-auto pr-1 grid grid-cols-[minmax(0,9fr)_minmax(0,11fr)] gap-x-2 gap-y-0.5 text-[10px] leading-snug">
      {details.map(({ label, value }) => (
        <div key={label} className="contents">
          <dt className="text-zinc-400 dark:text-zinc-500 break-words">{label}</dt>
          <dd
            className={`break-words ${
              value === "Not Reported" ? "text-zinc-400 dark:text-zinc-500 italic" : "text-zinc-700 dark:text-zinc-200"
            }`}
          >
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
