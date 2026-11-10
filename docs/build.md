# The build

What happens between a sync landing in R2 and a page on the site. The sync ([sync.md](sync.md)) decides the numbers; the build only packages them for the deployed code. Scripts are in [`app/scripts/build/`](../app/scripts/build). What the deployed app then reads, route by route, is [app.md](app.md).

## Sync or build?

| | Sync | Build |
|---|---|---|
| Runs | monthly, by hand | every deploy (Vercel), or `npm run build` locally |
| Where | your machine (GBIF mirror, Docker, the Red List database) | Vercel |
| Reads | the Red List database, the GBIF snapshot, Catalogue of Life | the sync named in `app/latest-sync.txt`, and the repo's code |
| Writes | a new, immutable `syncs/<timestamp>/` in R2 | `app/data/sync/`, and the static files in `app/public/prebuilt/<sync>/` |
| Changes a number? | yes: every count and link is decided here | never: it reshapes the sync's rows for the browser |
| Goes live when | its `latest-sync.txt` bump merges to `main` | the deployment does |

So a code change rebuilds with the same data, and a data change is a one-line pointer change that rebuilds the same code. Neither can surprise the other.

## Where things are

```
app/data/sync/              what the build reads: one sync, as src/lib/data/sync-layout.ts lays it out
app/data/narratives/        the searchable narratives, per Red List release (local copy; production reads R2)
app/data/overlays/          map layers (local copy; production reads the maps bucket)
app/public/prebuilt/<sync>/ what the build writes: species-lists/, search-shards/, tree/
```

The pre-built files must be under `public/`: that is what Next serves as static files, from the CDN. The sync timestamp in their path makes every URL immutable, so a new sync is new URLs.

## Steps

`npm run build` runs `prebuild` first (`app/package.json`), in this order:

1. **`fetch-data-from-r2.ts`** reads `app/latest-sync.txt` and downloads every file under `syncs/<timestamp>/` into `app/data/sync/`, emptied first so it holds exactly that sync. Needs the R2 credentials (`R2_*` in `.env.local`, and in Vercel's environment).
2. **`fetch-duckdb-ext.ts`** vendors DuckDB's `httpfs` extension for Linux into `app/duckdb-ext/`, so a cold function never downloads it at request time.
3. **`build-species-lists.ts`** writes the rows `/api/redlist/species` would return, per taxon group, as brotli-compressed column files in `app/public/prebuilt/<sync>/species-lists/`. The browser filters deeper drilldowns locally.
4. **`build-search-shards.ts`** writes the search dropdown's results, sharded by prefix, to `app/public/prebuilt/<sync>/search-shards/`.
5. **`build-tree-children.ts`** writes every unscoped expand of the taxonomy tree to `app/public/prebuilt/<sync>/tree/`.

Steps 3 to 5 run through **`build-prebuilt.ts`**, which reuses them between deploys (below).

Then `next build`. It doesn't type-check (`typescript.ignoreBuildErrors` in `next.config.ts`); CI's `typecheck` job does, on every PR.

Steps 3 to 5 run at build time rather than in the sync because some of what they write comes from the repo, not the sync: display names, taxonomy constants, the CoL-revision overrides. Building them with the deployed code keeps the two in step. `outdated` is as of the sync's date, not the build's. Each file is produced by the same function the live API route uses, and the sync timestamp in the path makes every URL immutable.

### Reusing them between deploys

They were three-quarters of a deploy (3.6 of 4.8 minutes on Vercel's 3 cores; search shards alone 2.3), yet they change only when the sync or the code that builds them does. `build-prebuilt.ts` keeps the last set in `app/.next/cache/prebuilt/`, which Vercel restores at the start of every build, under a key made of the sync name and a hash of every source file the three builders import (followed through relative and `@/` imports) plus `package-lock.json`. A hit copies the set into `public/prebuilt/<sync>/`; a miss builds it and replaces the cached one. A data PR always misses (new sync name), as does any PR touching code the builders import. `--no-cache` forces a rebuild.

## Checking the pre-built files

Each pre-built file replaces a live route, and has a check that proves the two still agree, run by hand after the matching build step:

```bash
npx tsx scripts/build/check-species-lists.ts [--quick]
npx tsx scripts/build/check-search-shards.ts
npx tsx scripts/build/check-tree-children.ts [--quick]
```

Run them after changing the route, the row format, or the taxonomy code.

## At runtime

API routes query the sync's parquets with DuckDB: the local `app/data/sync/` copy when it's there (development), otherwise R2 over `httpfs`, since the deployed functions leave the large parquets out of their bundle (`next.config.ts`; `species-duckdb.ts` picks the source). Smaller files, the JSON summaries among them, are read from the deployment's own `app/data/sync/`. Everything else on a page comes from live APIs (GBIF, Species+, OpenAlex and the others in the README).

## What git holds

None of a sync's data. `app/latest-sync.txt` is the only pointer to it, so a data PR is that one line, plus `app/src/config/` when the sync moves to a new CoL release (the release label and taxon ids, which the code imports). Tests that need real data skip in CI and run in the sync's checks ([sync.md](sync.md#checks)).
