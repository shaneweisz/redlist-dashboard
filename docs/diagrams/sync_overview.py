"""The sync at a glance: its stages top to bottom, its three sources left to
right, every table it builds, and what each is built from.

Usage: python3 -I sync_overview.py <out.dot>
Render: neato -n2 -Tpng -Gdpi=110 <out.dot> -o <out.png>   (positions are fixed; Graphviz routes the arrows)

The columns of each table are in docs/sync.md's table reference, not here.
"""
import html, json, subprocess, sys

OUT = sys.argv[1]
FILL = {"input": ("#f1f3f5", "#868e96"), "seed": ("#fff9db", "#e67700"), "core": ("#d3f9d8", "#2b8a3e"),
        "data": ("#ffe8cc", "#d9480f"), "else": ("#ffffff", "#495057")}

# Stages, top to bottom: (id, label, what it does)
STAGES = [
    ("inputs", "inputs", "fetched and cached"),
    ("sources", "1  sources", "each input as one clean table"),
    ("link", "2  link", "which CoL species each\nassessed species is"),
    ("count", "3  count", "whose records each\nGBIF usage's are"),
    ("lists", "4  lists", "what the app reads:\njoins only"),
    ("precomputed", "5  precomputed", "the app's own queries,\nrun ahead of time"),
    ("checks", "6  checks", "stop, or explain"),
]
# Each lane's heading sits over the middle of its tables.
LANES = [("Catalogue of Life", 0.2), ("Red List", 1.65), ("GBIF", 2.6)]

# (id, stage, lane position 0..2 (fractions allowed), kind, title, subtitle)
NODES = [
    ("in_col", "inputs", 0.0, "input", "CoL XR + curated checklist", "the release GBIF indexes"),
    ("in_inat", "inputs", 0.75, "input", "iNaturalist names", "monthly"),
    ("in_rl", "inputs", 1.25, "input", "Red List database", "read-only"),
    ("in_seeds", "inputs", 1.75, "seed", "seeds/", "people's decisions, each with why"),
    ("in_gbif", "inputs", 2.5, "input", "GBIF snapshot", "monthly, ~255 GiB, reduced once"),
    ("taxa", "sources", 0.0, "core", "taxa", "one row per CoL usage"),
    ("names", "sources", 0.75, "core", "common_names", "one row per name a source gives"),
    ("assessments", "sources", 1.5, "core", "assessments", "one row per global assessment"),
    ("occ", "sources", 2.25, "core", "occurrences", "usage × georef × date"),
    ("occc", "sources", 2.9, "core", "occurrence_countries", "usage × country × georef"),
    ("matches", "link", 1.5, "core", "matches", "GBIF's matcher's answer per species"),
    ("link", "link", 0.75, "core", "assessment_link", "assessed species → CoL species it is"),
    ("queue", "link", 2.25, "else", "match-queue.tsv", "species waiting for a person"),
    ("owner", "count", 1.0, "core", "usage_owner", "one row per usage: whose records"),
    ("counts", "count", 2.0, "core", "record_counts", "one row per species with records"),
    ("species", "lists", 0.0, "data", "species/", "the universe: described"),
    ("appt", "lists", 0.75, "data", "taxa + assessment_link", "as the app reads them"),
    ("assessed", "lists", 1.5, "data", "assessed", "one row per assessed species"),
    ("history", "lists", 2.15, "data", "assessments", "history, one per year"),
    ("ne", "lists", 2.8, "data", "ne", "Not Evaluated with records"),
    ("vern", "lists", -0.6, "data", "vernacular-names.json", "the tree's labels"),
    ("coldiff", "precomputed", 0.25, "data", "CoL differences", "3 tables + col-revisions.json"),
    ("summaries", "precomputed", 1.25, "data", "summaries", "4 JSON files"),
    ("search", "precomputed", 2.25, "data", "search", "name, rank and synonym indexes"),
    ("checks", "checks", 1.25, "else", "fixtures · data tests · comparison", "sync.json, sync.log, compare/"),
]
EDGES = [
    ("in_col", "taxa"), ("in_seeds", "taxa"), ("in_col", "names"), ("in_inat", "names"), ("taxa", "names"),
    ("in_rl", "assessments"), ("in_seeds", "assessments"), ("in_gbif", "occ"), ("in_gbif", "occc"), ("taxa", "occ"),
    ("assessments", "matches"), ("in_col", "matches"),
    ("taxa", "link"), ("assessments", "link"), ("matches", "link"), ("in_seeds", "link"), ("link", "queue"),
    ("taxa", "owner"), ("link", "owner"), ("owner", "counts"), ("occ", "counts"), ("assessments", "counts"),
    ("taxa", "species"), ("link", "species"), ("taxa", "appt"), ("link", "appt"),
    ("assessments", "assessed"), ("counts", "assessed"), ("names", "assessed"), ("assessments", "history"), ("history", "assessed"),
    ("species", "ne"), ("counts", "ne"), ("occc", "ne"), ("names", "ne"), ("names", "vern"),
    ("appt", "coldiff"), ("assessed", "coldiff"), ("species", "coldiff"),
    ("assessed", "summaries"), ("ne", "summaries"), ("species", "summaries"), ("coldiff", "summaries"),
    ("assessed", "search"), ("ne", "search"), ("names", "search"), ("vern", "search"), ("appt", "search"),
    ("coldiff", "checks"), ("summaries", "checks"), ("search", "checks"),
]

LANE_W, ROW_H, X0 = 420, 175, 330


def label(kind, title, sub):
    fill, border = FILL[kind]
    return (f'<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6" BGCOLOR="{fill}" COLOR="{border}">'
            f'<TR><TD><FONT POINT-SIZE="17"><B>{html.escape(title)}</B></FONT></TD></TR>'
            f'<TR><TD><FONT POINT-SIZE="12" COLOR="#495057">{html.escape(sub)}</FONT></TD></TR></TABLE>>')


out = ['digraph overview {',
       '  graph [splines=true, overlap=true, bgcolor="white", pad=0.5, fontname="Helvetica",',
       '         label=<<FONT POINT-SIZE="30"><B>The sync</B></FONT><BR ALIGN="LEFT"/><FONT POINT-SIZE="15" COLOR="#495057">'
       'Every table it builds, by stage and by source, and what each is built from. Only link and count make judgements.<BR ALIGN="LEFT"/>'
       'Grey: input. Yellow: decisions people made. Green: working table (build/core/). Orange: published (build/data/). White: elsewhere.<BR ALIGN="LEFT"/>'
       'Each table\'s columns are in the table reference below.<BR ALIGN="LEFT"/></FONT>>, labelloc=t, labeljust=l];',
       '  node [shape=plaintext, fontname="Helvetica", fontcolor="#1e1e1e"];',
       '  edge [color="#868e96", arrowsize=0.7, penwidth=1.1];']
rows = {s[0]: i for i, s in enumerate(STAGES)}
for i, (sid, name, what) in enumerate(STAGES):
    y = -i * ROW_H
    out.append(f'  band_{sid} [label=<<FONT POINT-SIZE="19"><B>{html.escape(name)}</B></FONT><BR/>'
               f'<FONT POINT-SIZE="12" COLOR="#6c757d">{html.escape(what).replace(chr(10), "<BR/>")}</FONT>>, pos="0,{y}!"];')
for j, (lane, at) in enumerate(LANES):
    out.append(f'  lane_{j} [label=<<FONT POINT-SIZE="20" COLOR="#495057"><B>{html.escape(lane)}</B></FONT>>, pos="{X0 + at * LANE_W + 120:.0f},{ROW_H * 0.6:.0f}!"];')
for nid, stage, lane, kind, title, sub in NODES:
    out.append(f'  {nid} [label={label(kind, title, sub)}, pos="{X0 + lane * LANE_W + 120:.0f},{-rows[stage] * ROW_H}!"];')
for a, b in EDGES:
    out.append(f'  {a} -> {b};')
out.append("}")
open(OUT, "w").write("\n".join(out) + "\n")
print(f"wrote {OUT}")
