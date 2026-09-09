"use client";

/**
 * Assessment prose, with its in-text citations turned into things you can open.
 *
 * Lifted out of NearbySpeciesPanel when the assessment-text search wanted the
 * same thing. "(Oldfield 1997)" in a rationale means nothing on its own; the
 * bibliography that resolves it is on the same assessment, and matching them
 * up is what lib/mapping/nearby-citations.ts does.
 *
 * `renderText` is how a caller decorates the prose in between the citations —
 * the search marks the words it was asked about. Left out, the text is text.
 */
import { useCallback, useState, type ReactNode } from "react";
import { stripHtml } from "@/lib/html-text";
import { linkCitations, type AssessmentReference } from "@/lib/mapping/nearby-citations";

/** Prose with its in-text citations turned into things you can open. */
export function CitationProse({
  text,
  references,
  renderText,
}: {
  text: string;
  references: AssessmentReference[];
  renderText?: (text: string) => ReactNode;
}) {
  const [open, setOpen] = useState<number | null>(null);
  /**
   * Keep the reference on screen.
   *
   * A citation near the right edge opens a tooltip that runs off it, and
   * nothing in CSS alone knows how far. Measured in a ref callback rather than
   * an effect: it needs the laid-out box, and this way there is no state to
   * keep in step with it.
   */
  const place = useCallback((el: HTMLSpanElement | null) => {
    if (!el) return;
    el.style.transform = "";
    const r = el.getBoundingClientRect();
    const overhang = r.right - (window.innerWidth - 12);
    if (overhang > 0) el.style.transform = `translateX(${-Math.min(overhang, r.left - 12)}px)`;
  }, []);

  const segments = linkCitations(text, references);
  return (
    <span className="block whitespace-pre-wrap text-zinc-600 dark:text-zinc-300">
      {segments.map((seg, i) =>
        seg.reference ? (
          <span key={i} className="relative">
            <button
              onClick={() => setOpen((prev) => (prev === i ? null : i))}
              title="Show this reference"
              className={`underline decoration-dotted underline-offset-2 ${
                open === i
                  ? "bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
                  : "text-blue-700 hover:text-blue-500 dark:text-blue-400"
              }`}
            >
              {seg.text}
            </button>
            {/* Beside the citation that asked for it: in prose this dense, a
                block at the foot of the paragraph left you working out which of
                six citations it had answered. Selectable, because the point of
                reaching a reference is usually to put it somewhere else. */}
            {open === i && (
              <span
                ref={place}
                className="absolute left-0 top-full z-[1003] mt-1 block w-max max-w-[26rem] rounded-md border border-zinc-200 bg-white p-1.5 shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
              >
                <span className="block select-text text-zinc-700 dark:text-zinc-200">
                  {stripHtml(seg.reference.citation)}
                </span>
                <span className="mt-1 flex items-center gap-1">
                  <button
                    onClick={() => navigator.clipboard?.writeText(stripHtml(seg.reference!.citation))}
                    className="rounded px-1 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
                  >
                    Copy
                  </button>
                  <button
                    onClick={() => setOpen(null)}
                    className="rounded px-1 py-0.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                  >
                    Close
                  </button>
                </span>
              </span>
            )}
          </span>
        ) : (
          <span key={i}>{renderText ? renderText(seg.text) : seg.text}</span>
        )
      )}
    </span>
  );
}
