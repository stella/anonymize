# Twitter / X Holdings merger agreement — FP/FN ledger

Public M&A filing (Twitter, Inc. + X Holdings I/II, Inc., dated 25 April 2022).
Fixture: `packages/anonymize/src/__test__/fixtures/contracts/en/twitter-merger-agreement.txt`.
Pipeline output captured from a single `runPipeline` call with all
detectors enabled except `enableGazetteer`/`enableNer` (matches
`contract-snapshots.test.ts` defaults). 315 entities total
(date 68, address 83, person 70, organization 84, monetary amount 10).

The cases below are each pinned by `TODO(anon-NNN)` to a corresponding
`test.skip(...)` in `twitter-regression.test.ts`. Every test names the
exact text, label, and offset so a fix can land case-by-case without
having to re-read the entire 277 KB fixture.

## False Positives

Cases where the pipeline emitted an entity that is either not PII
or is labelled incorrectly. Grouped by suspected detector.

### deny-list (English): generic legal/role terms tagged as person

The deny-list dictionary appears to contain English defined-term tokens
("Laws", "Vote", "Letters", "Fee", "Measures") and clauses
("Blue Sky Laws", "Bond Hedge Transactions", "Bond Hedge Documentation",
"Master Confirmation", "Labor Matters", "Vote Required") that surface
as `person`. None of these are personally identifying — they are
defined terms or section headings in the merger agreement.

- anon-101: `"Laws"` tagged as `person` (offset 5366, also 8454).
  Context: `"Antitrust Laws"`, `"Blue Sky Laws"`. Likely from a
  deny-list entry that should be label `MISC` or removed entirely.
- anon-102: `"Blue Sky Laws"` tagged as `person` (offset 5500,
  16682, 84893). U.S. securities law term, not a person.
- anon-103: `"Bond Hedge Documentation"` tagged as `person`
  (offset 6025, 21755). Defined term inside Article I.
- anon-104: `"Bond Hedge Transactions"` tagged as `person`
  (offset 6071, 78322, 135794). Defined term.
- anon-105: `"Vote"` tagged as `person` (offset 6843). Plain
  English noun appearing inside `"Company Stockholder Advisory Vote"`.
- anon-106: `"Measures"` tagged as `person` (offset 7275).
  Comes from `"COVID-19 Measures"`.
- anon-107: `"Letters"` tagged as `person` (offset 7366).
  From `"Debt Commitment Letters"`.
- anon-108: `"Morgan"` tagged as `person` (offset 8833).
  Bare surname token captured outside the full firm name —
  should either roll up into `"J.P. Morgan Securities LLC"` /
  `"Morgan Stanley"` or not fire at all.
- anon-109: `"Fee"` tagged as `person` (offset 9579, 10538).
  From `"Termination Fee"` defined term.
- anon-110: `"Tesla Shares"` tagged as `person` (offset 10555,
  45014 with curly quote, 193109, 193374). Title of a
  defined term, not a person.
- anon-111: `"Master Confirmation"` tagged as `person`
  (offset 17518, 17659). Derivative-contract document name.
- anon-112: `"London Branch"` tagged as `person` (offset 19247,
  19643, 28054, 28402). Branch designator inside
  `"JPMorgan Chase Bank, N.A., London Branch"`.
- anon-113: `"Bond Hedging Transactions"` tagged as `person`
  (offset 78322). Variant spelling, same class as anon-104.
- anon-114: `"Hart-Scott-Rodino Antitrust Improvements"`
  tagged as `person` (offset 38029). Name of an Act.
- anon-115: `"Labor Matters"` tagged as `person` (offset 99655).
  Article heading.
- anon-116: `"Vote Required"` tagged as `person` (offset 106425).
  Section heading.
- anon-117: `"Accounting Standards Board"` tagged as `person`
  (offset 142319). Body name (organization at best).
- anon-118: `"Merrill Lynch"` tagged as `person` (offset 126341).
  Context: `"Bank of America Merrill Lynch"`. Should be folded
  into the bank name as organization.
- anon-119: `"Wall Street Journal"` tagged as `person`
  (offset 239123). Newspaper name (organization).
- anon-120: `"Bond Hedge Documentation”"` and
  `"Bond Hedge Transactions”"` — entries with a stray
  trailing curly quote (offset 18985, 21662). Span should
  trim the punctuation; orthogonal to the label issue but
  worth its own regression.

### deny-list: bare bank token

- anon-121: `"Bank"` tagged as `organization` (offset 5400, 5454,
  16530, 16611, 118057, 118392, 118874, 119294, 120462, 192215,
  199227, 199552, 202280, 206372, 206451, 207776, 208673,
  212074, 212236, 214739). 20+ hits across the file. The
  literal word `"Bank"` is too generic to mask. Should only fire
  when expanded into the full bank name (e.g.
  `"Wells Fargo Bank, National Association"`). Suspect a too-short
  deny-list entry or legal-form leaving a stub.
- anon-122: `"Oil"` tagged as `organization` (offset 37739).
  Bare common noun — almost certainly a deny-list entry
  meant for an oil-company brand bleeding through.

### deny-list / hotword: location nouns tagged as address

- anon-123: `"Delaware"` tagged as `address` (offset 11369, 11429,
  11485, 118589, 265233). Useful as `jurisdiction` perhaps,
  but the bare state name is shown standalone in
  `"X Holdings I, Inc., a Delaware corporation"` — that is a
  corporate-formation phrase, not an address. Either the
  label should not be `address`, or the span should pull in
  the whole `"Delaware corporation"` context.
- anon-124: `"New York"` tagged as `address` (offset 259881,
  261230). Standalone, no street/postal context — likely a
  governing-law fragment, not a postal address.
- anon-125: `"California Corporations"` tagged as `address`
  (offset 17055). Span is a defined-term fragment from
  `"California Corporations Code"`, not an address.
- anon-126: `"Pacific Time"` tagged as `address` (offset 45924).
  Time-zone label, not an address.
- anon-127: `"Silver Lake Partners"` tagged as `address`
  (offset 42947). Should be `organization` — see FN anon-205.
- anon-128: `"Silver Lake Investment"` tagged as `address`
  (offset 10056, 78504). Same defined-term: should not be
  `address`.
- anon-129: `"New York Stock"` tagged as `address`
  (offset 85039, 219877). Truncation of
  `"New York Stock Exchange"` — should be `organization` with
  the full span.
- anon-130: `"The D"` tagged as `address` (offset 181239).
  Two-character fragment — clearly a span-extraction bug.
- anon-131: `"Anthony"` tagged as `address` (offset 243844).
  First name of a notice contact. Should be `person`, not
  `address`.
- anon-132: `"Katherine"` tagged as `address` (offset 243863).
  Same as anon-131.
- anon-133: `"Palo Alto"` tagged as `address` (offset 243590)
  — correct label, but it appears _inside_ the broader
  `"650 Page Mill Road / Palo Alto, CA 94304-1050"` block
  and should be merged into that single address span (see
  also anon-220).
- anon-134: `"Delaware Court"` tagged as `address`
  (offset 256295, 256817, 257331). The Delaware Court of
  Chancery is a court (potentially `organization`), not a
  street address.
- anon-135: `"State of Delaware or any other jurisdiction)..."`
  (offset 251792). The trigger expansion captured an entire
  multi-clause governing-law paragraph (159 chars) as
  `address`. Likely a runaway boundary in the
  `"State of <X>"` trigger.
- anon-136: `"State of Delaware or any federal court sitting in
the State of Delaware in the event any dispute..."` (offset
  256346, 158 chars). Same pattern as anon-135 — trigger
  expansion eats the entire forum-selection clause.
- anon-137: `"District of New York sitting in New York County"`
  (offset 260025, 261374) tagged as `address`. Forum-selection
  language, not an address.
- anon-138: `"State of New York"` tagged as `address`
  (offset 259852, 260412, 261201). Governing-law reference,
  not a postal address.
- anon-139: `"State of Delaware."` tagged as `address`
  (offset 273754). Trailing period swallowed into the span;
  separate trim bug.

### deny-list / coreference: court tagged as organization

- anon-140: `"Supreme Court"` tagged as `organization`
  (offset 259831, 261180). Bare phrase, no jurisdiction
  context bundled in — either should be `organization` with
  `"Supreme Court of the State of New York"` as the span,
  or not emitted at all.

### regex: section/index numbers extending into address

- anon-141: TOC entries of the form `"<Title> <PageNumber>"`
  tagged as `address` (offsets 248, 283, 319, 1434, 1496,
  1548, 1584, 1632, 1671, 1718, 1749, 1793, 1827, 1861,
  1904, 1943, 1976, 2032, 2074, 2109). Examples:
  `"The Merger 13"`, `"Effective Time 13"`,
  `"Absence of Certain Changes or Events 26"`,
  `"Litigation 26"`, `"Taxes 29"`, `"RESERVED 30"`,
  `"Brokers 30"`, `"Vote Required 30"`, etc. Caused by an
  address-seeds postal-code clustering pass that treats
  any trailing 2-digit number as a postal seed.
- anon-142: `"Section 6"` tagged as `address` (offset 42400,
  42481, 181280). Article numbering swept into address span.
- anon-143: `"Section 8"` tagged as `address` (offset 85005).
- anon-144: `"Suite 900"` tagged as `address` (offset 243386).
  Suite is correctly part of an address — but it was emitted
  as a standalone entity, not merged with the surrounding
  `"525 University Ave / Palo Alto, California 94301"` block
  (see FN anon-206). Same root cause as anon-133.

### deny-list / coreference: name fragments tagged as person

- anon-145: `"Market Street"` tagged as `person` (offset 243371).
  Should be address (it's `"1355 Market Street"`); the entity
  span lost the leading number.
- anon-146: `"Meagher & Flom LLP"` tagged as `person`
  (offset 243184). Fragment of
  `"Skadden, Arps, Slate, Meagher & Flom LLP"` — should be
  `organization` and the span should start at "Skadden".
- anon-147: `"Wilson Sonsini Goodrich & Rosati"` tagged as
  `person` (offset 243513). Law firm name, should be
  `organization`.
- anon-148: `"Simpson Thacher & Bartlett LLP"` tagged as
  `person` (offset 243750). Law firm, should be
  `organization`.
- anon-149: `"Kim"` tagged as `person` (offset 243308).
  Truncation of `"Dohyun Kim"` — surname-only span.
- anon-150: `"Segal"` tagged as `person` (offset 273964,
  273982). Bare surname, lacks first name context.
- anon-151: `"Road"` tagged as `person` (offset 243585).
  Street-type word leaked into person — `"650 Page Mill
Road"` should be address.
- anon-152: `"M. Krause"` tagged as `person` via `regex`
  (offset 243873). Source label says `regex` but the
  full name is `"Katherine M. Krause"`. The regex captured
  the initial + surname and dropped the given name.

### legal-form: organization span includes extra trailing text

- anon-153: `"X Holdings III, LLC"` is detected correctly
  (offset 118566) but only once — `"a Delaware limited
liability company"` is appended in the source. The
  legal-form detector cleanly stops, which is good — but
  see FN anon-201 for the I and II variants that are
  missed at _every_ additional occurrence after the first.

## False Negatives

Text that should have surfaced as an entity but did not. Grouped
by suspected detector that should fire.

### deny-list / legal-form: missing party names

- anon-201: `"X Holdings I, Inc."` and `"X Holdings II, Inc."`
  occur many times across the recitals, signature block, and
  body (e.g. preamble line 1164, signature page lines 1709,
  1721). Only one instance of `"X Holdings II, Inc."` is
  caught by `[legal-form]` at offset 11462 and a couple at
  the signature pages. The preamble line that introduces
  both entities (`"is made by and among Twitter, Inc., a
Delaware corporation (the “Company”), X Holdings I, Inc.,
a Delaware corporation (“Parent”), X Holdings II, Inc.,..."`)
  emits no entity for `"X Holdings I, Inc."`. Likely the
  comma + `"a Delaware corporation"` clause defeats the
  legal-form boundary walker on the first occurrence.
- anon-202: `"Twitter, Inc."` is never tagged as
  `organization` despite occurring 20+ times — preamble,
  recitals, signature page, exhibits. The deny-list /
  legal-form detector should catch it; an in-name comma
  may be the cause.
- anon-203: `"Twitter"` standalone — appears in the document
  title block (`"TWITTER, INC."` at line 7) and as part of
  defined-term references. Should at minimum be coreferent
  with `"Twitter, Inc."` once that fires.
- anon-204: `"Computershare Trust Company, N.A."`
  (line 1314, 1802) — paying / rights agent, missing
  from output entirely.
- anon-205: `"Silver Lake Partners V DE (AIV), L.P."`
  (line 1307). Investor partnership. Partially captured as
  `"Silver Lake Partners"` but mislabeled as `address`
  (see anon-127) and the unique disambiguating tail
  `"V DE (AIV), L.P."` is dropped, defeating any redaction
  of the actual fund identity.
- anon-206: `"Skadden, Arps, Slate, Meagher & Flom LLP"`
  full span (line 1631) — law firm. Only a fragment fires
  (anon-146).
- anon-207: `"Morgan Stanley Senior Funding, Inc."` (line 1460) — debt-financing source. Pipeline only emits
  `"Morgan Stanley"`.
- anon-208: `"Goldman Sachs & Co. LLC"` full span — only
  `"Goldman Sachs"` fires; the LLC tail is dropped.
- anon-209: `"J.P. Morgan Securities LLC"` — only
  `"Morgan Securities LLC"` is captured (offset 106891),
  the `"J.P."` prefix is lost.
- anon-210: `"Allen & Company LLC"` (line 1438) — fires
  once at offset 106933 but is `organization`, good; missing
  at follow-on references in the brokers / advisors
  paragraphs.
- anon-211: `"U.S. Bank National Association"` is captured
  (good), but its sibling co-trustee references via
  `"Wells Fargo Bank, National Association"` and
  `"Bank of America, N.A."` are only partially captured
  — the `, N.A.` suffix never carries through.
- anon-212: `"Barclays Bank PLC"` — pipeline emits only
  `"Barclays Bank"`, dropping the `PLC` legal form.
- anon-213: `"JPMorgan Chase Bank, N.A."` — only the
  stem `"JPMorgan Chase Bank"` fires; the `, N.A.` suffix
  is lost.
- anon-214: `"Barclays"` standalone (line 1462). Should
  be `organization`; currently not emitted at all.
- anon-215: `"Bank of America Merrill Lynch"` (line 1462)
  is split: `"Bank of America"` fires as organization but
  `"Merrill Lynch"` fires separately as person (anon-118).
  The single brand name should be one organization span.

### legal-form / regex: address blocks lost or truncated

- anon-216: Notice address for Skadden Arps:
  `"525 University Ave, Suite 1400 / Palo Alto, California
94301"` (lines 1632–1633). Only fragments — `"University
Ave"`, `"Suite 900"` (wrong number!), `"Palo Alto,
California"` — are captured.
- anon-217: Twitter HQ address:
  `"1355 Market Street, Suite 900 / San Francisco,
California 94103"` (lines 1643–1644). Only
  `"Market Street"` (mislabeled as person, anon-145) and
  `"San Francisco, California"` fire. The street number
  `1355`, the suite, and the ZIP code `94103` are dropped.
- anon-218: Wilson Sonsini address:
  `"650 Page Mill Road / Palo Alto, CA 94304-1050"`
  (lines 1650–1651). Street number missing, ZIP missing.
- anon-219: Simpson Thacher address:
  `"425 Lexington Avenue / New York, New York 10017"`
  (lines 1662–1663). `"Lexington Avenue"` captured but
  the street number `425` and ZIP `10017` are dropped.
- anon-220: U.S. ZIP codes (`94301`, `94103`, `94304-1050`,
  `10017`) — five distinct ZIP+4 / ZIP5 values across the
  notice block. None are emitted as standalone entities.
  No detector handles U.S. ZIP codes; should be added.

### regex: missing percentages / financial rates

- anon-221: `"3.875%"` — interest rate on the
  `"Existing 2027 Senior Notes"` (line 1255). Not flagged.
- anon-222: `"5.000%"` — rate on `"Existing 2030 Senior
Notes"` (line 1256). Not flagged.
- anon-223: `"0.25%"`, `"0.375%"`, `"0%"` — convertible-note
  coupon rates (line 1257). Not flagged. Percentages are
  not necessarily PII, but here they identify the security
  series; the test simply asserts the regex detector exposes
  them when enabled.

### regex: missing year-only / due-year identifiers

- anon-224: `"due 2027"`, `"due 2030"`, `"due 2024"`,
  `"due 2025"`, `"due 2026"` (lines 1255–1257). Note
  maturities. Plain-year references are intentionally not
  tagged as `date`; this is the date-regex limitation, but
  worth pinning to ensure the policy is deliberate.

### regex: missing large monetary amounts

- anon-225: `"$25 million"` (line 1492). Pipeline emits
  `"$25"` (offset 143401) but truncates before the unit.
  Span should include `million`.
- anon-226: `"$1,000,000,000"` correctly fires at offsets
  40315 and 44997 but `"Parent Termination Fee" / "$1
billion"` (used elsewhere) — the textual `"one billion
dollars"` would not be captured either. Pin as deferred.
- anon-227: Share counts: `"5,000,000,000 shares"`,
  `"763,577,530"`, `"200,000,000"`, `"953,365"`,
  `"2,900,689"`, `"67,575,223"`, `"1,386,850"`, `"5,000,000"`
  (line 1381). Comma-grouped numbers without `$` prefix
  are not emitted. Whether share counts are PII is debatable
  — see Defer section.

### regex / coreference: missing dates

- anon-228: `"April 25, 2022"` — captured many times (good),
  but `"as of the date first written above"` and the
  cross-references `"dated as of the date hereof"` should
  coreference back to the canonical date. Not pinned as a
  hard test; coreference for date defined-terms not yet
  implemented.
- anon-229: `"the date of this Agreement"` (line 1675) and
  `"the date hereof"` (multiple). Defined-term coreferences
  to `"April 25, 2022"`. Coreference detector should link;
  currently no link.

### deny-list / name-corpus: missing people / signatories

- anon-230: `"Dohyun Kim"` (line 1636) — full given name +
  surname. Pipeline only emits `"Kim"` (anon-149).
- anon-231: `"Anthony F. Vernace"` (line 1665) — full name.
  Pipeline emits `"Anthony"` as `address` (anon-131).
- anon-232: `"Katherine M. Krause"` (line 1666) — full name.
  Pipeline emits `"Katherine"` as `address` (anon-132) and
  `"M. Krause"` as `person` (anon-152). Should be one span.
- anon-233: `"Remi P. Korenblit"` (line 1655) — not emitted
  at all.
- anon-234: `"Parag Agrawal"`, `"Ned Segal"`, other Twitter
  executive names if present in disclosure schedules — the
  document references the Board of Directors and current
  officers obliquely but does not list them by name in the
  agreement body. Marked deferred.

### defined-term coreference

- anon-235: `"the Company"` — defined as Twitter, Inc. in
  the preamble. Should propagate as `organization` wherever
  used. Currently no coreference entity for the
  defined-term references.
- anon-236: `"Parent"` — defined as X Holdings I, Inc.
  Hundreds of references in the body. Not coreferenced.
- anon-237: `"Acquisition Sub"` — defined as X Holdings II,
  Inc. Not coreferenced.
- anon-238: `"the Equity Investor"` — defined as Elon R.
  Musk. Should coreference to person. Not emitted.
- anon-239: `"Surviving Corporation"` / `"Surviving Company"`
  — defined as Twitter, Inc. after the merger. Same
  coreference gap.
- anon-240: `"Paying Agent"`, `"Rights Agent"`,
  `"Margin Loan Borrower"` — each is a defined alias for an
  organization (`"Computershare Trust Company, N.A."`,
  `"X Holdings III, LLC"`). Not coreferenced.

### Span hygiene / curly-quote stripping

- anon-241: Multiple entities end with a curly closing
  quote `”`. Examples: `"Bond Hedge Documentation”"` at
  offset 18985, `"Bond Hedge Transactions”"` at 21662,
  `"Tesla Shares”"` at 45014. Span trimmer should strip
  trailing typographic quotes.
- anon-242: `"World Health Organization"` tagged as
  `organization` at offset 30437 — span correct, label
  correct, but it sits inside `"World Health Organization
declared"`-style sentence and may have boundary issues
  upstream. Borderline pass; pin so future detector tweaks
  don't regress this.

## Defer (out of scope)

- Fiscal-year references such as `"fiscal year 2021"` /
  `"2021 fiscal year"` — arguable whether PII.
- Share counts and treasury balances without currency
  symbols (anon-227) — not classically PII but identifying
  in the public-company context.
- Year-only note maturity tags (`"due 2027"`) — date
  regex policy is deliberately calendar-date-only.
- Time-only spans (`"5:00 p.m."`, `"9:00 a.m."`) — captured
  as `date` already; debate whether that label is right.
- Defined-term coreference for non-personal aliases
  (`"DGCL"`, `"ERISA"`, `"GAAP"`, `"COVID-19 Measures"`).
- `"Specified Provisions"` and `"Funded Obligations"` —
  internal references with no PII content.
