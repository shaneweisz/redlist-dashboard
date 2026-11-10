"""The versions a sync holds together: which must agree with which, and what
makes them agree, a check or a person. Read from a build's sync.json, plus
GBIF's answer to which CoL release its live index runs now.

Usage: python3 -I versions.py <build dir> <out.dot>
Render: dot -Tpng -Gdpi=110 <out.dot> -o <out.png>
"""
import html, json, os, sys, urllib.request

BUILD, OUT = sys.argv[1], sys.argv[2]
m = json.load(open(os.path.join(BUILD, "publish", "sync.json")))
xr, checklist = m["col"]["xr"], m["col"]["checklist"]
with urllib.request.urlopen("https://api.gbif.org/v2/species/match/metadata?checklistKey=xcol", timeout=30) as r:
    live = json.load(r).get("mainIndex", {})
live_alias, live_key = live.get("datasetAlias", "?"), live.get("clbDatasetKey", "?")
moved = live_key != xr["key"]

CHECK, HAND, FREE = "#2b8a3e", "#e8590c", "#868e96"


def node(nid, title, sub, fill="#f8f9fa", border="#868e96"):
    return (f'  {nid} [label=<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="7" BGCOLOR="{fill}" COLOR="{border}">'
            f'<TR><TD><FONT POINT-SIZE="16"><B>{html.escape(title)}</B></FONT></TD></TR>'
            f'<TR><TD><FONT POINT-SIZE="12" COLOR="#495057">{html.escape(sub).replace(chr(10), "<BR/>")}</FONT></TD></TR></TABLE>>];')


def edge(a, b, how, colour, style="solid"):
    return f'  {a} -> {b} [color="{colour}", fontcolor="{colour}", style={style}, label=<<FONT POINT-SIZE="12">{html.escape(how).replace(chr(10), "<BR/>")}</FONT>>];'


out = ['digraph versions {',
       '  graph [rankdir=LR, bgcolor="white", pad=0.4, nodesep=0.5, ranksep=1.1, fontname="Helvetica",',
       '         label=<<FONT POINT-SIZE="28"><B>The versions a sync holds together</B></FONT><BR ALIGN="LEFT"/>'
       '<FONT POINT-SIZE="14" COLOR="#495057">Each arrow: one version decides another. '
       f'<FONT COLOR="{CHECK}"><B>Green</B></FONT>: a check enforces it. '
       f'<FONT COLOR="{HAND}"><B>Orange</B></FONT>: a person has to. '
       f'<FONT COLOR="{FREE}"><B>Grey</B></FONT>: free to differ.<BR ALIGN="LEFT"/>'
       f'From the build of {html.escape(m["built_at"][:10])}, and GBIF\'s live index as of drawing.<BR ALIGN="LEFT"/></FONT>>, labelloc=t, labeljust=l];',
       '  node [shape=plaintext, fontname="Helvetica", fontcolor="#1e1e1e"];',
       '  edge [fontname="Helvetica", arrowsize=0.8, penwidth=1.6];',
       node("snapshot", f'GBIF snapshot {m["gbif"]["snapshot"]}', "every record, keyed by CoL id", "#e7f5ff", "#1c7ed6"),
       node("xr", f'{xr["alias"]} ({xr["key"]})', "every name and id the sync uses", "#d3f9d8", "#2b8a3e"),
       node("checklist", f'{checklist["alias"]} ({checklist["key"]})', "the curated release: which species are curated", "#d3f9d8", "#2b8a3e"),
       node("matcher", f'matching-ws {m["matching"]["matcher"]}', f'its index, built from {xr["key"]}', "#d3f9d8", "#2b8a3e"),
       node("from", "earlier stages' tables", "reused by npm run sync -- --from <stage>", "#d3f9d8", "#2b8a3e"),
       node("config", "src/config/col-release.json", "and col-taxon-ids.json: in the repo,\nimported by the app's client code"),
       node("live", f"GBIF's live index: {live_alias} ({live_key})", "what gbif.org and its API answer with now" + ("\n(newer than the snapshot's)" if moved else ""),
            "#fff4e6" if moved else "#e7f5ff", "#e8590c" if moved else "#1c7ed6"),
       node("panels", "the app's live panels", "map, record breakdown, photos, nearby, gbif.org links"),
       node("redlist", f'Red List {m["redlist"]["database"]}', f'{m["redlist"]["assessed_species"]:,} assessed species'),
       node("names", "match decisions · fixtures", "seeds/match-overrides.tsv, checks/fixtures/"),
       '  { rank=same; snapshot; live; }',
       '  { rank=same; redlist; names; }',
       edge("snapshot", "xr", "filed under: the build stops if more than\n0.1% of records have ids the XR lacks", CHECK),
       edge("live", "xr", "the sync takes the XR GBIF runs now;\nafter a re-index, COL_XR_DATASET must\nname the snapshot's until the next one", HAND),
       edge("xr", "checklist", "the release the XR was built from:\nworked out, and demotions stop the build", CHECK),
       edge("xr", "matcher", "an index per XR, cached by its key", CHECK),
       edge("xr", "from", "sources-releases.json: --from refuses\ntables built from other releases", CHECK),
       edge("xr", "config", "written by the sync, committed\nin the data PR", HAND),
       edge("live", "panels", "asked with our id and the id GBIF's\nmatcher gives our name there (#627)", CHECK),
       edge("names", "xr", "kept by name, not id: CoL\nrenumbers ~2% of ids a release", FREE, "dashed"),
       edge("redlist", "xr", "independent: DB_NAME;\nthe link is one release × one XR", FREE, "dashed"),
       "}"]
open(OUT, "w").write("\n".join(out) + "\n")
print(f"wrote {OUT}")
