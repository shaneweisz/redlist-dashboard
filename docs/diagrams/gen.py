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
    """Every file in a sync (app/data/sync = syncs/<ts>/ in R2): which step writes it, who reads it."""
    heading(0, -170, "The files in a sync: where each comes from, and who reads it", 34)
    heading(0, -118, "app/data/sync/ = build/data/ = syncs/<timestamp>/ in R2. The app queries the parquets from R2 at runtime; "
            "the deploy build turns some into the prebuilt files.", 17, "#495057")
    heading(0, -86, "Dashed: could be simplified (see docs/sync.md, What the app reads).", 17, "#495057")
    S = {}
    W3, X3 = 300, 3.25  # the files column: wider boxes
    # inputs
    S["pg"] = box("pg", 0, 0.2, "IUCN Red List\nPostgres (read-only)", "source")
    S["xr"] = box("xr", 0, 2.6, "CoL XR + curated\nchecklist (+ CoL\ncommon names)", "source", h=86)
    S["dec"] = box("dec", 0, 4.3, "GBIF matcher (local\nDocker) + decisions.tsv", "source", h=80)
    S["snap"] = box("snap", 0, 6.2, "GBIF monthly\nsnapshot (local\nmirror)", "source", h=86)
    S["inat"] = box("inat", 0, 8.0, "iNaturalist\ncommon names", "source")
    # core tables (build/core/, not published)
    heading(1 * COL_W, -40, "core/ (not published)", 18, "#2b8a3e")
    S["assess"] = box("assess", 1, 0.2, "assessments\n(every assessment)", "core")
    S["taxa"] = box("taxa", 1, 2.6, "taxa\n(every CoL usage)", "core")
    S["link"] = box("link", 1, 4.3, "assessment_link\nSIS id -> CoL species", "core", h=80)
    S["occ"] = box("occ", 1, 6.2, "occurrence_counts,\n_dates, _countries", "core", h=80)
    # steps
    heading(2 * COL_W, -40, "sync steps (scripts/sync/)", 18, "#5f3dc4")
    S["s_taxa"] = box("s_taxa", 2, 1.4, "core/build-taxa\n(+ build-vernaculars)", "step")
    S["s_rm"] = box("s_rm", 2, 3.6, "outputs/\nbuild-read-models", "step")
    S["s_sum"] = box("s_sum", 2, 7.6, "outputs/\nbuild-taxa-summary", "step")
    S["s_rev"] = box("s_rev", 2, 9.6, "outputs/\nbuild-col-revisions", "step")
    S["s_srch"] = box("s_srch", 2, 11.0, "outputs/build-search-\nindex, -synonym-index", "step")
    S["s_chk"] = box("s_chk", 2, 13.4, "sync.ts: fixtures,\ndata tests, comparison", "step")
    # files
    heading(X3 * COL_W, -40, "data/sync/ (published)", 18, "#d9480f")
    F = [
        ("f_ass", 0.0, "lists/assessed.parquet  8 MB\none row per assessed species", False),
        ("f_hist", 0.9, "lists/assessments.parquet  4 MB\npublished history, one per year", False),
        ("f_spp", 1.8, "lists/species/  37 MB, 29 files\nthe CoL species universe, by group", False),
        ("f_ne", 2.7, "lists/ne.parquet  34 MB\nGBIF counts for Not Evaluated species", True),
        ("f_taxa", 3.9, "taxonomy/taxa.parquet  152 MB\ncopy of the taxa core table", True),
        ("f_sl", 4.8, "taxonomy/species_link.parquet  3 MB\nthe links, in the old shape", True),
        ("f_al", 5.7, "taxonomy/assessment_link.parquet 3 MB\ncopy of the link core table", False),
        ("f_vern", 6.6, "taxonomy/vernacular-names.json\nnames for the tree's labels", False),
        ("f_sum", 7.6, "summaries/  5 JSON, 2.4 MB\ngroup, node, country, realm totals", False),
        ("f_colx", 8.5, "taxonomy/col-*.parquet  3 files\nCoL-differences breakdowns", False),
        ("f_rev", 9.6, "taxonomy/col-revisions.json\neach species' CoL-differences flag", False),
        ("f_name", 10.6, "search/name-index + rank-index\n163 MB: names, taxon suggestions", False),
        ("f_syn", 11.5, "search/synonym-index  78 MB\nold names", False),
        ("f_json", 13.4, "sync.json\nevery input version, check result", False),
    ]
    for id_, row, label, dashed in F:
        S[id_] = box(id_, X3, row, label, "out", w=W3, h=72, size=15, dashed=dashed)
    # readers
    heading(4.55 * COL_W, -40, "who reads it", 18, "#1e1e1e")
    S["r_build"] = box("r_build", 4.55, 0.4, "deploy build: prebuilt\nspecies lists, search\nshards, tree files", "app", h=86)
    S["r_list"] = box("r_list", 4.55, 2.2, "species lists, charts,\nfilters (/api/redlist/\nspecies, /browse, MCP)", "app", h=86)
    S["r_detail"] = box("r_detail", 4.55, 4.0, "species detail: history,\nsynonyms", "app")
    S["r_cmp"] = box("r_cmp", 4.55, 5.7, "next sync's comparison\n(and tracing)", "app")
    S["r_sum"] = box("r_sum", 4.55, 7.2, "summary table, tree,\ncountry + realm views", "app")
    S["r_col"] = box("r_col", 4.55, 9.0, "CoL-differences card,\npopover and flags", "app")
    S["r_srch"] = box("r_srch", 4.55, 11.0, "search bar (beyond the\nshards), /browse, MCP", "app")
    S["r_pub"] = box("r_pub", 4.55, 13.4, "sync:publish checks,\nprovenance", "app")

    for a, b in [("pg", "assess"), ("xr", "taxa"), ("snap", "occ"),
                 ("assess", "link"), ("taxa", "link"), ("dec", "link"),
                 ("xr", "s_taxa"), ("s_taxa", "f_vern"),
                 ("assess", "s_rm"), ("taxa", "s_rm"), ("link", "s_rm"), ("occ", "s_rm"),
                 ("s_rm", "f_ass"), ("s_rm", "f_hist"), ("s_rm", "f_spp"), ("s_rm", "f_ne"),
                 ("s_rm", "f_taxa"), ("s_rm", "f_sl"), ("s_rm", "f_al"),
                 ("s_rm", "s_sum"), ("s_sum", "s_rev"), ("s_rev", "s_srch"), ("s_srch", "s_chk"),
                 ("s_sum", "f_sum"), ("s_sum", "f_colx"), ("s_rev", "f_rev"),
                 ("s_srch", "f_name"), ("s_srch", "f_syn"), ("s_chk", "f_json"),
                 # readers
                 ("f_ass", "r_build"), ("f_spp", "r_build"), ("f_ne", "r_build"),
                 ("f_ass", "r_list"), ("f_ne", "r_list"), ("f_spp", "r_list"), ("f_sl", "r_list"),
                 ("f_hist", "r_detail"), ("f_taxa", "r_detail"), ("f_sl", "r_detail"),
                 ("f_al", "r_cmp"),
                 ("f_vern", "r_sum"), ("f_sum", "r_sum"),
                 ("f_colx", "r_col"), ("f_rev", "r_col"), ("f_taxa", "r_col"), ("f_sl", "r_col"),
                 ("f_name", "r_srch"), ("f_syn", "r_srch"), ("f_name", "r_build"),
                 ("f_json", "r_pub")]:
        arrow(S[a], S[b])
    arrow(S["inat"], S["s_rm"], dashed=True)
    legend(0, 10.2 * ROW_H, [("source", "input"), ("core", "core table (build/core/)"),
                              ("step", "sync step"), ("out", "published sync file"), ("app", "reader")])


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
