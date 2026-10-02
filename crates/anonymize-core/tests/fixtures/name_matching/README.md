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

Each of Czech, Slovak and English has five positive forced-identifier cases:
both configured UUIDs exactly, an uppercase UUID, a UUID embedded in a path,
and a UUID embedded in JSON. All 15 require exact entities and redaction with
that language enabled alone, then repeat under every language superset.

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
surface. The corpus defaults to the redact operator for each gazetteer label;
per-case label overrides also exercise keep alongside redact.
An independent oracle replaces each expected span with the configured redact
string (or retains a kept entity) and copies every intervening byte. The produced redacted text must
match this output exactly, preserving Unicode, newlines, CRLF and non-breaking
spaces outside expected spans. Empty expected sets require byte-identical
output. Unit tests reject incorrect entity sets, unchanged source text and
corrupted context. The complete oracle replaces the derived adjacent-word
checks on redact cases and the separate span-extent metric; adjacent-word
keep fixtures retain their own class.

Every currently tolerated failure declares `knownFailure`: its actual entity
set and exact redacted output. Unannotated failures and any drift from a pin
reject the gate regardless of aggregate bounds. A pinned case that starts
passing also rejects the gate, requiring removal of the pin and a tighter
class bound. Pins belong to their measurement profile, so a deny-list pin
never applies to the same keep fixture's forced-value replay.

Dedicated cases preserve CRLF, NBSP, tabs and multiline context before and
after names. Multi-entity cases cover different lengths, repeated names and
entities with touching byte ranges. Mixed keep/redact labels check both
operator dispatch and replacements of different lengths. Of the 20 Czech and
Slovak cases in `inflected` and `inflected-diacritics-dropped`, all 15 that
produce no English-only match carry `languageExclusions: ["en"]`. Their
English-only engines must resolve no entities and return unchanged text:

- `inflected` (10): `Novákovi`, `Nováka`, `Novákem`, `Marií Dvořákovou`,
  `Tomáše Kubíčka`, `Tomášovi Kubíčkovi`, `Ľubomírovi Šťastnému`,
  `Zuzany Kováčovej`, `Zuzanou Kováčovou`, `Zelvanskou energetikou, a. s.`.
- `inflected-diacritics-dropped` (5): `Novakovi`, `Novakem`, `Tomase Kubicka`,
  `Lubomirovi Stastnemu`, `Zuzany Kovacovej`.

The remaining five omit the exclusion because English still supports
case/diacritics folding and language-neutral fuzzy matching. Each is within
the corresponding canonical name's two-edit budget:

| Class                          | Surface                    | Folded edits from canonical      |
| ------------------------------ | -------------------------- | -------------------------------- |
| `inflected`                    | `Marii Dvořákové`          | 2 from `Marie Dvořáková`         |
| `inflected-diacritics-dropped` | `Marii Dvorakove`          | 2 from `Marie Dvořáková`         |
| `inflected`                    | `Velmorské stavební a.s.`  | 1 from `Velmorská stavební a.s.` |
| `inflected-diacritics-dropped` | `Velmorske stavebni a.s.`  | 1 from `Velmorská stavební a.s.` |
| `inflected`                    | `Velmorskou stavební a.s.` | 2 from `Velmorská stavební a.s.` |

Czech and Slovak share the matcher inflection policy. These checks enforce
that morphology boundary against English, without disabling its fuzzy
matching or claiming separate cs/sk policies.

Every keep fixture declares a tagged `negativeCheck`. Suppression cases
identify a configured surface inside the guarded region and a neutral context
where the real assembled engine must resolve that entire surface with its
expected label and exact output. All identifier, hex, UUID, hash and marker
classes require this control, and the `guard-control` class requires every
control to pass. The synthetic four-letter name `Acfe` seeds hex-compatible
opaque tokens without enabling fuzzy matching for that name. Plain numeric
or word segments are intentionally permitted by the matcher; bracketed
identifier fixtures therefore use opaque compound segments, or a field
glued to digits inside template delimiters (`<<token:zeta9>>`), rather than
assuming brackets suppress names: a plain name inside `<<…>>`, `{{…}}` or
`[[…]]` still matches; only `⟦…⟧` suppresses everything inside it.

Distinct negatives declare why the text is not a configured surface;
context negatives require expected entities elsewhere in the document.
Forced-only replay declares `forcedNegativeCheck` separately because those
fixtures contain neither configured forced UUID. Missing negative intent,
a control seed absent from its guarded surface, an unmatched neutral
control, or a guard class relabelled as a distinct non-match rejects the gate.
Unit tests exercise these validation failures through the production engine.

`thresholds.json` stores class floors and ceilings as integer numerators with
fixed denominators, avoiding rounded percentages. Bounds were measured on the
matcher this suite ships with; class ceilings retain its behavior for
compounds with plain word or number segments. Measured classes must equal
the declared classes, and case counts must equal the denominators. Review
fixture and threshold changes together; do not lower bounds to accommodate a
regression. By default the test prints aggregate counts only, never case text
or outputs.

Run `cargo test -p stella-anonymize-core --test name_matching_corpus -- --nocapture`.
The normal workspace Rust CI test command discovers this integration test.

To list failing cases, set `NAME_MATCHING_CORPUS_FAILURES=1`:

```sh
NAME_MATCHING_CORPUS_FAILURES=1 cargo test -p stella-anonymize-core \
  --test name_matching_corpus labeled_name_matching_corpus_gate -- --nocapture
```

Each failing case, pinned ones included, prints as one JSON line with its
profile, class, languages, text, expected and actual entities, and expected
and actual output; the per-class table follows. The gate collects every case
violation and fails once, after the table.

Suppression controls also replay the seed at its original byte span: replace
only the surrounding annotated envelope with equal-width spaces, preserve the
seed and all text outside that envelope, and require the exact entity and
redacted output. Shared production predicates must reject each unpinned guarded occurrence
and accept the counterfactual occurrence. Contiguous hex/hash seeds exercise
candidate edge admission; whole joined segments and marker contents exercise
identifier suppression after edge admission. The `acfe0a1b2c3d4e5f` regression
explicitly checks the former, while `9b1d0c3e-acfe-4ca1-8b2e-5c7a0a1b2c3d`
checks the latter. A neutral match alone cannot satisfy these controls.

The existing `<<token:zeta9>>` accepted failure is eligible under production's
numeric-glue rule. Its exact entity and redacted output stay pinned; the control
must not misrepresent it as a suppressed occurrence. Guard rejection is required
for every unpinned control, and the accepted failure still requires exact recall
at the counterfactual occurrence. Existing false-positive ceilings are unchanged.
