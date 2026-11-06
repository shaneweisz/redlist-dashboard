"use client";

import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/**
 * Wraps a photo with its credit, which the photo's licence requires wherever
 * it's shown: a small © in the photo's bottom-right corner (on hover, or
 * always on touchscreens, which have no hover) that opens the credit text
 * when clicked. Clicking elsewhere or pressing Escape closes it.
 *
 * Hover handlers for the photo (e.g. an enlarged preview) go on this wrapper
 * rather than the <img>, so moving onto the © doesn't count as leaving it.
 */
export default function PhotoCredit({
  credit,
  children,
  className = "",
  iconSize = 16,
  onMouseEnter,
  onMouseLeave,
}: {
  credit: string | null | undefined;
  children: React.ReactNode;
  className?: string;
  /** Diameter of the © badge, in px. Smaller for tiny thumbnails. */
  iconSize?: number;
  onMouseEnter?: (e: React.MouseEvent<HTMLSpanElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLSpanElement>) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; left: number; maxWidth: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!buttonRef.current?.contains(t) && !popRef.current?.contains(t)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // Fixed-position popover: close rather than drift away from its photo.
    const onScroll = () => setOpen(false);
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  if (!credit) {
    return (
      <span className={`relative inline-block ${className}`} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}>
        {children}
      </span>
    );
  }

  return (
    <span
      className={`group/credit relative inline-block ${className}`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {children}
      <button
        ref={buttonRef}
        type="button"
        aria-label="Photo credit"
        aria-expanded={open}
        onClick={(e) => {
          // The photo often sits inside a clickable row: don't trigger it.
          e.stopPropagation();
          e.preventDefault();
          // Opening the credit replaces any hover preview of the photo.
          onMouseLeave?.(e as unknown as React.MouseEvent<HTMLSpanElement>);
          const r = e.currentTarget.getBoundingClientRect();
          // Starts at the ©'s left edge and runs right, kept inside the
          // window; below the ©, or above it near the bottom of the screen.
          const left = Math.max(8, Math.min(r.left, window.innerWidth - 264));
          const maxWidth = Math.min(256, window.innerWidth - left - 8);
          setPos(r.bottom + 80 > window.innerHeight
            ? { bottom: window.innerHeight - r.top + 4, left, maxWidth }
            : { top: r.bottom + 4, left, maxWidth });
          setOpen((o) => !o);
        }}
        style={{ width: iconSize, height: iconSize, fontSize: Math.round(iconSize * 0.7) }}
        className={`absolute bottom-0.5 right-0.5 flex items-center justify-center rounded-full bg-black/60 text-white leading-none cursor-pointer transition-opacity hover:bg-black/80 ${
          open ? "opacity-100" : "opacity-0 group-hover/credit:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100"
        }`}
      >
        ©
      </button>
      {open && pos && typeof document !== "undefined" && createPortal(
        <span
          ref={popRef}
          role="tooltip"
          style={{ position: "fixed", top: pos.top, bottom: pos.bottom, left: pos.left, maxWidth: pos.maxWidth, zIndex: 10060 }}
          className="block w-max rounded-lg bg-zinc-800 dark:bg-zinc-700 px-2.5 py-1.5 text-[11px] leading-snug text-white shadow-lg"
        >
          {credit}
        </span>,
        document.body
      )}
    </span>
  );
}
