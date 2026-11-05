# The build

What happens between a sync landing in R2 and a page on the site. The sync ([sync.md](sync.md)) decides the numbers; the build only packages them for the deployed code. Scripts are in [`app/scripts/build/`](../app/scripts/build).

## Sync or build?

| | Sync | Build |
|---|---|---|
| Runs | monthly, by hand | every deploy (Vercel), or `npm run build` locally |
| Where | your machine (GBIF mirror, Docker, the Red List database) | Vercel |
| Reads | the Red List database, the GBIF snapshot, Catalogue of Life | the sync named in `app/latest-sync.txt`, and the repo's code |
| Writes | a new, immutable `syncs/<timestamp>/` in R2 | `app/data/` and static files inside one deployment |
| Changes a number? | yes: every count and link is decided here | never: it reshapes the sync's rows for the browser |
| Goes live when | its `latest-sync.txt` bump merges to `main` | the deployment does |

So a code change rebuilds with the same data, and a data change is a one-line pointer change that rebuilds the same code. Neither can surprise the other.

## Steps

`npm run build` runs `prebuild` first (`app/package.json`), in this order:

1. **`fetch-data-from-r2.ts`** reads `app/latest-sync.txt` and downloads every file under `syncs/<timestamp>/` into `app/data/`. Needs the R2 credentials (`R2_*` in `.env.local`, and in Vercel's environment).
2. **`fetch-duckdb-ext.ts`** vendors DuckDB's `httpfs` extension for Linux into `app/duckdb-ext/`, so a cold function never downloads it at request time.
3. **`build-species-lists.ts`** writes the rows `/api/redlist/species` would return, per taxon group, as brotli-compressed column files in `app/public/species-lists/<sync>/`. The browser filters deeper drilldowns locally.
4. **`build-search-shards.ts`** writes the search dropdown's results, sharded by prefix, to `app/public/search-shards/<sync>/`.
5. **`build-tree-children.ts`** writes every unscoped expand of the taxonomy tree to `app/public/species-lists/<sync>/tree/`.

Then `next build`.

Steps 3 to 5 run at build time rather than in the sync because some of what they write comes from the repo, not the sync: display names, taxonomy constants, the CoL-revision overrides, and `outdated` as of the build date. Building them with the deployed code keeps the two in step. Each file is produced by the same function the live API route uses, and the sync timestamp in the path makes every URL immutable.

## Checking the pre-built files

Each pre-built file replaces a live route, and has a check that proves the two still agree, run by hand after the matching build step:

```bash
npx tsx scripts/build/check-species-lists.ts [--quick]
npx tsx scripts/build/check-search-shards.ts
npx tsx scripts/build/check-tree-children.ts [--quick]
```

Run them after changing the route, the row format, or the taxonomy code.

## At runtime

API routes query the sync's parquets with DuckDB: the local `app/data/` copy when it's there (development), otherwise R2 over `httpfs`, since the deployed functions leave the large parquets out of their bundle (`next.config.ts`; `species-duckdb.ts` picks the source). Smaller files, the JSON summaries among them, are read from the deployment's own `app/data/`. Everything else on a page comes from live APIs (GBIF, Species+, OpenAlex and the others in the README).

## Known wart

Nine files in `app/data/` are both committed to git and published with each sync (`taxa-summary.json`, `col-revisions.json`, the CoL match helpers and others), so every data PR carries their diff and the repo copy can drift from the sync's. They should come from R2 only; that change is planned with the move of the app onto the sync's core tables.
