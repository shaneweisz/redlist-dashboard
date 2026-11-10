"""The table reference in docs/sync.md: one card per table the sync builds.

Usage: python3 -I sync_tables.py <build dir>

Each card is the header comment of the file that builds the table (what one row
is, what it is built from, its decisions and checks), with a column table whose
names, types, row count and size come from the build itself and whose
descriptions come from the header's "Columns:" block. The section between the
<!-- tables:start --> and <!-- tables:end --> markers in docs/sync.md is
replaced; everything else is left alone.
"""
import json, os, re, subprocess, sys

BUILD = os.path.expanduser(sys.argv[1])
ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
SYNC = os.path.join(ROOT, "app", "scripts", "sync")
DOC = os.path.join(ROOT, "docs", "sync.md")

# (stage, builder file, [files it writes, relative to the build dir])
CARDS = [
    ("Sources", "sources/taxa.ts", ["core/taxa.parquet"]),
    ("Sources", "sources/assessments.ts", ["core/assessments.parquet"]),
    ("Sources", "sources/occurrences.ts", ["core/occurrences.parquet", "core/occurrence_countries.parquet"]),
    ("Sources", "sources/common-names.ts", ["core/common_names.parquet"]),
    ("Sources", "sources/specialist-groups.ts", ["core/specialist_group_remits.parquet", "core/rank_aliases.parquet"]),
    ("Link", "link/matches.ts", ["core/matches.parquet"]),
    ("Link", "link/assessment-link.ts", ["core/assessment_link.parquet"]),
    ("Count", "dbt/models/count/usage_owner.sql", ["core/usage_owner.parquet"]),
    ("Count", "dbt/models/count/record_counts.sql", ["core/record_counts.parquet"]),
    ("Lists", "dbt/models/lists/assessed.sql", ["data/lists/assessed.parquet"]),
    ("Lists", "dbt/models/lists/assessment_history.sql", ["data/lists/assessments.parquet"]),
    ("Lists", "dbt/models/lists/species.sql", ["data/lists/species"]),
    ("Lists", "dbt/models/lists/ne.sql", ["data/lists/ne.parquet"]),
    ("Lists", "dbt/models/lists/app_taxa.sql", ["data/taxonomy/taxa.parquet", "data/taxonomy/assessment_link.parquet"]),
    ("Lists", "dbt/models/lists/vernacular_names.sql", ["data/taxonomy/vernacular-names.json"]),
    ("Lists", "dbt/models/lists/specialist_group_species.sql", ["core/specialist_group_species.parquet"]),
    ("Precomputed", "dbt/models/precomputed/col_split_candidates.sql", ["data/taxonomy/col-split-candidates.parquet"]),
    ("Precomputed", "dbt/models/precomputed/col_synonym_assessed.sql", ["data/taxonomy/col-synonym-assessed.parquet"]),
    ("Precomputed", "dbt/models/precomputed/col_to_assessed.sql", ["data/taxonomy/col-to-assessed.parquet"]),
    ("Precomputed", "dbt/models/precomputed/name_index.sql", ["data/search/name-index.parquet"]),
    ("Precomputed", "dbt/models/precomputed/rank_index.sql", ["data/search/rank-index.parquet"]),
    ("Precomputed", "dbt/models/precomputed/synonym_index.sql", ["data/search/synonym-index.parquet"]),
    ("Precomputed", "precomputed/col-revisions.ts", ["data/taxonomy/col-revisions.json"]),
    ("Precomputed", "precomputed/summaries.ts", ["data/summaries/taxa-summary.json", "data/summaries/country-stats.json",
        "data/summaries/table1a-children-summaries.json", "data/summaries/ssc-group-children-summaries.json"]),
    ("Precomputed", "precomputed/col-taxon-ids.ts", []),
    ("Checks", "dbt/models/audit/link_audit.sql", ["core/link_audit.parquet"]),
]


def header(file):
    src = open(os.path.join(SYNC, file)).read()
    m = re.match(r"\s*/\*\*(.*?)\*/", src, re.S)
    return [re.sub(r"^ ?\* ?", "", l) for l in m.group(1).strip("\n").split("\n")]


def duck(sql):
    out = subprocess.run(["duckdb", "-json", "-c", sql], capture_output=True, text=True, check=True).stdout
    return json.loads(out) if out.strip() else []


def relation(full):
    return f"read_parquet('{full}/**/*.parquet', hive_partitioning=true)" if os.path.isdir(full) else f"read_parquet('{full}')"


def size(full):
    b = sum(os.path.getsize(os.path.join(d, f)) for d, _, fs in os.walk(full) for f in fs) if os.path.isdir(full) else os.path.getsize(full)
    return f"{b / 1e6:,.0f} MB" if b >= 1e6 else f"{b / 1e3:,.0f} kB"


def short(t):
    t = re.sub(r"STRUCT\((.*)\)\[\]", lambda m: "list of {" + ", ".join(p.split(" ")[0].strip('"') for p in m.group(1).split(", ")) + "}", t)
    return t.replace("VARCHAR", "text").replace("BIGINT", "integer").replace("INTEGER", "integer").replace("SMALLINT", "integer") \
            .replace("TINYINT", "integer").replace("BOOLEAN", "boolean").replace("DATE", "date").replace("text[]", "list of text")


def column_notes(lines):
    """Column name → description, from the header's Columns: blocks."""
    notes, current, in_block = {}, None, False
    for l in lines:
        if re.match(r"^Columns\b", l):
            in_block = True; current = None; continue
        if in_block and l and not l.startswith(" "):
            in_block = False
        if not in_block or not l.strip():
            continue
        m = re.match(r"^ {1,4}(\S.*?)(?: {2,}(.*))?$", l)
        if m and not re.match(r"^ {5,}", l):
            names = [n.strip() for n in re.split(r",\s*", m.group(1).strip().rstrip(",")) if n.strip()]
            if all(re.match(r"^[a-z_][a-z0-9_]*$|^[a-z_]+ … [a-z_]+$", n) for n in names):
                current = names
                for n in names:
                    notes.setdefault(n, (m.group(2) or "").strip())
                continue
        if current:
            for n in current:
                notes[n] = (notes[n] + " " + l.strip()).strip()
    # "kingdom … genus" covers the columns between them; the caller expands it.
    return notes


def column_table(cols, notes):
    rows = ["| column | type | |", "|---|---|---|"]
    names = [c["column_name"] for c in cols]
    expanded = dict(notes)
    for k, v in notes.items():
        if " … " in k:
            a, b = k.split(" … ")
            if a in names and b in names:
                for n in names[names.index(a):names.index(b) + 1]:
                    expanded.setdefault(n, v)
    for c in cols:
        note = expanded.get(c["column_name"], "").replace("|", "\\|")
        rows.append(f"| `{c['column_name']}` | {short(c['column_type'])} | {note} |")
    return "\n".join(rows)


def prose(lines):
    """The header without its Columns: blocks, as markdown."""
    out, skip = [], False
    for l in lines:
        if re.match(r"^Columns\b", l):
            skip = True; continue
        if skip and l and not l.startswith(" "):
            skip = False
        if skip:
            continue
        out.append(l)
    text = "\n".join(out).strip()
    # Indented runs (lists of decisions, aligned definitions) stay as written.
    return re.sub(r"\n{3,}", "\n\n", text)


parts = []
stage = None
for st, file, outputs in CARDS:
    if st != stage:
        parts.append(f"### {st}\n")
        stage = st
    lines = header(file)
    notes = column_notes(lines)
    parts.append(f"#### `{file}`\n")
    parts.append("```text\n" + prose(lines) + "\n```\n")
    for o in outputs:
        full = os.path.join(BUILD, o)
        name = o.split("/", 1)[1] if o.startswith("data/") else o
        if not os.path.exists(full):
            parts.append(f"`{name}`: not in this build\n"); continue
        if o.endswith(".json"):
            parts.append(f"`{name}` · {size(full)}\n"); continue
        rel = relation(full)
        cols = duck(f"DESCRIBE SELECT * FROM {rel}")
        n = duck(f"SELECT count(*) AS n FROM {rel}")[0]["n"]
        parts.append(f"`{name}` · {n:,} rows · {size(full)}\n\n" + column_table(cols, notes) + "\n")

body = "\n".join(parts)
doc = open(DOC).read()
start, end = "<!-- tables:start -->", "<!-- tables:end -->"
note = (f"{start}\n<!-- Generated by `python3 -I docs/diagrams/sync_tables.py <build dir>` from each builder's header and the build's files. "
        f"Edit the headers, not this section. -->\n\n")
doc = doc[:doc.index(start)] + note + body + "\n" + doc[doc.index(end):]
open(DOC, "w").write(doc)
print(f"wrote {len(CARDS)} cards into {DOC}")
