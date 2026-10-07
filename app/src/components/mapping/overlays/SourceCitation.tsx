"use client";

/**
 * Where an overlay's data comes from, as a citation you can click.
 *
 * These rows each carried an ⓘ linking to the source, which said that a source
 * existed and nothing about what it was. A layer drawn over a species' range
 * is evidence, and evidence in an assessment gets attributed — so the row
 * names the paper or the database instead, in the bracketed form a reader
 * already knows how to skim past or follow.
 *
 * It links where the ⓘ linked, and opens the same way: these sit inside a
 * <label>, so a plain anchor click would be forwarded to the checkbox and
 * toggle the layer on the way out.
 */
export default function SourceCitation({ href, cite, title }: { href: string; cite: string; title: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={title}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        window.open(href, "_blank", "noopener,noreferrer");
      }}
      className="shrink-0 italic tabular-nums text-[10px] text-zinc-400 hover:text-zinc-600 hover:underline dark:text-zinc-500 dark:hover:text-zinc-300"
    >
      [{cite}]
    </a>
  );
}
