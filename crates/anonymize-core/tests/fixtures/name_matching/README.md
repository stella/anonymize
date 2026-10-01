# Name matching corpus

All names, organizations and identifiers are fictional test data. Czech,
Slovak and English cases exercise case folding, diacritics, morphology,
typos, legal forms and whitespace/order variations. Identifier-shaped tokens,
ordinary words and adjacent words provide negative labels. This vocabulary
covers those three languages; it does not claim coverage of other languages.

`name_matching_corpus.rs` assembles the production native gazetteer and runs
its complete resolution/redaction path. Unrelated dictionary, regex and
contextual detectors are disabled to attribute results to caller-owned names.
Forced values are gazetteer entries labeled `registration number`, including
case-insensitive and embedded occurrences; negative name cases run again with
only those entries active.

Each case declares its language. Scores use that language alone; the
`language-scope` class requires identical resolved entities and redaction when
either other language, or both, are enabled. Its divergence ceiling is zero.
The `marker-suppression` case contains the configured fictional name `Zeta`
inside `⟦…⟧`, with zero false positives allowed. Its `marker-control` pair
requires an exact hit on the same name in the same sentence without brackets;
both cases must pass, so marker suppression cannot pass vacuously.

Recall requires a gazetteer entity with the expected label and exactly the
labeled byte range, with no overlapping entity extending outside it. Partial matches, even several
that collectively remove the name, do not count. Any overlap with a keep
surface is a false positive. Every must-redact case additionally contributes
a negative word check to `adjacent-word`: all resolved entities are checked
against the nearest preceding and following Unicode word ranges, including
separate neighboring entities. Swallowing a neighboring word also fails
recall. `span-extent` separately scores all overreach, including punctuation, so punctuation cannot relax the
adjacent-word ceiling. Offsets must remain valid UTF-8
boundaries. A scoring test rejects substring and overextended matchers.

`thresholds.json` stores class floors and ceilings as integer numerators with
fixed denominators, avoiding rounded percentages. Bounds were measured on the
matcher this suite ships with; class ceilings retain its behavior for
compounds with plain word or number segments. Measured classes must equal
the declared classes, and case counts must equal the denominators. Review
fixture and threshold changes together; do not lower bounds to accommodate a
regression. The test prints aggregate counts only, never case text or outputs.

Run `cargo test -p stella-anonymize-core --test name_matching_corpus -- --nocapture`.
The normal workspace Rust CI test command discovers this integration test.
