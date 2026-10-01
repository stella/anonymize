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

Every case declares its complete `expectedEntities` list of UTF-8 byte spans
and labels. Adjacent-word keep cases include the name or forced identifier
elsewhere in the sentence; identifier-shaped and ordinary-word keep cases
expect no entities. Replayed keep cases declare a separate
`forcedExpectedEntities` list for the forced-value profile.

Scoring compares the complete resolved entity multiset (span, label and
gazetteer source). Missing, extra, duplicate, partial or mislabelled entities
fail the case's class, including false positives far from the annotated
surface. The corpus configures the redact operator for each gazetteer label.
An independent oracle replaces each expected span with the configured redact
string and copies every intervening byte. The produced redacted text must
match this output exactly, preserving Unicode, newlines, CRLF and non-breaking
spaces outside expected spans. Empty expected sets require byte-identical
output. Unit tests reject incorrect entity sets, unchanged source text and
corrupted context. The complete oracle replaces the derived adjacent-word
checks on redact cases and the separate span-extent metric; adjacent-word
keep fixtures retain their own class.

`thresholds.json` stores class floors and ceilings as integer numerators with
fixed denominators, avoiding rounded percentages. Bounds were measured on the
matcher this suite ships with; class ceilings retain its behavior for
compounds with plain word or number segments. Measured classes must equal
the declared classes, and case counts must equal the denominators. Review
fixture and threshold changes together; do not lower bounds to accommodate a
regression. The test prints aggregate counts only, never case text or outputs.

Run `cargo test -p stella-anonymize-core --test name_matching_corpus -- --nocapture`.
The normal workspace Rust CI test command discovers this integration test.
