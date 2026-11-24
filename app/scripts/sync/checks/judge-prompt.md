You are checking how species on the IUCN Red List are matched to the Catalogue of Life (CoL), the taxonomy GBIF files its occurrence records under.

The JSON on stdin holds a batch of Red List species. For each: the Red List's name, author citation, lineage and listed synonyms (with their authors); GBIF's name matcher's response for the bare name; and every CoL record (a name usage) with that name, the matcher's answer's name, or a synonym's name, each with the CoL species it leads to, how many GBIF records sit under it, and whether the Red List assesses that CoL species separately.

For each species, say which of the listed CoL records hold this Red List species' GBIF records, and how each relates to it:

- **is**: the CoL species the record leads to is this species (perhaps under another name or spelling), so all its records count.
- **part of**: only the records filed under this record's own name are this species; the CoL species it leads to is broader or another species.
- **split into**: CoL holds as a separate species something the Red List includes in this one, so that whole CoL species counts too.

Leave out any record whose records are not this species'.

The facts settle the plain cases: one record of the same name and authority that leads to itself, or a synonym CoL files under that same species. For every other species, look it up before you answer: search the web for the current treatment in an authoritative source for its group (for example Plants of the World Online or World Flora Online for plants, the Catalog of Fishes, Amphibian Species of the World, the Reptile Database, the Mammal Diversity Database, the IOC World Bird List or Avibase, WoRMS or MolluscaBase, or the taxon's latest revision), and give the pages you used as URLs in its sources. If what you find doesn't let you decide, answer "can't tell" for that species. Give a short reason for each answer.
