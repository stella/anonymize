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

Recall requires a resolved entity with exactly the labeled byte range, with
no overlapping entity extending outside it. Partial matches, even several
that collectively remove the name, do not count. Any overlap with a keep
surface is a false positive. Every must-redact case additionally contributes
a negative word check to `adjacent-word`: swallowing neighboring words both
fails recall and counts as a false positive. `span-extent` separately scores
all overreach, including punctuation, so punctuation cannot relax the
adjacent-word ceiling. Offsets must remain valid UTF-8
boundaries. A scoring test rejects substring and overextended matchers.

`thresholds.json` stores class floors and ceilings as integer numerators with
fixed denominators, avoiding rounded percentages. Bounds were measured on
`3598acf007`; class ceilings retain that implementation’s behavior for
compounds with plain word or number segments. Measured classes must equal
the declared classes, and case counts must equal the denominators. Review
fixture and threshold changes together; do not lower bounds to accommodate a
regression. The test prints aggregate counts only, never case text or outputs.

Run `cargo test -p stella-anonymize-core --test name_matching_corpus -- --nocapture`.
The normal workspace Rust CI test command discovers this integration test.
