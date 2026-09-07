/**
 * sync: End-to-end CSV sync orchestrator
 *
 * Runs all CSV pipeline phases in sequence:
 *   Phase 1: fetch-redlist-species  (IUCN DB → per-taxon CSVs)
 *   Phase 2: fetch-col-xr           (CoL XR ColDP archive → NameUsage.tsv, full sync only)
 *   Phase 3: fetch-col-checklist    (curated CoL Checklist ColDP → demotion overlay, full sync only)
 *   Phase 4: build-backbone         (NameUsage.tsv → backbone.parquet + species/ + vernaculars)
 *   Phase 4b: derive-gbif-taxon-keys (Red List groups + backbone → src/config/gbif-taxon-keys.json, committed to git)
 *   Phase 5: fetch-gbif-species     (GBIF facets + backbone → per-taxon CSVs)
 *   Phase 6: match-redlist-species-to-gbif (GBIF Match API → data/mapping.csv)
 *   Phase 7: fetch-gbif-country-data (GBIF API → country occurrences per species)
 *   Phase 8: fetch-gbif-new-counts  (GBIF API → updates GBIF CSVs)
 *   Phase 8b: fetch-lumped-own-counts (GBIF API → counts for keys facets cannot emit)
 *   Phase 9: build-parquet          (CSVs → assessed/unassessed parquets + search)
 *   Phase 10: build-matching        (→ species_link.parquet, IUCN/GBIF → col_id)
 *   Phase 11: build-synonym-index   (→ synonym-index.parquet, search)
 *   Phase 11b: build-search-index   (→ name-index.parquet + rank-index.parquet, search)
 *   Phase 12: build-col-taxon-ids   (taxonomy tree + backbone.parquet → src/config/col-taxon-ids.json, committed to git)
 *   Phase 13: build-taxa-summary    (CSVs + CoL artifacts → taxa-summary.json, incl. col counts)
 *   Phase 13a: build-col-revisions  (CoL artifacts → col-revisions.json, the dashboard-wide
 *                                    "possible taxonomic revision" flag)
 *   Phase 13b: check-sync-regressions (diff per-group numbers against the live sync)
 *   Phase 14: upload-range-maps     (IUCN DB → R2, skips existing; skipped by --skip-redlist)
 *   Phase 15: upload-aoh-maps       (STAR GeoTIFFs → R2, skips existing; skipped by --skip-redlist)
 *
 * Prerequisites:
 *   1. DB connectivity to IUCN Postgres — primary is a local restore from
 *      ~/Data/RedList/*.bkp (`brew services start postgresql@16`); fallback
 *      is an SSH tunnel to the remote SIS DB on localhost:5433
 *   2. Environment variables (see .env.example)
 *
 * Usage:
 *   npx tsx scripts/sync.ts                     # Full sync, all taxa
 *   npx tsx scripts/sync.ts mammalia aves        # Specific taxa only
 *   npx tsx scripts/sync.ts --skip-redlist       # Skip every DB-dependent phase (1, 14) —
 *                                                # reuses data/redlist/*.csv from the last
 *                                                # fetch, and leaves range maps untouched.
 *                                                # Phase 15 (AOH maps) is skipped too, since
 *                                                # it depends on local STAR pipeline output
 *                                                # that only exists on the same machine. See
 *                                                # .github/workflows/weekly-sync.yml, which
 *                                                # runs on a schedule with no DB credentials
 *                                                # and no STAR data, refreshing everything
 *                                                # phase 1/14/15 feed EXCEPT those themselves.
 */

import * as fs from "fs";
import * as path from "path";
import { loadEnvFiles, SyncLogger, DATA_DIR } from "./utils";
import { run as fetchRedlistSpecies } from "./fetch-redlist-species";
import { run as fetchGbifSpecies } from "./fetch-gbif-species";
import { run as matchRedlistSpeciesToGbif } from "./match-redlist-species-to-gbif";
import { run as fetchGbifNewCounts } from "./fetch-gbif-new-counts";
import { run as fetchLumpedOwnCounts } from "./fetch-lumped-own-counts";
import { run as fetchGbifCountryData } from "./fetch-gbif-country-data";
import { run as buildTaxaSummary } from "./build-taxa-summary";
import { run as buildColRevisions } from "./build-col-revisions";
import { run as checkSyncRegressions } from "./check-sync-regressions";
import { run as buildSpeciesParquet } from "./build-parquet";
import { run as fetchColXr, resolveXrDataset, currentReleaseOnDisk, currentChecklistOnDisk, writeReleaseMetadata } from "./fetch-col-xr";
import { run as fetchColChecklist, resolveChecklistDataset } from "./fetch-col-checklist";
import { run as buildBackbone, backboneHasCurrentColumns } from "./build-backbone";
import { run as deriveGbifTaxonKeys } from "./derive-gbif-taxon-keys";
import { run as buildMatching } from "./build-matching";
import { run as buildSynonymIndex } from "./build-synonym-index";
import { run as buildSearchIndex } from "./build-search-index";
import { run as buildColTaxonIds } from "./build-col-taxon-ids";
import { run as uploadRangeMaps } from "./upload-range-maps";
import { run as uploadAohMaps } from "./upload-aoh-maps";
import { reloadTaxonKeys } from "./taxa";

async function main() {
  loadEnvFiles();

  const args = process.argv.slice(2);
  const skipRedlist = args.includes("--skip-redlist");
  const taxa = args.filter((a) => a !== "--skip-redlist").map((a) => a.toLowerCase());
  const taxaFilter = taxa.length > 0 ? taxa : undefined;

  console.log("sync: Full CSV pipeline");
  console.log("=".repeat(60));
  console.log(`Taxa: ${taxaFilter ? taxaFilter.join(", ") : "all"}`);
  if (skipRedlist) console.log("Phases 1, 14, 15 (DB/STAR-dependent): skipped (--skip-redlist)");
  console.log();

  const startTime = Date.now();
  const logger = new SyncLogger("sync");
  let coldpDir: string | null = null;
  let checklistTsv: string | null = null;
  // Resolved before the download and written into the pin after a successful
  // build, so a failed run can't leave the pin claiming a checklist we never used.
  let checklistInfo: Awaited<ReturnType<typeof resolveChecklistDataset>> | null = null;

  try {
    logger.log("sync_start", { taxa: taxaFilter ?? "all", skipRedlist });

    // Phase 1: Red List — needs IUCN Postgres access. Skippable for schedule-driven
    // refreshes (e.g. CI, which never has DB credentials) that only need to pick up
    // new GBIF/CoL data against the existing Red List snapshot, not a fresh DB pull
    // (that's a separate, manual, ~6-monthly step). --skip-redlist also skips phases
    // 14-15 below, which need the same DB access (14) or local-only STAR data (15).
    if (!skipRedlist) {
      console.log("Phase 1: fetch-redlist-species");
      console.log("═".repeat(60));
      await fetchRedlistSpecies({ taxa: taxaFilter, logger });
    }

    // The Catalogue of Life backbone comes first: the GBIF phases resolve species
    // keys against it, because GBIF's occurrence index is keyed by CoL ids. It is
    // taxon-independent, so a partial-taxa sync reuses whatever is already built.
    if (!taxaFilter) {
      // The CoL work is keyed to the release GBIF's occurrence index runs, and
      // GBIF moves about once a month while this job runs weekly. When the
      // release has not moved, re-downloading 3.4GB to rebuild an identical
      // backbone is most of the sync's wall-clock for no change — so the archive
      // is only refetched when GBIF's release id differs from the one on disk.
      //
      // The same comparison is the re-resolution trigger: a changed id means CoL
      // has renumbered some usages, so the keys stored against the old release
      // can no longer be trusted and the GBIF phases must run again. There is no
      // notification for this; the id is the only signal.
      const wantRelease = (await resolveXrDataset()).key;
      const haveRelease = currentReleaseOnDisk();
      // The CURATED checklist moves independently of the XR — `3LR` was COL26.6 in
      // June and COL26.8 by late August, while GBIF's XR pin had not moved at all.
      // build-backbone stamps in_checklist / checklist_parent_id / checklist_name
      // from it, and those carry claims the UI shows beside links to its pages, so
      // gating solely on the XR would leave a rename displaying the old accepted
      // name next to a link to the page that now disagrees. Checked before the
      // download, since it is one metadata call against a 2 GB fetch.
      checklistInfo = await resolveChecklistDataset();
      const haveChecklist = currentChecklistOnDisk();
      const xrMoved = wantRelease !== haveRelease;
      const checklistMoved = checklistInfo.issued !== haveChecklist;
      const releaseMoved = xrMoved || checklistMoved;

      // A release pin can be current while the backbone on disk is not. The pin is
      // a checked-in file (src/config/col-release.json), so a commit that adds a
      // column to build-backbone AND records the checklist that column comes from
      // leaves every later sync reading "both pins match, nothing to rebuild" over
      // a backbone that never had the column written into it. That is exactly what
      // happened to in_checklist / checklist_parent_id / checklist_name: the
      // queries reading them shipped, the rebuild never ran, and every
      // live-drilldown breakdown answered with a Binder Error 500. The schema of
      // the file itself is therefore a rebuild trigger too — it is the one signal
      // about the backbone that cannot be out of step with the backbone.
      const backbonePath = path.join(DATA_DIR, "backbone.parquet");
      const backboneOnDisk = fs.existsSync(backbonePath);
      const schemaStale = backboneOnDisk && !(await backboneHasCurrentColumns(backbonePath));

      if (!releaseMoved && !schemaStale && backboneOnDisk) {
        console.log(`\nPhases 2-4 (CoL backbone): skipped — GBIF still indexes release ${wantRelease} and the curated checklist is still ${checklistInfo.alias}, already built.`);
      } else {
        if (haveRelease && xrMoved) {
          console.log(`\nGBIF's indexed CoL release moved: ${haveRelease} → ${wantRelease}.`);
          console.log("Species keys are renumbered between releases, so the backbone is rebuilt.");
        }
        if (checklistMoved) {
          console.log(`\nCurated checklist moved: ${haveChecklist ?? "(unpinned)"} → ${checklistInfo.issued} (${checklistInfo.alias}).`);
          console.log("in_checklist / checklist_parent_id / checklist_name come from it, so the backbone is rebuilt.");
        }
        if (schemaStale && !releaseMoved) {
          console.log("\nbackbone.parquet is missing columns build-backbone now writes, though both release pins are current.");
          console.log("The queries that read them fail outright against it, so the backbone is rebuilt.");
        }
        console.log("\nPhase 2: fetch-col-xr (CoL XR ColDP → NameUsage.tsv + Reference.tsv + VernacularName.tsv)");
        console.log("═".repeat(60));
        const coldp = await fetchColXr();
        coldpDir = coldp.dir;

        console.log("\nPhase 3: fetch-col-checklist (curated CoL Checklist → demotion overlay)");
        console.log("═".repeat(60));
        checklistTsv = await fetchColChecklist();

        console.log("\nPhase 4: build-backbone (→ backbone.parquet + species/ + vernacular-names.json)");
        console.log("═".repeat(60));
        await buildBackbone({ tsv: coldp.nameUsage, referenceTsv: coldp.reference, vernacularTsv: coldp.vernacularNames, demotionsTsv: checklistTsv });

        // Only now is the pin true. It records which release backbone.parquet was
        // built from, and it is what the skip above tests, so writing it any
        // earlier lets a failed download leave the two disagreeing — with the
        // sync skipping the rebuild from then on because the pin already claims
        // to be current.
        // Phase 4b: the group root keys are CoL ids too, and they are renumbered
        // by the same mechanism as any other usage. Between COL26.6 and 26.7 two
        // of the 74 died: Blattodea, and Rhodophyta — which is red_algae's ONLY
        // root key, so that group would lose every species it has.
        //
        // Without this the sync could not heal itself across a release: the
        // per-query guard in fetch-gbif-species would (correctly) fail the run,
        // and then keep failing every week until a human noticed and ran this
        // script by hand. Deriving here, on the same trigger that rebuilt the
        // backbone, is what makes the pin-and-rebuild design actually automatic.
        //
        // It asserts coverage and non-overlap and throws if either fails, so an
        // automated rewrite cannot quietly widen or narrow a group.
        console.log("\nPhase 4b: derive-gbif-taxon-keys (→ src/config/gbif-taxon-keys.json)");
        console.log("═".repeat(60));
        await deriveGbifTaxonKeys(true);

        // The keys were loaded when this process started, which was before the
        // file above was rewritten. Without dropping that cache, phase 5 checks
        // the PREVIOUS release's root keys against the taxonomy just built from
        // the new one, finds Rhodophyta renumbered and Blattodea gone, and fails
        // the run it exists to rescue — every Sunday, until someone ran the
        // derivation by hand. Which is the exact outcome this phase is here to
        // prevent.
        reloadTaxonKeys();

        // Only now is the pin true. It records which release backbone.parquet was
        // built from AND whose root keys are on disk, and it is what the skip
        // test above reads. Writing it any earlier lets a failure in between
        // leave a pin claiming to be current while the keys are not — and since
        // the skip then fires, the phase that would fix them never runs again.
        writeReleaseMetadata(coldp.xrDataset, checklistInfo ?? undefined);
      }

    } else {
      console.log("\nCoL backbone: skipped on a partial-taxa sync — reusing the existing build.");
    }

    // Phase 5: GBIF species — resolved against the backbone built above.
    console.log("\nPhase 5: fetch-gbif-species");
    console.log("═".repeat(60));
    await fetchGbifSpecies({ taxa: taxaFilter, logger });

    // Phase 6: Match
    console.log("\nPhase 6: match-redlist-species-to-gbif");
    console.log("═".repeat(60));
    await matchRedlistSpeciesToGbif({ logger });

    // Phase 7: GBIF country data
    console.log("\nPhase 7: fetch-gbif-country-data");
    console.log("═".repeat(60));
    await fetchGbifCountryData({ taxa: taxaFilter, logger });

    // Phase 8: New GBIF counts
    console.log("\nPhase 8: fetch-gbif-new-counts");
    console.log("═".repeat(60));
    await fetchGbifNewCounts({ taxa: taxaFilter, logger });

    // Phase 8b: species CoL treats as synonyms of another species are not shown
    // that species' counts, but they do have records of their own, and those keys
    // never appear in the facet enumeration. Counted directly here.
    // Skipped on a partial sync, like the other whole-dataset phases. This one
    // rewrites lumped-own-counts.csv in its entirety — that is deliberate, and is
    // what makes it idempotent — but with a taxa filter it would rewrite the file
    // containing ONLY those taxa, deleting every other group's rows. Phase 9 is
    // not filtered, so it would immediately consume the truncated file and drop
    // every other lumped species back to "no data", which is exactly the defect
    // this phase exists to fix, reintroduced through the partial-sync door.
    if (!taxaFilter) {
      console.log("\nPhase 8b: fetch-lumped-own-counts");
      console.log("═".repeat(60));
      await fetchLumpedOwnCounts({ logger });
    } else {
      console.log("\nPhase 8b (lumped own counts): skipped on a partial-taxa sync — it rewrites the");
      console.log("whole file, so running it filtered would delete the other taxa's rows.");
    }

    // Phase 9: Build DuckDB read-layer parquets (#261) — also powers search.
    console.log("\nPhase 9: build-parquet");
    console.log("═".repeat(60));
    await buildSpeciesParquet();

    // Phases 10-12: the CoL joins (#271). Matching needs the complete
    // assessed/unassessed parquets, so these run only on a FULL sync; a
    // partial-taxa sync leaves the existing artifacts in place.
    if (!taxaFilter) {
      console.log("\nPhase 10: build-matching (→ species_link.parquet)");
      console.log("═".repeat(60));
      await buildMatching();

      console.log("\nPhase 11: build-synonym-index (→ synonym-index.parquet, search)");
      console.log("═".repeat(60));
      await buildSynonymIndex();

      // The other half of search's read layer: the name-sorted indexes over the fast
      // path (assessed ∪ GBIF-observed) and over the higher-rank taxon names, so a
      // typeahead prefix prunes to a row group instead of scanning both species
      // parquets. Needs species_link (phase 10) for the col_ids it bakes in, so it
      // can't move up next to build-parquet.
      console.log("\nPhase 11b: build-search-index (→ name-index.parquet + rank-index.parquet)");
      console.log("═".repeat(60));
      await buildSearchIndex();

      // Small + derived from committed source (the taxonomy tree), so this writes to
      // src/config/ and gets committed to git, unlike the R2-published data/ outputs
      // above — re-run whenever a node's filter changes, not just on every data sync.
      console.log("\nPhase 12: build-col-taxon-ids (→ src/config/col-taxon-ids.json)");
      console.log("═".repeat(60));
      await buildColTaxonIds();
    } else {
      console.log("\nPhases 10-12 (CoL joins): skipped on a partial-taxa sync — run a full sync to refresh.");
    }

    // Phase 13: Build taxa summary LAST — it reads the CoL artifacts (species/ +
    // species_link) to add per-group col_described / col_ne counts to taxa-summary.json.
    console.log("\nPhase 13: build-taxa-summary");
    console.log("═".repeat(60));
    await buildTaxaSummary();

    // Phase 13a: the same no-1:1-CoL-match diagnostic Phase 13 computes per SSC
    // group, run once unscoped so the main dashboard can flag and filter by it,
    // plus the split signal from the same split_candidates table. Reads the same
    // CoL artifacts, so it belongs here rather than earlier.
    console.log("\nPhase 13a: build-col-revisions");
    console.log("═".repeat(60));
    await buildColRevisions();

    // A taxonomy migration moves numbers everywhere, which makes it exactly the
    // situation where a group quietly collapsing hides in the noise. Reported
    // rather than fatal — deciding whether a move is the intended one needs a
    // person — but reported unconditionally, so nobody has to think to look.
    let regressionCheckError: Error | undefined;
    console.log("\nChecking for per-group regressions against the live sync");
    console.log("═".repeat(60));
    // Loud, but not fatal to the phases after it.
    //
    // Two failure modes pull in opposite directions. This ran once inside a
    // try/catch that downgraded failure to a warning, and spent every sync
    // printing "skipped" because it could not reach its baseline — a check that
    // cannot run must not read as a pass. But letting it throw kills the run at
    // phase 13b, after several hours of API calls, and takes phases 14-15 with
    // it. The baseline needs `origin/main`, which a shallow CI checkout may not
    // have fetched, so that is a real scenario rather than a hypothetical.
    //
    // So a failure here is recorded and re-raised once the remaining phases have
    // run: the sync still exits non-zero and says why, having finished its work.
    try {
      // The findings are written to a file as well as the log. The log is four
      // hours long and nobody reads it, so a phase whose entire purpose is "no
      // change goes unseen" was reporting into a void — the weekly job would
      // print "corals lost 45% of their occurrences", exit 0, upload, and open a
      // PR whose body said only "review the diff". The workflow puts this file
      // into that PR body.
      const { regressions, drifts } = await checkSyncRegressions();
      const driftLines = drifts.length === 0 ? [] : [
        "",
        "Systematic drift (each group moved the same way, below the per-group threshold):",
        "",
        ...drifts.map(
          (d) =>
            `- ${d.metric}: ${d.before.toLocaleString()} → ${d.after.toLocaleString()} ` +
            `(${(d.pctChange * 100).toFixed(2)}%, down in ${d.groupsDown} groups, up in ${d.groupsUp})`
        ),
      ];
      const summary = (regressions.length === 0
        ? "No material per-group regressions against the live sync."
        : [
            `${regressions.length} material regression(s) against the live sync:`,
            "",
            ...regressions.map(
              (r) =>
                `- ${r.taxonGroup} — ${r.metric}: ${r.before.toLocaleString()} → ` +
                `${r.after.toLocaleString()} (${(r.pctChange * 100).toFixed(1)}%)`
            ),
          ].join("\n")) + driftLines.join("\n");
      fs.writeFileSync(path.join(DATA_DIR, "..", "sync-regressions.md"), summary + "\n");
    } catch (err) {
      regressionCheckError = err instanceof Error ? err : new Error(String(err));
      console.error("\n*** REGRESSION CHECK FAILED TO RUN ***");
      console.error(`    ${regressionCheckError.message}`);
      console.error("    The sync continues, and will exit non-zero. This is NOT a pass.");
    }

    // Phases 14-15: uploadRangeMaps needs the same IUCN Postgres access as phase 1;
    // uploadAohMaps needs local STAR pipeline output that only exists on this machine.
    // Neither is reachable from CI, so both are skipped alongside phase 1.
    if (!skipRedlist) {
      console.log("\nPhase 14: upload-range-maps");
      console.log("═".repeat(60));
      await uploadRangeMaps({ taxa: taxaFilter, logger });

      console.log("\nPhase 15: upload-aoh-maps");
      console.log("═".repeat(60));
      await uploadAohMaps({ taxa: taxaFilter, logger });
    }

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(0);
    const minutes = Math.floor(Number(elapsed) / 60);
    const seconds = Number(elapsed) % 60;

    logger.log("sync_complete", { duration_seconds: Number(elapsed) });

    console.log("\n" + "=".repeat(60));
    console.log(`Sync complete: ${minutes}m ${seconds}s`);
    console.log("");
    console.log("Next steps:");
    console.log("  npm run diff-data-vs-r2     # see what changed vs the live R2 sync");
    console.log("  npm run upload-data-to-r2   # publish this sync to R2");

    // Deferred from phase 13b so the phases after it still ran. The data on disk
    // is complete and usable; what is missing is the assurance that it does not
    // quietly differ from what production serves, and that is not something to
    // let a zero exit code imply.
    if (regressionCheckError) {
      console.error("\nThe regression check never ran, so this sync is UNVERIFIED against the live data.");
      throw regressionCheckError;
    }
  } finally {
    // Drop the temp ColDP TSVs (XR ~3.4GB + curated checklist) so they're never swept
    // into the R2 upload.
    if (coldpDir) fs.rmSync(coldpDir, { recursive: true, force: true });
    if (checklistTsv) fs.rmSync(path.dirname(checklistTsv), { recursive: true, force: true });
    logger.close();
  }
}

const isDirectRun = process.argv[1]?.endsWith("sync.ts") || process.argv[1]?.endsWith("sync.js");
if (isDirectRun) {
  main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
