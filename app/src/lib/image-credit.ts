/**
 * Photo credits. Most of the photos the dashboard shows are Creative Commons
 * licensed (iNaturalist, GBIF occurrence media, EOL), and CC licences require
 * naming the author and the licence wherever the photo is shown.
 */

/** Format CC license URL to short label, e.g. ".../by-nc/4.0/legalcode" -> "CC BY-NC 4.0" */
export function formatLicense(url: string): string {
  const match = url.match(/creativecommons\.org\/licenses\/([^/]+)\/([^/]+)/);
  if (match) return `CC ${match[1].toUpperCase()} ${match[2]}`;
  if (/creativecommons\.org\/publicdomain\/zero/.test(url)) return "CC0";
  return url;
}

/**
 * Credit line for a GBIF occurrence image: "© Creator · CC BY 4.0". Falls back
 * to the rights holder when the record names no creator. null when the record
 * carries neither, so callers can leave the line out.
 */
export function gbifImageCredit(image: { creator?: string; rightsHolder?: string; license?: string }): string | null {
  const who = image.creator || image.rightsHolder;
  const licence = image.license ? formatLicense(image.license) : null;
  if (!who && !licence) return null;
  return [who ? `© ${who}` : null, licence].filter(Boolean).join(" · ");
}
