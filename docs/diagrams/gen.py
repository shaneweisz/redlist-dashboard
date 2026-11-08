"""Generator for the build and API-route diagrams: boxes on a grid, arrows bound between them.
(The sync's are sync_overview.py and sync_tables.py.)

Usage: python3 -I gen.py <build|routes> <out.excalidraw>
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
    S["f_data"] = box("f_data", 2, 0.55, "app/data/sync/\nthe sync, 458 MB", "out")
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
            "species-lists: assessed, ne, species/, assessment_link, col-revisions\n"
            "search-shards: name-index, rank-index\n"
            "tree: assessed, species/", 15, "#495057")
    legend(0, 7.0 * ROW_H, [("source", "input"), ("step", "build step"), ("out", "what it writes"), ("app", "reader")])


def routes():
    """The API routes, grouped: what each group reads, and which part of the app calls it."""
    heading(0, -170, "The API routes: what they read, and who calls them", 34)
    heading(0, -118, "38 route handlers in app/src/app, grouped. Dashed: unused, or mostly answered by the prebuilt files "
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
        "/api/redlist/species/history, /api/redlist/synonyms",
        "/api/redlist/taxa-summary, /taxa-subgroups",
        "/api/redlist/country-stats",
        "/api/redlist/credit-candidates, /api/data-sync-date"])
    group("g_col", 2.1, "CoL differences", [
        "/api/redlist/taxa-breakdown-live",
        "/api/redlist/col-taxon-ids-live",
        "/api/col/provenance  (ChecklistBank)"])
    group("g_srch", 3.6, "Search  (fallback: prebuilt shards)", [
        "/api/search, /api/search/warm"], dashed=True)
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
    group("g_misc", 12.8, "CITES, native range, EOL traits", [
        "/api/cites, /api/cites/trade",
        "/api/wcvp-native-range  (bundled parquet)",
        "/api/eol/traits"])
    group("g_auth", 14.3, "Sign-in", ["/api/auth/me, /auth/callback"])
    group("g_dead", 15.4, "No callers", ["/api/taxa/species, /api/eol"], dashed=True)

    # consumers
    S["c_tbl"] = box("c_tbl", 2.75, 0.3, "species table, charts,\nfilters, summary table", "app")
    S["c_srch"] = box("c_srch", 2.75, 3.4, "search bar", "app")
    S["c_nar"] = box("c_nar", 2.75, 5.6, "narrative search page", "app")
    S["c_det"] = box("c_det", 2.75, 8.4, "species detail panel:\nGBIF map, iNat, literature,\nCITES, CoL, Red List tabs", "app", h=96)
    S["c_map"] = box("c_map", 2.75, 11.2, "nearby / world map", "app")
    S["c_hdr"] = box("c_hdr", 2.75, 14.3, "sign-in, header", "app")

    for a, b in [("pq", "g_list"), ("js", "g_list"), ("pq", "g_col"), ("ext", "g_col"),
                 ("pq", "g_srch"), ("nar", "g_nar"),
                 ("maps", "g_maps"), ("supa", "g_maps"), ("gbif", "g_gbif"), ("pq", "g_gbif"),
                 ("inat", "g_inat"), ("gbif", "g_inat"), ("iucn", "g_iucn"), ("ext", "g_iucn"),
                 ("ext", "g_misc"), ("supa", "g_auth"), ("pq", "g_dead"), ("ext", "g_dead"),
                 ("g_list", "c_tbl"), ("g_col", "c_tbl"), ("g_srch", "c_srch"),
                 ("g_nar", "c_nar"), ("g_maps", "c_det"), ("g_gbif", "c_det"), ("g_gbif", "c_map"),
                 ("g_inat", "c_det"), ("g_iucn", "c_det"), ("g_misc", "c_det"), ("g_auth", "c_hdr")]:
        arrow(S[a], S[b])
    legend(2.75 * COL_W, 16.2 * ROW_H, [("out", "our data"), ("api", "external API"), ("source", "Supabase"),
                                       ("step", "route group"), ("app", "caller")])


if __name__ == "__main__":
    {"build": build, "routes": routes}[sys.argv[1]]()
    doc = {"type": "excalidraw", "version": 2, "source": "redlist-dashboard",
           "elements": elements,
           "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None},
           "files": {}}
    with open(sys.argv[2], "w") as f:
        json.dump(doc, f, indent=1)
