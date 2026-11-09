"""How an assessed species is linked to a CoL species: the two questions the link
stage answers (docs/sync.md, "Matching"), with every branch's count and a real
species that takes it.

Usage: python3 -I link_flow.py <build dir> <out.dot>
Render: dot -Tpng -Gdpi=110 <out.dot> -o <out.png>

Counts come from the build. Each example is checked against it too: if a species
no longer takes its branch (CoL moved it, a rule changed), this stops, so the
diagram never shows an example its own data contradicts. Pick a new one then.
"""
import html, json, os, subprocess, sys

BUILD, OUT = os.path.expanduser(sys.argv[1]), sys.argv[2]
CORE = os.path.join(BUILD, "core")


def q(s):
    """A SQL string literal."""
    return "'" + s.replace("'", "''") + "'"


def duck(sql):
    out = subprocess.run(["duckdb", "-json", "-c", sql], capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else []


LINKS = f"""(SELECT l.*, a.scientific_name AS iucn, t.scientific_name AS col
  FROM read_parquet('{CORE}/assessment_link.parquet') l
  JOIN read_parquet('{CORE}/assessments.parquet') a ON a.sis_taxon_id = l.sis_taxon_id AND a.is_latest
  LEFT JOIN read_parquet('{CORE}/taxa.parquet') t ON t.col_id = l.col_id
  WHERE l.role = 'primary')"""
QUEUE = f"read_csv('{BUILD}/match-queue.tsv', delim='\\t', header=true, quote='', all_varchar=true)"

# Each branch: how to count it, and a species that takes it (checked below).
NAME_BRANCHES = {
    "decision": ("basis = 'decision'", "Acer divergens"),
    "matcher": ("basis = 'matcher'", "Panthera leo"),
    "unlinked": ("col_id IS NULL", "Diospyros sp. nov. 'malcomberi'"),
}
CONCEPT_BRANCHES = {
    "accepted": ("verdict = 'own' AND method = 'accepted'", "Panthera leo"),
    "renamed": ("verdict = 'own' AND method IN ('synonym', 'provisional')", "Glossopsitta porphyrocephala"),
    "lumped": ("verdict = 'lumped' AND method <> 'ambiguous_synonym'", "Tetraodon biocellatus"),
    "refused": ("verdict = 'refused'", "Turcichondrostoma fahirae"),
    "ambiguous": ("method = 'ambiguous_synonym'", "Astragalus albanicus"),
    "duplicate": ("verdict = 'duplicate'", "Agapanthia probsti"),
}
QUEUE_REASONS = [  # reason, example: the commonest reasons the matcher's answer waits for a person
    ("spelling variant", "Pseudechis pailsi"),
    ("homonym the authors don't decide", "Boscia senegalensis"),
    ("no species match", "Sudanonautes orthostylis"),
    ("informal or qualified name", "Diospyros sp. nov. 'malcomberi'"),
]


def branch(where, example):
    [r] = duck(f"SELECT count(*) AS n, count(*) FILTER (iucn = {q(example)}) AS hit,"
               f" any_value(col) FILTER (iucn = {q(example)}) AS col FROM {LINKS} WHERE {where}")
    if not r["hit"]:
        sys.exit(f"link_flow: {example} no longer takes the branch `{where}`; pick another example")
    return r["n"], r["col"]


name = {k: branch(w, e) for k, (w, e) in NAME_BRANCHES.items()}
concept = {k: branch(w, e) for k, (w, e) in CONCEPT_BRANCHES.items()}
queue = {}
for reason, example in QUEUE_REASONS:
    [r] = duck(f"SELECT count(*) AS n, count(*) FILTER (name = {q(example)}) AS hit,"
               f" any_value(authority) FILTER (name = {q(example)}) AS a,"
               f" any_value(matcher_name) FILTER (name = {q(example)}) AS m,"
               f" any_value(matcher_authorship) FILTER (name = {q(example)}) AS ma FROM {QUEUE} WHERE reason = {q(reason)}")
    if not r["hit"]:
        sys.exit(f"link_flow: {example} is no longer queued as '{reason}'; pick another example")
    queue[reason] = (r["n"], example, r["a"], r["m"], r["ma"])
[queued] = duck(f"SELECT count(*) AS n FROM {QUEUE}")

# The versions matched: one Red List release against one CoL release, as this build's sync.json records them.
manifest = json.load(open(os.path.join(BUILD, "data", "sync.json")))
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
       '  graph [rankdir=TB, nodesep=0.35, ranksep=0.45, pad=0.4, bgcolor="white", fontname="Helvetica", labelloc=t, labeljust=l,',
       '         label=<<FONT POINT-SIZE="26"><B>Which CoL species an assessed species is</B></FONT><BR ALIGN="LEFT"/>'
       f'<FONT POINT-SIZE="16"><B>{E(RL)} × {E(XR["alias"])}</B></FONT><FONT POINT-SIZE="14" COLOR="#495057">   (CoL\'s newest extended release, of {E(XR["issued"])}, and curated release {E(CK["alias"])}, the one it was built from; '
       f'GBIF\'s {E(SNAP)} snapshot mapped onto it)</FONT><BR ALIGN="LEFT"/>'
       '<FONT POINT-SIZE="14" COLOR="#495057">Two questions, answered separately. Counts: assessed species in this build; each example is a real species taking that branch.</FONT><BR ALIGN="LEFT"/>>];',
       '  node [shape=plaintext, fontname="Helvetica"]; edge [color="#868e96", fontname="Helvetica", fontsize=12, fontcolor="#495057", arrowsize=0.7];']

def named(n, a):
    return f'<I>{E(n)}</I> {E(a or "")}'.strip()


def queue_line(reason, n, e, a, m, ma):
    # The homonym's point is its authors; elsewhere the name alone says it.
    show = (lambda x, y: named(x, y)) if reason.startswith("homonym") else (lambda x, y: f"<I>{E(x)}</I>")
    return f'{E(reason)} ({n:,}): {show(e, a)}' + (f', matcher: {show(m, ma)}' if m else "")


out.append(f'  start [label={box("src", "A Red List species: its name and authority")}];')
out.append(f'  q1 [label={box("q", "1. Which CoL name is it?")}];')
out.append(f'  mat [label={box("own", "matching-ws, when its answer is certain", ["the name found exactly, as a species, with full confidence,", "and no same-spelled name leads elsewhere (unless the authors decide);", "a synonym only if its authors could be the Red List's", eg("Panthera leo", name["matcher"][1])], name["matcher"][0])}];')
out.append(f'  queue [label={box("q", "Otherwise a person decides: the match queue", [queue_line(r, *v) for r, v in queue.items()], queued["n"])}];')
out.append(f'  dec [label={box("own", "Decided: a row in decisions.tsv", ["carried over from the old matching passes, or drafted by an agent; none reviewed yet", eg("Acer divergens", name["decision"][1])], name["decision"][0])}];')
out.append(f'  und [label={box("none", "Not yet decided: linked to nothing", ["counts no records until someone decides", f"<I>{E(NAME_BRANCHES['unlinked'][1])}</I>"], name["unlinked"][0])}];')
out.append(f'  q2 [label={box("q", "2. What does that CoL name make the species?")}];')
out.append(f'  acc [label={box("own", "An accepted species: the species itself", [eg("Panthera leo", concept["accepted"][1])], concept["accepted"][0])}];')
out.append(f'  ren [label={box("own", "A synonym: the species, renamed", [eg("Glossopsitta porphyrocephala", concept["renamed"][1])], concept["renamed"][0])}];')
out.append(f'  lum [label={box("part", "A synonym CoL folds into another species: lumped", ["counts only the records filed under its own name", eg("Tetraodon biocellatus", concept["lumped"][1])], concept["lumped"][0])}];')
out.append(f'  amb [label={box("part", "An ambiguous synonym: its own name\'s records only", [eg("Astragalus albanicus", concept["ambiguous"][1])], concept["ambiguous"][0])}];')
out.append(f'  ref [label={box("none", "Folded into a species IUCN assesses too: refused", ["counts nothing", eg("Turcichondrostoma fahirae", concept["refused"][1])], concept["refused"][0])}];')
out.append(f'  dup [label={box("none", "Its CoL name is already another assessment\'s: duplicate", ["each CoL name counts for one assessed species, so this counts nothing", eg("Agapanthia probsti", concept["duplicate"][1])], concept["duplicate"][0])}];')

out += ['  start -> q1; q1 -> mat [label="  certain"]; q1 -> queue [label="  not certain"];',
        '  queue -> dec; queue -> und;',
        '  { rank=same; mat; queue }',
        '  mat -> q2; dec -> q2;',
        '  q2 -> acc; q2 -> ren; q2 -> lum; q2 -> amb;',
        '  { rank=same; acc; ren; lum; amb }',
        '  lum -> ref [label="  if IUCN assesses that species"];',
        '  ren -> dup [label="  if another assessment\\n  already has that name", style=dotted];',
        '}']
open(OUT, "w").write("\n".join(out) + "\n")
print(f"wrote {OUT}")
