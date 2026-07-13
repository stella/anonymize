# Reproducing the benchmark

This document records the exact toolchain, library versions, models, and
taxonomy-mapping decisions behind the numbers in `results/`. The goal is that
anyone can re-run the comparison and get the same shape of result on comparable
hardware.

## What is measured

`@stll/anonymize` (stella) versus three other open-source PII libraries on a
public, synthetic, legal-domain corpus (en/cs/de):

- **Microsoft Presidio** (`presidio-analyzer`) with spaCy models.
- **scrubadub** (base install).
- **redact-pii** 3.4.0 detector assets, vendored from the npm package.

Metrics: per-label and overall precision / recall / F1 with span-overlap
matching, plus throughput (chars/sec, cold and warm). See `src/metrics.ts`.

## Hardware / runtime note

The committed run under `results/` was produced on Apple M3 (8 cores), 24 GiB
RAM, macOS, with Bun 1.3.14 and CPython 3.11.12. Throughput is a single run on
one machine; treat it as order-of-magnitude, not a precise micro-benchmark.
Recall/precision are deterministic and machine-independent.

## Toolchain versions (committed run)

| Component                       | Version       |
| ------------------------------- | ------------- |
| Bun                             | 1.3.14        |
| stella (`@stll/anonymize`)      | 2.0.0-alpha.1 |
| redact-pii (npm)                | 3.4.0         |
| Python                          | 3.11.12       |
| presidio-analyzer               | 2.2.360       |
| presidio-anonymizer             | 2.2.360       |
| spaCy                           | 3.8.7         |
| en_core_web_lg                  | 3.8.0         |
| de_core_news_lg                 | 3.8.0         |
| xx_ent_wiki_sm (used for Czech) | 3.8.0         |
| scrubadub                       | 2.0.1         |
| phonenumbers                    | 8.13.55       |

## Steps

### 0. Build the workspace

The stella adapter needs the native binding. From the repo root:

```sh
bun install
bun run build
```

### 1. stella and redact-pii (Node/Bun)

No extra setup. stella is a workspace dependency. The exact regexp and name-list
assets used by the redact-pii 3.4.0 adapter are committed under
`vendor/redact-pii/3.4.0/` with their upstream license and checksums. The adapter
does not install redact-pii's unused Google DLP dependency tree.

### 2. Presidio virtualenv (Python)

Uses [uv](https://github.com/astral-sh/uv). From `packages/benchmark`:

```sh
uv venv .venv-presidio --python 3.11
uv pip install --python .venv-presidio -r python/requirements-presidio.txt
uv pip install --python .venv-presidio \
  "https://github.com/explosion/spacy-models/releases/download/en_core_web_lg-3.8.0/en_core_web_lg-3.8.0-py3-none-any.whl" \
  "https://github.com/explosion/spacy-models/releases/download/de_core_news_lg-3.8.0/de_core_news_lg-3.8.0-py3-none-any.whl" \
  "https://github.com/explosion/spacy-models/releases/download/xx_ent_wiki_sm-3.8.0/xx_ent_wiki_sm-3.8.0-py3-none-any.whl"
```

If the venv is missing, the runner reports Presidio as `unavailable` and
continues with the other libraries rather than failing.

### 3. scrubadub virtualenv (Python)

```sh
uv venv .venv-scrubadub --python 3.11
uv pip install --python .venv-scrubadub -r python/requirements-scrubadub.txt
```

### 4. Run

```sh
bun run bench:compare
```

Writes `results/<date>.json`, `results/<date>.md`, and `results/latest.md`.

## Corpus and ground truth

The corpus lives in `fixtures/` as per-language JSON. Each document is an
ordered list of segments; plain strings are non-PII filler and objects carry a
labelled entity. The loader (`src/ground-truth.ts`) concatenates segment text
and derives every entity's `[start, end)` from its position, so offsets are
correct by construction and reviewable in the diff.

All text is **public-safe synthetic** legal prose: invented people, companies,
and identifiers. The repo's `.snapshot.json` contract fixtures are stella's own
pipeline output and are deliberately NOT used as ground truth (that would be
circular). Offsets are UTF-16 code units; fixtures avoid astral-plane
characters, so UTF-16 offsets equal Python code-point offsets and spans align
across the Node and Python adapters.

## Common taxonomy and per-library mapping

Every library reports its own label vocabulary. To compare fairly, each
library's native labels are mapped onto eight common categories. The coarseness
is a fairness choice: libraries that lump identifiers together are not penalised,
and stella's finer labels are collapsed the same way. The authoritative mapping
is `src/taxonomy.ts`; a summary:

Common labels: `person`, `organization`, `address`, `email`, `phone`,
`id-number`, `date`, `money`.

| Common label | stella                                                                                                                 | Presidio                                                                                                                                     | scrubadub                                                                                                                    | redact-pii                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| person       | person                                                                                                                 | PERSON                                                                                                                                       | —                                                                                                                            | names                                    |
| organization | organization                                                                                                           | ORGANIZATION / ORG                                                                                                                           | —                                                                                                                            | —                                        |
| address      | address, country, land parcel                                                                                          | LOCATION, GPE, NRP, ADDRESS                                                                                                                  | —                                                                                                                            | streetAddress, zipcode                   |
| email        | email address                                                                                                          | EMAIL_ADDRESS                                                                                                                                | email                                                                                                                        | emailAddress                             |
| phone        | phone number                                                                                                           | PHONE_NUMBER                                                                                                                                 | phone                                                                                                                        | phoneNumber                              |
| id-number    | bank account, iban, tax id, identity card, birth number, national id, ssn, registration, credit card, passport, crypto | US_SSN, US_ITIN, US_PASSPORT, US_DRIVER_LICENSE, US_BANK_NUMBER, IBAN_CODE, CREDIT_CARD, CRYPTO, MEDICAL_LICENSE, UK_NHS, IN_PAN, IN_AADHAAR | credit_card, social_security_number, drivers_licence, national_insurance_number, tax_reference_number, vehicle_licence_plate | creditCardNumber, usSocialSecurityNumber |
| date         | date, date of birth                                                                                                    | DATE_TIME                                                                                                                                    | —                                                                                                                            | —                                        |
| money        | monetary amount                                                                                                        | —                                                                                                                                            | —                                                                                                                            | —                                        |

`—` means the library has no recognizer that maps to that category, so it scores
zero recall there (reported, not hidden). scrubadub's base install ships no name
detector (it needs the optional `scrubadub_spacy`/`scrubadub_stanford` plugin,
not installed here), so `person` is deliberately left out of scrubadub's mapping
in `src/taxonomy.ts`: the base library can never emit a name, and listing it
would inflate scrubadub's supported-labels denominator with a category it does
not attempt. scrubadub's supported labels are therefore `email`, `phone`, and
`id-number` (3/8).

Native labels mapped to `null` in `src/taxonomy.ts` (URLs, usernames, IP
addresses, Twitter handles, credentials) are dropped before scoring, so a
library is never charged a false positive for correctly detecting a real
category the ground truth does not track.

### Mapping fairness decisions

- **Presidio NRP/GPE/LOCATION -> address.** NRP (nationalities, religious and
  political groups) is folded into `address` as the closest bucket; this is
  generous to Presidio (it converts some would-be false positives into possible
  true positives).
- **Coarse `id-number`.** All government/financial identifiers collapse to one
  bucket for every library, so no library is penalised for not distinguishing a
  passport number from a tax id.
- **Czech via multilingual model.** Presidio has no first-party Czech pipeline,
  so Czech uses `xx_ent_wiki_sm`, which has PER/LOC/ORG/MISC but no DATE. Czech
  date recall for Presidio is therefore structurally zero; this is a real
  limitation, reported in the per-language table.

## Adapter faithfulness notes

- **stella** runs its native rules pipeline with NER off, matching the product
  default and the corpus tooling config (`src/adapters/stella.ts`).
- **Presidio** is configured multilingually with the language-agnostic pattern
  recognizers enabled for all three languages (`python/presidio_adapter.py`).
- **scrubadub** runs its default `Scrubber()`; the active detector set is
  recorded in the JSON output and the report's adapter notes.
- **redact-pii** is a redaction library that returns masked text, not spans. The
  adapter recovers spans by running redact-pii's own detectors over the original
  text: the exported regexp built-ins via `matchAll`, and a faithful
  reproduction of its `NameRedactor` (internals are not exported) loading the
  same `well-known-names.json`. Those detector inputs are vendored byte-for-byte
  from the pinned 3.4.0 npm package; see the vendor README for provenance and
  checksums. Running on the original text yields a superset of what sequential
  redaction emits, so this is generous to redact-pii's recall.

## Init vs. per-document boundary (throughput fairness)

The `init (s)` column is one-time setup; `cold`/`warm` chars/sec are the
per-document detection passes. For the comparison to be fair, every library's
own one-time cost must fall inside `init`, not be hidden at import time or folded
into the per-document loop. What counts as init for each adapter:

| Library    | Counted as init (one-time)                                                                      | Per document (cold/warm)       |
| ---------- | ----------------------------------------------------------------------------------------------- | ------------------------------ |
| stella     | load full bundled dictionaries (names, deny lists, cities), load native binding, build pipeline | `redactText` per doc           |
| Presidio   | load the three spaCy models and build the analyzer/recognizer registry                          | `analyzer.analyze` per doc     |
| scrubadub  | construct `Scrubber()` (instantiates its detectors)                                             | `iter_filth` per doc           |
| redact-pii | load built-in pattern list + well-known-names, compile regexes (large name alternation)         | run compiled detectors per doc |

stella's dictionary load and binding load are the analogue of Presidio's model
load, so they are timed inside `init` (`src/adapters/stella.ts`); earlier they
happened in the adapter factory before the timer started, which understated
stella's init. redact-pii's pattern/name-list load and regex compilation are
likewise timed as init rather than left as a module-load side effect
(`src/adapters/redact-pii.ts`). Python init is measured inside each Python
process and excludes interpreter startup, which is reported separately in prose.

## Provenance of committed results

The `commit` field in committed results records the SHA of the source tree
that produced them, which is a PR-branch commit. This repository squash-merges,
so that SHA is not on `main`'s first-parent history; it remains permanently
fetchable via the pull request head ref (`git fetch origin pull/<PR>/head`).
Recording the post-squash SHA is impossible by construction: it does not exist
until after the results are committed.
