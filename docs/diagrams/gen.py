"""Generator for the sync diagrams: boxes on a grid, arrows bound between them.

Usage: python3 -I gen.py <today|target> <out.excalidraw>
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


if __name__ == "__main__":
    {"today": today, "target": target}[sys.argv[1]]()
    doc = {"type": "excalidraw", "version": 2, "source": "redlist-dashboard",
           "elements": elements,
           "appState": {"viewBackgroundColor": "#ffffff", "gridSize": None},
           "files": {}}
    with open(sys.argv[2], "w") as f:
        json.dump(doc, f, indent=1)
