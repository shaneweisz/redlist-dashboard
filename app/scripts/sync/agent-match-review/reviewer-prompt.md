You are an AI agent reviewing one name match: the link between an IUCN Red List species and a Catalogue of Life (CoL) record. The sync could not decide this link automatically, so it is waiting. Another reviewer is checking the same link independently; the link is only made if you both agree. Is the CoL record that GBIF's name matcher (matching-ws) answered the right one for this Red List species, and if not, which CoL record is?

Why it matters: the dashboard counts GBIF occurrence records for each Red List species through the CoL species it links to. A wrong link makes a threatened species show another organism's records, and nobody questions a number. If you are not sure, say "unsure": that is always safe.

## The link, as the sync sees it

- `redlist_*`, `category`, `class`, `order`, `family`: the Red List species and its authority.
- `countries` (ISO codes), `systems`, `common_name`: where the Red List assessment says it lives. This is the best evidence of which organism the Red List means.
- `redlist_synonyms`: the names the Red List lists as its synonyms.
- `to_review`: why the sync would not decide. `match_description`: the matcher's answer and the candidates it weighed, in a sentence.
- `matcher_*`: the matcher's answer; `matcher_accepted_*` is the species a synonym answer leads to. `matcher_alternatives`: the other CoL records it weighed, each with the species it leads to.

```json
{{row}}
```

## What to decide

Judge which organism the Red List assesses (its name and authority, and where it lives), then whether the CoL record is that organism. A name can belong nomenclaturally to one taxon while the Red List uses it for the organism living in its countries; the organism is what matters.

Verdicts, about the matcher's answer (`matcher_col_id`):

- "same species": it, and the CoL species it leads to, is this Red List species (same taxon concept; a rename, genus transfer or respelling is fine). `col_id` = `matcher_col_id`.
- "lumped": it is this species' own name, but CoL folds it into a broader species that also covers other taxa. `col_id` = `matcher_col_id`.
- "different species": it, or the species it leads to, is another organism (a homonym by other authors, a congener, a misapplied name, a mis-filed record). Set `col_id` to the CoL record whose name is this species if one exists (often among `matcher_alternatives`), else null.
- "not in CoL": no CoL record is this species.
- "unsure": the evidence doesn't settle it.

`col_id` is the CoL record for this species' name, not the accepted species it leads to, and it must lead to a species: a record CoL files under a genus or higher, or marks "misapplied", is never the answer. When the matcher's record is one of those, look for the record CoL holds this organism under (a species of the same epithet in another genus, say) and give that, or null if there is none; the verdict is then "different species".

## Sources

CoL, the release the sync used, is ChecklistBank dataset 315557. Read it with curl, so the record keeps the raw JSON. Run one plain curl per command: pipes, `;` and `&&` are refused.

    curl -s "https://api.checklistbank.org/dataset/315557/nameusage/<id>"
    curl -s "https://api.checklistbank.org/dataset/315557/taxon/<id>/synonyms"
    curl -s "https://api.checklistbank.org/dataset/315557/nameusage/search?q=<name>&limit=5"

For what the name means and where the species lives, use the group's own authority: Catalog of Fishes or WoRMS for fishes and marine taxa, Amphibian Species of the World, the Reptile Database, Avibase or the IOC list for birds, the Mammal Diversity Database, POWO / IPNI / Tropicos / WFO for plants, MolluscaBase, AntCat, the Phasmida Species File, Index Fungorum. Use curl for APIs (e.g. `https://www.marinespecies.org/rest/AphiaRecordsByName/<name>?like=false`, `https://api.gbif.org/v1/species/search?q=<name>`) and WebFetch or WebSearch for web pages. Do not use or cite the IUCN Red List website. Keep to about 4 to 8 lookups.

In `reasoning`, name the facts that decided it (authors, years, family, where each lives) and the source of each.
