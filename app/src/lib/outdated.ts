/**
 * Shared "is this assessment outdated" logic. Has zero server-only imports
 * (no fs/path) so it's safe to use from both server code (species-store.ts)
 * and client components (RedListView.tsx).
 */

const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;
export const OUTDATED_THRESHOLD_YEARS = 10;

/**
 * Is an assessment outdated? True if more than OUTDATED_THRESHOLD_YEARS have
 * elapsed since assessment_date (precise elapsed time, not calendar-year
 * subtraction — see outdatedCutoffDate for the matching "as of" cutoff), or
 * if assessment_date is missing/unparseable.
 */
export function isOutdated(assessmentDate: string | null, now: Date = new Date()): boolean {
  if (!assessmentDate) return true; // No date → treat as outdated
  const date = new Date(assessmentDate);
  if (isNaN(date.getTime())) return true;
  const yearsSince = (now.getTime() - date.getTime()) / MS_PER_YEAR;
  return yearsSince > OUTDATED_THRESHOLD_YEARS;
}

/** The cutoff date: assessments on or before this date are outdated. For tooltips. */
export function outdatedCutoffDate(now: Date = new Date()): Date {
  return new Date(now.getTime() - OUTDATED_THRESHOLD_YEARS * MS_PER_YEAR);
}
