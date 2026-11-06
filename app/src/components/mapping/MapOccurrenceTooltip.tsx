"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useMap } from "react-map-gl/maplibre";
import LinkifiedText from "./LinkifiedText";
import { gbifImageCredit } from "@/lib/image-credit";

interface MapOccurrenceTooltipProps {
  lat: number;
  lng: number;
  /**
   * Every field this record has, as label/value pairs, in the order they
   * should be read.
   *
   * A table rather than a styled summary. The panel used to pick a dozen
   * fields and give each its own colour and weight — italic species, amber
   * flags, violet georeference — which made a record look like a verdict. Two
   * plain columns say the same things and let you compare one record with the
   * next without decoding the formatting first.
   */
  fields: { label: string; value: string; link?: boolean }[];
  /**
   * What this dashboard says about the record, as opposed to what GBIF
   * publishes about it: the coordinate-cleaning flags, whether it falls
   * outside the native range, why it's hidden, how an imported CSV row
   * disagrees with it.
   *
   * Kept out of the table and below it. Mixed in, an inference of ours read
   * as another field off the record, and the table stopped being a copy of
   * what the publisher sent. `flag` marks the ones worth picking out.
   */
  notes?: { label: string; value: string; flag?: boolean }[];
  /**
   * Photographs the publisher attached to the record, from GBIF's media.
   *
   * Drawn beside the panel at a size worth looking at — a herbarium sheet is
   * the record, and a 64px thumbnail of one says only that a photograph
   * exists. Clicking opens the full image.
   */
  images?: { url: string; title?: string; creator?: string; license?: string; rightsHolder?: string }[];
  /**
   * What the cleaning tests and the native-range check say about this record,
   * as one line. Drawn as a flag in the panel's top corner, with the line
   * itself on hover — worth seeing at a glance, not worth six rows.
   */
  mark?: string | null;
  /** Set where the record is a type specimen — "Isotype", "Holotype". */
  typeStatus?: string | null;
  /** Position within the records sharing this point, when more than one does. */
  page?: { index: number; total: number; onPrev: () => void; onNext: () => void };
  /** Dismisses a pinned tooltip. */
  onClose?: () => void;
  /** Keeps the tooltip up while the pointer is on it, so its controls are usable. */
  onPointerEnter?: () => void;
  onPointerLeave?: () => void;
  /**
   * Editing the record's position, where it has one to edit.
   *
   * Below the fields and above the actions: it belongs to the record rather
   * than being something you do with it, and it is where the coordinates it
   * changes are shown.
   */
  editor?: React.ReactNode;
  /**
   * What you can do with this record, drawn as a block at the foot of the
   * panel.
   */
  actions?: React.ReactNode;
}

const DEFAULT_WIDTH = 220;
const DEFAULT_FIELDS_HEIGHT = 220;
const MIN_WIDTH = 180;
const MAX_WIDTH = 560;
const MIN_FIELDS_HEIGHT = 60;
const MAX_FIELDS_HEIGHT = 640;

const clamp = (value: number, low: number, high: number) => Math.max(low, Math.min(value, high));

/**
 * The eight places the panel can be taken hold of, as a window has.
 *
 * `dirX`/`dirY` say which way that edge grows the panel, so each handle
 * follows the pointer rather than mirroring it.
 */
const RESIZE_HANDLES = [
  { key: "n", dirX: 0, dirY: -1, className: "top-0 left-2 right-2 h-1.5 cursor-ns-resize" },
  { key: "s", dirX: 0, dirY: 1, className: "bottom-0 left-2 right-2 h-1.5 cursor-ns-resize" },
  { key: "w", dirX: -1, dirY: 0, className: "left-0 top-2 bottom-2 w-1.5 cursor-ew-resize" },
  { key: "e", dirX: 1, dirY: 0, className: "right-0 top-2 bottom-2 w-1.5 cursor-ew-resize" },
  { key: "nw", dirX: -1, dirY: -1, className: "top-0 left-0 h-2.5 w-2.5 cursor-nwse-resize" },
  { key: "ne", dirX: 1, dirY: -1, className: "top-0 right-0 h-2.5 w-2.5 cursor-nesw-resize" },
  { key: "sw", dirX: -1, dirY: 1, className: "bottom-0 left-0 h-3 w-3 cursor-nesw-resize" },
  { key: "se", dirX: 1, dirY: 1, className: "bottom-0 right-0 h-3 w-3 cursor-nwse-resize" },
];

export default function MapOccurrenceTooltip(props: MapOccurrenceTooltipProps) {
  const { current: map } = useMap();
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  // Measured rather than guessed: the panel's height depends on which fields
  // the record has and whether it carries an image, and both the clamping and
  // the arrow's position need the real number. Observed rather than read once,
  // since paging between records at a point changes it under us.
  const [panelHeight, setPanelHeight] = useState(0);
  /**
   * Photograph URLs the browser couldn't load, so they can be left out of the
   * render.
   *
   * A dead publisher image link used to be dealt with by removing its node
   * from the document in the error handler. That takes a node React owns out
   * from under it, and the next time React unmounts that subtree — moving the
   * pointer off the record, or paging to the next one at the same point — it
   * tries to remove a child that is no longer there and throws
   * NotFoundError, which takes the whole page down.
   */
  const [brokenImages, setBrokenImages] = useState<string[]>([]);
  /**
   * Whether the flag's reasons are showing.
   *
   * Its own bubble rather than a `title`: the browser holds a title back for
   * about a second, which is long enough that the flag read as unexplained.
   */
  const [markOpen, setMarkOpen] = useState<string | null>(null);
  /** Whether the photograph icon is being pointed at. */
  const [imageOpen, setImageOpen] = useState(false);
  /**
   * The panel's size, which the reader can change by dragging its corner.
   *
   * A locality description can run to four lines in 220px and a record to
   * seventeen fields, and how much of either is worth seeing at once is a
   * judgement about the record in front of you, not something to fix here.
   * The width is the panel's; the height is the field list's, since the
   * controls and the actions around it are what they are.
   */
  const [size, setSize] = useState({ width: DEFAULT_WIDTH, fieldsHeight: DEFAULT_FIELDS_HEIGHT });
  const resizeFrom = useRef<{
    x: number;
    y: number;
    width: number;
    height: number;
    dirX: number;
    dirY: number;
  } | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const panelRef = useCallback((el: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    if (!el) return;
    const observer = new ResizeObserver(() => setPanelHeight(el.getBoundingClientRect().height));
    observer.observe(el);
    observerRef.current = observer;
  }, []);

  useEffect(() => {
    if (!map) return;
    const update = () => {
      const point = map.project([props.lng, props.lat]);
      setPos({ x: point.x, y: point.y });
    };
    update();
    map.on("move", update);
    map.on("zoom", update);
    return () => {
      map.off("move", update);
      map.off("zoom", update);
    };
  }, [map, props.lat, props.lng]);

  if (!pos || !map) return null;

  const container = map.getContainer();
  const containerRect = container.getBoundingClientRect();

  // Convert container-relative position to viewport-fixed position
  const fixedX = containerRect.left + pos.x;
  const fixedY = containerRect.top + pos.y;

  const shownImages = (props.images ?? []).filter((i) => !brokenImages.includes(i.url));

  const tooltipWidth = size.width;
  // Beside the point rather than above it: the map is far wider than it is
  // tall, so horizontal room is what there is plenty of — and a tooltip above
  // the point covers the very area you're comparing it against. Flips to the
  // left when there isn't room on the right.
  const showLeft = fixedX + tooltipWidth + 24 > containerRect.right;
  /**
   * Kept inside the map horizontally, the way it already was vertically.
   *
   * Choosing a side isn't enough on its own: zoomed in, a record near a corner
   * put the panel past the map's edge and the close button went with it, since
   * the button sits in the panel's own top row rather than floating. The edge
   * is computed here and clamped, so there is no arrangement that hides it.
   */
  const panelLeft = Math.max(
    containerRect.left + 4,
    Math.min(
      showLeft ? fixedX - 12 - tooltipWidth : fixedX + 12,
      containerRect.right - tooltipWidth - 4
    )
  );
  // Keep it inside the map vertically. The estimate only covers the first
  // frame, before the panel has been measured.
  const height = panelHeight || 160;
  const halfHeight = height / 2;
  const clampedY = Math.max(
    containerRect.top + halfHeight + 4,
    Math.min(fixedY, containerRect.bottom - halfHeight - 4)
  );
  // Once clamped, the panel's middle is no longer level with the point, so the
  // arrow has to move to keep pointing at it — otherwise a tooltip nudged away
  // from the edge appears to be labelling a different record entirely.
  const arrowOffset = Math.max(10, Math.min(height - 10, fixedY - (clampedY - halfHeight)));

  // A rotated square rather than a CSS-border triangle, so it can carry the
  // panel's own background and border in both themes (the old triangle was
  // hardcoded white and vanished into dark mode).
  const arrow = (
    <div
      className="absolute w-2.5 h-2.5 bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-700"
      style={{
        top: arrowOffset,
        [showLeft ? "right" : "left"]: -5,
        transform: "translateY(-50%) rotate(45deg)",
        borderRightWidth: showLeft ? 1 : 0,
        borderTopWidth: showLeft ? 1 : 0,
        borderLeftWidth: showLeft ? 0 : 1,
        borderBottomWidth: showLeft ? 0 : 1,
      }}
    />
  );

  /**
   * Where a photograph opens when you point at its icon.
   *
   * Beside the panel, on the side with room for it — the same place the
   * photographs used to sit permanently. They don't any more: a herbarium
   * sheet is worth seeing and worth putting away, and an icon in the header
   * beside the flag says one is there without spending the map on it.
   */
  const IMAGE_WIDTH = 220;
  const outerLeft = showLeft ? panelLeft - IMAGE_WIDTH - 6 : panelLeft + tooltipWidth + 6;
  const innerLeft = showLeft ? panelLeft + tooltipWidth + 6 : panelLeft - IMAGE_WIDTH - 6;
  const fits = (x: number) => x >= containerRect.left + 4 && x + IMAGE_WIDTH <= containerRect.right - 4;
  const imagesLeft = Math.max(
    containerRect.left + 4,
    Math.min(fits(outerLeft) || !fits(innerLeft) ? outerLeft : innerLeft, containerRect.right - IMAGE_WIDTH - 4)
  );

  return createPortal(
    <>
    {shownImages.length > 0 && imageOpen && (
      <div
        style={{
          position: "fixed",
          left: imagesLeft,
          top: clampedY,
          transform: "translateY(-50%)",
          width: IMAGE_WIDTH,
          maxHeight: "min(70vh, 420px)",
          zIndex: 10002,
          pointerEvents: "none",
        }}
        data-occurrence-images
        className="flex flex-col gap-1 overflow-hidden"
      >
        {shownImages.slice(0, 2).map((image) => (
          <span
            key={image.url}
            className="block rounded-lg overflow-hidden bg-white dark:bg-zinc-900 shadow-xl border border-zinc-200 dark:border-zinc-700"
          >
            <img
              src={image.url}
              alt={image.title ?? "Specimen photograph"}
              className="w-full max-h-[15rem] object-contain"
              onError={() => {
                setBrokenImages((prev) => (prev.includes(image.url) ? prev : [...prev, image.url]));
              }}
            />
            <span className="block px-1.5 py-1 text-[10px] leading-snug text-zinc-500 dark:text-zinc-400">
              {/* Its own wrapping line: the licence requires the credit, so it
                  must not be truncated away. */}
              {gbifImageCredit(image) && <span className="block">{gbifImageCredit(image)}</span>}
              Click to open the full image
            </span>
          </span>
        ))}
      </div>
    )}
    {markOpen && (
      <div
        style={{
          position: "fixed",
          left: panelLeft,
          top: clampedY - height / 2 + 22,
          width: tooltipWidth,
          zIndex: 10002,
          pointerEvents: "none",
        }}
        data-occurrence-mark
        className="rounded-md bg-zinc-900/95 dark:bg-zinc-700 px-1.5 py-1 text-[10px] leading-snug text-white shadow-lg"
      >
        {markOpen}
      </div>
    )}
    <div
      data-occurrence-tooltip=""
      style={{
        position: "fixed",
        left: panelLeft,
        top: clampedY,
        // Only the vertical half-shift: the horizontal edge is already the
        // clamped value, so translating it again would undo the clamp.
        transform: "translateY(-50%)",
        width: tooltipWidth,
        zIndex: 10000,
        // Interactive when there is something to reach: the record pager, an
        // action, or a field list long enough to scroll. Inert otherwise, so a
        // panel with four lines in it can't get between the pointer and the
        // map.
        pointerEvents:
          props.page || props.actions || props.editor || props.fields.length > 8 ? "auto" : "none",
      }}
      onMouseEnter={props.onPointerEnter}
      onMouseLeave={props.onPointerLeave}
    >
      <div
        ref={panelRef}
        className="relative bg-white dark:bg-zinc-900 rounded-lg shadow-lg border border-zinc-200 dark:border-zinc-700"
        style={{ maxWidth: size.width }}
      >
        {arrow}
        <div className="rounded-lg overflow-hidden">
        <div className="p-2 text-xs space-y-0.5">
          {/* The controls row. Laid out as a label that gives way and a
              button group that never does: the label used to be free to push
              the buttons along, so at "10 of 120 records here" the row grew
              past the panel and the close button was clipped off its edge by
              the panel's own overflow-hidden. */}
          {((props.page && props.page.total > 1) ||
            props.onClose ||
            props.mark ||
            props.typeStatus ||
            shownImages.length > 0) && (
            <div className="flex items-center gap-1 pb-1 mb-1 border-b border-zinc-100 dark:border-zinc-800 text-[10px] text-zinc-500 dark:text-zinc-400">
              {props.page && props.page.total > 1 && (
                <span
                  className="tabular-nums truncate min-w-0"
                  title={`Record ${props.page.index + 1} of ${props.page.total} at this point`}
                >
                  {props.page.index + 1} of {props.page.total} records here
                </span>
              )}
              <div className="ml-auto flex items-center shrink-0">
                {/* Drawn even when there's nothing to say, invisibly. The
                    controls in this row are right-aligned, so a flag that came
                    and went as you paged through the records at a point moved
                    the buttons beside it out from under the pointer. */}
                <span
                  onMouseEnter={() => props.mark && setMarkOpen(props.mark)}
                  onMouseLeave={() => setMarkOpen(null)}
                  className={`p-0.5 ${
                    props.mark ? "text-amber-600 dark:text-amber-500 cursor-help" : "invisible"
                  }`}
                >
                  <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M5 21V4m0 0h11l-1.5 3.5L16 11H5" />
                  </svg>
                </span>
                {props.typeStatus && (
                  <span
                    onMouseEnter={() =>
                      setMarkOpen(
                        `${props.typeStatus!.charAt(0).toUpperCase()}${props
                          .typeStatus!.slice(1)
                          .toLowerCase()
                          .replace(/_/g, " ")} — a type specimen`
                      )
                    }
                    onMouseLeave={() => setMarkOpen(null)}
                    className="p-0.5 text-amber-500 cursor-help"
                  >
                    <svg className="w-3 h-3" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 3.5l2.6 5.3 5.9.9-4.3 4.1 1 5.8-5.2-2.7-5.2 2.7 1-5.8L3.5 9.7l5.9-.9z" />
                    </svg>
                  </span>
                )}
                {/* The photograph, as a mark you can point at and click
                    through, rather than a column of pictures beside the panel
                    that was the loudest thing on the map whether you wanted it
                    or not. */}
                {shownImages.length > 0 && (
                  <a
                    href={shownImages[0].url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onMouseEnter={() => setImageOpen(true)}
                    onMouseLeave={() => setImageOpen(false)}
                    onClick={() => setImageOpen(false)}
                    className="p-0.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                  >
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
                      <rect x="3" y="5" width="18" height="14" rx="2" />
                      <circle cx="8.5" cy="10" r="1.5" />
                      <path strokeLinecap="round" strokeLinejoin="round" d="M4 17l5-5 4 4 3-2 4 4" />
                    </svg>
                  </a>
                )}
                {props.page && props.page.total > 1 && (
                  <>
                    <button
                      onClick={props.page.onPrev}
                      title="Previous record at this point"
                      className="p-0.5 hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
                      </svg>
                    </button>
                    <button
                      onClick={props.page.onNext}
                      title="Next record at this point"
                      className="p-0.5 hover:text-zinc-700 dark:hover:text-zinc-200"
                    >
                      <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </>
                )}
                {props.onClose && (
                  <button
                    onClick={props.onClose}
                    title="Close (or click anywhere outside)"
                    className="p-0.5 hover:text-zinc-700 dark:hover:text-zinc-200"
                  >
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
            </div>
          )}
          {/* The record as a table. One type, one colour, two columns: the
              label you are looking up and the value it has.

              Scrolled rather than paged. Paging meant a record's fields were
              split across three screens with no way to see two of them at
              once, and the field you wanted was never on the page you were
              looking at. */}
          <div className="overflow-y-auto overscroll-contain" style={{ maxHeight: size.fieldsHeight }}>
          <table className="w-full border-collapse">
            <tbody>
              {props.fields.map((field) => (
                <tr key={field.label} className="align-top">
                  <td className="py-[1px] pr-1.5 whitespace-nowrap text-zinc-400 dark:text-zinc-500">
                    {field.label}
                  </td>
                  {/* pre-line for the note, which can be a paragraph now. */}
                  <td className="py-[1px] break-words whitespace-pre-line text-zinc-700 dark:text-zinc-200">
                    {field.link ? <LinkifiedText text={field.value} /> : field.value}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          {props.notes && props.notes.length > 0 && (
            <div className="pt-1 mt-1 border-t border-zinc-100 dark:border-zinc-800 space-y-0.5">
              {props.notes.map((note) => (
                <div
                  key={note.label}
                  className={`flex gap-1.5 ${
                    note.flag ? "text-amber-700 dark:text-amber-400" : "text-zinc-600 dark:text-zinc-300"
                  }`}
                >
                  <span
                    className={`shrink-0 ${note.flag ? "text-amber-600 dark:text-amber-500" : "text-zinc-400 dark:text-zinc-500"}`}
                  >
                    {note.label}
                  </span>
                  <span className="break-words">{note.value}</span>
                </div>
              ))}
            </div>
          )}
          {props.editor}
        </div>
        {props.actions && (
          <div className="border-t border-zinc-100 dark:border-zinc-800 p-1 space-y-0.5 text-[11px] text-zinc-700 dark:text-zinc-200">
            {props.actions}
          </div>
        )}
        </div>
        {/* Every edge and corner resizes, as a window does. Each pulls the
            side it's on: dragging the right edge right widens, dragging the
            top edge up heightens. The panel is centred on its point
            vertically, so a vertical drag grows it by twice the distance —
            half of which goes the other way — and the edge stays under the
            pointer. Only the free bottom corner is drawn; the rest are
            invisible strips, the way a window's edges are. */}
        {RESIZE_HANDLES.map((handle) => (
          <span
            key={handle.key}
            onPointerDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              resizeFrom.current = {
                x: e.clientX,
                y: e.clientY,
                width: size.width,
                height: size.fieldsHeight,
                dirX: handle.dirX,
                dirY: handle.dirY,
              };
            }}
            onPointerMove={(e) => {
              const from = resizeFrom.current;
              if (!from) return;
              setSize({
                width: clamp(from.width + from.dirX * (e.clientX - from.x), MIN_WIDTH, MAX_WIDTH),
                fieldsHeight: clamp(
                  from.height + from.dirY * (e.clientY - from.y) * 2,
                  MIN_FIELDS_HEIGHT,
                  MAX_FIELDS_HEIGHT
                ),
              });
            }}
            onPointerUp={() => { resizeFrom.current = null; }}
            onPointerCancel={() => { resizeFrom.current = null; }}
            onDoubleClick={() => setSize({ width: DEFAULT_WIDTH, fieldsHeight: DEFAULT_FIELDS_HEIGHT })}
            title="Drag to resize — double-click to put it back"
            data-occurrence-resize={handle.key}
            className={`absolute ${handle.className}`}
          />
        ))}
        <span
          className={`pointer-events-none absolute bottom-0 h-3 w-3 text-zinc-400 dark:text-zinc-500 ${
            showLeft ? "left-0" : "right-0"
          }`}
        >
          <svg viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.5} className="w-3 h-3">
            <path d="M2 10h8" strokeLinecap="round" />
            <path d={showLeft ? "M2 10V6" : "M10 10V6"} strokeLinecap="round" />
          </svg>
        </span>
      </div>
    </div>
    </>,
    document.body
  );
}
