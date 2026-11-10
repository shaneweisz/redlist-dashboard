"""The sync at a glance: its stages top to bottom, its three sources left to
right, every table it builds, and what each is built from.

Usage: python3 -I sync_overview.py <out.dot>
Render: neato -n2 -Tpng -Gdpi=110 <out.dot> -o <out.png>   (positions are fixed; Graphviz routes the arrows)

The columns of each table are in the header of the file that builds it.
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
LANES = [("Catalogue of Life", 0.2), ("Red List", 1.65), ("GBIF", 2.6), ("Specialist Groups", 3.55)]

# (id, stage, lane position (fractions allowed), kind, title, subtitle). A subtitle
# starting "dbt · " is a dbt model (app/scripts/sync/dbt/); the rest is TypeScript.
NODES = [
    ("in_col", "inputs", 0.0, "input", "CoL XR + curated checklist", "the release GBIF indexes"),
    ("in_inat", "inputs", 0.75, "input", "iNaturalist names", "monthly"),
    ("in_rl", "inputs", 1.25, "input", "Red List database", "read-only"),
    ("in_seeds", "inputs", 1.75, "seed", "seeds/", "people's decisions, each with why"),
    ("in_gbif", "inputs", 2.5, "input", "GBIF snapshot", "monthly, ~255 GiB, reduced once"),
    ("in_sg", "inputs", 3.55, "else", "src/config/specialist-groups.ts", "the remits, as the app shows them"),
    ("taxa", "sources", 0.0, "core", "taxa", "one row per CoL usage"),
    ("names", "sources", 0.75, "core", "common_names", "one row per name a source gives"),
    ("assessments", "sources", 1.5, "core", "assessments", "one row per global assessment"),
    ("occ", "sources", 2.25, "core", "occurrences", "usage × georef × date"),
    ("occc", "sources", 2.9, "core", "occurrence_countries", "usage × country × georef"),
    ("remits", "sources", 3.55, "core", "specialist_group_remits", "+ rank_aliases; written every run"),
    ("matches", "link", 1.5, "core", "matches", "matching-ws's answer per species"),
    ("link", "link", 0.75, "core", "assessment_link", "assessed species → CoL species it is"),
    ("queue", "link", 2.25, "else", "match-queue.tsv", "review/: species waiting for a person"),
    ("owner", "count", 1.0, "core", "usage_owner", "dbt · one row per usage: whose records"),
    ("counts", "count", 2.0, "core", "record_counts", "dbt · one row per species with records"),
    ("species", "lists", 0.0, "data", "species/", "dbt · lists/: the universe, described"),
    ("appt", "lists", 0.75, "data", "taxa + assessment_link", "dbt · taxonomy/: as the app reads them"),
    ("assessed", "lists", 1.5, "data", "assessed", "dbt · lists/: one per assessed species"),
    ("history", "lists", 2.15, "data", "assessments", "dbt · lists/: history, one per year"),
    ("ne", "lists", 2.8, "data", "ne", "dbt · lists/: Not Evaluated with records"),
    ("vern", "lists", -0.6, "data", "vernacular-names.json", "dbt · taxonomy/: the tree's labels"),
    ("sgspecies", "lists", 3.55, "core", "specialist_group_species", "dbt · each species' group, at most one"),
    ("coldiff", "precomputed", 0.0, "data", "CoL differences", "dbt · taxonomy/: 3 col-*.parquet"),
    ("colrev", "precomputed", 0.75, "data", "col-revisions.json", "taxonomy/: app code, the revision flags"),
    ("summaries", "precomputed", 1.6, "data", "summaries", "summaries/: app code, 4 JSON files"),
    ("search", "precomputed", 2.5, "data", "search", "dbt · search/: name, rank, synonym indexes"),
    ("checks", "checks", 1.25, "else", "dbt tests · fixtures · data tests · comparison", "published/sync.json, sync.log; review/changes/"),
]
EDGES = [
    ("in_col", "taxa"), ("in_seeds", "taxa"), ("in_col", "names"), ("in_inat", "names"), ("taxa", "names"),
    ("in_rl", "assessments"), ("in_seeds", "assessments"), ("in_gbif", "occ"), ("in_gbif", "occc"), ("taxa", "occ"),
    ("in_sg", "remits"),
    ("assessments", "matches"), ("in_col", "matches"),
    ("taxa", "link"), ("assessments", "link"), ("matches", "link"), ("in_seeds", "link"), ("link", "queue"),
    ("taxa", "owner"), ("link", "owner"), ("owner", "counts"), ("occ", "counts"), ("assessments", "counts"),
    ("remits", "sgspecies"), ("taxa", "sgspecies"), ("assessments", "sgspecies"),
    ("taxa", "species"), ("link", "species"), ("sgspecies", "species"), ("taxa", "appt"), ("link", "appt"),
    ("assessments", "assessed"), ("counts", "assessed"), ("names", "assessed"), ("assessments", "history"), ("history", "assessed"),
    ("sgspecies", "assessed"),
    ("species", "ne"), ("counts", "ne"), ("occc", "ne"), ("names", "ne"), ("names", "vern"),
    ("appt", "coldiff"), ("assessed", "coldiff"),
    ("coldiff", "colrev"), ("species", "colrev"), ("assessed", "colrev"),
    ("assessed", "summaries"), ("ne", "summaries"), ("species", "summaries"), ("coldiff", "summaries"), ("sgspecies", "summaries"),
    ("assessed", "search"), ("ne", "search"), ("names", "search"), ("vern", "search"), ("appt", "search"), ("species", "search"),
    ("coldiff", "checks"), ("colrev", "checks"), ("summaries", "checks"), ("search", "checks"), ("sgspecies", "checks"),
]

LANE_W, ROW_H, X0 = 420, 175, 330


def label(kind, title, sub):
    fill, border = FILL[kind]
    tag = ""
    if sub.startswith("dbt · "):
        sub = sub[len("dbt · "):]
        tag = '<FONT POINT-SIZE="12" COLOR="#ffffff"><B> dbt </B></FONT>'
    return (f'<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="6" BGCOLOR="{fill}" COLOR="{border}">'
            f'<TR><TD><FONT POINT-SIZE="17"><B>{html.escape(title)}</B></FONT></TD>'
            + (f'<TD BGCOLOR="#5f3dc4">{tag}</TD>' if tag else '') + '</TR>'
            f'<TR><TD{" COLSPAN=\"2\"" if tag else ""}><FONT POINT-SIZE="12" COLOR="#495057">{html.escape(sub)}</FONT></TD></TR></TABLE>>')


out = ['digraph overview {',
       '  graph [splines=true, overlap=true, bgcolor="white", pad=0.5, fontname="Helvetica",',
       '         label=<<FONT POINT-SIZE="30"><B>The sync</B></FONT><BR ALIGN="LEFT"/><FONT POINT-SIZE="15" COLOR="#495057">'
       'Every table it builds, by stage and by source, and what each is built from. Only link and count make judgements.<BR ALIGN="LEFT"/>'
       'Grey: input. Yellow: decisions people made. Green: working table (.sync/working/&lt;stage&gt;/). Orange: published, in the .sync/published/ folder its subtitle names. White: elsewhere.<BR ALIGN="LEFT"/>'
       'Purple tag: a dbt model (app/scripts/sync/dbt/; npm run sync:lineage draws its graph). Everything else is TypeScript.<BR ALIGN="LEFT"/>'
       'Each table\'s columns are in the header of the file that builds it.<BR ALIGN="LEFT"/></FONT>>, labelloc=t, labeljust=l];',
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
