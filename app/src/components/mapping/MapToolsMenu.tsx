"use client";

import { useEffect, useState } from "react";
import { useMap } from "react-map-gl/maplibre";

/**
 * The map's tools, behind one button under the basemap and locate controls.
 *
 * EOO/AOO, measuring and the GPS uncertainty rings are all things an assessor
 * reaches for occasionally and none is worth a permanent panel — between them
 * they had two corners of the map, the metrics standing open whether or not they
 * were switched on.
 *
 * Top right, below the other two: everything that acts on the map is in one
 * column now, and the bottom right is left to the scale bar and the
 * attribution — which grow by a line whenever another layer credits itself, so
 * anything anchored above them moved about as layers went on and off.
 *
 * The offset is still measured rather than fixed, because the column above is
 * two buttons tall until the basemap list is opened.
 */
export default function MapToolsMenu({
  open,
  onToggle,
  measuring,
  onMeasureToggle,
  uncertainty,
  onUncertaintyToggle,
  uncertaintyNote,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  measuring: boolean;
  onMeasureToggle: () => void;
  /** Whether each record's stated GPS uncertainty is drawn around it. */
  uncertainty: boolean;
  onUncertaintyToggle: () => void;
  /**
   * What the rings do and don't cover — how many records state a radius at all.
   * Shown only while they're on, where it's a caveat about what you're looking
   * at rather than a paragraph in front of a switch.
   */
  uncertaintyNote?: string;
  children?: React.ReactNode;
}) {
  const { current: map } = useMap();
  const [offset, setOffset] = useState(80);
  /**
   * How tall the open panel may be before it runs off the bottom of the map.
   * The map is 450px on a desktop but 300px in the tab on a phone, and the
   * EOO/AOO figures alone are 235px.
   */
  const [maxHeight, setMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!map) return;
    const container = map.getContainer();
    const column = container.parentElement?.querySelector('[data-map-corner="top-right"]');
    const measure = () => {
      // The column's own top inset, its height, and a gap under it.
      const top = 8 + (column?.getBoundingClientRect().height ?? 68) + 6;
      setOffset(top);
      // Leave room for the button itself and a margin at the map's bottom edge.
      setMaxHeight(Math.max(120, container.getBoundingClientRect().height - top - 52));
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (column) observer.observe(column);
    observer.observe(container);
    return () => observer.disconnect();
  }, [map]);

  return (
    <div className="absolute right-2 z-[999] flex flex-col items-end gap-1.5" style={{ top: offset }}>
      <button
        onClick={onToggle}
        title={open ? "Hide the map tools" : "Map tools: EOO/AOO, measuring and GPS uncertainty"}
        aria-label="Map tools"
        className={`p-1.5 rounded-lg shadow-md border transition-colors ${
          // Lit while a tool is on, not only while the panel is open: both of
          // them change what the map is showing, and the panel folds away over
          // whichever one you left running.
          open || measuring || uncertainty
            ? "bg-blue-600 border-blue-700 text-white"
            : "bg-white dark:bg-zinc-800 border-zinc-200 dark:border-zinc-700 text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200"
        }`}
      >
        {/* A ruler and pencil, not a cog. A cog means settings — the things
            that change how a tool behaves — and these are the tools: measure
            this, compute that. */}
        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.5 3.5l6 6L8 22H2v-6L14.5 3.5z" />
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 6l6 6M9.5 8.5l2 2M7 11l2 2M4.5 13.5l2 2" />
        </svg>
      </button>
      {/* Under the button, not above it: the column it belongs to runs down
          from the map's top-right corner. */}
      {open && (
        <div
          className="w-56 max-w-[calc(100vw-1rem)] overflow-y-auto overscroll-contain rounded-lg bg-white dark:bg-zinc-800 shadow-md border border-zinc-200 dark:border-zinc-700 p-2 space-y-2"
          style={{ maxHeight }}
        >
          {children}
          <button
            onClick={onMeasureToggle}
            className={`flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-[11px] transition-colors ${
              measuring
                ? "bg-blue-600 text-white"
                : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            }`}
          >
            <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 20L20 4M4 20v-5m0 5h5M20 4v5m0-5h-5" />
            </svg>
            {measuring ? "Measuring — click two points" : "Measure a distance"}
          </button>
          {/* Under measuring, and next to it rather than among the filters,
              because it's the same kind of thing: a way of interrogating the
              points already on the map, switched on while you're asking and off
              again afterwards. */}
          <button
            onClick={onUncertaintyToggle}
            title="Draw each record's stated GPS uncertainty as a circle on the ground, to scale"
            aria-pressed={uncertainty}
            className={`flex items-center gap-1.5 w-full px-1.5 py-1 rounded text-[11px] transition-colors ${
              uncertainty
                ? "bg-blue-600 text-white"
                : "text-zinc-600 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-700"
            }`}
          >
            {/* A dot inside a dashed ring: the point, and the ground it might
                actually be anywhere in. */}
            <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <circle cx="12" cy="12" r="8.5" strokeDasharray="3 2.5" />
              <circle cx="12" cy="12" r="2" fill="currentColor" stroke="none" />
            </svg>
            GPS uncertainty
          </button>
          {uncertainty && uncertaintyNote && (
            <p className="px-1.5 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
              {uncertaintyNote}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
