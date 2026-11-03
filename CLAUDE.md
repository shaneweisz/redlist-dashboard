# Working conventions for this repo

These apply to anyone (or any agent) opening a PR against redlist-dashboard, not just a specific assistant's preferences.

## Keep the PR description current

Treat the PR body as a living summary, not a one-time snapshot. Every time a commit changes what the PR does, what it fixes, or what's been verified, update the body's Summary/Test-plan sections to match (`gh pr edit --body ...`) — don't just leave the original description stale with fixes trailing below in comments. A reviewer should be able to read the PR body alone and get the current, complete picture.

## Always verify UI changes in a real browser

For any UI-facing change, complete an actual browser drive-through (navigate, interact, screenshot) before calling it done. Playwright is already an `app/` devDependency. If a view comes up empty or full of zeros, first check whether the precomputed `app/data/*.json` behind it is stale and needs regenerating (see the README's data sync pipeline, e.g. `npx tsx scripts/build-taxa-summary.ts`) before assuming the UI is broken.

Passing typecheck, lint, tests or API checks is not a substitute. If the browser check can't run, fix whatever's stopping it or ask. If it's skipped, say plainly that the change wasn't checked in a browser.

## Use a git worktree for each new piece of work

Start a new git worktree (a dedicated branch checked out to its own directory) for each new, substantial feature or fix, rather than branching in place in the main checkout — this keeps unrelated in-progress work isolated and lets multiple pieces of work proceed in parallel without one clobbering another's uncommitted state. Not worth it for a one-line fix or a quick doc change — use judgment on "substantial."

## Data resyncs: uploading to R2 is safe, merging `latest-sync.txt` is what goes live

`npm run upload-data-to-r2` (`scripts/upload-data-to-r2.ts`) pushes `app/data/` to a timestamped `syncs/<timestamp>/` prefix in the `dashboard-data` R2 bucket and updates the repo-tracked `app/latest-sync.txt` pointer file locally — but production only starts reading the new sync once that `latest-sync.txt` change is committed, pushed, and merged to main (prod's build/deploy pipeline is what actually fetches from R2 via `fetch-data-from-r2.ts`, keyed off whatever `latest-sync.txt` says on main). So it's safe to run the upload from a feature branch/worktree at any point once local data looks right — the upload itself is inert for prod until the `latest-sync.txt` bump lands on main via a normal PR merge. No need to hold off on uploading just because a PR is still in review.

## PR screenshots: Backblaze B2, not the repo

Don't commit screenshots to the repo (`docs/pr-screenshots/` or anywhere else) — images committed to git stay in the object history forever, even after being deleted in a later commit, so screenshot-heavy PRs become a permanent, un-reclaimable addition to repo/clone size.

Instead:
1. Resize to ~1000px wide (`sips --resampleWidth 1000 <file> --out <file>`), or crop to the part of the page that matters — legible in a PR body, meaningfully smaller than a raw viewport capture.
2. Upload to the public Backblaze B2 bucket named by `B2_BUCKET` via its S3-compatible API (`@aws-sdk/client-s3`, already a dependency), using `B2_KEY_ID`/`B2_APPLICATION_KEY`/`B2_ENDPOINT` from `app/.env.local` — `endpoint: B2_ENDPOINT`, `region` = the `us-east-005`-style segment of that endpoint. Set `ContentType: "image/png"`.
3. Key convention: `pr-<number>-<short-feature-slug>/<NN>-<description>.png` — lead with the actual PR number (durable, collision-proof, and groups a PR's screenshots together).
4. Embed as `https://f005.backblazeb2.com/file/<B2_BUCKET>/<key>` in the PR body. GitHub proxies any public HTTPS image through Camo, so this renders identically to a GitHub-hosted image.
5. If a screenshot needs replacing after a follow-up commit changes the UI, **always upload it under a new key** (e.g. append `-v2`, `-v3`, ...) — never overwrite an existing key (check with `HeadObjectCommand` first). GitHub's Camo image proxy (`camo.githubusercontent.com`), which every embedded image goes through, caches by URL, not content, and doesn't reliably revalidate when the object changes — a PR can keep rendering the old screenshot indefinitely (observed directly when this lived on R2: overwriting `01-map-only.png` in place left the PR showing the stale image well after the object itself had updated). A new key is a URL Camo has never seen, so it's guaranteed to render fresh.
6. Before calling a UI-touching PR done, re-check *every* screenshot already in the body against the current app, not just ones you're actively adding — an older screenshot from an earlier phase of the same PR is exactly as stale as one from a different PR if the UI it shows has since changed.
