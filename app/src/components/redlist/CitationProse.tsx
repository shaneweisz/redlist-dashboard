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
 *
 * `className` is the caller's typography. The default is the nearby-species
 * panel's, which is where this started; the assessments tab passes an inline
 * one, because the "read the full assessment" link has to keep flowing after
 * the last sentence rather than dropping to a line of its own.
 */
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { stripHtml } from "@/lib/html-text";
import { linkCitations, type AssessmentReference } from "@/lib/mapping/nearby-citations";
import { CHART_MENU_PANEL_CLASS } from "@/components/redlist/chart-controls";

/** Prose with its in-text citations turned into things you can open. */
export function CitationProse({
  text,
  references,
  renderText,
  className = "block whitespace-pre-wrap text-zinc-600 dark:text-zinc-300",
}: {
  text: string;
  references: AssessmentReference[];
  renderText?: (text: string) => ReactNode;
  className?: string;
}) {
  /** The open citation, and the element it hangs from. */
  const [open, setOpen] = useState<{ index: number; anchor: HTMLElement } | null>(null);
  const close = useCallback(() => setOpen(null), []);
  const segments = linkCitations(text, references);
  return (
    <span className={className}>
      {segments.map((seg, i) =>
        seg.reference ? (
          <span key={i}>
            <button
              onClick={(e) => {
                const anchor = e.currentTarget;
                setOpen((prev) => (prev?.index === i ? null : { index: i, anchor }));
              }}
              title="Show this reference"
              className={`underline decoration-dotted underline-offset-2 ${
                open?.index === i
                  ? "bg-blue-50 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200"
                  : "text-blue-700 hover:text-blue-500 dark:text-blue-400"
              }`}
            >
              {seg.text}
            </button>
            {/* Beside the citation that asked for it: in prose this dense, a
                block at the foot of the paragraph left you working out which of
                six citations it had answered. */}
            {open?.index === i && (
              <ReferencePopover
                anchor={open.anchor}
                citation={stripHtml(seg.reference.citation)}
                onClose={close}
              />
            )}
          </span>
        ) : (
          <span key={i}>{renderText ? renderText(seg.text) : seg.text}</span>
        )
      )}
    </span>
  );
}

/**
 * One reference, opened from its citation.
 *
 * Portalled to the body and placed with fixed coordinates: the prose sits in
 * scrolling and overflow-clipped containers (the species table, the nearby
 * panel), and a popover positioned inside them was cut off at their edge.
 * Below the citation when it fits, above when it doesn't, and kept inside the
 * viewport sideways. It follows the citation on scroll and resize, and takes
 * the prose's own type size, which a portal would otherwise lose.
 */
function ReferencePopover({
  anchor,
  citation,
  onClose,
}: {
  anchor: HTMLElement;
  citation: string;
  onClose: () => void;
}) {
  const box = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const style = getComputedStyle(anchor);
    el.style.fontSize = style.fontSize;
    el.style.lineHeight = style.lineHeight;
    const place = () => {
      const a = anchor.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const margin = 8;
      const below = a.bottom + 4;
      const top = below + r.height <= window.innerHeight - margin ? below : Math.max(margin, a.top - 4 - r.height);
      const left = Math.max(margin, Math.min(a.left, window.innerWidth - margin - r.width));
      el.style.top = `${top}px`;
      el.style.left = `${left}px`;
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      window.removeEventListener("keydown", onKey);
    };
  }, [anchor, onClose]);

  return createPortal(
    <span
      ref={box}
      role="dialog"
      className={`fixed left-0 top-0 z-[1003] block w-max max-w-[min(26rem,calc(100vw-16px))] p-1.5 ${CHART_MENU_PANEL_CLASS}`}
    >
      {/* Selectable, because the point of reaching a reference is usually to
          put it somewhere else. */}
      <span className="block select-text text-zinc-700 [overflow-wrap:anywhere] dark:text-zinc-200">{citation}</span>
      <span className="mt-1 flex items-center gap-1">
        <button
          onClick={() => navigator.clipboard?.writeText(citation)}
          className="rounded px-1 py-0.5 text-zinc-500 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Copy
        </button>
        <button
          onClick={onClose}
          className="rounded px-1 py-0.5 text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800"
        >
          Close
        </button>
      </span>
    </span>,
    document.body
  );
}
