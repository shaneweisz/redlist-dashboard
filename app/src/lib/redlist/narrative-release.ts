/**
 * Which Red List release the searchable narratives were built from.
 *
 * The narratives are not sync data. A sync runs weekly and carries numbers
 * that move weekly; the assessment text moves when the Red List publishes,
 * twice a year. Keeping the two parquets (~170 MB) inside `syncs/<timestamp>/`
 * would copy them into the bucket again every Sunday to say the same thing —
 * so they live at `narratives/<release>/` instead, written once per release
 * and read by every sync until the next one.
 *
 * Bumping this constant is what points production at a newly built pair:
 *   npm run build-narratives        # against the restored release database
 *   npm run upload-narratives-to-r2 # writes narratives/<release>/
 *   …then change the line below, in the same PR.
 */
export const NARRATIVE_RELEASE = "2026-1";

/** Where a narrative parquet lives in the data bucket, for this release. */
export function narrativeKey(name: string): string {
  return `narratives/${NARRATIVE_RELEASE}/${name}`;
}
