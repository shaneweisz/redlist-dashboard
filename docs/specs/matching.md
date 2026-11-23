# Matching and counting: which CoL records and GBIF occurrences represent a Red List species

*   **Author:** shaneweisz
*   **Status:** Implemented (2026-11-23); the judge's first pass is pending
*   **Date:** 2026-11-20

--------------------------------------------------------------------------------

## Overview

The dashboard counts GBIF occurrences for each species on the IUCN Red List.
GBIF files each occurrence under a Catalogue of Life (CoL) record (a name
usage: a name, its authorship and status). This spec is one function and
what reads it:

- **In**: one assessed species (SIS id): its Red List name and author
  citation, its synonyms with their authors, and its kingdom to family; and,
  fixed for the build, the CoL release and GBIF's matcher.
- **Out**: 0 to n CoL records, each with a **relation** to its CoL species
  (the Red List species *is* it, is *part of* it, is *split into* it and
  others, or the record is *refused*) and where it came from (the matcher's
  answer, another candidate the citation picked, a Red List synonym, or a
  decision); and for the species, its **doubts**, or the **reason** nothing
  was taken.
- **Counting** turns relations into occurrences; the **Not Evaluated (NE)
  list** shows CoL species no record leads to.

```text
Red List name ─▶ matcher ─▶ candidates ─▶ steps ─┐
Red List synonyms ─▶ CoL records of those names ─┼▶ records + relations + doubts ─▶ counting, NE list
decisions.tsv ───────────────────────────────────┘
```

Accuracy is measured outside the sync by an agent, the **judge** (at the
end).

| Term | Meaning |
|---|---|
| sync | the monthly build of the dashboard's data (`npm run sync`, `docs/sync.md`) |
| maintainer | the person who runs the sync and merges its data PR |
| CoL record | a name usage in the CoL release the matcher was built on (COL26.6 XR, ChecklistBank 315557) |
| SIS id | the Red List's id for an assessed species (`sis_taxon_id`) |

In today's code, *links* and *covered rows* are the records, *flags* (⚑) are
doubts, *overrides* are decisions, and the *verdict* is the relation.

## The problem

The matcher's answer is usually right, and it is where GBIF files
occurrences carrying that bare name. Sometimes the name has CoL records for
different organisms (a homonym), only the genus is answered, or CoL holds as
several species what the Red List assesses as one. Today's code (#593, #639)
gives each species one link and adds rows by rules that grew one example at
a time; an agent review on 2026-11-18 found only about 3 in 10 flags
pointing at a real problem, and outcomes that depended on the order of the
checks.

Taxonomic differences are expected: for 84 % of groups, CoL follows another
source than the Red List Authority ([Garnett et al.
2026](https://doi.org/10.1111/cobi.70306)). So this works by names and
citations, not concepts.

## Goals

1. **Accurate**, as the judge measures it: every species that isn't easy,
   and a sample of those that are, then every species whose records change.
2. **No change of ours makes a group worse.** A change to these rules or the
   four functions merges only if, among the species it changes, no taxonomic
   group has fewer judged right, unless the maintainer makes each species
   lost a fixture case with its correct answer. Release moves
   are judged and reported, never gated.
3. **Reproducible** from this document and the four functions.
4. **Use what GBIF uses**: candidates come from matching-ws, queried as GBIF
   files occurrences.
5. **Show, with doubts, rather than hide.**
6. **No rule for one case**: those get a decision. The one tuned number is
   the 2-letter typo limit.

**Non-functional**: deterministic (the judge never feeds the sync); seconds
for all species on the matcher's saved answers; `npm run sync:trace --
"<name or SIS id>"` shows a species' working.

**Non-goals**: how the matcher is queried (`link/matches.ts`); which
taxonomy is right; the app's record modes (all or georeferenced, since the
assessment), which filter counted occurrences.

## Critical user journey: a decision, and when it lapses

*   **Given**: a decision selecting *Centropogon australis* (White, 1790), the
    waspfish, for the Red List's *C. australis* (Shaw, 1790).
*   **Then**: its record is taken, no doubts, until a release moves that
    record to another species; then the rules apply and the species is
    listed for review with what changed.

## Technical plan

### Inputs

- **Species**, from `sources/assessments.parquet` (`is_latest`): `name`
  (`scientific_name`), `authority`, `kingdom` (`kingdom_name`), `phylum`
  (`phylum_name`), and `synonyms` in the Red List's order, each with
  `authors` (the distinct non-empty `species_author` of the `taxon_synonyms`
  rows whose name is the same name, per *Definitions*). The **assessed names** are
  every `name`.
- **The matcher's response** for `name` (`link/matches.parquet`; asked with
  kingdom to family as hints, no authority): `match_type`, the `answer`
  (`matcher_col_id`, `matcher_name`, …; its `classification` in
  `matcher_score`) and the `alternatives` (JSON, in its order: `col_id`,
  `name`, `authorship`, `rank`, `status`, `score.classification`). The
  classification is the matcher's points for it against the hints.
- **The CoL release** (`sources/taxa.parquet`): `speciesOf(id)` =
  `species_id` (the accepted or provisional species a record leads to, or
  none), with that species' name, authorship, class, kingdom and phylum.
  Its statuses are lower-case (`ambiguous synonym`); the rules use the
  matcher's forms (`AMBIGUOUS_SYNONYM`) for both.
- **Occurrences** per CoL record, its own and those below it
  (`sources/occurrences.parquet`, `usage_key`, `n`).
- **Described species**: `lists/species/`'s `described` (#604), the one
  definition of which CoL species exist.
- **Decisions**, `seeds/decisions.tsv`.

### Releases

`sync.json` records the Red List database, the CoL XR the snapshot is filed
under and its curated release, `MATCHER_VERSION`, GBIF's live matcher
commit (recorded, not checked), the snapshot, and the build's step and
doubt counts. The build stops if the matcher serves another XR, or if
`--from link` would reuse tables from another release (this change adds the
Red List). Decisions and fixtures carry over by names and citations; a
decision for a species no longer assessed is listed for deletion. Numbers
here are from the 2026-11-23 build (Red List 2026-1, COL26.6 XR, snapshot
2026-11-01), with its four decisions.

### Functions

All in `link/name-rules.ts`, the one library an implementer of this spec may
use (it imports only `src/lib/authors.ts` and `src/lib/name-parts.ts`, and
holds `orthographicKey` too):

- **`compareAuthors(a, b)`** (from `src/lib/authors.ts`): `same`, `other` or
  `unclear` (either missing, mixed evidence, or a bare initial such as "L."
  against another citation).
- **`orthographicallySame(a, b)`**: two binomials
  are one name under the codes' spelling rules (*pallasii* / *pallasi*); for
  epithets, both under the first name's genus.
- **`sameOrganism(a, b)`** (each `{scientificName, authorship?}`): the same name; or the same epithet; or different genera
  and epithets differing only in a gender ending; or equal authorships
  (`normaliseAuthorship`, both non-empty) and epithets that are a
  respelling.
- **`isCoLRespelling(synonym, accepted)`**: one genus, the same
  citation (`f.` = `fil.`, diacritics ignored), two different epithets that
  are a respelling.

and `normaliseAuthorship`, `canonicalEpithet` and `epithetOf`, which they
use, and the definitions below (`sameName`, `genderEnding`, `respelling`).

### Definitions

- **The same name**: equal lower-cased, without ×, whitespace (tabs too)
  collapsed. "Another assessed name" means the same name as one.
- **A gender ending**: `canonicalEpithet` (`src/lib/name-parts.ts`) makes
  the epithets equal; or they end in -er, -era, -erum, -ra or -rum, or in
  -tor or -trix, after a common stem (*niger* / *nigrum*, *simulator* /
  *simulatrix*).
- **A respelling**: epithets that are `orthographicallySame`, or differ only
  in a gender ending, or only in a genitive ending (-i, -ii, -ae, -iae,
  -orum, -arum, -iorum, -iarum, the longest that fits: *jamesi* /
  *jamesorum*), or by **at most 2 letters** (Levenshtein: insertions,
  deletions, substitutions). It is asked only of
  names with the same citation, which is the evidence; the limit keeps two
  words from one paper apart.
- **Red List citation**: `authority` without "ined." and a comma before it;
  none if empty.
- **Informal or qualified**: a name matching
  `/\b(aff|cf|sp|spp|nov|indet)\.|\[|\bsp\b/i`, or a citation matching
  `/\bauct\b\.?|\bnon\b|\bsensu\b/i`. A synonym author is qualified by
  that citation pattern, or by `/\bpro parte\b|(^|[\s,(])p\.\s?p\./` (lower-case, so
  initials such as "P.P.J. Herman" aren't).
- **Agrees with the lineage**: `speciesOf` exists, and its kingdom and
  phylum equal the Red List's, lower-cased, a missing one agreeing
  (Heterokontophyta = Ochrophyta).

### Candidates and groups

**Candidates**: the answer and alternatives, once each, at species rank, not
`MISAPPLIED`, that agree with the lineage and have the same name as `name`
or the answer, or are `orthographicallySame` as `name`.

**Groups**: candidates with the same `speciesOf`. Two groups join
(transitively) through **copies**: two records the citation doesn't
contradict, with the same or `orthographicallySame` names, whose
authorships compare `same`, or that are both accepted or provisional in one
known class and don't compare `other` (CoL often holds a copy with no
authorship or a year apart: *Harpia harpyja*). A contradicted record joins
nothing (*Hoplocephalus bungaroides*'s Wagler record under *Ophiophagus
bungarus*).

A group **matches** when a record's authorship compares `same` with the
citation; the answer is **contradicted** when it compares `other`. *A* is
the answer's group; *M* the matching groups.

### Steps

The first that applies:

1. A decision holds → its records, with their recorded relations; no doubts.
2. Informal or qualified name → nothing; reason `informal or qualified name`.
3. No candidates → nothing; reason `no candidate`.
4. *M*, plus *A* unless contradicted, if not empty. (175,067 species)
5. *A*: GBIF files the bare name there. (577)
6. The groups with a record not comparing `other`; if none, every group. (6)

Every candidate in a chosen group is taken, the answer first, then in the
matcher's order.

### Relations of the steps' records

For each record *r*, with *s* = `speciesOf(r)`, the first that applies:

1. *r* is `AMBIGUOUS_SYNONYM` → **part of**.
2. *r* is a `SYNONYM`, `isCoLRespelling(r, s)`, and *s*'s name isn't
   another assessed name → **is**.
3. `sameOrganism({name, citation}, s)`, or, when `name` and *r*'s name are
   `orthographicallySame`, `sameOrganism(r, s)` → **is** (*Sorbus greenii* →
   *Aria greenii*), or **refused** if *s*'s name is another assessed name.
4. `sameOrganism({name, citation}, r)`, or `name` and *r*'s name are
   `orthographicallySame` → **part of** (*Pleurobema furvum* → *P. furva*,
   under *P. rubellum*).
5. Otherwise → **refused**.

Records are passed as `{name, authorship}`. Step 2 compares CoL's two
citations, so it holds where the Red List writes its own differently.

### Synonym records

For a species at steps 3 to 6 (not informal, no holding decision), each Red
List synonym, in order, adds the CoL records at species rank with its name
(or `orthographicallySame`), not `MISAPPLIED`, accepted and provisional
first, then by `id`, that agree with the lineage, aren't taken, don't lead to a species already
counted whole (by the steps or an earlier synonym record), and whose
authorship one of the synonym's unqualified authors doesn't compare `other`
with (or it has none). If one of those records compares `same`, only such
records and their copies (as in *Candidates and groups*) are added, as the
steps prefer matching records (*Pogostemon crassicaulis*'s synonym *Mentha
verticillata* D.Don takes the D.Don record, not the hybrid *Mentha ×
verticillata* L.; *Muscicapa tessmanni* (Reichenow, 1907) keeps CoL's
provisional copy with no authorship). A synonym whose every author is
qualified adds
nothing: it names part of a taxon or a misapplied name (*Alchemilla
vulgaris* "auct."; *Goggia rupicola* "[pro parte]"). A synonym the Red List
files under two species was already dropped (`sources/assessments.ts`).
Each record *r*, with *s* = `speciesOf(r)`, the first that applies:

1. `sameOrganism({name, citation}, s)`, and either *r* is *s* and the
   citation doesn't compare `other` with *s*, or *r* is a `SYNONYM` of *s*
   and the citation compares `same` with *s* → **is** (*Cephalorhynchus
   australis* → *Lagenorhynchus australis*; *Isoaeschna isoceles*
   (Müller, 1767) → *Anaciaeschna isoceles* (Müller, 1767), through *Aeshna
   isoceles*). The stricter test for a synonym keeps out an epithet shared
   by chance: *Chiococca alba* (L.) Hitchc. and the snowberry
   *Symphoricarpos albus* (L.) K.Koch compare only `unclear`.
2. *r* is *s* → **split into**: the Red List counts as one species what CoL
   holds as several (*Butorides striata* includes the green heron *B.
   virescens*).
3. Otherwise, *s* is another species. If the steps' records already lead
   to *s* → **part of**. Else, if *s* is another assessed name, or another
   assessed species' steps (or decision) count it whole, the record isn't
   added; otherwise → **part of**, with the doubt `synonym filed elsewhere`
   if it has occurrences (*Elymus farctus*'s synonym *E. junceiformis*,
   under *Thinopyrum junceiforme*). Either way the occurrences GBIF filed
   under the Red List's synonym count for it, and *s* keeps the rest.

In 1 and 2, *s* being another assessed name makes it **refused**. On the
2026-11-23 build, synonym records count 794 species' CoL species whole by
1, 1,139 by *split into*, and give 842 species *part of* records under a
species the steps don't reach and 918 under one they do. The author check
keeps other authors' species out (*Solanum glabrum* Merr., for the Red
List's *S. glabrum* Dunal), but a bare "L." can't be told apart, hence the
doubt `split, authors unclear` (*Vicia sepium* would count *V. dumetorum*
L. for the Red List's *V. dumetorum* Thuill.).

### Doubts

Computed on the steps' records (4 to 6), in this order, then the last two
rows on synonym records:

| Doubt | Holds when | Species |
|---|---|---|
| `chosen by the citation` | the answer is not taken | 277 |
| `homonym` | more than one group, unless exactly one matches and only it is taken | 143 |
| `other authors` | the citation compares `other` with every taken record | 575 |
| `other spelling` | the answer is taken, `match_type` isn't `EXACT`, and its name isn't `orthographicallySame` as `name` | 32 |
| `ambiguous synonym` | a taken record is `AMBIGUOUS_SYNONYM` | 538 |
| `placed elsewhere` | a taken record's `classification` is below 0 | 155 |
| `counts nothing` | every taken record is *refused* | 55 |
| `split, authors unclear` | a split-into record none of its synonym's unqualified authors compares `same` with | 68 |
| `synonym filed elsewhere` | a relation-3 record with the doubt, with occurrences under it | 498 |

A species with a reason, or doubts and no holding decision, is **listed for
review**: 2,320 (1,525 with doubts on the steps' records, the rest with
the two synonym doubts or one of 255 reasons). A homonym the citation
settles (3,553 of 3,696 species with several groups) has no doubt; its
other groups stay on the NE list with a note, not a flag, since the citation
says they are other organisms.

### Counting and the NE list

A CoL species is **counted whole** by an assessed species that has an *is*
or *split into* record leading to it. Each CoL record's occurrences have one
owner (`models/count/usage_owner.sql`), the first that applies:

1. **Part of**: a *part of* record owns its occurrences and those of the
   records below it, three levels down (the deepest in the release). Roots
   can nest; a record goes to the nearest root claiming it, and of two
   species' roots, the one whose own name it is (*Zosterops simplex* owns
   the synonym *Z. simplex* filed under *Z. japonicus simplex*).
2. **Whole species**: otherwise a record counts for its CoL species (its own
   name, synonyms, subspecies and their BINs): for the assessed species that
   counts it whole, if one does.
3. **Unassessed**: otherwise, for the CoL species itself.

A *part of* or *refused* record never takes the rest of its species: *Pararge
xiphioides* (assessed) owns the occurrences under its own name, and *P.
aegeria*, which no assessed species counts whole, owns the rest (3.5M) and
is on the NE list. (Today any link row hides its species; about 1,560
described species with 20.4M occurrences count for no one that way.)

Where two assessed species claim one record under the same rule, the first
by: primary before covered; no doubts before doubts; *is*, then *split
into*, then *part of*; a decision before the matcher; the species whose CoL
name is its Red List name as written; the lower SIS id
(`oneOwnerPerUsage`, `link/rules.ts`). The loser's row gets `relation =
'duplicate'` and counts nothing.

The **GBIF key** a species links to (`gbif_species_key`,
`count/record_counts.sql`) is the record it counts from with the most
occurrences, *is* before *split into* before *part of*: *Butorides striata*
keeps its own, not the green heron's, and *Hylatomus pileatus* links to
*Dryocopus pileatus*' 5.2M, not its own 156.

The **Not Evaluated list** is every described species no assessed species
counts whole, with or without GBIF records (counts added where there are,
`lists/ne.parquet`). Two notes, on `lists/species/` so they don't depend on
records:

- **`may_be_assessed`** (flagged, as today): the CoL species of a candidate
  not taken, for an assessed species with a doubt.
- **`assessed_here`** (a note, not a flag): an assessed species whose *part
  of* records lie under it ("*Pararge xiphioides*, assessed, is part of it
  in CoL"), or whose name it holds but the citation settled elsewhere
  ("the Red List's *Gymnosporia gracilis* Loes. has this name; its citation
  points to another CoL record").

The build stops if a record has two owners, or if a described species is
neither counted whole nor on the NE list; `sync.json` records the
occurrences counted for no one (outside the release's species).

### Output

`link/assessment_link.parquet`, as today, with these changes:

- **One row per record**, with a new `relation` column (`is`, `part of`,
  `split into`, `refused`): the steps' first is `role = 'primary'`, the rest
  and all synonym records `covered`; a record whose `col_taxon_id` an
  earlier row has gets none. With nothing from the steps, the primary row
  has `basis`, `col_taxon_id` and `col_species_id` NULL, `counts =
  'nothing'`, and the reason as `match_reason`.
- **Relation → columns**: *is*, *split into*: `col_taxon_id` = *s*, `counts
  = 'the whole CoL species'`; *part of*: `col_taxon_id` = *r* (or its
  non-nominate infraspecific record), `counts = 'only records under its own
  name'` (*r*'s non-nominate infraspecific parent when CoL files a synonym
  under one, as `assessment-link.ts`'s `lumpRoot` does today); *refused*:
  `counts = 'nothing'`. `col_species_id` is
  *s*. `counted` is false only for *refused*.
- **`basis`**: `matcher` (the answer), `citation` (any other step record),
  `synonym` or `decision`; `decided_by` and `reviewed` (boolean) for a
  decision.
- **Primary row**: `step`; `doubts` (`;`-joined text, NULL when none);
  `to_review` as `<kind> (<detail>)`: the first doubt (all doubts,
  `; `-joined), the reason, `decision lapsed (<name | citation | assessed
  name | record not found>)`, `decision's candidates changed (<species>)`
  or `decision not yet reviewed (<by>)`; NULL when not listed.
- **Candidate rows**: one per untaken group's CoL species, `counts =
  'nothing'`, `relation = 'none'`: `method = 'undecided_candidate'` for a
  species with a doubt (the NE list's flag), `other_group` otherwise (its
  note).
- **Labels as today** for `method`, `col_treatment` (plus `split`),
  `match_reason` (`decision` replaces `override`; `flagged: …` and
  `waiting` go), `match_note`, `match_records`, candidate rows, the
  synonyms-only bar and "Also counts other CoL names".

### Decisions

`seeds/decisions.tsv`, one row per decided record, with its `relation`
(only *is*, *part of* or *split into*), so a decision can count a CoL
species the rules wouldn't relate: `sis_taxon_id`, `redlist_name`,
`redlist_authority`, `id`, `name`, `authorship`, `status`, `species`,
`relation`; `candidates` (the candidates' species names when decided,
sorted, `;`-separated); `by` (a GitHub handle, `agent:<model>`, or
`fixture`); `reviewed` (`yes`); `date`; `evidence`. A species' rows agree on
the species-level columns. "Not in CoL" is a species' only row, with the
record columns empty.

A decision **holds** while `name` is the same as `redlist_name`, the
citation doesn't compare `other` with `redlist_authority`, no record's name
or species is another assessed name, and each record is found in
`sources/taxa.parquet` (by `id` with the recorded name, status and species;
else as the one such record with an equal authorship); it holds only if
every row does. One that doesn't hold is ignored and the species listed for
review; one that holds is also listed when its `candidates` changed, or it
isn't reviewed and `by` isn't `fixture`.

### Examples

Each is a fixture case (`checks/fixtures/matching.ts`).

| Red List | Answer | Other candidates | Taken (step) | Doubts |
|---|---|---|---|---|
| *Panthera leo* (Linnaeus, 1758) | accepted | — | answer (4) | — |
| *Sorbus greenii* T.C.G.Rich | synonym of *Aria greenii* | — | answer, *is* (4) | — |
| *Cygnus buccinator* Richardson, 1832 | Richardson, 1831 | provisional, 1832 (copy) | both (4) | — |
| *Weinmannia heterophylla* Ruiz & Pav. | Kunth (contradicted) | "Ruiz & Pav. ex López" (matches) | López (4) | chosen by the citation, ambiguous synonym |
| *Rubus fruticosus* L. | HIGHERRANK | L. under *R. plicatus* (matches); G.N.Jones; Lour. | L. (4) | chosen by the citation |
| *Galium palustre* L. | M.Bieb. | L. (matches); Pourr. ex Willk. & Lange | answer, L. (4) | homonym, ambiguous synonym |
| *Vireo chivi* (Vieillot, 1817) | accepted, no authorship | (Vieillot, 1817) under *V. olivaceus* | both (4) | homonym |
| *Lycaena clarki* Clark & Dickson, 1971 | synonym of *Aloeides clarki*, also assessed | — | answer, *refused* (4) | counts nothing |
| *Turdus rubrocanus* Hodgson, 1846 | Gray & Gray, 1847 (contradicted) | "Hodgson, BH, 1844" under *Philepitta castanea* | answer (5) | homonym, other authors |
| *Agrotis sabine* Brandstetter, 2010 | VARIANT *A. sabura* Mabille | — | answer, *refused* (5) | other authors, other spelling, counts nothing |
| *Palaina martensi* (Adams, 1866) | HIGHERRANK | (H. Adams, 1867); (Andreae, 1902) | H. Adams (6) | chosen by the citation, homonym |
| *Amygdalus ledebouriana* Schlecht. | — | two "Schltdl." synonyms | both (6) | chosen by the citation, homonym, other authors |
| *Kuhlia rubens* (Spinola, 1807) | synonym of *Apogon imberbis*, −20 | — | answer (4) | placed elsewhere |
| *Galaxias* sp. nov. 'Verlorenvlei' | HIGHERRANK | — | nothing (2) | — |
| *Ampedus karpathicus* (Buysson, 1885) | misapplied | — | nothing (3), and *A. suecicus* Palm, 1976, *split into* | — |
| *Lepilemur jamesorum* Louis Jr. et al., 2006 | synonym of *L. jamesi*, same citation | — | answer, *is* (4) | — |
| *Butorides striata* (Linnaeus, 1758) | accepted | — | answer (4), and *B. virescens*, *split into* | — |
| *Hoplocephalus bungaroides* (Schlegel, 1837) | accepted | Wagler, 1830 synonyms under it and under *Ophiophagus bungarus* (contradicted: no join) | answer and the Wagler synonym under it (4) | — |

## Alternatives considered

- **One link per species (#639).** A homonym forces one record: *Galium
  palustre* counts its 126,131 bare-name or its 229,826 Linnaeus-cited
  occurrences, not both.
- **Author first (*M*, else *A*).** On the 28 species where it differs,
  never more accurate; it drops where GBIF files the bare name (*Sambucus
  nigra*: 1,166,917).
- **Every group of a homonym.** Counts groups no evidence points to; step 6
  does it only where every citation is contradicted.
- **Querying the matcher with the author, or with each synonym.** With the
  author it prefers a provisional duplicate (301 species lost 42.6M
  occurrences, #593) and adds no candidate species; the synonym answers are
  mostly hybrids and other authors' homonyms (*Ulmus major* → *U. ×
  hollandica*), which the synonym records above avoid by looking up the
  names directly.
- **Matching concepts through each Red List Authority's checklist.** Not
  machine-readable for most groups; GBIF files by name.
- **Another typo limit.** Today's 3 letters merges 4 pairs of different
  words (*Drimys confertifolia* / *confertiflora*); Taxamatch's length-scaled
  limit ([Rees 2014](https://doi.org/10.1371/journal.pone.0107510)) merges 5,
  among them *Hoplocephalus bungaroides* (a snake) with *Ophiophagus
  bungarus* (a king cobra). Against today's code, the rule here changes 27
  species: 21 better (12 genitive corrections), 6 typos split.

## Risks and mitigations

- **A union or split counts another organism**: a homonym the citation
  can't contradict, or a synonym the Red List means only in part without
  saying so (*Catapodium borgesii*, VU, would count 20,886 records of the
  widespread *C. marinum*; it has a decision). The judge reads every
  species whose records change; a decision corrects one.
- **The judge is wrong, or a web page steers it**: its verdicts only gate a
  merge and never feed the sync, and the maintainer reads every species
  whose verdict differs.
- **`compareAuthors` or `orthographicallySame` misreads a name** (*afer* /
  *afra* is refused): it shows as a doubt; the fix is general, under Goal 2.
  The largest is "L.": `compareAuthors` treats it as a bare initial, so it is
  `unclear` against any other author, though in botany it is Linnaeus
  (*Mentha × verticillata* L. against D.Don; *Vicia dumetorum* L. against
  Thuill.). Reading it as Linnaeus is the next general change to measure.
- **Counts change**: the change list shows every one before publishing.

## Implementation plan

One PR, then the data PR. Paths are under `app/scripts/sync/` (`link/`,
`checks/`, `seeds/`, `dbt/`, `inputs/`, `sources/`, and `sync.ts`,
`trace.ts`, `sources-releases.ts`), `app/scripts/__tests__/`, or `app/src/`
(`src/`, `components/`; `gbif-match.test.ts` in `src/lib/__tests__/`).

1. **The rule.**
   - `link/select.ts` (create): `select(species, release, decision)` and
     `selectEvery`; `link/select-inputs.ts`, `selectAll(buildDir)`, reading
     the build. They give `step`, `reason`, `groups`, `doubts`, and
     records with `relation`, relation step and `basis`; `"sync:select"`
     (`app/package.json`) writes `[{sis_taxon_id, step, reason, doubts,
     selected: [{id, relation, relation_step, basis}]}]` to stdout;
     `relation_step` is 1–5 for steps' records, and for synonym records 1, 2,
     `3` (with the doubt) or `3s` (*s* already reached by the steps).
   - `link/name-rules.ts` (create): the functions above, moved from
     `species-key.ts` and `name-variants.ts`, which go, with the respelling
     rule replacing `MAX_RESPELLING_EDITS = 3`.
   - Tests: `link-select.test.ts` (each step, doubt, relation, example);
     `name-rules.test.ts`, taking the `sameOrganism`, `isCoLRespelling` and
     `orthographicallySame` tests from `species-key.test.ts` and
     `name-variants.test.ts`.
   - **Rebuild check**, `npm run sync:rebuild-check` (`checks/rebuild-check.ts`):
     builds a sealed folder with this spec, `name-rules.ts` bundled into one
     file (rolldown), the build's inputs as JSON (species, matcher responses, synonyms
     with authors, the CoL records they name with their species' name,
     authorship, class, kingdom and phylum, and the occurrences under each)
     and the output schema; runs
     `claude -p` there with only read, write and run tools inside it and no
     web (`--tools Read,Write,Edit,Bash`, `--setting-sources ""`,
     `--strict-mcp-config`, `--output-format stream-json --verbose`, `HOME`
     set to the folder); compares its output with `sync:select` species by
     species; and keeps the agent's log, from which it lists every file it
     read and every command it ran. Run after
     every change to the rules and every release move.
2. **The sync writes it.**
   - `link/assessment-link.ts` calls `select.ts` and writes *Output*;
     `decideKey` and its tests go.
   - `link/rules.ts`: `LinkRow.verdict` becomes `relation` (`is`, `part of`,
     `split into`, `refused`, `none`, `duplicate`), plus `doubts`,
     `reviewed`, `step`; `basis` as in *Output*. Deleted:
     `coverUndecidedCandidates`, `dropCrossPhylum`, `coverTwins`,
     `coverSameNameSynonyms` (of their 4,388 rows, 4,303 are already taken;
     85 go to the NE list) and `coverSynonymSpecies` (now synonym records).
     `isFlaggedLink` reads `doubts`; the one-owner keys as in *Counting*.
   - `sources/assessments.ts`: synonyms gain `authors`.
   - `match-overrides.ts` → `decisions.ts`, `match-overrides.tsv` →
     `decisions.tsv` (its three rows converted; `candidates` from the build;
     `agent audit` → `agent:unrecorded`).
   - `dbt/models/lists/assessed.sql`: `match_doubts`, `match_reviewed`;
     `count_note = 'flagged'` also when `match_doubts` is set.
     `dbt/models/count/record_counts.sql`: the GBIF key's `arg_min` puts
     `role = 'primary'` first. `dbt/models/count/usage_owner.sql`: rules 2
     and 3 read only *is* and *split into* rows as counting a species whole.
   - **What makes a CoL species assessed**: every reader that today treats
     any non-candidate link row as making a CoL species assessed reads only
     *is* and *split into* rows (`relation`): `lists/ne.sql`, `lists/species.sql`
     (EX/EW), `precomputed/name_index.sql`, `col_to_assessed.sql`,
     `synonym_index.sql`, `col_split_candidates.sql`, `col_synonym_assessed.sql`,
     `checks/compare/facts.ts`, `precomputed/summaries.ts`,
     `precomputed/col-differences.ts`, and `src/lib/data/species-duckdb.ts`'s
     `ne_assessed_col_ids` and `live-taxa-children.ts`.
   - `dbt/models/lists/species.sql`: `may_be_assessed` (moved from `ne.sql`,
     whose `candidates` CTE goes) and `assessed_here` (`;`-joined
     `<assessed name> (part of | same name)` items, sorted), NULL when none.
   - `sync.ts`: `describeBuild` counts by `basis` and writes `matching.steps`,
     `matching.doubts` and `matching.gbif_matcher` (GBIF's `buildInfo.sha`
     from `.../v2/species/match/metadata?checklistKey=xcol`, or `unknown`).
     `sources-releases.ts`: the Red List database.
   - `trace.ts` and `checks/review-links.ts` show `relation`, `step` and
     `doubts` from the rows `select.ts` wrote. `select.ts` returns the untaken groups and
     `assessment-link.ts` writes their candidate rows, as `rules.ts` does
     today.
   - `sync.ts` also writes `matching.unowned` (occurrences counted for no
     one) and stops if a described species is neither counted whole nor on
     the NE list.
   - Fixtures (`checks/fixtures/matching.ts`, `checks/check-fixtures.ts`,
     `pipeline-fixtures.test.ts`): `expect` gains `doubts` and `selected`
     (`{name, authorship, relation}[]`); `flagged: …` labels become `doubts`,
     `waiting: X` becomes X, `override` becomes `decision`; the examples are
     cases; every label and doubt a build gives needs one. *Catapodium
     borgesii* gets a decision (*Risks*). Tests: `link-rules`, `pipeline-record-counts`,
     `pipeline-match-overrides` → `pipeline-decisions` (a case per hold
     condition).
3. **The app reads doubts.**
   - `src/lib/gbif-match.ts`: `doubtKeys` (like `countsKeys`) and
     `SpeciesMatch.match_doubts`; `isFlagged` on doubts, the `agent` key or
     `may_be_assessed`; `isExact` only without doubts; filter and tally read
     every doubt; `matchKey` reads `match_doubts` before `count_note`;
     `decision` replaces `override` (and `decided: not in CoL`, `override,`);
     the `FLAGGED` map goes; a bar per doubt (today's keys, and
     `f_counts_nothing`, `f_split_unclear`, `f_filed_elsewhere`), and one
     for NE species with an `assessed_here` note; an `agent:` decision is
     flagged until reviewed.
   - `src/lib/data/species-duckdb.ts`: the two new columns, `match_doubt_keys:
     doubtKeys(r)` beside `match_counts_keys`, and `match_reason ===
     'decision'` at line 207; `src/hooks/useRedListSpeciesQuery.ts`: the
     types; the NE list query reads `may_be_assessed` and `assessed_here`
     from `species/`, and the match tooltip shows `assessed_here` as a note. `components/redlist/RedListView.tsx`: tooltip pills
     for every doubt; the single-species bars read doubts.
4. **Remove the old rule**: `link/accept-match.ts`, its test, and every
   reference to it or to `match-overrides` (code, fixtures' `source` fields,
   `README.md`, `docs/`); `docs/sync.md` links here instead of restating
   rules; `docs/diagrams/link_flow.py` redrawn.
5. **The judge**, below. This change is judged and reported; there is no
   earlier judge to gate it.
6. **Verify**: tests, typecheck, lint; `npm run sync -- --from link` with
   every fixture passing; the GBIF card and tooltip in a browser, one
   species per doubt; the change list against the 2026-11-16 build; the
   judge's first pass and Goal 2 report, read before the data PR merges.

## The judge

Headless Claude Code reads one species' facts and says which records it
would take; code compares its answer with ours. It runs by hand, outside
the sync (`checks/judge.ts`, `checks/judge-prompt.md`; `npm run sync:judge
-- <first | changed>`), and the sync never reads its output.

- **Which species**: those that aren't easy. Easy is one group, no doubt
  and no reason, every step record *is*, and no synonym record other than
  refused:
  164,324 of 175,909 on the 2026-11-23 build. `first`, once this change's
  first build is ready, judges the other 11,585 and a random 1,000 easy
  ones (how often an easy species is wrong); `changed`, every species whose
  records differ, old rules against new on one build (the old rules'
  `sync:select` output as the baseline), with Goal 2 per group.
- **Facts**, per species, independent of the rules being judged: the Red
  List name, citation, lineage and synonyms with authors; the matcher's
  response; every species-rank CoL record with the same or
  `orthographicallySame` name as the Red List name, the answer or a
  synonym, each with its CoL species, classification, occurrences, and
  whether the Red List assesses that species separately. Not our
  selection.
- **Call**: `claude -p`, run in an empty temporary folder, with the batch's
  facts (20 species) on stdin, so it can't read our build or this repo; the
  default model, `--setting-sources ""`, `--strict-mcp-config`, `--tools
  WebSearch,WebFetch`, `--allowedTools WebSearch,WebFetch`,
  `--disallowedTools "WebFetch(domain:dashforlife.org)"
  "WebFetch(domain:vercel.app)"`, `--output-format json`, and
  `--json-schema` for `{answers: [{sis_taxon_id, records: [{id, relation:
  "is" | "part of" | "split into"}] | "can't tell", reason, sources:
  [url]}]}`.
- **Scoring**, in code: `right` (the same records and relations; *refused*
  counts as not taken), `wrong` or `can't tell`.
- **Before a run**, it answers the fixture cases, whose answers are known,
  and prints its score and the number of calls; the maintainer decides
  whether to go on. Answers are kept by the SHA-256 of a species' facts and
  the prompt, so a rerun asks only what changed.
- **Output**: `.sync/review/judgements.parquet` (`sis_taxon_id`, `answer`,
  `sources`, `verdict`, `reason`, `model`) and a report by doubt and by
  group (the CoL class, or kingdom for plants and fungi);
  `checks/review-links.ts` shows each verdict. Test: `judge.test.ts`, with
  `claude` stubbed.

--------------------------------------------------------------------------------

*Drafted with EGM*
