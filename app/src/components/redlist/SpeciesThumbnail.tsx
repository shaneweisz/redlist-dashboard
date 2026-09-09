"use client";

/**
 * A species' photo, small, with a bigger one on hover.
 *
 * Lifted out of NearbySpeciesPanel when the assessment-text search wanted the
 * same thing: a list of species reads far better with faces on it, and the
 * rules for fetching them politely (only what is on screen, four at a time,
 * one request per name however many rows ask) are worth having in one place.
 * The fetching itself lives in lib/redlist/inat-thumbnail.ts.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import TaxaIcon from "@/components/TaxaIcon";
import { cachedThumbnail, loadThumbnail, type InatThumbnail } from "@/lib/redlist/inat-thumbnail";

/**
 * A species' iNaturalist photo, fetched when its row is scrolled to.
 *
 * The same thumbnail the dashboard's species table shows, from the same route
 * and now the same cache — a neighbour you recognise on sight is worth more
 * than the binomial beside it, and this list is full of names an assessor
 * works next to without ever having seen.
 *
 * Only when the row comes into view: the list is not paginated, so a 50 km
 * radius in a well-collected place is a hundred rows, and asking iNaturalist
 * for a hundred photos to show the twelve on screen is most of a request
 * budget spent on nothing.
 */
export function SpeciesThumbnail({ name, taxonGroup }: { name: string; taxonGroup: string }) {
  const [image, setImage] = useState<InatThumbnail | undefined>(() => cachedThumbnail(name));
  const [seen, setSeen] = useState(() => cachedThumbnail(name) !== undefined);
  const box = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (seen || !box.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setSeen(true);
      },
      // A little ahead of the scroll, so a row is usually holding its photo by
      // the time it arrives rather than filling in under the reader.
      { rootMargin: "200px" }
    );
    observer.observe(box.current);
    return () => observer.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen || image !== undefined) return;
    let live = true;
    loadThumbnail(name).then((next) => {
      if (live) setImage(next);
    });
    return () => {
      live = false;
    };
  }, [seen, image, name]);

  /**
   * Where to hang the big version, once it is being pointed at.
   *
   * Fixed to the viewport and rendered through a portal, because the row it
   * belongs to is inside a panel that scrolls and clips: anything grown in
   * place is cut off at the panel's edge, which is exactly where a 20px
   * thumbnail sits. Placed left of the row and flipped above the pointer near
   * the bottom of the window, so it never opens off screen.
   */
  const [preview, setPreview] = useState<{ top: number; left: number } | null>(null);
  const show = useCallback((e: React.MouseEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const size = 176;
    setPreview({
      top: Math.max(8, Math.min(window.innerHeight - size - 8, r.top - size / 2 + r.height / 2)),
      left: Math.max(8, r.left - size - 10),
    });
  }, []);

  return (
    <span ref={box} className="flex h-5 w-5 shrink-0 items-center justify-center">
      {image?.squareUrl ? (
        <>
        <img
          src={image.squareUrl}
          alt=""
          title={name}
          onMouseEnter={show}
          onMouseLeave={() => setPreview(null)}
          className="h-5 w-5 cursor-zoom-in rounded object-cover hover:ring-2 hover:ring-blue-400"
          loading="lazy"
        />
        {preview &&
          createPortal(
            <span
              style={{ position: "fixed", top: preview.top, left: preview.left, zIndex: 10050 }}
              className="pointer-events-none block rounded-lg border border-zinc-200 bg-white p-1 shadow-lg dark:border-zinc-700 dark:bg-zinc-800"
            >
              <img
                src={image.mediumUrl ?? image.squareUrl}
                alt={name}
                className="block h-40 w-40 rounded object-cover"
              />
              <span className="block max-w-40 truncate pt-0.5 text-center text-[10px] italic text-zinc-500 dark:text-zinc-400">
                {name}
              </span>
            </span>,
            document.body
          )}
        </>
      ) : (
        // The taxon's own mark while the photo is coming, and instead of it for
        // a species iNaturalist has no photo of — a grey square that never
        // resolves reads as something broken.
        <span className="text-zinc-300 dark:text-zinc-600">
          <TaxaIcon taxonId={taxonGroup} size={13} />
        </span>
      )}
    </span>
  );
}
