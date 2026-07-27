---
"@stll/anonymize": patch
---

Stop an address span absorbing the sentence that precedes it. A city name that is also an ordinary word (`Send`, `Post`) seeded an address, and the seed cluster bridged the prose between it and a nearby street word, so `Send it to 14 Rue de la Paix.` produced the whole sentence as one address. Two ordinary words between two address seeds now end the cluster, while connectives inside a street name (`Avenue of the Americas`, `Rue de la Paix`) still join. Standalone street spans also bound their left edge the way they already bound the right: the walk only crosses street-name words and only when it reaches the house number that opens the address. House numbers now accept a unit letter (`221B Baker Street`).
