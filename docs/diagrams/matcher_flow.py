"""How matching-ws picks a CoL name for a query: the steps it takes (from its source,
MatchingService.matchByClassification at the pinned release), each with a real query
and the scores the matcher itself reports for it (verbose=true).

Usage: python3 -I matcher_flow.py <matcher url> <build dir> <out.dot>
  the matcher: `npx tsx scripts/sync/inputs/matcher.ts` serves the sync's (http://localhost:8190)
Render: dot -Tpng -Gdpi=110 <out.dot> -o <out.png>

Each example is asked live and checked: if the matcher no longer answers it the way its
box says (a new XR moved the name, a new matcher release scores differently), this stops,
so the diagram never shows an example its own matcher contradicts. Pick a new one then.
"""
import html, json, os, re, subprocess, sys, urllib.parse, urllib.request

URL, BUILD, OUT = sys.argv[1].rstrip("/"), os.path.expanduser(sys.argv[2]), sys.argv[3]
CORE = os.path.join(BUILD, "core")
E = html.escape


def duck(sql):
    out = subprocess.run(["duckdb", "-json", "-c", sql], capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else []


def get(path):
    return json.load(urllib.request.urlopen(URL + path))


def q(s):
    return "'" + s.replace("'", "''") + "'"


def cap(s):
    return s[:1].upper() + s[1:].lower() if s else None


def ask(name, hints=True):
    """Ask the matcher about an assessed species the way the sync does (no authority: docs/sync.md says why), optionally without hints."""
    [a] = duck(f"""SELECT scientific_name, authority, kingdom_name, phylum_name, class_name, order_name, family
      FROM read_parquet('{CORE}/assessments.parquet') WHERE is_latest AND scientific_name = {q(name)}""")
    p = {"verbose": "true", "scientificName": a["scientific_name"]}
    if hints:
        for k, col in [("kingdom", "kingdom_name"), ("phylum", "phylum_name"), ("class", "class_name"),
                       ("order", "order_name"), ("family", "family")]:
            if a[col]:
                p[k] = cap(a[col])
    d = get("/v2/species/match?" + urllib.parse.urlencode(p))
    return a, d


def expect(d, name, match_type, what):
    u, t = (d.get("usage") or {}), d["diagnostics"]["matchType"]
    if (u.get("canonicalName") or u.get("name")) != name or t != match_type:
        sys.exit(f"matcher_flow: {what} now answers {u.get('name')} {t}, not {name} {match_type}; pick another example")


PARTS = [("name", "name"), ("authorship", "authority"), ("classification", "hints"), ("rank", "rank"), ("status", "status")]


def scores(diag):
    """The matcher's own score note as a sum: name 110 + authority 20 + ... = 185."""
    note = dict(re.findall(r"(\w+)=(-?\d+)", diag.get("note") or ""))
    terms = [(int(note[k]), label) for k, label in PARTS if k in note and int(note[k]) != 0]
    if "score" not in note or not terms:
        return ""
    (v0, l0), rest = terms[0], terms[1:]
    return f"{v0} {l0}" + "".join(f" {'−' if v < 0 else '+'} {abs(v)} {l}" for v, l in rest) + f" = {note['score']}"


def usage(u):
    return f'<I>{E(u.get("canonicalName") or u["name"])}</I> {E(u.get("authorship") or "")}'.strip()


meta = get("/v2/species/match/metadata")
XR = meta["mainIndex"]["datasetAlias"]
VERSION = next((l.split()[-1] for l in open(os.path.join(os.path.dirname(__file__), "..", "..", "app", "scripts", "sync",
                "inputs", "matcher.ts")) if "MATCHER_VERSION =" in l), "?").strip('";')

# --- the examples, asked live ---------------------------------------------------------------
_, variant = ask("Saprosma corymbosa")
expect(variant, "Saprosma corymbosum", "VARIANT", "Saprosma corymbosa")

_, hinted = ask("Solenopsis bicolor")
expect(hinted, "Solenopsis bicolor", "EXACT", "Solenopsis bicolor")
_, unhinted = ask("Solenopsis bicolor", hints=False)
if unhinted["diagnostics"]["matchType"] != "NONE":
    sys.exit("matcher_flow: Solenopsis bicolor without hints is no longer a tie; pick another example")
plant, ant = hinted, hinted["diagnostics"]["alternatives"][0]


_, tie = ask("Licania parviflora")
expect(tie, "Chrysobalanaceae", "HIGHERRANK", "Licania parviflora")

_, higher = ask("Diospyros sp. nov. 'mahaboensis'")
expect(higher, "Diospyros", "HIGHERRANK", "Diospyros sp. nov. 'mahaboensis'")

_, syn = ask("Glossopsitta porphyrocephala")
expect(syn, "Glossopsitta porphyrocephala", "EXACT", "Glossopsitta porphyrocephala")
if (syn["usage"].get("status") != "SYNONYM") or not syn.get("acceptedUsage"):
    sys.exit("matcher_flow: Glossopsitta porphyrocephala is no longer a synonym; pick another example")

tie_score = re.search(r"score=(\d+)", tie["diagnostics"]["alternatives"][0]["diagnostics"]["note"]).group(1)

counts = {r["match_type"]: r["n"] for r in duck(
    f"SELECT match_type, count(*) AS n FROM read_parquet('{CORE}/matches.parquet') GROUP BY 1")}

# --- drawing ----------------------------------------------------------------------------------
FILL = {"q": ("#eef2f6", "#5b6b7c"), "step": ("#ffffff", "#5b6b7c"), "eg": ("#f8f9fa", "#adb5bd"),
        "src": ("#f1f3f5", "#868e96"), "out": ("#e3f2e6", "#2c7a3f")}


def box(kind, title, lines=(), examples=()):
    fill, border = FILL[kind]
    rows = f'<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="15"><B>{E(title)}</B></FONT></TD></TR>'
    for line in lines:
        rows += f'<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="12" COLOR="#343a40">{line}</FONT></TD></TR>'
    for line in examples:
        rows += f'<TR><TD ALIGN="LEFT"><FONT POINT-SIZE="12" COLOR="#1c5d99">{line}</FONT></TD></TR>'
    return (f'<<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="5" BGCOLOR="{fill}" COLOR="{border}">'
            f'{rows}</TABLE>>')


def eg(text):
    return "e.g. " + text


d = lambda x: x["diagnostics"]
out = ['digraph matcher {',
       '  graph [rankdir=TB, nodesep=0.35, ranksep=0.35, pad=0.4, bgcolor="white", fontname="Helvetica", labelloc=t, labeljust=l,',
       '         label=<<FONT POINT-SIZE="26"><B>How matching-ws picks a CoL name</B></FONT><BR ALIGN="LEFT"/>'
       f'<FONT POINT-SIZE="16"><B>matching-ws {E(VERSION)} on {E(XR)}</B></FONT>'
       '<FONT POINT-SIZE="14" COLOR="#495057">   GBIF\'s own name matcher, the one it files occurrence records with, run locally</FONT><BR ALIGN="LEFT"/>'
       '<FONT POINT-SIZE="14" COLOR="#495057">The steps are its source\'s (MatchingService). Examples in blue are live answers, with the scores the matcher reports for them.</FONT><BR ALIGN="LEFT"/>>];',
       '  node [shape=plaintext, fontname="Helvetica"]; edge [color="#868e96", fontname="Helvetica", fontsize=12, fontcolor="#495057", arrowsize=0.7];']

out.append(f'  query [label={box("src", "The query, one per assessed species", ["the Red List name, with IUCN\'s kingdom, phylum, class, order and family as hints", "no authority: the acceptance rule compares it afterwards (docs/sync.md says why)"])}];')
out.append(f'  parse [label={box("step", "1. Parse the name", ["name-parser reduces it to its canonical form, and a binomial is read as a species", "an informal name (<I>sp. nov.</I>, <I>aff.</I>) keeps only what parses; hybrid formulas and codes get no fuzzy search"])}];')
out.append(f'  find [label={box("step", "2. Find candidates in the XR", ["up to 50 CoL usages: the same spelling (EXACT), or a VARIANT: the same once normalised", "(accents, Latin gender endings, doubled letters), or a letter away (two, for names over 10 letters)"], [eg(f"<I>Saprosma corymbosa</I> → {usage(variant['usage'])}, VARIANT, {E(scores(d(variant)))}")])}];')
out.append(f'  score [label={box("step", "3. Score every candidate", ["name: the same spelling 100, +10 for a binomial; a variant by its similarity, −10 if the genus differs", "authority, when one is sent (the sync sends none): agrees +12, the identical string +8 more, differs −36", "hints: kingdom +5 (plant against animal −51), phylum +10, class +15, order +15, family +25,", "   each mismatch −10 to −15, the total held to −60…+50", "status: accepted +1, synonym 0, ambiguous synonym −1, provisional −5, misapplied −10; rank a few points"], [eg(f"<I>Solenopsis bicolor</I> {E(plant['usage'].get('authorship') or '')}, a bellflower: {E(scores(d(plant)))}"), f"   against the ant of that name, {E(ant['usage'].get('authorship') or '')}: {E(scores(d(ant)))}", "   with no hints the two tie, and nothing is returned"])}];')
out.append(f'  pick [label={box("step", "4. Pick the best", ["the top score, plus up to 5 for its lead over the next, rescaled to a confidence of 0–100 (a raw 175 or more is 100)", "a tie: if the candidates share a classification, the oldest CoL id (CoL holding one name twice);", "   if not, the lowest taxon they share (HIGHERRANK), or nothing", "below 80 confidence: nothing"], [eg(f"<I>Licania parviflora</I>: two ambiguous synonyms, by different authors, tie at {tie_score} → the family {usage(tie['usage'])}")])}];')
out.append(f'  up [label={box("step", "5. No match at its own rank? Go up", ["a subspecies tries its species, then the genus, then the hints from family up to kingdom", "each a HIGHERRANK answer, which needs 90 confidence"], [eg(f"<I>Diospyros</I> sp. nov. \'mahaboensis\' → the genus {usage(higher['usage'])}")])}];')
out.append(f'  ans [label={box("out", "The answer", ["one CoL usage, which may be a synonym, with the accepted name it points to;", "its match type and confidence, and every alternative with its score",
            f"this build: EXACT {counts.get('EXACT', 0):,}, VARIANT {counts.get('VARIANT', 0):,}, HIGHERRANK {counts.get('HIGHERRANK', 0):,}, none {counts.get('NONE', 0):,}"], [eg(f"<I>Glossopsitta porphyrocephala</I>: a synonym, of {usage(syn['acceptedUsage'])}")])}];')
out.append(f'  rule [label={box("q", "Then the sync\'s acceptance rule decides whether to take it (see the matching diagram)")}];')
out += ['  query -> parse -> find -> score -> pick;',
        '  pick -> ans [label="  a match"]; pick -> up [label="  nothing"]; up -> ans;',
        '  ans -> rule;',
        '}']
open(OUT, "w").write("\n".join(out) + "\n")
print(f"wrote {OUT}")
