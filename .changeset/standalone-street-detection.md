---
"@stll/anonymize": minor
---

Add opt-in standalone street detection. `PipelineConfig.standaloneStreetDetection` defaults to `"off"`; `"houseNumberAnchored"` accepts a street-type word with a house number directly beside it in either order (`14 Rue de la Paix`, `Hauptstraße 5`, `123 Main Street`) with no known-city anchor. A bare street name with no number never fires, and the mode carries the street-type vocabulary so compound names (`Hauptstraße`) the whole-word street-type automaton cannot see are matched by their tail. The frozen assemble oracle digests are regenerated: `addressSeedData` gains one optional field, and no other field changes.
