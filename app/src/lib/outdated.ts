/**
 * Shared "is this assessment outdated" logic. Has zero server-only imports
 * (no fs/path) so it's safe to use from both server code (species-store.ts)
 * and client components (RedListView.tsx).
 */

export const OUTDATED_THRESHOLD_YEARS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** UTC midnight of a date: everything here counts whole calendar days. */
function utcDay(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The same calendar day `n` years on, in UTC (29 Feb rolls to 1 Mar). */
function addYears(dayMs: number, n: number): number {
  const d = new Date(dayMs);
  return Date.UTC(d.getUTCFullYear() + n, d.getUTCMonth(), d.getUTCDate());
}

/**
 * Years since a date, exact to the day: the whole part is completed calendar
 * years (anniversaries reached), the fraction is how far through the current
 * year it is. Assessed 7 Nov 2016, on 7 Nov 2026 → exactly 10. Unlike an
 * average 365.25-day year, this never puts a species on the wrong side of an
 * anniversary. NaN for an unparseable date.
 */
export function yearsSince(date: string | Date, now: Date = new Date()): number {
  const from = utcDay(new Date(date)), to = utcDay(now);
  if (isNaN(from)) return NaN;
  let full = new Date(to).getUTCFullYear() - new Date(from).getUTCFullYear();
  if (addYears(from, full) > to) full--;
  const last = addYears(from, full), next = addYears(from, full + 1);
  return full + (to - last) / (next - last);
}

/** Whole years and months since a date, by the calendar: "10 years, 3 months". */
export function yearsMonthsSince(date: string | Date, now: Date = new Date()): { years: number; months: number } {
  const from = new Date(utcDay(new Date(date))), to = new Date(utcDay(now));
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months--;
  months = Math.max(0, months);
  return { years: Math.floor(months / 12), months: months % 12 };
}

/**
 * Is an assessment outdated? True if more than OUTDATED_THRESHOLD_YEARS have
 * passed since assessment_date, to the day: exactly 10 years ago today is not
 * outdated, the day before is (see outdatedCutoffDate for the matching
 * cutoff). Also true if assessment_date is missing or unparseable.
 */
export function isOutdated(assessmentDate: string | null, now: Date = new Date()): boolean {
  if (!assessmentDate) return true; // No date → treat as outdated
  const y = yearsSince(assessmentDate, now);
  if (isNaN(y)) return true;
  return y > OUTDATED_THRESHOLD_YEARS;
}

/** The cutoff date: assessments on or before this date are outdated (10 calendar years ago, less a day). */
export function outdatedCutoffDate(now: Date = new Date()): Date {
  return new Date(addYears(utcDay(now), -OUTDATED_THRESHOLD_YEARS) - DAY_MS);
}
