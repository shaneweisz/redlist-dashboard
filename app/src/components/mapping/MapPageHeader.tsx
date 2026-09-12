"use client";

import Link from "next/link";
import { FaGlobeAmericas } from "react-icons/fa";
import { useBrand } from "@/components/BrandProvider";
import { ThemeToggle } from "@/components/ThemeToggle";
import { AuthStatus } from "@/components/AuthStatus";

/**
 * The site's own header, on a fullscreen map page.
 *
 * These pages are the map and nothing else, and for a while that included
 * dropping the header — which left a shared link landing somewhere that gave no
 * sign of what site it belonged to, and no way to sign in from where you'd
 * arrived. It's the dashboard's header row compressed to one line: the brand on
 * the left, what this page is in the middle, the theme and account controls on
 * the right. The subtitle and the species search stay behind on the dashboard,
 * where there's room for them.
 *
 * Written once for the occurrence map and shared with the near-here view, so
 * two fullscreen maps don't drift into two different-looking headers.
 */
export default function MapPageHeader({
  title,
  subtitle,
  /** Set for a scientific name, which is italic wherever it is printed. */
  italicTitle = false,
}: {
  title: string;
  subtitle?: string | null;
  italicTitle?: boolean;
}) {
  const brand = useBrand();
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 border-b border-zinc-200 dark:border-zinc-700 shrink-0">
      <Link
        href="/"
        title={`Back to ${brand.title}`}
        className="flex items-center gap-1.5 shrink-0 hover:opacity-80 transition-opacity"
      >
        {brand.showGlobe && (
          <FaGlobeAmericas className="shrink-0 text-lg text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        )}
        <span className="text-sm font-bold text-zinc-900 dark:text-zinc-100">{brand.title}</span>
      </Link>
      <span className="text-zinc-300 dark:text-zinc-600 shrink-0">|</span>
      <span
        className={`text-sm font-medium text-zinc-800 dark:text-zinc-100 truncate${italicTitle ? " italic" : ""}`}
      >
        {title}
      </span>
      {subtitle && (
        <span className="text-xs text-zinc-500 dark:text-zinc-400 truncate">{subtitle}</span>
      )}
      <div className="ml-auto flex items-center gap-2 shrink-0">
        <ThemeToggle />
        <AuthStatus />
      </div>
    </div>
  );
}
