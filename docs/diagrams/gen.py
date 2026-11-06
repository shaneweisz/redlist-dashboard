"""Generator for the sync diagrams: boxes on a grid, arrows bound between them.

Usage: python3 -I gen.py <today|target|files|build|routes> <out.excalidraw>
Render: npx @excalidraw/cli@0.2.0 render <out.excalidraw> --out <out.png> --scale 2
The .excalidraw files are the editable sources (open them at excalidraw.com).
Specs are Python functions below returning (nodes, edges, notes).
"""
import json, sys, random

random.seed(7)
FONT = 5  # Excalifont
COL_W, ROW_H = 300, 110
BOX_W, BOX_H = 230, 72

PALETTE = {
    "source": ("#1e1e1e", "#e9ecef"),
    "phase": ("#1e1e1e", "#a5d8ff"),
    "api": ("#c92a2a", "#ffc9c9"),
    "file": ("#1e1e1e", "#fff3bf"),
    "core": ("#1e1e1e", "#b2f2bb"),
    "step": ("#1e1e1e", "#d0bfff"),
    "out": ("#1e1e1e", "#ffd8a8"),
    "app": ("#1e1e1e", "#ffffff"),
    "gone": ("#868e96", "#f1f3f5"),
}

elements = []


def seed():
    return random.randint(1, 2**31 - 1)


def base(id_, type_, x, y, w, h, stroke, bg, **kw):
    e = {
        "id": id_, "type": type_, "x": x, "y": y, "width": w, "height": h,
        "angle": 0, "strokeColor": stroke, "backgroundColor": bg,
        "fillStyle": "solid", "strokeWidth": 2, "strokeStyle": "solid",
        "roughness": 1, "opacity": 100, "groupIds": [], "frameId": None,
        "roundness": {"type": 3}, "seed": seed(), "version": 1,
        "versionNonce": seed(), "isDeleted": False, "boundElements": [],
        "updated": 1, "link": None, "locked": False,
    }
    e.update(kw)
    return e


def text_el(id_, x, y, txt, size, container=None, color="#1e1e1e", align="center"):
    lines = txt.split("\n")
    w = max(len(l) for l in lines) * size * 0.56
    h = len(lines) * size * 1.25
    return base(
        id_, "text", x, y, w, h, color, "transparent", roundness=None,
        boundElements=None, text=txt, originalText=txt, fontSize=size,
        fontFamily=FONT, textAlign=align, verticalAlign="middle",
        containerId=container, autoResize=True, lineHeight=1.25,
    )


def box(id_, col, row, label, kind, w=BOX_W, h=BOX_H, dx=0, dy=0, size=16, dashed=False):
    stroke, bg = PALETTE[kind]
    x, y = col * COL_W + dx, row * ROW_H + dy
    shape = "ellipse" if kind == "source" else "rectangle"
    r = base(id_, shape, x, y, w, h, stroke, bg,
             strokeStyle="dashed" if dashed else "solid")
    t = text_el(id_ + "_t", 0, 0, label, size, container=id_,
                color="#868e96" if kind == "gone" else "#1e1e1e")
    t["x"] = x + (w - t["width"]) / 2
    t["y"] = y + (h - t["height"]) / 2
    r["boundElements"].append({"type": "text", "id": t["id"]})
    elements.extend([r, t])
    return r


def arrow(a, b, color="#495057", dashed=False, label=None, via=()):
    # straight arrow from a's right edge to b's left edge (or vertical if stacked)
    ax, ay, aw, ah = a["x"], a["y"], a["width"], a["height"]
    bx, by, bw, bh = b["x"], b["y"], b["width"], b["height"]
    if bx >= ax + aw - 1:
        sx, sy = ax + aw, ay + ah / 2
        ex, ey = bx, by + bh / 2
    elif bx + bw <= ax + 1:
        sx, sy = ax, ay + ah / 2
        ex, ey = bx + bw, by + bh / 2
    elif by >= ay + ah:
        sx, sy = ax + aw / 2, ay + ah
        ex, ey = bx + bw / 2, by
    else:
        sx, sy = ax + aw / 2, ay
        ex, ey = bx + bw / 2, by + bh
    id_ = f"ar_{a['id']}_{b['id']}"
    gap = 4
    e = base(id_, "arrow", sx, sy, abs(ex - sx), abs(ey - sy), color, "transparent",
             roundness=None if via else {"type": 2}, strokeStyle="dashed" if dashed else "solid",
             points=[[0, 0]] + [[vx - sx, vy - sy] for vx, vy in via] + [[ex - sx, ey - sy]], lastCommittedPoint=None,
             startBinding={"elementId": a["id"], "focus": 0, "gap": gap},
             endBinding={"elementId": b["id"], "focus": 0, "gap": gap},
             startArrowhead=None, endArrowhead="arrow", elbowed=False,
             strokeWidth=1.5)
    a["boundElements"].append({"type": "arrow", "id": id_})
    b["boundElements"].append({"type": "arrow", "id": id_})
    elements.append(e)


def heading(x, y, txt, size=28, color="#1e1e1e"):
    t = text_el(f"h_{len(elements)}", x, y, txt, size, color=color, align="left")
    elements.append(t)


def legend(x, y, items):
    for i, (kind, label) in enumerate(items):
        stroke, bg = PALETTE[kind]
        r = base(f"lg_{i}_{len(elements)}", "rectangle", x, y + i * 34, 26, 22, stroke, bg)
        elements.append(r)
        elements.append(text_el(f"lgt_{i}_{len(elements)}", x + 36, y + i * 34, label, 15,
                                align="left", color="#495057"))


# ---------------------------------------------------------------- specs

def today():
    heading(0, -150, "Today: 20 steps, API-shaped", 34)
    heading(0, -100, "Two independent matching chains; counts assembled from API facets via per-group CSVs",
            17, "#495057")
    S = {}
    S["pg"] = box("pg", 0, 0, "IUCN Red List\nPostgres", "source")
    S["xr"] = box("xr", 0, 2, "CoL XR +\ncurated checklist", "source")
    S["gapi"] = box("gapi", 0, 4.4, "GBIF API\n(search + match)", "api")
    S["inat"] = box("inat", 0, 6.6, "iNaturalist", "source")

    S["p1"] = box("p1", 1, 0, "1  fetch-redlist", "phase")
    S["p24"] = box("p24", 1, 2, "2-4  backbone\n4b  derive root keys", "phase")
    S["p5"] = box("p5", 1, 3.5, "5  species facets\nper group root", "api")
    S["p78"] = box("p78", 1, 4.6, "7 countries  8 per-year\n8b lumped keys", "api")
    S["p6"] = box("p6", 1, 5.7, "6  match SIS → GBIF key\n(one name per request)", "api")
    S["p8c"] = box("p8c", 1, 6.8, "8c  iNat names", "phase")

    S["rlcsv"] = box("rlcsv", 2, 0, "redlist/*.csv\nhistory/*.json", "file")
    S["bb"] = box("bb", 2, 2, "backbone.parquet\nspecies/", "file")
    S["gcsv"] = box("gcsv", 2, 4, "gbif/*.csv\nlumped-own-counts.csv", "file")
    S["map"] = box("map", 2, 5.7, "mapping.csv\n(key claims, verdicts)", "file")

    S["p9"] = box("p9", 3, 1.6, "9  build-parquet\n(chooseRepresentative,\ncross-group owner)", "phase", h=92)
    S["p10"] = box("p10", 3, 3.4, "10  build-matching\n(SIS → col_id by name,\n7 passes)", "phase", h=92)
    S["pq"] = box("pq", 4, 0.6, "assessed / unassessed /\nassessments.parquet", "out")
    S["sl"] = box("sl", 4, 3.4, "species_link.parquet\n(899k rows, 2 halves)", "out")
    S["p11"] = box("p11", 5, 1.2, "11, 11b  synonym +\nsearch indexes", "phase")
    S["p13"] = box("p13", 5, 2.6, "13  taxa-summary\n13a col-revisions", "phase")
    S["json"] = box("json", 6, 1.9, "summary JSON\n(precomputed AND live)", "out")
    S["chk"] = box("chk", 5, 4.2, "13b regression check\nvs prod", "phase")

    for a, b in [("pg", "p1"), ("p1", "rlcsv"), ("xr", "p24"), ("p24", "bb"),
                 ("gapi", "p5"), ("gapi", "p78"), ("gapi", "p6"), ("p5", "gcsv"),
                 ("p78", "gcsv"), ("p6", "map"), ("inat", "p8c"),
                 ("rlcsv", "p9"), ("gcsv", "p9"), ("map", "p9"), ("bb", "p9"),
                 ("p9", "pq"), ("pq", "p10"), ("bb", "p10"), ("p10", "sl"),
                 ("pq", "p11"), ("sl", "p11"), ("sl", "p13"), ("pq", "p13"),
                 ("rlcsv", "p13"), ("p13", "json"),
                 ("pq", "chk")]:
        arrow(S[a], S[b])
    arrow(S["gcsv"], S["p13"], via=[(870, 560), (1420, 560)])
    arrow(S["p8c"], S["p9"], dashed=True)
    legend(6 * COL_W, 4.2 * ROW_H, [("source", "external input"), ("api", "GBIF API work"),
                                     ("phase", "phase"), ("file", "intermediate file"),
                                     ("out", "what the app reads")])


def target():
    heading(0, -150, "Rewrite: three inputs, four tables, one match", 34)
    heading(0, -100, "Monthly, local on the Mac Studio. Everything the app reads is SQL over the core tables.",
            17, "#495057")
    S = {}
    S["pg"] = box("pg", 0, 0.3, "IUCN Red List\nPostgres", "source")
    S["xr"] = box("xr", 0, 1.9, "CoL XR (release\nGBIF indexes)\n+ curated checklist", "source", h=86)
    S["snap"] = box("snap", 0, 3.6, "GBIF monthly\nsnapshot (local\nmirror, 253 GiB)", "source", h=86)
    S["inat"] = box("inat", 0, 1.1, "iNaturalist\n(names)", "source")

    S["assess"] = box("assess", 1.15, 0.3, "assessments\none row per assessment\nlists as lists", "core", h=86, size=16)
    S["taxa"] = box("taxa", 1.15, 1.9, "taxa\none row per CoL usage\nlineage, group, names", "core", h=86)
    S["occ"] = box("occ", 1.15, 3.6, "occurrence_counts\nusage × year × georef\n× basis (+ countries)", "core", h=86)

    S["match"] = box("match", 2.3, 1.1, "match (one step)\nlocal name passes,\nGBIF batch matcher\nfor leftovers", "step", h=104)
    S["link"] = box("link", 3.3, 1.1, "assessment_link\nSIS → col_id + own usage\nverdict · method · reason\n(one-to-one)", "core", h=104)

    S["sql"] = box("sql", 4.4, 2.3, "SQL read models\n(same modules the\nlive routes run)", "step", h=96)

    S["o1"] = box("o1", 5.5, 0.6, "assessed.parquet\n+ history", "out")
    S["o2"] = box("o2", 5.5, 1.65, "ne.parquet + species/\n(keyed by col_id)", "out")
    S["o3"] = box("o3", 5.5, 2.7, "search + synonym\nindexes", "out")
    S["o4"] = box("o4", 5.5, 3.75, "summaries JSON\n(as of the sync date)", "out")

    S["chk"] = box("chk", 4.4, 4.5, "checks: snapshot complete,\nTable 1a, invariants,\ndiff vs prod", "phase", w=250, h=90)
    S["pub"] = box("pub", 5.5, 5.0, "R2 upload +\nlatest-sync.txt PR", "app")

    for a, b in [("pg", "assess"), ("xr", "taxa"), ("snap", "occ"),
                 ("assess", "match"), ("taxa", "match"), ("match", "link"),
                 ("link", "sql"), ("taxa", "sql"), ("occ", "sql"),
                 ("sql", "o1"), ("sql", "o2"), ("sql", "o3"), ("sql", "o4"),
                 ("sql", "chk"), ("chk", "pub")]:
        arrow(S[a], S[b])
    arrow(S["inat"], S["taxa"], dashed=True)
    arrow(S["assess"], S["sql"], via=[(1265, 76)])
    legend(0, 5.0 * ROW_H, [("source", "external input"), ("core", "core table (source of truth)"),
                             ("step", "derivation step"), ("out", "what the app reads")])


def files():
    """Every file a sync reads and writes, step by step in sync.ts order, and where each lands."""
    heading(0, -190, "A sync, step by step: every file it reads and writes, and where it lands", 34)
    heading(0, -140, "npm run sync (scripts/sync/sync.ts), top to bottom in the order it runs. Paths under ~/.cache/redlist-dashboard/. "
            "build/data/ is what sync:publish uploads to syncs/<timestamp>/ in R2 and copies to app/data/sync/.", 17, "#495057")
    heading(0, -110, "Dashed: unused, or could be simpler (docs/sync.md). sync.log is written throughout.", 17, "#495057")
    cols = [("inputs and caches", 0.0, 290, "#495057"), ("step", 1.05, 250, "#5f3dc4"),
            ("build/core/  (working, not published)", 2.0, 320, "#2b8a3e"),
            ("build/data/  (published)", 3.15, 340, "#d9480f"), ("elsewhere", 4.4, 300, "#1e1e1e")]
    for title, x, _w, color in cols:
        heading(x * COL_W, -55, title, 18, color)
    kinds = {0: "source", 2: "core", 3: "out", 4: "app"}
    steps = [
        ("1  inputs\ninputs/col.ts, inat.ts", {
            0: [("col/<xr>/  CoL XR + curated\nchecklist + common names", False), ("inat/<month>/\niNaturalist names", False)]}),
        ("2  taxa\ncore/build-taxa.ts", {
            2: [("taxa.parquet  159 MB\nevery CoL usage", False), ("species-fallback-display-\nname-col.parquet", False),
                ("species-common-names-col\n.parquet  (for search)", False)],
            3: [("taxonomy/vernacular-names.json\nnames for the tree's labels", False)]}),
        ("3  assessments\ncore/build-assessments.ts", {
            0: [("Red List Postgres\n(read-only, not cached)", False)],
            2: [("assessments.parquet  12 MB\nevery assessment", False)]}),
        ("4  occurrences\ncore/build-occurrences.ts", {
            0: [("~/Data/gbif/<date>/\nthe snapshot mirror", False), ("occurrences/<date>/parts/\nresumable aggregate", False)],
            2: [("occurrence_counts  135 MB\nusage x year x georef x type", False),
                ("occurrence_dates  943 MB\n... x month x day", False),
                ("occurrence_countries  58 MB", False),
                ("occurrence_species_keys  23 MB\nnothing reads it", True),
                ("occurrences.json\nsnapshot, citation, rows", False)]}),
        ("5  match names\ncore/build-matches.ts", {
            0: [("matching-ws/export-<xr>/\nthe matcher's index (Docker)", False)],
            2: [("matches.parquet  6 MB\nthe matcher's answers", False), ("matches.json\nnothing reads it", True)]}),
        ("6  link\ncore/build-link.ts", {
            0: [("core/decisions.tsv\n(in the repo)", False)],
            2: [("assessment_link.parquet\nSIS id -> CoL species", False), ("match_queue.parquet\nwaiting for a decision", False)],
            4: [("build/match-queue.tsv\nthe queue, to review", False)]}),
        ("7  read models\noutputs/build-read-models.ts", {
            2: [("count_components.parquet\nwhat each count is made of", False)],
            3: [("lists/assessed.parquet  8 MB", False), ("lists/assessments.parquet  4 MB", False),
                ("lists/species/  29 files, 37 MB", False), ("lists/ne.parquet  34 MB", True),
                ("taxonomy/species_link.parquet  3 MB", True), ("taxonomy/taxa.parquet  152 MB (copy)", True),
                ("taxonomy/assessment_link (copy)", False)]}),
        ("8  summaries, indexes\noutputs/build-taxa-summary,\n-col-revisions, -synonym-\nindex, -search-index", {
            3: [("summaries/  5 JSON, 2.4 MB", False), ("taxonomy/col-*.parquet  3 files", False),
                ("taxonomy/col-revisions.json", False), ("search/name-index  160 MB", False),
                ("search/rank-index  3 MB", False), ("search/synonym-index  78 MB", False)],
            4: [("app/src/config/col-taxon-ids\n.json, col-release.json (repo)", False)]}),
        ("9  checks\nsync.ts, checks/", {
            0: [("baseline-<sync>/  prod's\nsync, downloaded once", False)],
            3: [("sync.json  every input\nversion, check result", False), ("sync.log  everything\nthe run printed", False)],
            4: [("build/compare/  report.md,\ndiffs.parquet, summary.json", False)]}),
        ("10  npm run sync:publish\nscripts/sync/publish.ts", {
            4: [("app/data/sync/ and R2\nsyncs/<timestamp>/", False), ("app/latest-sync.txt\n(the data PR)", False)]}),
    ]
    BH, GAP = 54, 12
    y = 0
    for n, (label, files) in enumerate(steps):
        rows = max([len(v) for v in files.values()] + [1])
        bh = max(rows * (BH + GAP) + GAP, 2 * BH)
        band = base(f"band{n}", "rectangle", -15, y, 4.4 * COL_W + 300 + 30, bh, "transparent",
                    "#f1f3f5" if n % 2 == 0 else "#ffffff", strokeWidth=0, roundness=None)
        elements.append(band)
        step_h = min(bh - 2 * GAP, 96)
        box(f"st{n}", 1.05, 0, label, "step", w=250, h=step_h, dy=y + (bh - step_h) / 2, size=14)
        for col, items in files.items():
            x, w = [(c[1], c[2]) for c in cols][col]
            for k, (txt, dashed) in enumerate(items):
                box(f"f{n}_{col}_{k}", x, 0, txt, kinds[col], w=w, h=BH, dy=y + GAP + k * (BH + GAP), size=13, dashed=dashed)
        y += bh
    legend(0, y + 30, [("source", "input or cache"), ("step", "sync step"), ("core", "working table"),
                        ("out", "published"), ("app", "elsewhere")])


def build():
    """Every deploy: what the build fetches and writes, and who reads it."""
    heading(0, -170, "The build: what every deploy fetches, writes and serves", 34)
    heading(0, -118, "npm run build = prebuild (scripts/build/) then next build, on Vercel for every deploy. "
            "The prebuilt files are reused from .next/cache unless the sync or their code changed.", 17, "#495057")
    S = {}
    S["ptr"] = box("ptr", 0, 0.0, "app/latest-sync.txt\n(which sync, in git)", "source")
    S["r2"] = box("r2", 0, 1.1, "R2 dashboard-data\nsyncs/<timestamp>/", "source")
    S["code"] = box("code", 0, 2.6, "the repo's code: taxonomy\ntree, display names, formats", "source", h=80)
    S["cache"] = box("cache", 0, 3.7, ".next/cache/prebuilt/\n(restored by Vercel)", "source")
    S["duck"] = box("duck", 0, 5.6, "extensions.duckdb.org\n(httpfs for Linux)", "source")

    S["s_fetch"] = box("s_fetch", 1, 0.55, "fetch-data-from-r2", "step")
    S["f_data"] = box("f_data", 2, 0.55, "app/data/sync/\nthe sync, 447 MB", "out")
    S["s_pre"] = box("s_pre", 2, 2.6, "build-prebuilt\n(cache key: sync +\nthe builders' code)", "step", h=86)
    S["s_sl"] = box("s_sl", 3, 1.6, "build-species-lists", "step")
    S["s_ss"] = box("s_ss", 3, 2.7, "build-search-shards", "step")
    S["s_tc"] = box("s_tc", 3, 3.8, "build-tree-children", "step")
    S["f_sl"] = box("f_sl", 4, 1.6, "species-lists/\n59 files, 42 MB", "out")
    S["f_ss"] = box("f_ss", 4, 2.7, "search-shards/\n4,827 files, 146 MB", "out")
    S["f_tc"] = box("f_tc", 4, 3.8, "tree/\n37 files, 4.5 MB", "out")
    S["r_cdn"] = box("r_cdn", 5, 2.55, "the browser, from\nthe CDN (loaders in\nsrc/lib/species-lists,\nsearch-shards, tree-children)", "app", h=110)

    S["s_ext"] = box("s_ext", 1, 5.6, "fetch-duckdb-ext", "step")
    S["f_ext"] = box("f_ext", 2, 5.6, "app/duckdb-ext/\nhttpfs extension", "out")
    S["s_next"] = box("s_next", 3, 5.6, "next build\n(no type-check: CI does it)", "step")
    S["f_fn"] = box("f_fn", 4, 5.6, "serverless functions:\nsummaries JSON bundled,\nparquets left out", "out", h=86)
    S["r_fn"] = box("r_fn", 5, 5.6, "API routes: DuckDB reads\nthe parquets from R2 at\nrequest time", "app", h=86)

    for a, b in [("ptr", "s_fetch"), ("r2", "s_fetch"), ("s_fetch", "f_data"), ("f_data", "s_pre"),
                 ("code", "s_pre"), ("cache", "s_pre"),
                 ("s_pre", "s_sl"), ("s_pre", "s_ss"), ("s_pre", "s_tc"),
                 ("s_sl", "f_sl"), ("s_ss", "f_ss"), ("s_tc", "f_tc"),
                 ("f_sl", "r_cdn"), ("f_ss", "r_cdn"), ("f_tc", "r_cdn"),
                 ("duck", "s_ext"), ("s_ext", "f_ext"), ("f_ext", "s_next"), ("s_next", "f_fn"), ("f_fn", "r_fn")]:
        arrow(S[a], S[b])
    heading(3 * COL_W, 0.2 * ROW_H, "public/prebuilt/<sync>/, served from the CDN:\n"
            "species-lists: assessed, ne, species/, species_link, col-revisions\n"
            "search-shards: name-index, rank-index\n"
            "tree: assessed, species/", 15, "#495057")
    legend(0, 7.0 * ROW_H, [("source", "input"), ("step", "build step"), ("out", "what it writes"), ("app", "reader")])


def routes():
    """The API routes, grouped: what each group reads, and which part of the app calls it."""
    heading(0, -170, "The API routes: what they read, and who calls them", 34)
    heading(0, -118, "42 route handlers in app/src/app, grouped. Dashed: unused, or mostly answered by the prebuilt files "
            "(see docs/app.md).", 17, "#495057")
    S = {}
    W1, X1 = 380, 1.05
    # sources
    S["pq"] = box("pq", 0, 0.4, "sync parquets on R2\n(DuckDB over httpfs)", "out")
    S["js"] = box("js", 0, 2.6, "sync JSON bundled\ninto the function", "out")
    S["nar"] = box("nar", 0, 4.6, "narratives parquets\n(R2 narratives/<release>/)", "out")
    S["maps"] = box("maps", 0, 6.4, "R2 maps bucket: range\nmaps, AOH, overlays", "out")
    S["gbif"] = box("gbif", 0, 8.4, "GBIF API", "api")
    S["inat"] = box("inat", 0, 10.4, "iNaturalist API", "api")
    S["iucn"] = box("iucn", 0, 12.0, "IUCN Red List API v4", "api")
    S["ext"] = box("ext", 0, 13.6, "CITES, ChecklistBank,\nOpenAlex & co, EOL", "api")
    S["supa"] = box("supa", 0, 15.2, "Supabase (auth,\nuser_roles)", "source")

    def group(id_, row, title, lines, dashed=False):
        h = 30 + 19 * (len(lines) + 1)
        S[id_] = box(id_, X1, row, title + "\n" + "\n".join(lines), "step", w=W1, h=h, size=14, dashed=dashed)

    group("g_list", 0.0, "Species lists and summaries", [
        "/api/redlist/species  (fallback: prebuilt lists)",
        "/api/redlist/species/history, /synonyms",
        "/api/redlist/taxa-summary, /taxa-subgroups",
        "/api/redlist/country-stats, /realm-stats",
        "/api/redlist/credit-candidates, /api/data-sync-date"])
    group("g_col", 2.1, "CoL differences", [
        "/api/redlist/taxa-breakdown-live",
        "/api/redlist/col-taxon-ids-live",
        "/api/col/provenance  (ChecklistBank)"])
    group("g_srch", 3.6, "Search  (fallback: prebuilt shards)", [
        "/api/search, /api/search/warm"], dashed=True)
    group("g_agent", 4.6, "For agents", ["/api/mcp, /browse, /llms.txt"])
    group("g_nar", 5.6, "Narrative search", ["/api/narrative-search, /[assessmentId]"])
    group("g_maps", 6.6, "Map layers  (range map + AOH: admins only)", [
        "/api/species/[key]/range-map, /aoh, /aoh/metadata",
        "/api/overlays/[asset]"])
    group("g_gbif", 8.0, "GBIF, live", [
        "/api/occurrences, /api/country/stats",
        "/api/species/[key]/breakdown, /inat-photos",
        "/api/nearby-species, /nearby-species/points"])
    group("g_inat", 9.9, "iNaturalist, live", [
        "/api/inat/observations, /api/inat/thumbnail",
        "/api/species/[key]/inat-top-observers"])
    group("g_iucn", 11.6, "Red List assessment, literature", [
        "/api/redlist/assessment/[id], /api/literature"])
    group("g_misc", 12.8, "CITES, native range", [
        "/api/cites, /api/cites/trade",
        "/api/wcvp-native-range  (bundled parquet)"])
    group("g_auth", 14.3, "Sign-in", ["/api/auth/me, /auth/callback"])
    group("g_dead", 15.4, "No callers", ["/api/taxa/species, /api/eol, /api/eol/traits"], dashed=True)

    # consumers
    S["c_tbl"] = box("c_tbl", 2.75, 0.3, "species table, charts,\nfilters, summary table", "app")
    S["c_srch"] = box("c_srch", 2.75, 3.4, "search bar", "app")
    S["c_agent"] = box("c_agent", 2.75, 4.6, "AI agents (MCP)", "app")
    S["c_nar"] = box("c_nar", 2.75, 5.6, "narrative search page", "app")
    S["c_det"] = box("c_det", 2.75, 8.4, "species detail panel:\nGBIF map, iNat, literature,\nCITES, CoL, Red List tabs", "app", h=96)
    S["c_map"] = box("c_map", 2.75, 11.2, "nearby / world map", "app")
    S["c_hdr"] = box("c_hdr", 2.75, 14.3, "sign-in, header", "app")

    for a, b in [("pq", "g_list"), ("js", "g_list"), ("pq", "g_col"), ("ext", "g_col"),
                 ("pq", "g_srch"), ("pq", "g_agent"), ("js", "g_agent"), ("nar", "g_nar"),
                 ("maps", "g_maps"), ("supa", "g_maps"), ("gbif", "g_gbif"), ("pq", "g_gbif"),
                 ("inat", "g_inat"), ("gbif", "g_inat"), ("iucn", "g_iucn"), ("ext", "g_iucn"),
                 ("ext", "g_misc"), ("supa", "g_auth"), ("pq", "g_dead"), ("ext", "g_dead"),
                 ("g_list", "c_tbl"), ("g_col", "c_tbl"), ("g_srch", "c_srch"), ("g_agent", "c_agent"),
                 ("g_nar", "c_nar"), ("g_maps", "c_det"), ("g_gbif", "c_det"), ("g_gbif", "c_map"),
                 ("g_inat", "c_det"), ("g_iucn", "c_det"), ("g_misc", "c_det"), ("g_auth", "c_hdr")]:
        arrow(S[a], S[b])
    legend(2.75 * COL_W, 16.2 * ROW_H, [("out", "our data"), ("api", "external API"), ("source", "Supabase"),
                                       ("step", "route group"), ("app", "caller")])


if __name__ == "__main__":
    {"today": today, "target": target, "files": files, "build": build, "routes": routes}[sys.argv[1]]()
    doc = {"type": "excalidraw", "version": 2, "source": "redlist-dashboard",
           "elements": elements,
           "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None},
           "files": {}}
    with open(sys.argv[2], "w") as f:
        json.dump(doc, f, indent=1)
