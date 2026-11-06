/**
 * Undo URLSearchParams' over-encoding of characters a query string may carry bare.
 *
 * `toString()` serializes as application/x-www-form-urlencoded, which escapes
 * everything outside `*-._` and alphanumerics. RFC 3986 is looser for the query
 * component — `query = *( pchar / "/" / "?" )` where `pchar` includes `unreserved`
 * (which contains `~`), the sub-delims (which contain `,`) and `:` — so `%7E`/`%3A`/
 * `%2C` are pure noise. Turning `?taxa=pl-flowering_plants%7Eorder%3Adioscoreales`
 * into `?taxa=flowering_plants~dioscoreales` is most of why the URLs read badly.
 *
 * Deliberately a STATIC escape map, never decodeURIComponent per match: `%C3` is
 * half of a multi-byte UTF-8 sequence and decoding it alone throws URIError, so a
 * species named "Müller's shrew" would crash the URL sync. Substituting fixed
 * three-character escapes can't misfire that way.
 *
 * Only these three. `%2B` in particular must stay encoded — a bare `+` in a query
 * string means a space, so decoding it would silently corrupt any value containing
 * a literal plus. `&`, `=` and `#` are delimiters and stay encoded for the same
 * reason. Reading needs no counterpart: URLSearchParams already parses bare `~`,
 * `:` and `,` correctly, so links written before this change are unaffected.
 *
 * Lives here rather than in useFilterParams because page.tsx and TaxaSummary
 * build URLs of their own and need the same treatment.
 */
const QS_BARE_ESCAPES: Record<string, string> = { "%7E": "~", "%3A": ":", "%2C": "," };
const QS_BARE_ESCAPE_RE = new RegExp(Object.keys(QS_BARE_ESCAPES).join("|"), "gi");

export const prettifyQs = (qs: string): string =>
  qs.replace(QS_BARE_ESCAPE_RE, (m) => QS_BARE_ESCAPES[m.toUpperCase()]);
