# Matching and counting: which CoL records and GBIF occurrences represent a Red List species

*   **Status:** Implemented (2026-11-23, `link/select.ts`); rebuilt from the
    spec alone (2026-11-24, `npm run sync:rebuild-check`)
*   **Releases:** Red List 2026-1, CoL COL26.6 XR (ChecklistBank 315557),
    GBIF snapshot 2026-11-01

This spec states the rules and why each exists. The code is the truth about
behaviour, this is the truth about intent, and the examples, each a fixture
case (`checks/fixtures/matching.ts`), tie the two together.

## What it decides

GBIF files each occurrence under a Catalogue of Life (CoL) record: a name, its
authorship and status. For one assessed species, the rule returns 0 to n CoL
records, each with:

- a **relation** to its CoL species (`speciesOf`, the accepted or provisional
  species it leads to): the Red List species **is** it, is **part of** it, is
  **split into** it and others, or the record is **refused** (taken, counts
  nothing);
- a **basis**: `matcher` for the answer record itself, `citation` for every
  other record the steps take (copies in the answer's group too), `synonym`
  for a Red List synonym's record;

and for the species, its **doubts**, or the **reason** nothing was taken.

It works by names and citations, not taxon concepts: for 84 % of groups CoL
follows another source than the Red List Authority ([Garnett et al.
2026](https://doi.org/10.1111/cobi.70306)), and GBIF files by name.

**Principles.** Use what GBIF uses (candidates come from GBIF's matcher,
matching-ws, asked with kingdom to family as hints and no authority). Show,
with doubts, rather than hide. No rule for one case, and no exceptions: a
species the rules can't settle stays flagged, with the AI taxonomic reviewers'
answers beside it.
Deterministic, fast on the saved matcher answers, and traceable (`npm run
sync:trace -- "<name or SIS id>"`).

## Inputs

Per species: its Red List `name`, `authority`, kingdom, phylum, and synonyms
in the Red List's order, each with its distinct non-empty authors. The
matcher's response for `name`: `match_type`, the answer, and the alternatives
in its order, each with a `classification` (its points against the hints).
For any CoL record: name, authorship, rank, status, `speciesOf` with that
species' name, authorship, class, kingdom and phylum, and the occurrences
GBIF files under it and the records below it. Statuses use the
matcher's forms (`SYNONYM`, `AMBIGUOUS_SYNONYM`, `MISAPPLIED`). Ids are
strings, ordered by code unit (an arbitrary but fixed order). The
**assessed names** are every species' `name`. The AI taxonomic reviews come
from `seeds/ai-reviews.tsv`.

## Name tests

The rules use these, all in `link/name-rules.ts` (the one library an
implementer may use; it holds the code's spelling rules):

- **`compareAuthors(a, b)`** → `same`, `other` or `unclear` (either missing,
  mixed evidence, or a bare initial such as "L.").
- **`orthographicallySame(a, b)`**: one name under the codes' spelling rules
  (*pallasii* / *pallasi*).
- **`sameOrganism(a, b)`**: the same name; or the same epithet; or different
  genera and a gender ending; or the same non-empty authorship and a
  respelling.
- **`isCoLRespelling(synonym, accepted)`**: one genus, the same citation, and
  epithets that are a respelling.

Defined here, as they carry choices:

- **The same name**: equal lower-cased, without ×, whitespace collapsed.
  "Another assessed name" is the same name as another species' `name`.
- **A respelling**: epithets `orthographicallySame`, or differing only in a
  gender ending (*niger* / *nigrum*, *simulator* / *simulatrix*), or a
  genitive ending (-i, -ii, -ae, -iae, -orum, -arum, -iorum, -iarum, the
  longest that fits: *jamesi* / *jamesorum*), or by **at most 2 letters**
  (Levenshtein). It is only ever asked of names with the same citation, which
  is the evidence. The limit is the one tuned number: 3 merged different words
  from one paper (*Drimys confertifolia* / *confertiflora*), and Taxamatch's
  length-scaled limit merged a snake with a king cobra (*Hoplocephalus
  bungaroides* / *Ophiophagus bungarus*).
- **Red List citation**: `authority` without "ined." (and a comma before it);
  none if empty.
- **Informal or qualified**: a name matching
  `/\b(aff|cf|sp|spp|nov|indet)\.|\[|\bsp\b/i`, or a citation matching
  `/\bauct\b\.?|\bnon\b|\bsensu\b/i`. A synonym author is **qualified** by that
  citation pattern or by `/\bpro parte\b|(^|[\s,(])p\.\s?p\./` (case-sensitive,
  so "P.P.J. Herman" isn't).
- **Agrees with the lineage**: `speciesOf` exists, and its kingdom and phylum
  each equal the Red List's, ignoring case, where either side's value is
  missing counting as equal. The one equivalence is Heterokontophyta =
  Ochrophyta. Without this, a homonym in another phylum would count. Class
  isn't checked, as classifications disagree on classes far more often than
  on phyla.

## Candidates and groups

**Candidates**: the answer and the alternatives, once each, at species rank,
not `MISAPPLIED` (a misapplied name is by definition another organism),
agreeing with the lineage, and with the same name as `name` or the answer, or
`orthographicallySame` as `name`.

**Copies**: two records with the same or `orthographicallySame` names, and
either their authorships compare `same`, or both are accepted or provisional,
their `speciesOf` have the same non-empty class, and their authorships don't
compare `other`.

**Groups**: candidates with the same `speciesOf`. Groups join (transitively)
when a record of one and a record of the other are copies and the citation
contradicts neither (compares `other` with neither). *Why*: CoL often holds a duplicate with
no authorship or a year off (*Harpia harpyja*), and GBIF files under both. A
contradicted record joins nothing (*Hoplocephalus bungaroides*'s Wagler
record under *Ophiophagus bungarus*).

A group **matches** when one of its records compares `same` with the
citation. The answer is **contradicted** when it compares `other`. *A* is the
answer's group, *M* the matching groups.

## Steps

The first that applies:

1. The name or citation is informal or qualified → nothing; reason `informal or qualified name`.
2. No candidates → nothing; reason `no candidate`.
3. The union of *M* and (unless the answer is contradicted) *A*, if that
   union isn't empty.
4. *A*, which is then contradicted and nothing matches.
5. (No answer among the candidates and nothing matches.) The groups with a
   record the citation doesn't compare `other` with; if none, every group.

Every record of a chosen group is taken, the answer first, then in the
matcher's order.

*Why this order*: the matcher's answer is where GBIF files occurrences of the
bare name, so it stays unless the citation contradicts it (step 3). Even
contradicted, it is kept when nothing else matches (step 4), since GBIF still
files the bare name there, and the doubt `other authors` says so. A homonym where the citation settles
it takes only its own group; one where the citation matches several takes
them all and doubts it. Trying author-first (*M*, else *A*) was never more
accurate on the 28 species where it differs, and drops where the bare name is
filed (*Sambucus nigra*: 1,166,917 occurrences). Taking every group of a
homonym counts groups no evidence points to, so only step 5 does it, where
every citation is contradicted.

## Relations of the steps' records

For each record *r*, with *s* = `speciesOf(r)`, the first that applies:

1. *r* is `AMBIGUOUS_SYNONYM` → **part of**.
2. *r* is a `SYNONYM`, `isCoLRespelling(r, s)`, and *s*'s name isn't another
   assessed name → **is** (*Lepilemur jamesorum* → *L. jamesi*). This compares
   CoL's two citations, so it holds where the Red List writes its own
   differently.
3. `sameOrganism({name, citation}, s)`, or (when `name` and *r*'s name are
   `orthographicallySame`) `sameOrganism(r, s)` → **is** (*Sorbus greenii* →
   *Aria greenii*); **refused** if *s*'s name is another assessed name, as that
   species counts it.
4. `sameOrganism({name, citation}, r)`, or `name` and *r*'s name are
   `orthographicallySame` → **part of** (*Pleurobema furvum* → *P. furva*,
   under *P. rubellum*).
5. Otherwise → **refused**.

*Why*: a record leads to a species that is either this organism under another
name (*is*), or another species that holds this one's name among its synonyms
(*part of*: count only what GBIF filed under this name, and the rest stays
with that species).

## Synonym records

For a species at steps 2 to 5, each Red List synonym in order adds CoL
records. Here `name` and the citation are still the species' own, not the
synonym's. *Why*: CoL may hold as separate species what the Red List treats as
one (*Butorides striata* includes the green heron *B. virescens*), or file
under another species what the Red List lists as a synonym.

**Which records.** Species rank, with the synonym's name (or
`orthographicallySame`), not `MISAPPLIED`, agreeing with the lineage, not
already taken, not under a CoL species this species already counts whole,
and with an authorship at least one unqualified author of the synonym
doesn't compare `other` with (any authorship, if the synonym has no authors
at all). Accepted and provisional first, then by `id`; the order matters
only for which copy gets in. Then, if any record that passed all of these
filters compares `same` with an unqualified author, only those records and
the records that are a copy of one of them (directly, not transitively; by
the test above, with no citation condition) are added, as the steps prefer
matching records (*Pogostemon crassicaulis*'s synonym *Mentha verticillata* D.Don
takes the D.Don record, not the hybrid *Mentha × verticillata* L.).

"Counted whole" is checked again as each record is added: by the steps, or by
any record added before it, of this synonym or an earlier one (*Mycteroperca
radiatus*'s synonym *Epinephelus doderleinii* adds *E. doederleinii*, which is
*E. radiatus*, and not its copy *E. döderleinii*).

A synonym whose every author is qualified adds nothing: it names part of a
taxon or a misapplied name (*Alchemilla vulgaris* "auct."; *Goggia rupicola*
"[pro parte]"). A synonym the Red List files under two species is dropped
before this (`sources/assessments.ts`).

**Relation**, for each record *r* with *s* = `speciesOf(r)`, the first that
applies:

1. `sameOrganism({name, citation}, s)`, and either *r* is *s* and the citation
   doesn't compare `other` with *s*, or *r* is a `SYNONYM` of *s* and the
   citation compares `same` with *s* → **is** (*Cephalorhynchus australis* →
   *Lagenorhynchus australis*). A synonym needs `same` to keep out an epithet
   shared by chance: *Chiococca alba* (L.) Hitchc. and the snowberry
   *Symphoricarpos albus* (L.) K.Koch compare only `unclear`.
2. *r* is *s* → **split into**.
3. Otherwise *s* is another species. If any of the steps' records (a
   *refused* one too) leads to *s* → **part of**. Else if *s* is another assessed name, or another assessed
   species' steps count it whole, the record isn't added.
   Otherwise → **part of**, with the doubt `synonym filed elsewhere` if it has
   occurrences (*Elymus farctus*'s synonym *E. junceiformis*, under
   *Thinopyrum junceiforme*).

In 1 and 2, *s* being another assessed name makes the record **refused**.

## Doubts

A doubt marks a species whose records may be wrong; it never changes which
records are taken. The first seven are computed on the steps' records (steps
3 to 5), the next two on synonym records (steps 2 to 5), and the last from
the AI taxonomic reviews (*AI taxonomic review*), listed in this order:

| Doubt | Holds when | Why it's a doubt |
|---|---|---|
| `chosen by the citation` | the answer isn't taken (or there is none) | the records aren't where GBIF's matcher files the name |
| `homonym` | more than one group, unless exactly one matches and only it is taken | several organisms share the name |
| `other authors` | the citation compares `other` with every taken record | nothing taken is the Red List's name |
| `other spelling` | the answer is taken, `match_type` isn't `EXACT`, and its name isn't `orthographicallySame` as `name` | the matcher guessed a spelling |
| `ambiguous synonym` | a taken record is `AMBIGUOUS_SYNONYM` | CoL itself isn't sure |
| `placed elsewhere` | a taken record's `classification` is below 0 | the matcher scores its family to class against the hints, and below 0 they disagree more than they agree |
| `counts nothing` | every one of the steps' records is *refused* (synonym records may still count) | the Red List's own name counts nothing |
| `split, authors unclear` | a *split into* record (not made *refused*) that no unqualified author of its synonym compares `same` with | a bare "L." can't rule out another author's species (*Vicia sepium* would count *V. dumetorum* L. for the Red List's *V. dumetorum* Thuill.) |
| `synonym filed elsewhere` | a relation-3 synonym record with occurrences | part of another species' records count here |
| `reviewer suggests other records` | a reviewer of a review that applies would count other records | an independent check disagrees with the records; the count follows the rules |

A species is **listed for review** when it has doubts or a reason, until
every AI taxonomic reviewer agrees with its records (see *AI taxonomic
review*). A homonym the citation settles has no doubt; its other groups
stay on the NE list with a note, since the citation says they're other
organisms.

## Counting and the NE list

A CoL species is **counted whole** by an assessed species with an *is* or
*split into* record leading to it. Each CoL record's occurrences have one
owner (`count/usage_owner.sql`), the first that applies:

1. **Part of**: a *part of* record owns its occurrences and those of the
   records CoL files beneath it (by parent), down to three levels. Its count
   starts at the record, except a record of status `synonym` (not an
   ambiguous one) whose parent is a non-nominate infraspecific of the same
   CoL species (the parent leads to the species the synonym leads to, is not
   that species' record, is not of rank species, and its own name's last word
   is not its second, as in *F. teydea teydea*), which starts at that parent
   (*Fringilla polatzeki* → *F. teydea polatzeki*). A synonym leading to no
   species starts at itself. Roots can nest; a record
   goes to the nearest root claiming it, then the lower SIS id, then the
   lower root id (*Zosterops simplex* owns the synonym *Z. simplex* filed
   under *Z. japonicus simplex*: its root is the nearer).
2. **Whole species**: otherwise a record counts for the assessed species that
   counts its CoL species whole, if one does.
3. **Unassessed**: otherwise, for the CoL species itself.

*Why*: a *part of* or *refused* record never takes the rest of its species.
*Pararge xiphioides* (assessed) owns what GBIF filed under its own name, and
*P. aegeria*, which no assessed species counts whole, keeps the rest (3.5M)
and is on the NE list.

Each species claims records through rows, made from its selected records in
order: one per CoL taxon it counts from (the CoL species for *is* and *split
into*, or the record itself where it leads to none; the root above for
*part of*), from the first record that names that taxon, with that record's
relation; a *refused* record claims nothing. The row of its first step record
(never a synonym record) is its **primary** row, and the rest are
**covered**; a species with no step record has no primary row. Where two
assessed species claim one CoL taxon, the stronger claim wins, first by:
primary row before covered; no doubts (other than a review's) before
doubts; *is*, *split into*, *part of*; the species
whose primary row's record has its Red List name as written; the lower SIS id. The
loser's row counts nothing. (This is the one place a doubt affects
counting.)

The species' **GBIF key** is the record it counts from with the best
relation (*is*, then *split into*, then *part of*), then the most
georeferenced occurrences, then the most occurrences, then the lowest id:
*Butorides striata* keeps its own, not the green heron's.

The **Not Evaluated list** is every described species (`lists/species/`'s
`described`) no assessed species counts whole. Two notes ride on it:
`may_be_assessed` (flagged), a candidate's CoL species not taken for a species
with a doubt; and `assessed_here` (a note, not a flag), an assessed species
whose *part of* records lie under it or whose name it holds but whose citation
settled elsewhere.

The build stops if a record has two owners, or a described species is
neither counted whole nor on the NE list.

## AI taxonomic review

Two **AI taxonomic reviewers** check each species listed for review (`npm
run sync:ai-review -- review`, outside the sync). Each is an agent with web
search, asked independently (other batch-mates, other order), that reads the
species' facts, not our answer, and says which of its CoL records it would
count, or *can't tell*. A review never changes the records: the sync reads
the committed `seeds/ai-reviews.tsv` and shows each reviewer's answer beside
the rules', so a build stays reproducible.

Each answer is read as counting would read it (a *part of* on a record that
is itself its CoL species is *is*; any relation on a record leading to no
species is *part of*). A reviewer **agrees** when its answer counts what the
rules count: the same CoL species counted whole (with records or not) and
the same *part of* records, outside those, with records. It suggests **other
records** when it counts something else and cites a source; else it **can't
tell** (also: no answer, a record it wasn't given, or a change without a
source). One row per species and reviewer, with its finding, the records it
would count (each CoL species it counts whole, and each *part of* record,
with their GBIF records when reviewed), its reason, sources and transcript
(the whole conversation, kept so it can be audited), the model, date and
`context` (the CoL XR, GBIF snapshot, matcher version and prompt), and what
it was given: the rules' answer by its records' names, authorship, status and
species, and a hash of the rest (the Red List name, citation and synonyms,
the candidates' species, the rules' doubts).

A species' reviews **apply** while the rules give that answer and that hash.
When every reviewer agrees, the species leaves the review list; it keeps its
doubts and its flag. When one suggests other records, the species gets the
doubt `reviewer suggests other records`, which never weakens its claim in a
clash (*Counting*). Otherwise it stays listed as it was. Either way its match
note says what each reviewer found. A species whose reviews apply isn't asked
again; a new homonym, candidate, synonym or answer lists it again.

**Over time.** Each answer is cached by reviewer, keyed by the species' facts
without the occurrence counts, the prompt and the model, so a run pays only
for species whose facts changed. A release, a Red List update or a matcher
version asks again only what it moves; a new snapshot changes counts, not
answers. A new model or prompt asks nothing by itself: reviews are re-asked
by a run that chooses them (by `context`), which isn't built yet. The
taxonomic notes are facts the reviewers read but not part of the hash, so a
re-assessment that changes only its notes doesn't list a species again.

The reviewers' disagreements are the to-do list for these rules: many of one
kind (the review run prints them by doubt and by what changes) are a rule to
change, which then applies everywhere. One-off exceptions aren't written.

## Output

`npm run sync:select` writes, per species, `{sis_taxon_id, step, reason,
doubts, selected: [{id, relation, relation_step, basis}]}`. `relation_step` is
the relation rule that applied: 1 to 5 for the steps' records; for synonym
records 1, 2, `3` (*s* not reached by the steps) or `3s` (*s* reached by the
steps). `link/assessment_link.parquet` writes the
same as one row per record (the first of the steps' records `primary`, the
rest `covered`, a duplicate `col_taxon_id` once), plus one candidate row per
untaken group's species for the NE list's notes.

## Examples

Each is a fixture case. "Taken" is the records and the step.

| Red List | Answer | Other candidates | Taken (step) | Doubts |
|---|---|---|---|---|
| *Panthera leo* (Linnaeus, 1758) | accepted | — | answer (3) | — |
| *Sorbus greenii* T.C.G.Rich | synonym of *Aria greenii* | — | answer, *is* (3) | — |
| *Cygnus buccinator* Richardson, 1832 | Richardson, 1831 | provisional, 1832 (copy) | both (3) | — |
| *Weinmannia heterophylla* Ruiz & Pav. | Kunth (contradicted) | "Ruiz & Pav. ex López" (matches) | López (3) | chosen by the citation, ambiguous synonym |
| *Rubus fruticosus* L. | HIGHERRANK | L. under *R. plicatus* (matches); G.N.Jones; Lour. | L. (3) | chosen by the citation |
| *Galium palustre* L. | M.Bieb. | L. (matches); Pourr. ex Willk. & Lange | answer, L. (3) | homonym, ambiguous synonym |
| *Vireo chivi* (Vieillot, 1817) | accepted, no authorship | (Vieillot, 1817) under *V. olivaceus* | both (3) | homonym |
| *Lycaena clarki* Clark & Dickson, 1971 | synonym of *Aloeides clarki*, also assessed | — | answer, *refused* (3) | counts nothing |
| *Turdus rubrocanus* Hodgson, 1846 | Gray & Gray, 1847 (contradicted) | "Hodgson, BH, 1844" under *Philepitta castanea* | answer (4) | homonym, other authors |
| *Agrotis sabine* Brandstetter, 2010 | VARIANT *A. sabura* Mabille | — | answer, *refused* (4) | other authors, other spelling, counts nothing |
| *Palaina martensi* (Adams, 1866) | HIGHERRANK | (H. Adams, 1867); (Andreae, 1902) | H. Adams (5) | chosen by the citation, homonym |
| *Amygdalus ledebouriana* Schlecht. | — | two "Schltdl." synonyms | both (5) | chosen by the citation, homonym, other authors |
| *Kuhlia rubens* (Spinola, 1807) | synonym of *Apogon imberbis*, −20 | — | answer (3) | placed elsewhere |
| *Galaxias* sp. nov. 'Verlorenvlei' | HIGHERRANK | — | nothing (1) | — |
| *Ampedus karpathicus* (Buysson, 1885) | misapplied | — | nothing (2), and *A. suecicus* Palm, 1976, *split into* | — |
| *Lepilemur jamesorum* Louis Jr. et al., 2006 | synonym of *L. jamesi*, same citation | — | answer, *is* (3) | — |
| *Butorides striata* (Linnaeus, 1758) | accepted | — | answer (3), and *B. virescens*, *split into* | — |
| *Hoplocephalus bungaroides* (Schlegel, 1837) | accepted | Wagler, 1830 synonyms under it and under *Ophiophagus bungarus* (contradicted: no join) | answer and the Wagler synonym under it (3) | — |

## Not done, and why

- **One record per species** (#639): a homonym forces a choice. *Galium
  palustre* would count its 126,131 bare-name or its 229,826 Linnaeus-cited
  occurrences, not both.
- **Asking the matcher with the author, or with each synonym**: with the
  author it prefers a provisional duplicate (301 species lost 42.6M
  occurrences, #593); the synonyms' answers are mostly hybrids and other
  authors' homonyms (*Ulmus major* → *U. × hollandica*), which looking up the
  names directly avoids.
- **Matching concepts through each Red List Authority's checklist**: not
  machine-readable for most groups.

## Known risks

- **A union or split counts another organism**, where a synonym is meant only
  in part without saying so (*Catapodium borgesii*, VU, would count 20,886
  records of *C. marinum*; it has a decision).
- **A name test misreads a name.** The largest is "L.", which
  `compareAuthors` reads as a bare initial, though in botany it is Linnaeus.

## How it's checked

- **Tests and fixtures**: every example and every doubt is a fixture case,
  run on every build. A fixture states what the rules do; where the AI
  taxonomic reviewers disagree with one, its review says so.
- **Rebuild check** (`npm run sync:rebuild-check`): an agent given only this
  spec, `name-rules.ts` and the inputs rewrites the rule in a sealed folder,
  and its output is compared with `select.ts` species by species. With
  `--counting` it is given select.ts's selection, the CoL taxa and the GBIF
  records under each usage instead, and writes every species' record count
  from *Counting and the NE list*, compared with the sync's. Run after a
  change to these rules or a release move; a disagreement is a gap here, a
  bug there, or an unstated rule.
- **One counting rule** (`npm run sync:owners-check`): the counting rebuild
  check counts with `count/owners.ts`, a copy of `usage_owner.sql`'s rule, so
  the two are compared on a whole build and must give every CoL usage the
  same owner.
- **The AI taxonomic reviewers** (`npm run sync:ai-review`,
  `checks/ai-review.ts`): an agent with web search says which records it would
  count for each species, from the facts alone, and code compares it with
  ours. `review` writes the reviews (*AI taxonomic review*); `first` and
  `changed` score the rules without writing anything. A rule change merges
  only if, among the species it changes, no taxonomic group has fewer judged
  right, unless each species lost becomes a fixture with its correct answer.
  Release moves are scored and reported, never gated.
