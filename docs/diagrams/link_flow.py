"""How an assessed species is linked to a CoL species: the two questions the link
stage answers (docs/sync.md, "Matching"), with every branch's count and a real
species that takes it. Question 1's branches must cover every assessed species.

Usage: python3 -I link_flow.py <build dir> <out.dot>
Render: dot -Tpng -Gdpi=110 <out.dot> -o <out.png>

Counts come from the build. Each example is checked against it too: if a species
no longer takes its branch (CoL moved it, a rule changed), this stops, so the
diagram never shows an example its own data contradicts. Pick a new one then.
"""
import html, json, os, subprocess, sys

BUILD, OUT = os.path.expanduser(sys.argv[1]), sys.argv[2]
CORE = os.path.join(BUILD, "working")


def q(s):
    """A SQL string literal."""
    return "'" + s.replace("'", "''") + "'"


def duck(sql):
    out = subprocess.run(["duckdb", "-json", "-c", sql], capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else []


LINKS = f"""(SELECT l.*, a.scientific_name AS iucn, a.authority, t.scientific_name AS col, m.match_type
  FROM read_parquet('{CORE}/link/assessment_link.parquet') l
  JOIN read_parquet('{CORE}/sources/assessments.parquet') a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
  LEFT JOIN read_parquet('{CORE}/sources/taxa.parquet') t ON t.col_id = l.col_species_id
  LEFT JOIN read_parquet('{CORE}/link/matches.parquet') m ON m.sis_taxon_id = l.sis_taxon_id
  WHERE l.role = 'primary')"""

PICKED = "match_reason = 'flagged: picked by the author citation'"
UNSETTLED = "match_reason = 'flagged: homonym the authors don''t decide'"
# Each branch of question 1, by match_reason: how to count it, and a species that takes it (checked below).
NAME_BRANCHES = {
    "decision": ("basis = 'decision'", "Cipangopaludina chinensis"),
    "unique": ("match_reason IN ('exact, unique', 'exact, duplicate in CoL', 'spelling variant', 'spelling variant, duplicate in CoL')", "Panthera leo"),
    "settled": ("match_reason LIKE '%homonym, author decides'", "Coturnix coturnix"),
    "picked_homonym": (f"{PICKED} AND match_type <> 'HIGHERRANK'", "Weinmannia heterophylla"),
    "picked_genus": (f"{PICKED} AND match_type = 'HIGHERRANK'", "Rubus fruticosus"),
    "unsettled": (UNSETTLED, "Buteo rufinus"),
    "doubt": (f"match_reason LIKE 'flagged: %' AND NOT ({PICKED}) AND NOT ({UNSETTLED})", "Agrotis sabine"),
    "none": ("col_species_id IS NULL", "Breviceps batrachophiliorum"),
}
CONCEPT_BRANCHES = {
    "accepted": ("col_treatment = 'accepted' AND counts = 'the whole CoL species'", "Panthera leo"),
    "renamed": ("col_treatment LIKE 'synonym, %' AND counts = 'the whole CoL species'", "Glossopsitta porphyrocephala"),
    "lumped": ("col_treatment = 'lumped, unassessed' AND counts <> 'nothing' AND method <> 'ambiguous_synonym'", "Tetraodon biocellatus"),
    "refused": ("col_treatment = 'lumped, assessed'", "Turcichondrostoma fahirae"),
    "duplicate": ("counts = 'nothing' AND col_species_id IS NOT NULL AND col_treatment <> 'lumped, assessed'", "Agapanthia probsti"),
}
def branch(where, example):
    [r] = duck(f"SELECT count(*) AS n, count(*) FILTER (iucn = {q(example)}) AS hit,"
               f" any_value(col) FILTER (iucn = {q(example)}) AS col FROM {LINKS} WHERE {where}")
    if not r["hit"]:
        sys.exit(f"link_flow: {example} no longer takes the branch `{where}`; pick another example")
    return r["n"], r["col"]


name = {k: branch(w, e) for k, (w, e) in NAME_BRANCHES.items()}
concept = {k: branch(w, e) for k, (w, e) in CONCEPT_BRANCHES.items()}
[total] = duck(f"SELECT count(*) AS n FROM {LINKS}")
if sum(n for n, _ in name.values()) != total["n"]:
    sys.exit(f"link_flow: question 1's branches cover {sum(n for n, _ in name.values()):,} of {total['n']:,} species; a match_reason is missing")
# The other doubts, by label, largest first.
doubts = duck(f"SELECT replace(match_reason, 'flagged: ', '') AS d, count(*) AS n FROM {LINKS} WHERE {NAME_BRANCHES['doubt'][0]} GROUP BY 1 ORDER BY n DESC")
# Of the unlinked, those that still count records through a covered row (a name the Red List lists as a synonym).
[via] = duck(f"""SELECT count(*) AS n FROM {LINKS} p WHERE p.col_species_id IS NULL AND EXISTS (SELECT 1 FROM read_parquet('{CORE}/link/assessment_link.parquet') c
  WHERE c.sis_taxon_id = p.sis_taxon_id AND c.role = 'covered' AND c.counted)""")
[ex] = duck(f"SELECT any_value(authority) FILTER (iucn = 'Weinmannia heterophylla') AS w, any_value(authority) FILTER (iucn = 'Coturnix coturnix') AS c FROM {LINKS}")

# The versions matched: one Red List release against one CoL release, as this build's sync.json records them.
manifest = json.load(open(os.path.join(BUILD, "publish", "sync.json")))
RL = manifest["redlist"]["database"].replace("redlist_", "Red List ").replace("_", "-")
XR = manifest["col"]["xr"]
CK = manifest["col"]["checklist"]
SNAP = manifest["gbif"]["snapshot"]

E = html.escape
FILL = {"q": ("#eef2f6", "#5b6b7c"), "rule": ("#ffffff", "#5b6b7c"), "own": ("#e3f2e6", "#2c7a3f"),
        "part": ("#fff4dc", "#a26b00"), "none": ("#f6e3e3", "#9a3b3b"), "src": ("#f1f3f5", "#868e96")}


def box(kind, title, lines=(), count=None):
    fill, border = FILL[kind]
    rows = f'<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="15"><B>{E(title)}</B></FONT>'
    rows += f'<FONT POINT-SIZE="13" COLOR="#495057">   {count:,}</FONT>' if count is not None else ""
    rows += "</TD></TR>"
    for line in lines:
        rows += f'<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="12" COLOR="#343a40">{line}</FONT></TD></TR>'
    return (f'<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="5" BGCOLOR="{fill}" COLOR="{border}">'
            f'{rows}</TABLE>>')


def eg(iucn, col):
    return f'<I>{E(iucn)}</I> → <I>{E(col)}</I>'


out = ['digraph link {',
       '  graph [rankdir=TB, newrank=true, nodesep=0.35, ranksep=0.45, pad=0.4, bgcolor="white", fontname="Helvetica", labelloc=t, labeljust=l,',
       '         label=<<FONT POINT-SIZE="26"><B>Which CoL species an assessed species is</B></FONT><BR ALIGN="LEFT"/>'
       f'<FONT POINT-SIZE="16"><B>{E(RL)} × {E(XR["alias"])}</B></FONT><FONT POINT-SIZE="14" COLOR="#495057">   (CoL\'s extended release of {E(XR["issued"])}: the one GBIF\'s {E(SNAP)} occurrence snapshot is keyed to; '
       f'curated release {E(CK["alias"])}, the one it was built from)</FONT><BR ALIGN="LEFT"/>'
       '<FONT POINT-SIZE="14" COLOR="#495057">Two questions, answered separately. Counts: assessed species in this build; each example is a real species taking that branch.</FONT><BR ALIGN="LEFT"/>>];',
       '  node [shape=plaintext, fontname="Helvetica"]; edge [color="#868e96", fontname="Helvetica", fontsize=12, fontcolor="#495057", arrowsize=0.7];']

def node(nid, kind, title, lines=(), count=None):
    out.append(f"  {nid} [label={box(kind, title, lines, count)}];")


def n(k):
    return name[k][0]


doubt_text = [f"{E(d['d'])} ({d['n']:,})" for d in doubts]
node("start", "src", "A Red List species: its name and authority")
node("q1", "q", "1. Which CoL record is it?")
node("dec", "own", "A row in match-overrides.tsv",
     ["a person's decision beats the matcher, for the releases it names", eg("Cipangopaludina chinensis", name["decision"][1])], n("decision"))
node("mat", "q", "GBIF's matcher (matching-ws), on the bare name",
     ["returns its best CoL record, and every record spelt the same that it weighed (the alternatives);",
      "it isn't given the author citation, as most GBIF records carry none,",
      "so its answer is where GBIF files records carrying that bare name"])
node("uniq", "own", "One CoL species has the name: the matcher's answer, confirmed",
     ["found exactly (or spelt only as the codes allow), with full confidence;",
      "CoL holding the species twice still counts as one", eg("Panthera leo", name["unique"][1])], n("unique"))
node("cite", "q", "Several species share the name, or the matcher found only the genus",
     ["the Red List's author citation decides (citationPick), among the matcher's answer and its alternatives:",
      "whose citations match it, and do they all lead to one species?"])
node("settled", "own", "It picks the matcher's answer: settled",
     [f"<I>Coturnix coturnix</I> {E(ex['c'] or '')}: the quail, not CoL's other <I>Coturnix coturnix</I>"], n("settled"))
node("picked", "part", "⚑ It picks another record: that one counts",
     ["when the matcher's answer is clearly someone else's, or only the genus:",
      f"<I>Weinmannia heterophylla</I> {E(ex['w'] or '')} → CoL's Ruiz &amp; Pav. ex López, not Kunth's ({n('picked_homonym'):,})",
      f"<I>Rubus fruticosus</I> L. → Linnaeus's record; the matcher said only <I>Rubus</I> ({n('picked_genus'):,})"],
     n("picked_homonym") + n("picked_genus"))
node("unset", "part", "⚑ It can't tell: the matcher's answer counts",
     ["no citation matches for sure (a year apart, a bare initial, none given)",
      "<I>Buteo rufinus</I> (Cretzschmar, 1827); CoL's is dated 1829"], n("unsettled"))
node("doubt", "part", "⚑ Another doubt: the matcher's answer counts",
     [", ".join(doubt_text[:3]) + ",", ", ".join(doubt_text[3:]),
      eg("Agrotis sabine", name["doubt"][1]) + ", spelt differently"], n("doubt"))
node("none", "none", "No link: nothing to count through",
     ["CoL has nothing at species level to pick, or the Red List marks the name",
      "another taxon or not yet one (aff., cf., sp. nov., non, sensu)",
      f"<I>{E(NAME_BRANCHES['none'][1])}</I>: the matcher found only <I>Breviceps</I>",
      f"({via['n']:,} of them still count records under a name the Red List lists as a synonym, flagged)"], n("none"))
out.append('  linked [shape=point, width=0.08, color="#868e96"];')
out.append(f'  q2 [label={box("q", "2. What does that CoL name make the species?")}];')
out.append(f'  acc [label={box("own", "accepted", ["CoL accepts the Red List name; counts the whole CoL species", eg("Panthera leo", concept["accepted"][1])], concept["accepted"][0])}];')
out.append(f'  ren [label={box("own", "synonym, other name / other spelling", ["CoL accepts the species under another name; counts the whole CoL species", eg("Glossopsitta porphyrocephala", concept["renamed"][1])], concept["renamed"][0])}];')
out.append(f'  lum [label={box("part", "lumped, unassessed", ["CoL folds it into a species the Red List doesn't assess;", "counts only the records under its own name", eg("Tetraodon biocellatus", concept["lumped"][1])], concept["lumped"][0])}];')
out.append(f'  ref [label={box("none", "lumped, assessed", ["CoL folds it into a species the Red List assesses too;", "counts nothing", eg("Turcichondrostoma fahirae", concept["refused"][1])], concept["refused"][0])}];')
out.append(f'  dup [label={box("none", "counts nothing: another assessment owns that CoL species", ["each CoL species counts for one assessed species", eg("Agapanthia probsti", concept["duplicate"][1])], concept["duplicate"][0])}];')

out += ['  start -> q1; q1 -> mat; q1 -> dec [label="  if a person decided"];',
        '  { rank=same; mat; dec }',
        '  mat -> uniq; mat -> cite; mat -> none; mat -> doubt;',
        '  { rank=same; uniq; cite; none; doubt }',
        '  uniq -> cite -> none -> doubt [style=invis];',
        '  cite -> settled; cite -> picked; cite -> unset; cite -> none [style=dotted, label="  only the genus, no pick"];',
        '  { rank=same; settled; picked; unset }',
        '  settled -> picked -> unset [style=invis];',
        '  uniq -> linked [arrowhead=none]; settled -> linked [arrowhead=none]; picked -> linked [arrowhead=none];',
        '  unset -> linked [arrowhead=none]; doubt -> linked [arrowhead=none]; dec -> linked [arrowhead=none];',
        '  linked -> q2 [label="  ⚑ a flagged link loses to a confirmed one over the same records"];',
        '  q2 -> acc; q2 -> ren; q2 -> lum;',
        '  { rank=same; acc; ren; lum }',
        '  lum -> ref [label="  if IUCN assesses that species"];',
        '  ren -> dup [label="  if another assessment\\n  already has that name", style=dotted];',
        '}']
open(OUT, "w").write("\n".join(out) + "\n")
print(f"wrote {OUT}")
