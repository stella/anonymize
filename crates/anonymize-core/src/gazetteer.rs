//! Gazetteer matching: caller-supplied names found as whole words.
//!
//! Three candidate sources feed one acceptance policy:
//!
//! - word sequences: each entry is split at prepare time into words folded for
//!   case and diacritics, plus their Czech/Slovak forms when those languages
//!   are in scope, and indexed in a trie keyed by word, so inflected and
//!   diacritic-free spellings match and same-prefix entries share one walk;
//! - exact literal hits from the search index, kept only on token boundaries;
//! - fuzzy hits, kept only when they start and end on token boundaries and
//!   stay within the pattern's edit distance after folding.
//!
//! A name next to a plain number, year, or word still matches (`Acme/2024`,
//! `novak2@acme.cz`, `Novak_smlouva_2024.pdf`); a span glued to letters, or
//! joined to an identifier-shaped segment (hex, UUID parts, base64 runs, `⟦…⟧`
//! markers), does not. A span extends only over a following legal form.

use std::cell::{Cell, RefCell};
use std::collections::{BTreeMap, HashMap, HashSet};

use unicode_normalization::char::{decompose_canonical, is_combining_mark};

use crate::name_joiners::NameJoiner;

#[path = "gazetteer_policy.rs"]
mod policy;
pub(crate) use policy::is_unspaced_script;
#[cfg(test)]
use policy::{
  COMPOUND_JOINERS, MarkerKind, Markers, encloses, glue_is_free,
  is_identifier_segment, marker_spans, markers,
};
use policy::{CandidatePolicy, is_word_char};

use crate::declension::{expand_name_declensions, expand_surname_derivations};
use crate::labels::PERSON_LABEL;
use crate::processors::{
  GazetteerInflection, GazetteerMatchData, PatternSlice,
};
use crate::resolution::{DetectionSource, PipelineEntity, SourceDetail};
use crate::search::SearchPattern;
use crate::types::{Error, Result, SearchMatch};

const EXACT_SCORE: f64 = 0.9;
const FUZZY_SCORE: f64 = 0.85;

/// Longest run of whitespace and punctuation accepted between two words of
/// one entry, unless the entry itself spells a longer separator.
const MAX_WORD_GAP_CHARS: usize = 4;

/// Longest whitespace/comma run accepted between a name and its legal form.
const MAX_LEGAL_FORM_SEPARATOR_CHARS: usize = 3;

/// Separators with up to this many distinct punctuation marks accept every
/// subset of them (`A. & B.` accepts `A. B.` and `A & B`); longer ones accept
/// whitespace or the full set only, keeping the per-separator key count small.
const MAX_SUBSET_PUNCTUATION: usize = 3;

/// Person entries of up to this many words also match surname-first.
const MAX_REORDERED_PERSON_WORDS: usize = 3;

/// Fewer letters than this match only exactly (after folding and declension):
/// one edit turns a short name into an ordinary word (`Acme` -> `acne`).
const MIN_SHORT_FUZZY_LETTERS: usize = 5;

/// From this many letters an entry tolerates an edit anywhere. Shorter
/// fuzzy entries (exactly [`MIN_SHORT_FUZZY_LETTERS`]) tolerate one edit only
/// on a token spelled like a proper noun, as the entry is (see
/// [`short_typo_fits`]): `Orbys` for `Orbis`, never `orbit`.
const MIN_FUZZY_LETTERS: usize = 6;

/// Entries with at least this many letters tolerate two edits; shorter fuzzy
/// entries tolerate one.
const MIN_TWO_EDIT_LETTERS: usize = 10;

/// Longest pattern, in chars, the fuzzy engine accepts.
const MAX_FUZZY_PATTERN_CHARS: usize = 64;

/// Largest edit distance any fuzzy entry allows.
const MAX_FUZZY_DISTANCE: usize = 2;

/// Edit distance a fuzzy gazetteer pattern for `term` allows, if any. Entries
/// with digits are identifiers and match only exactly.
#[must_use]
pub fn gazetteer_fuzzy_distance(term: &str) -> Option<u8> {
  if term.chars().any(char::is_numeric)
    || term.chars().count() > MAX_FUZZY_PATTERN_CHARS
  {
    return None;
  }
  match term.chars().filter(|ch| ch.is_alphabetic()).count() {
    letters if letters < MIN_SHORT_FUZZY_LETTERS => None,
    letters if letters < MIN_FUZZY_LETTERS => {
      case_shape(term.trim()).map(|_| 1)
    }
    letters if letters < MIN_TWO_EDIT_LETTERS => Some(1),
    _ => Some(2),
  }
}

/// The form under which the matcher treats spellings as one: case and
/// diacritics folded, whitespace runs collapsed (`Acme`, `ACME`, and `Ácme`
/// share a key).
#[must_use]
pub fn gazetteer_spelling_key(term: &str) -> String {
  fold(term).split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Letter case a short entry is spelled in, and a one-edit match must share.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum CaseShape {
  /// `Orbis`: an uppercase letter, then lowercase letters.
  Capitalized,
  /// `ORBIS`: uppercase letters only.
  Upper,
}

/// The proper-noun case shape of a single word of letters, if it has one.
fn case_shape(word: &str) -> Option<CaseShape> {
  let mut letters = word.chars().filter(|ch| !is_combining_mark(*ch));
  let first = letters.next()?;
  let rest = letters.collect::<Vec<_>>();
  if !first.is_alphabetic()
    || rest.is_empty()
    || !rest.iter().all(|ch| ch.is_alphabetic())
  {
    return None;
  }
  if first.is_uppercase() && rest.iter().all(|ch| ch.is_uppercase()) {
    return Some(CaseShape::Upper);
  }
  (first.is_uppercase() && rest.iter().all(|ch| ch.is_lowercase()))
    .then_some(CaseShape::Capitalized)
}

/// How an entry spells each of its words, telling the entry's own name
/// from a field inside a template placeholder (`[[McDonald2024]]` against
/// `<<token:zeta9>>`).
#[derive(Clone, Debug, Eq, PartialEq)]
struct Spelling {
  words: Vec<SpelledWord>,
  inflection: GazetteerInflection,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SpelledWord {
  /// As the entry writes it, the source of its declined forms.
  written: String,
  /// Without diacritics, in its own case.
  plain: String,
  shape: Option<CaseShape>,
}

impl Spelling {
  /// The entry's words. `None` unless the entry shows a name: a capital
  /// letter (`Zeta`, `McDonald`), or letters of a script without case
  /// (`محمد`, `東京`). An entry whose cased letters are all lowercase
  /// (`orbis`, `@alice`) gives no such evidence.
  fn of(term: &str, inflection: GazetteerInflection) -> Option<Self> {
    let words = spelled_words(term)
      .map(|word| SpelledWord {
        written: word.to_owned(),
        plain: unmarked(word),
        shape: case_shape(word),
      })
      .collect::<Vec<_>>();
    (!words.is_empty() && shows_a_name(term))
      .then_some(Self { words, inflection })
  }

  /// Whether `surface` spells every entry word as the entry does
  /// (`McDonald`, `van`, `J`, `محمد`), as a supported declined form of it
  /// (`McDonalda`, `Dijka`), or in the same proper-noun case (`Nováka` for
  /// `Novák`).
  fn spells(&self, surface: &str) -> bool {
    let mut words = spelled_words(surface);
    shows_a_name(surface)
      && self.words.iter().all(|entry| {
        words
          .next()
          .is_some_and(|word| self.spells_word(entry, word))
      })
      && words.next().is_none()
  }

  fn spells_word(&self, entry: &SpelledWord, word: &str) -> bool {
    let plain = unmarked(word);
    plain == entry.plain
      || entry
        .shape
        .is_some_and(|shape| case_shape(word) == Some(shape))
      || (self.inflection == GazetteerInflection::CzechSlovak
        && !entry.written.chars().any(char::is_numeric)
        && expand_name_declensions(&entry.written)
          .into_iter()
          .chain(expand_surname_derivations(&entry.written))
          .any(|form| unmarked(&form) == plain))
  }
}

/// A capital letter, or letters only of scripts without case.
fn shows_a_name(text: &str) -> bool {
  let mut letters = text.chars().filter(|ch| ch.is_alphabetic()).peekable();
  letters.peek().is_some()
    && (text.chars().any(char::is_uppercase)
      || letters.all(|ch| !ch.is_lowercase() || is_unicameral(ch)))
}

/// Letters of a script that writes names in one case, though Unicode gives
/// it case mappings: Georgian Mkhedruli (`თბილისი`), whose capitals
/// (Mtavruli) appear only in all-caps titles.
const fn is_unicameral(ch: char) -> bool {
  matches!(ch, '\u{10D0}'..='\u{10FF}')
}

/// Runs of letters and digits, in any script.
fn spelled_words(text: &str) -> impl Iterator<Item = &str> {
  text
    .split(|ch: char| !(ch.is_alphanumeric() || is_combining_mark(ch)))
    .filter(|word| !word.is_empty())
}

/// `word` without diacritics, in its own case, transliterated as [`fold`]
/// does (`McDønałd` spells `McDonald`).
fn unmarked(word: &str) -> String {
  let mut plain = String::with_capacity(word.len());
  for ch in word.chars() {
    decompose_canonical(ch, |part| {
      if !is_combining_mark(part) {
        plain.push(unstroked(part));
      }
    });
  }
  plain
}

/// The base letter of a letter with a stroke, which has no canonical
/// decomposition (`ł`, `Đ`, `ø`), in its own case.
const fn unstroked(ch: char) -> char {
  match ch {
    'ł' => 'l',
    'Ł' => 'L',
    'đ' => 'd',
    'Đ' => 'D',
    'ø' => 'o',
    'Ø' => 'O',
    other => other,
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedGazetteerMatchData {
  slice: PatternSlice,
  rows: Vec<GazetteerRow>,
  /// Fuzzy rows by every string reachable from their folded letters with at
  /// most their edit distance in deletions. Two strings within distance `k`
  /// share such a string, so re-checking a span costs a bounded number of
  /// lookups instead of a scan of same-length entries.
  fuzzy_deletions: HashMap<Vec<char>, Vec<usize>>,
  /// Lengths of the fuzzy entries, bounding the spans re-checked around a
  /// fuzzy window.
  fuzzy_shape: FuzzyShape,
  sequences: SequenceTrie,
  legal_forms: Vec<LegalFormSuffix>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GazetteerRow {
  label: String,
  kind: RowKind,
  /// How the entry spells its words; see [`Spelling`].
  spelling: Option<Spelling>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RowKind {
  Exact,
  Fuzzy {
    folded: Vec<char>,
    max_distance: usize,
    /// Word count of the entry; see [`token_count_fits`].
    words: usize,
    /// For a short entry, the case a matched token must be spelled in; see
    /// [`short_typo_fits`].
    short_shape: Option<CaseShape>,
  },
}

/// Entry word sequences in a trie keyed by interned words. Every folded
/// spelling of a word (declined forms included) maps to that word, and every
/// separator a gap accepts maps to one interned key, so a document token
/// costs a bounded number of hash lookups per trie step, however many
/// entries share the prefix or how many separator spellings they use.
#[derive(Clone, Debug, Eq, PartialEq)]
struct SequenceTrie {
  inflection: GazetteerInflection,
  /// Folded spelling -> words it spells.
  spellings: HashMap<String, Vec<usize>>,
  /// Folded entry word -> interned word id. Words that fold alike
  /// (`Acḿe`, `Acme`) share one id, so one document token walks one path.
  words: HashMap<String, usize>,
  /// Separator key (sorted punctuation marks) -> interned key id.
  gap_keys: HashMap<String, usize>,
  nodes: Vec<TrieNode>,
}

/// An entry ending at a trie node: its label and the punctuation it spells
/// before its first and after its last word (`@` in `@alice`, `++` in
/// `C++`), which the document must spell around the words too.
#[derive(Clone, Debug, Eq, PartialEq)]
struct Terminal {
  label: String,
  edges: EdgePunctuation,
  /// How the entry spells its words; see [`Spelling`].
  spelling: Option<Spelling>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct EdgePunctuation {
  leading: String,
  trailing: String,
}

impl EdgePunctuation {
  /// The span widened over this punctuation, when the text spells it right
  /// before `start` and right after `end`.
  fn around(
    &self,
    text: &str,
    start: usize,
    end: usize,
  ) -> Option<(usize, usize)> {
    let before = text.get(..start)?;
    let after = text.get(end..)?;
    let leading = trailing_match(before, &self.leading)?;
    let trailing = leading_match(after, &self.trailing)?;
    Some((start.saturating_sub(leading), end.saturating_add(trailing)))
  }
}

/// Byte length of `marks` at the end of `text`, compared as canonical
/// punctuation.
fn trailing_match(text: &str, marks: &str) -> Option<usize> {
  let mut len = 0_usize;
  let mut text_chars = text.chars().rev();
  for expected in marks.chars().rev() {
    let actual = text_chars.next()?;
    if canonical_punctuation(actual) != canonical_punctuation(expected) {
      return None;
    }
    len = len.saturating_add(actual.len_utf8());
  }
  Some(len)
}

/// Byte length of `marks` at the start of `text`, compared as canonical
/// punctuation.
fn leading_match(text: &str, marks: &str) -> Option<usize> {
  let mut len = 0_usize;
  let mut text_chars = text.chars();
  for expected in marks.chars() {
    let actual = text_chars.next()?;
    if canonical_punctuation(actual) != canonical_punctuation(expected) {
      return None;
    }
    len = len.saturating_add(actual.len_utf8());
  }
  Some(len)
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct TrieNode {
  /// The entries that end here.
  terminals: Vec<Terminal>,
  /// Word -> child.
  children: HashMap<usize, usize>,
  /// `(separator key, word)` -> longest separator, in chars, accepted
  /// before that word.
  separators: HashMap<(usize, usize), usize>,
}

/// The separators an entry allows between two of its words: whitespace and
/// any subset of the punctuation it spells there, up to `max_chars`.
#[derive(Clone, Debug, Eq, PartialEq)]
struct GapRule {
  punctuation: Vec<char>,
  max_chars: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct LegalFormSuffix {
  chars: Vec<char>,
  /// Dotted abbreviations (`s.r.o.`, `a.s.`) match in any letter case;
  /// undotted forms (`SE`, `AG`) only as written, since they collide with
  /// ordinary words in lower case.
  case_insensitive: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Token {
  start: usize,
  end: usize,
}

#[derive(Clone, Debug)]
struct Hit<'a> {
  start: usize,
  end: usize,
  label: &'a str,
  score: f64,
  /// For an exact hit, how its entry spells its words.
  spelling: Option<&'a Spelling>,
}

/// Every per-row list covers the gazetteer slice; optional lists may be
/// empty.
fn validate_row_lengths(
  data: &GazetteerMatchData,
  slice: PatternSlice,
  patterns: Option<&[SearchPattern]>,
) -> Result<()> {
  validate_length("gazetteer_data.labels", slice, data.labels.len())?;
  validate_length("gazetteer_data.is_fuzzy", slice, data.is_fuzzy.len())?;
  if !data.terms.is_empty() {
    validate_length("gazetteer_data.terms", slice, data.terms.len())?;
  }
  if !data.person_forms.is_empty() {
    validate_length(
      "gazetteer_data.person_forms",
      slice,
      data.person_forms.len(),
    )?;
  }
  if let Some(patterns) = patterns {
    validate_length("gazetteer patterns", slice, patterns.len())?;
  }
  Ok(())
}

/// An exact row's entry text, indexed by word under its label.
#[derive(Clone, Copy)]
struct SequenceEntry<'a> {
  term: &'a str,
  label: &'a str,
  /// Also index the person word orders (surname first).
  person_forms: bool,
}

impl PreparedGazetteerMatchData {
  /// Prepares gazetteer rows from the assembled data and the search patterns
  /// of the gazetteer slice, which carry each row's entry text.
  pub(crate) fn new(
    data: GazetteerMatchData,
    slice: PatternSlice,
    patterns: Option<&[SearchPattern]>,
  ) -> Result<Self> {
    validate_row_lengths(&data, slice, patterns)?;
    let legal_forms = data
      .legal_form_suffixes
      .iter()
      .filter(|suffix| !suffix.trim().is_empty())
      .map(|suffix| LegalFormSuffix::new(suffix))
      .collect::<Vec<_>>();
    let mut prepared = Self {
      slice,
      rows: Vec::with_capacity(data.labels.len()),
      fuzzy_deletions: HashMap::new(),
      fuzzy_shape: FuzzyShape::default(),
      sequences: SequenceTrie::new(data.inflection),
      legal_forms,
    };
    for (index, (label, is_fuzzy)) in
      data.labels.into_iter().zip(data.is_fuzzy).enumerate()
    {
      let pattern = patterns.and_then(|patterns| patterns.get(index));
      let term = row_term(index, data.terms.get(index), pattern)?;
      let kind = match (is_fuzzy, pattern, term) {
        (
          false,
          None
          | Some(
            SearchPattern::Literal(_)
            | SearchPattern::LiteralWithOptions { .. },
          ),
          term,
        ) => {
          // An artifact-only config from before entry text was carried
          // keeps its exact search hits; only folded matching needs text.
          if let Some(term) = term {
            prepared.add_sequences(SequenceEntry {
              term,
              label: &label,
              person_forms: label == PERSON_LABEL
                || data.person_forms.get(index).copied().unwrap_or(false),
            });
          }
          RowKind::Exact
        }
        (true, None, Some(term)) => fuzzy_row(term, None),
        (true, Some(SearchPattern::Fuzzy { distance, .. }), Some(term)) => {
          fuzzy_row(term, *distance)
        }
        (true, None, None) => {
          return Err(Error::MissingStaticData {
            field: "gazetteer_data.terms",
          });
        }
        _ => {
          return Err(Error::InvalidStaticData {
            field: "gazetteer_data.is_fuzzy",
            reason: format!(
              "row {index} does not match the kind of its search pattern"
            ),
          });
        }
      };
      let term_chars = term.map_or(0, |term| term.chars().count());
      if let RowKind::Fuzzy {
        folded,
        max_distance,
        ..
      } = &kind
        // The fuzzy engine accepts no longer pattern, so longer entries have
        // no fuzzy windows to re-check.
        && folded.len() <= MAX_FUZZY_PATTERN_CHARS
      {
        let row = prepared.rows.len();
        prepared
          .fuzzy_shape
          .add(term_chars, folded.len(), *max_distance);
        for variant in deletion_variants(folded, *max_distance) {
          prepared
            .fuzzy_deletions
            .entry(variant)
            .or_default()
            .push(row);
        }
      }
      let spelling = (kind == RowKind::Exact)
        .then(|| {
          term
            .and_then(|term| Spelling::of(term, prepared.sequences.inflection))
        })
        .flatten();
      prepared.rows.push(GazetteerRow {
        label,
        kind,
        spelling,
      });
    }
    Ok(prepared)
  }

  fn row(&self, pattern: u32) -> Option<&GazetteerRow> {
    self
      .slice
      .local_index(pattern)
      .and_then(|index| self.rows.get(index))
  }

  fn add_sequences(&mut self, entry: SequenceEntry<'_>) {
    let SequenceEntry {
      term,
      label,
      person_forms,
    } = entry;
    let core = self.strip_legal_form(term);
    let Some(SplitTerm { words, gaps, edges }) = split_term(core) else {
      return;
    };
    let reorderable = person_forms
      && edges == EdgePunctuation::default()
      && (2..=MAX_REORDERED_PERSON_WORDS).contains(&words.len())
      && !words.iter().any(|word| word.chars().any(char::is_numeric));
    if reorderable
      && let (Some((last, leading)), Some(first_gap)) =
        (words.split_last(), gaps.first())
    {
      // Surname first: `Dvořáková, Marie` for `Marie Dvořáková`.
      let mut reordered = Vec::with_capacity(words.len());
      reordered.push(last.clone());
      reordered.extend(leading.iter().cloned());
      let mut reordered_gaps = Vec::with_capacity(gaps.len());
      reordered_gaps.push(first_gap.clone().with_comma());
      reordered_gaps
        .extend(gaps.iter().take(gaps.len().saturating_sub(1)).cloned());
      self
        .sequences
        .insert((&reordered, reordered_gaps), label, &edges);
    }
    self.sequences.insert((&words, gaps), label, &edges);
  }

  /// The entry without a trailing legal form, so `Beta Trading s.r.o.` also
  /// matches `Beta Trading` and every spelling of its legal form.
  fn strip_legal_form<'t>(&self, term: &'t str) -> &'t str {
    let trimmed = term.trim_end();
    for (position, ch) in trimmed.char_indices() {
      if position == 0 || !(ch.is_whitespace() || ch == ',') {
        continue;
      }
      if self.legal_form_end(trimmed, position) != Some(trimmed.len()) {
        continue;
      }
      let core = trimmed
        .get(..position)
        .unwrap_or_default()
        .trim_end_matches(|tail: char| tail.is_whitespace() || tail == ',');
      if core.chars().any(is_word_char) {
        return core;
      }
    }
    trimmed
  }

  /// End of a legal form that follows `end` after a short whitespace or
  /// comma separator.
  fn legal_form_end(&self, text: &str, end: usize) -> Option<usize> {
    let rest = text.get(end..)?;
    let mut separator_bytes = 0_usize;
    let mut separator_chars = 0_usize;
    let mut seen_comma = false;
    for ch in rest.chars() {
      let accepted = if ch == ',' {
        !std::mem::replace(&mut seen_comma, true)
      } else {
        is_horizontal_space(ch)
      };
      if !accepted || separator_chars == MAX_LEGAL_FORM_SEPARATOR_CHARS {
        break;
      }
      separator_chars = separator_chars.saturating_add(1);
      separator_bytes = separator_bytes.saturating_add(ch.len_utf8());
    }
    if separator_chars == 0 {
      return None;
    }
    let candidate = rest.get(separator_bytes..)?;
    self.legal_forms.iter().find_map(|suffix| {
      suffix
        .matched_len(candidate)
        .map(|len| end.saturating_add(separator_bytes).saturating_add(len))
    })
  }

  pub(crate) fn detect(
    &self,
    matches: &[SearchMatch],
    text: &str,
  ) -> Result<Vec<PipelineEntity>> {
    self.detect_with_guard(matches, &Guard::new(text))
  }

  fn detect_with_guard(
    &self,
    matches: &[SearchMatch],
    guard: &Guard<'_>,
  ) -> Result<Vec<PipelineEntity>> {
    let text = guard.text;
    let mut exact = self.sequence_hits(text);
    for found in matches {
      let Some(row) = self.row(found.pattern()) else {
        continue;
      };
      if row.kind != RowKind::Exact {
        continue;
      }
      let (start, end) = byte_span(text, found)?;
      if guard.edges_are_free(start, end) {
        exact.push(Hit {
          start,
          end,
          label: &row.label,
          score: EXACT_SCORE,
          spelling: row.spelling.as_ref(),
        });
      }
    }
    exact.retain(|hit| !guard.in_entry_identifier(hit));
    let exact_spans = SpanIndex::new(&exact);

    let mut fuzzy = Vec::new();
    let mut anchored = HashSet::new();
    let mut checked = HashSet::new();
    for found in matches {
      let Some(GazetteerRow {
        label,
        kind:
          RowKind::Fuzzy {
            folded,
            max_distance,
            words,
            short_shape,
          },
        ..
      }) = self.row(found.pattern())
      else {
        continue;
      };
      let (start, end) = trim_fuzzy_span(text, byte_span(text, found)?);
      let surface = text.get(start..end).unwrap_or_default();
      if !exact_spans.contains(start, end)
        && guard.fuzzy_span_is_whole_words(start, end)
        && !guard.in_identifier(start, end)
        && token_count_fits(tokenize(surface).len(), *words)
        && short_shape.is_none_or(|shape| {
          short_typo_fits(text, (start, end), shape, folded.len())
        })
        && edit_distance(&fold_word_chars(surface), folded) <= *max_distance
      {
        fuzzy.push(Hit {
          start,
          end,
          label,
          score: FUZZY_SCORE,
          spelling: None,
        });
      }
      // The engine keeps one non-overlapping window per region across all
      // fuzzy patterns, so any window, accepted or not, may hide another
      // entry's match that starts inside it (`WintermteX`, `Wintermute Y`).
      // Re-check the token-aligned spans anchored in the window against the
      // fuzzy entries through the deletion index.
      if anchored.insert((start, end)) {
        for candidate in anchored_spans(text, start, end, &self.fuzzy_shape) {
          let (span_start, span_end) = candidate.span;
          if checked.insert(candidate.span)
            && !exact_spans.contains(span_start, span_end)
            && guard.fuzzy_span_is_whole_words(span_start, span_end)
            && !guard.in_identifier(span_start, span_end)
          {
            self.push_fuzzy_rows(guard, candidate, &mut fuzzy);
          }
        }
      }
    }
    let fuzzy = without_contained(fuzzy, &exact);
    self.entities(text, exact, fuzzy)
  }

  /// Entities for the exact hits, then the fuzzy ones, each extended over a
  /// following legal form; a span already emitted for its label is skipped.
  fn entities(
    &self,
    text: &str,
    exact: Vec<Hit<'_>>,
    fuzzy: Vec<Hit<'_>>,
  ) -> Result<Vec<PipelineEntity>> {
    let mut seen = HashSet::new();
    let mut entities =
      Vec::with_capacity(exact.len().saturating_add(fuzzy.len()));
    let hits = exact
      .into_iter()
      .map(|hit| (hit, true))
      .chain(fuzzy.into_iter().map(|hit| (hit, false)));
    for (hit, exact_entry) in hits {
      // Every emitted span must close any dotted chain it ends or starts
      // in (`s.r.o` inside `s.r.o.y`); fall back to the unextended span,
      // then drop the hit.
      let extended = self
        .legal_form_end(text, hit.end)
        .filter(|end| dotted_edges_close(text, hit.start, *end));
      if extended.is_none() && !dotted_edges_close(text, hit.start, hit.end) {
        continue;
      }
      let legal_form_end = extended;
      let end = legal_form_end.unwrap_or(hit.end);
      if !seen.insert((hit.start, end, hit.label)) {
        continue;
      }
      let mut entity = PipelineEntity::detected(
        offset_u32(hit.start)?,
        offset_u32(end)?,
        hit.label,
        text.get(hit.start..end).unwrap_or_default(),
        hit.score,
        DetectionSource::Gazetteer,
      );
      entity.source_detail =
        legal_form_end.map(|_| SourceDetail::GazetteerExtension);
      entity.exact_entry = exact_entry;
      entities.push(entity);
    }
    Ok(entities)
  }

  /// Fuzzy entries within their edit distance of `text[start..end]`, found
  /// through the deletion index: a fixed number of lookups for a span of
  /// bounded length, and one distance check per entry that shares a
  /// deletion variant with the span.
  fn push_fuzzy_rows<'a>(
    &'a self,
    guard: &Guard<'_>,
    candidate: AnchoredSpan,
    hits: &mut Vec<Hit<'a>>,
  ) {
    let AnchoredSpan {
      span: (start, end),
      folded,
      tokens,
      distance,
    } = candidate;
    if self.fuzzy_deletions.is_empty()
      || folded.len()
        > MAX_FUZZY_PATTERN_CHARS.saturating_add(MAX_FUZZY_DISTANCE)
    {
      return;
    }
    // Names recur through a document: look each spelling up once.
    let key = (folded, tokens, distance);
    let known = guard.fuzzy_memo.borrow().get(&key).cloned();
    let rows = known.unwrap_or_else(|| {
      let rows = self.fuzzy_rows_for(guard, &key);
      guard.fuzzy_memo.borrow_mut().insert(key, rows.clone());
      rows
    });
    for row in rows.iter().filter_map(|row| self.rows.get(*row)) {
      // The case shape depends on the span itself, not its folded spelling.
      if let RowKind::Fuzzy {
        short_shape: Some(shape),
        folded: ref entry,
        ..
      } = row.kind
        && !short_typo_fits(guard.text, (start, end), shape, entry.len())
      {
        continue;
      }
      hits.push(Hit {
        start,
        end,
        label: &row.label,
        score: FUZZY_SCORE,
        spelling: None,
      });
    }
  }

  /// Rows of fuzzy entries that `folded` (a span of `tokens` tokens)
  /// matches, in row order.
  fn fuzzy_rows_for(
    &self,
    guard: &Guard<'_>,
    (folded, tokens, distance): &FuzzyMemoKey,
  ) -> Vec<usize> {
    // Every row sharing a deletion variant is checked, in row order, so the
    // result is complete and does not depend on hash iteration order.
    let mut candidates = Vec::<usize>::new();
    for variant in deletion_variants(folded, *distance) {
      guard.count_fuzzy_step();
      candidates.extend(
        self
          .fuzzy_deletions
          .get(&variant)
          .into_iter()
          .flatten()
          .copied(),
      );
    }
    candidates.sort_unstable();
    candidates.dedup();
    candidates.retain(|row| {
      let Some(GazetteerRow {
        kind:
          RowKind::Fuzzy {
            folded: entry,
            max_distance,
            words,
            ..
          },
        ..
      }) = self.rows.get(*row)
      else {
        return false;
      };
      guard.count_fuzzy_step();
      token_count_fits(*tokens, *words)
        && edit_distance(folded, entry) <= *max_distance
    });
    candidates
  }

  fn sequence_hits(&self, text: &str) -> Vec<Hit<'_>> {
    self.sequences.hits(text, &mut 0)
  }
}

impl SequenceTrie {
  fn new(inflection: GazetteerInflection) -> Self {
    Self {
      inflection,
      spellings: HashMap::new(),
      words: HashMap::new(),
      gap_keys: HashMap::new(),
      nodes: vec![TrieNode::default()],
    }
  }

  fn insert(
    &mut self,
    (words, gaps): (&[String], Vec<GapRule>),
    label: &str,
    edges: &EdgePunctuation,
  ) {
    let mut node = 0_usize;
    let mut gaps = gaps.into_iter();
    for (position, word) in words.iter().enumerate() {
      let word = self.intern_word(word);
      let separators = if position == 0 {
        Vec::new()
      } else {
        gaps
          .next()
          .map(|gap| {
            gap
              .keys()
              .into_iter()
              .map(|key| (self.intern_gap_key(key), gap.max_chars))
              .collect()
          })
          .unwrap_or_default()
      };
      let next = self.nodes.len();
      let Some(current) = self.nodes.get_mut(node) else {
        return;
      };
      let child = *current.children.entry(word).or_insert(next);
      for (key, max_chars) in separators {
        let longest = current.separators.entry((key, word)).or_insert(0);
        *longest = (*longest).max(max_chars);
      }
      if child == next {
        self.nodes.push(TrieNode::default());
      }
      node = child;
    }
    let spelling = Spelling::of(&words.join(" "), self.inflection);
    let terminal = Terminal {
      label: label.to_owned(),
      edges: edges.clone(),
      spelling,
    };
    if let Some(end) = self.nodes.get_mut(node)
      && !end.terminals.contains(&terminal)
    {
      end.terminals.push(terminal);
    }
  }

  fn intern_word(&mut self, word: &str) -> usize {
    let next = self.words.len();
    let id = *self.words.entry(fold(word)).or_insert(next);
    // A word folding like a known one adds its own declined forms (they
    // depend on its diacritics) to the shared id.
    for form in word_forms(word, self.inflection) {
      let ids = self.spellings.entry(form).or_default();
      if !ids.contains(&id) {
        ids.push(id);
      }
    }
    id
  }

  fn intern_gap_key(&mut self, key: String) -> usize {
    let next = self.gap_keys.len();
    *self.gap_keys.entry(key).or_insert(next)
  }

  fn word_ids(&self, folded: &str) -> &[usize] {
    self.spellings.get(folded).map_or(&[], Vec::as_slice)
  }

  /// Every entry span in `text`; `steps` counts trie steps taken.
  fn hits<'a>(&'a self, text: &str, steps: &mut usize) -> Vec<Hit<'a>> {
    let mut hits = Vec::new();
    if self.spellings.is_empty() {
      return hits;
    }
    let tokens = tokenize(text);
    let mut folded = String::new();
    for (index, token) in tokens.iter().enumerate() {
      for first in token.spellings(text) {
        fold_into(
          text.get(first.start..first.end).unwrap_or_default(),
          &mut folded,
        );
        for word in self.word_ids(&folded) {
          *steps = steps.saturating_add(1);
          let Some(child) = self.child(0, *word) else {
            continue;
          };
          self.walk(
            Walk {
              text,
              tokens: &tokens,
              start: first.start,
            },
            (child, first.end, index.saturating_add(1)),
            steps,
            &mut hits,
          );
        }
      }
    }
    hits
  }

  fn child(&self, node: usize, word: usize) -> Option<usize> {
    self.nodes.get(node)?.children.get(&word).copied()
  }

  /// Reports entries ending at `node` and follows the next token when the
  /// separator before it is one an entry allows. Every step is a hash lookup
  /// on the observed separator and word; depth is bounded by the longest
  /// entry.
  fn walk<'a>(
    &'a self,
    walk: Walk<'_>,
    (node, end, next): (usize, usize, usize),
    steps: &mut usize,
    hits: &mut Vec<Hit<'a>>,
  ) {
    let Some(current) = self.nodes.get(node) else {
      return;
    };
    for terminal in &current.terminals {
      if let Some((start, end)) =
        terminal.edges.around(walk.text, walk.start, end)
      {
        hits.push(Hit {
          start,
          end,
          label: &terminal.label,
          score: EXACT_SCORE,
          spelling: terminal.spelling.as_ref(),
        });
      }
    }
    let Some(token) = walk.tokens.get(next) else {
      return;
    };
    if current.separators.is_empty() {
      return;
    }
    let mut folded = String::new();
    // Glued digits between words land in the separator and fail it.
    for spelling in token.spellings(walk.text) {
      let Some((key, chars)) = walk
        .text
        .get(end..spelling.start)
        .and_then(observed_separator)
      else {
        continue;
      };
      let Some(key) = self.gap_keys.get(&key) else {
        continue;
      };
      fold_into(
        walk
          .text
          .get(spelling.start..spelling.end)
          .unwrap_or_default(),
        &mut folded,
      );
      for word in self.word_ids(&folded) {
        *steps = steps.saturating_add(1);
        let allowed = current
          .separators
          .get(&(*key, *word))
          .is_some_and(|longest| chars <= *longest);
        if let (true, Some(child)) = (allowed, self.child(node, *word)) {
          self.walk(
            walk,
            (child, spelling.end, next.saturating_add(1)),
            steps,
            hits,
          );
        }
      }
    }
  }
}

#[derive(Clone, Copy)]
struct Walk<'t> {
  text: &'t str,
  tokens: &'t [Token],
  start: usize,
}

/// Exact spans sorted by start with running maximum ends, so a fuzzy hit
/// checks containment in logarithmic time.
struct SpanIndex {
  starts: Vec<usize>,
  max_ends: Vec<usize>,
}

impl SpanIndex {
  fn new(hits: &[Hit<'_>]) -> Self {
    let mut spans = hits
      .iter()
      .map(|hit| (hit.start, hit.end))
      .collect::<Vec<_>>();
    spans.sort_unstable();
    let mut max_end = 0_usize;
    let max_ends = spans
      .iter()
      .map(|(_, end)| {
        max_end = max_end.max(*end);
        max_end
      })
      .collect();
    Self {
      starts: spans.into_iter().map(|(start, _)| start).collect(),
      max_ends,
    }
  }

  /// Whether one span covers `start..end` entirely.
  fn contains(&self, start: usize, end: usize) -> bool {
    let opened_by_start = self.starts.partition_point(|open| *open <= start);
    opened_by_start
      .checked_sub(1)
      .and_then(|last| self.max_ends.get(last))
      .is_some_and(|max_end| *max_end >= end)
  }
}

impl Token {
  /// The token itself and, when digits are glued to its letters
  /// (`novak2`, `2024Acme`), the letters alone.
  fn spellings(self, text: &str) -> impl Iterator<Item = Self> {
    let word = text.get(self.start..self.end).unwrap_or_default();
    let core = word.trim_matches(char::is_numeric);
    let core_start = self.start.saturating_add(
      word
        .len()
        .saturating_sub(word.trim_start_matches(char::is_numeric).len()),
    );
    let stripped =
      (!core.is_empty() && core.len() != word.len()).then_some(Self {
        start: core_start,
        end: core_start.saturating_add(core.len()),
      });
    std::iter::once(self).chain(stripped)
  }
}

impl GapRule {
  fn from_term_gap(gap: &str) -> Self {
    Self {
      punctuation: separator_marks(gap),
      max_chars: gap.chars().count().max(MAX_WORD_GAP_CHARS),
    }
  }

  /// The same separator, also allowing a comma (`Dvořáková, Marie`).
  fn with_comma(mut self) -> Self {
    if !self.punctuation.contains(&',') {
      self.punctuation.push(',');
      self.punctuation.sort_unstable();
    }
    self
  }

  /// Keys of the observed separators this rule accepts: whitespace only,
  /// and each subset of its punctuation (only the full set when it has many
  /// distinct marks).
  fn keys(&self) -> Vec<String> {
    let marks = &self.punctuation;
    if marks.len() > MAX_SUBSET_PUNCTUATION {
      return vec![String::new(), marks.iter().collect()];
    }
    let subsets = 1_usize.checked_shl(u32::try_from(marks.len()).unwrap_or(0));
    (0..subsets.unwrap_or(1))
      .map(|mask| {
        marks
          .iter()
          .enumerate()
          .filter(|(bit, _)| {
            1_usize
              .checked_shl(u32::try_from(*bit).unwrap_or(u32::MAX))
              .is_some_and(|flag| mask & flag != 0)
          })
          .map(|(_, mark)| *mark)
          .collect()
      })
      .collect()
  }
}

/// Distinct punctuation marks of a separator, canonicalized and sorted.
fn separator_marks(gap: &str) -> Vec<char> {
  let mut marks = gap
    .chars()
    .filter(|ch| !ch.is_whitespace())
    .map(canonical_punctuation)
    .collect::<Vec<_>>();
  marks.sort_unstable();
  marks.dedup();
  marks
}

/// The key and length of a separator seen between two document tokens, when
/// it can join two words of an entry at all: non-empty, at most one line
/// break.
fn observed_separator(gap: &str) -> Option<(String, usize)> {
  let chars = gap.chars().count();
  // `\r\n` is one line break, as are a lone `\r` or `\n`.
  let line_breaks = gap
    .char_indices()
    .filter(|(index, ch)| {
      is_line_break(*ch)
        && !(*ch == '\n' && previous_char(gap, *index) == Some('\r'))
    })
    .count();
  (chars > 0 && line_breaks <= 1)
    .then(|| (separator_marks(gap).into_iter().collect(), chars))
}

impl LegalFormSuffix {
  fn new(suffix: &str) -> Self {
    let chars = suffix.trim().chars().collect::<Vec<_>>();
    Self {
      case_insensitive: chars.contains(&'.'),
      chars,
    }
  }

  /// Byte length of this legal form at the start of `text`. Spaces may be
  /// added after a dot (`s. r. o.` for `s.r.o.`); the form must end on a
  /// token boundary, dotted forms included (`s.r.o.foo` is no legal form).
  fn matched_len(&self, text: &str) -> Option<usize> {
    let mut rest = text.char_indices().peekable();
    let mut consumed = 0_usize;
    let mut previous = None::<char>;
    for &expected in &self.chars {
      let skip_space = expected.is_whitespace() || previous == Some('.');
      if skip_space {
        while rest.next_if(|(_, ch)| is_horizontal_space(*ch)).is_some() {}
      }
      previous = Some(expected);
      if expected.is_whitespace() {
        continue;
      }
      let (index, actual) = rest.next()?;
      let same = actual == expected
        || (self.case_insensitive
          && actual.to_lowercase().eq(expected.to_lowercase()));
      if !same {
        return None;
      }
      consumed = index.saturating_add(actual.len_utf8());
    }
    let next_is_word = rest.peek().is_some_and(|(_, ch)| is_word_char(*ch));
    (consumed > 0 && !next_is_word).then_some(consumed)
  }
}

/// An entry split into its words, the separators between them, and the
/// punctuation around them.
struct SplitTerm {
  words: Vec<String>,
  gaps: Vec<GapRule>,
  edges: EdgePunctuation,
}

/// Splits an entry into words and the separators between them. Punctuation
/// at either end (`@alice`, `C++`, `.NET`) is kept as edge punctuation the
/// document must spell too, so the bare word never matches. Entries in
/// scripts written without spaces stay on the literal path only.
fn split_term(term: &str) -> Option<SplitTerm> {
  let trimmed = term.trim();
  if trimmed.chars().any(is_unspaced_script) {
    return None;
  }
  let core = trimmed.trim_matches(|ch: char| !is_word_char(ch));
  let leading = trimmed
    .get(
      ..trimmed.len().saturating_sub(
        trimmed
          .trim_start_matches(|ch: char| !is_word_char(ch))
          .len(),
      ),
    )
    .unwrap_or_default();
  let trailing = trimmed
    .get(trimmed.trim_end_matches(|ch: char| !is_word_char(ch)).len()..)
    .unwrap_or_default();
  if leading
    .chars()
    .chain(trailing.chars())
    .any(char::is_whitespace)
  {
    return None;
  }
  let mut words = Vec::new();
  let mut gaps = Vec::new();
  let mut word = String::new();
  let mut gap = String::new();
  for ch in core.chars() {
    if is_word_char(ch) {
      if !word.is_empty() && !gap.is_empty() {
        words.push(std::mem::take(&mut word));
        gaps.push(GapRule::from_term_gap(&gap));
      }
      gap.clear();
      word.push(ch);
    } else if !word.is_empty() {
      gap.push(ch);
    }
  }
  if word.is_empty() {
    return None;
  }
  words.push(word);
  Some(SplitTerm {
    words,
    gaps,
    edges: EdgePunctuation {
      leading: leading.to_owned(),
      trailing: trailing.to_owned(),
    },
  })
}

/// Folded spellings a word may take: itself and, for names of letters when
/// Czech or Slovak is in scope, its case forms and the forms derived from a
/// surname.
fn word_forms(word: &str, inflection: GazetteerInflection) -> HashSet<String> {
  let mut forms = HashSet::from([fold(word)]);
  if inflection == GazetteerInflection::CzechSlovak
    && !word.chars().any(char::is_numeric)
  {
    forms.extend(
      expand_name_declensions(word)
        .into_iter()
        .chain(expand_surname_derivations(word))
        .map(|form| fold(&form)),
    );
  }
  forms
}

fn tokenize(text: &str) -> Vec<Token> {
  let mut tokens = Vec::new();
  let mut start = None::<usize>;
  for (index, ch) in text.char_indices() {
    match (is_word_char(ch), start) {
      (true, None) => start = Some(index),
      (false, Some(token_start)) => {
        tokens.push(Token {
          start: token_start,
          end: index,
        });
        start = None;
      }
      _ => {}
    }
  }
  if let Some(token_start) = start {
    tokens.push(Token {
      start: token_start,
      end: text.len(),
    });
  }
  tokens
}

const fn is_line_break(ch: char) -> bool {
  matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

const fn is_horizontal_space(ch: char) -> bool {
  ch.is_whitespace() && !is_line_break(ch)
}

fn canonical_punctuation(ch: char) -> char {
  NameJoiner::of(ch).map_or(ch, NameJoiner::canonical)
}

/// Lower case without combining marks, so `Ľubomír` and `lubomir` agree.
fn fold(value: &str) -> String {
  let mut out = String::with_capacity(value.len());
  fold_into(value, &mut out);
  out
}

fn fold_into(value: &str, out: &mut String) {
  out.clear();
  for ch in value.chars() {
    decompose_canonical(ch, |part| {
      if is_combining_mark(part) {
        return;
      }
      for lower in part.to_lowercase() {
        out.push(unstroked(lower));
      }
    });
  }
}

fn fold_word_chars(value: &str) -> Vec<char> {
  fold(value).chars().filter(|ch| is_word_char(*ch)).collect()
}

fn previous_char(text: &str, offset: usize) -> Option<char> {
  text.get(..offset).and_then(|head| head.chars().next_back())
}

fn next_char(text: &str, offset: usize) -> Option<char> {
  text.get(offset..).and_then(|tail| tail.chars().next())
}

/// Lengths of the fuzzy entries: folded letter count -> largest edit
/// distance among entries of that length, and the longest entry in chars.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct FuzzyShape {
  distances: BTreeMap<usize, usize>,
  max_chars: usize,
}

impl FuzzyShape {
  fn add(&mut self, chars: usize, letters: usize, distance: usize) {
    let known = self.distances.entry(letters).or_insert(0);
    *known = (*known).max(distance);
    self.max_chars = self.max_chars.max(chars.saturating_add(distance));
  }

  /// The largest edit distance of an entry `letters` could match, if any.
  fn distance_for(&self, letters: usize) -> Option<usize> {
    self
      .distances
      .range(
        letters.saturating_sub(MAX_FUZZY_DISTANCE)
          ..=letters.saturating_add(MAX_FUZZY_DISTANCE),
      )
      .filter(|(length, distance)| length.abs_diff(letters) <= **distance)
      .map(|(_, distance)| *distance)
      .max()
  }
}

/// Token-aligned spans a fuzzy window may stand for, with the edit distance
/// to look them up with. The engine drops a window that starts inside a
/// kept one, and a dropped window reaches at most the longest fuzzy entry
/// past its start; spans therefore start at a token start from the token
/// the window opens in up to that length past its end, and are at most that
/// long. Only spans some fuzzy entry's length allows are kept, so the work
/// per window is bounded by the longest entry.
fn anchored_spans(
  text: &str,
  start: usize,
  end: usize,
  shape: &FuzzyShape,
) -> Vec<AnchoredSpan> {
  let mut spans = Vec::new();
  if shape.distances.is_empty() {
    return spans;
  }
  let reach = shape.max_chars;
  let back = text
    .get(..start)
    .unwrap_or_default()
    .chars()
    .rev()
    .take(reach)
    .take_while(|ch| is_word_char(*ch))
    .map(char::len_utf8)
    .sum::<usize>();
  let from = start.saturating_sub(back);
  let window = window_tokens(text, from, end, reach);
  let last_start_char = window.end_char.saturating_add(reach);
  for (first, opening) in window.tokens.iter().enumerate() {
    if opening.char_start > last_start_char {
      break;
    }
    let mut folded = Vec::new();
    for (tokens, closing) in window.tokens.iter().skip(first).enumerate() {
      if closing.char_end.saturating_sub(opening.char_start) > reach {
        break;
      }
      folded.extend_from_slice(&closing.folded);
      if let Some(distance) = shape.distance_for(folded.len()) {
        spans.push(AnchoredSpan {
          span: (opening.start, closing.end),
          folded: folded.clone(),
          tokens: tokens.saturating_add(1),
          distance,
        });
      }
    }
  }
  spans
}

/// A token-aligned span re-checked around a fuzzy window.
struct AnchoredSpan {
  span: (usize, usize),
  /// Folded letters of the span.
  folded: Vec<char>,
  tokens: usize,
  /// Edit distance to look the span up with.
  distance: usize,
}

/// A token near a fuzzy window, with byte offsets into the document and
/// char offsets from the window's scan origin.
struct WindowToken {
  start: usize,
  end: usize,
  char_start: usize,
  char_end: usize,
  folded: Vec<char>,
}

struct WindowTokens {
  tokens: Vec<WindowToken>,
  /// Char offset of the window end from the scan origin.
  end_char: usize,
}

/// Tokens from `from` up to twice `reach` chars past `end`, in one bounded
/// pass.
fn window_tokens(
  text: &str,
  from: usize,
  end: usize,
  reach: usize,
) -> WindowTokens {
  let tail = text.get(from..).unwrap_or_default();
  let mut tokens = Vec::new();
  let mut end_char = None::<usize>;
  let mut open = None::<(usize, usize)>;
  let mut chars = 0_usize;
  // Byte offset where the scan stops; a token still open there ends there.
  let mut scan_end = tail.len();
  let reach = reach.saturating_mul(2);
  let token = |(start, char_start): (usize, usize),
               (stop, char_end): (usize, usize)| {
    WindowToken {
      start: from.saturating_add(start),
      end: from.saturating_add(stop),
      char_start,
      char_end,
      folded: fold_word_chars(tail.get(start..stop).unwrap_or_default()),
    }
  };
  for (offset, ch) in tail.char_indices() {
    if end_char.is_none() && from.saturating_add(offset) >= end {
      end_char = Some(chars);
    }
    if end_char.is_some_and(|at| chars > at.saturating_add(reach)) {
      scan_end = offset;
      break;
    }
    match (is_word_char(ch), open) {
      (true, None) => open = Some((offset, chars)),
      (false, Some(opening)) => {
        tokens.push(token(opening, (offset, chars)));
        open = None;
      }
      _ => {}
    }
    chars = chars.saturating_add(1);
  }
  if let Some(opening) = open {
    tokens.push(token(opening, (scan_end, chars)));
  }
  WindowTokens {
    tokens,
    end_char: end_char.unwrap_or(chars),
  }
}

/// Fuzzy hits without those another hit of the same label covers: where
/// matches overlap, the longest one stands.
fn without_contained<'a>(
  fuzzy: Vec<Hit<'a>>,
  exact: &[Hit<'a>],
) -> Vec<Hit<'a>> {
  let mut all = exact
    .iter()
    .map(|hit| (hit.start, hit.end, hit.label))
    .chain(fuzzy.iter().map(|hit| (hit.start, hit.end, hit.label)))
    .collect::<Vec<_>>();
  // Longest first among equal starts.
  all.sort_unstable_by(|left, right| {
    left
      .2
      .cmp(right.2)
      .then(left.0.cmp(&right.0))
      .then(right.1.cmp(&left.1))
  });
  let mut covering = HashSet::new();
  let mut current_label = None::<&str>;
  let mut reach = 0_usize;
  let mut previous = None::<(usize, usize)>;
  for (start, end, label) in all {
    if current_label != Some(label) {
      current_label = Some(label);
      reach = 0;
      previous = None;
    }
    if end <= reach && previous != Some((start, end)) {
      covering.insert((start, end, label));
    }
    reach = reach.max(end);
    previous = Some((start, end));
  }
  fuzzy
    .into_iter()
    .filter(|hit| !covering.contains(&(hit.start, hit.end, hit.label)))
    .collect()
}

/// The entry text of gazetteer row `index`: the data's own term, or the
/// text of its search pattern, if either exists. When both exist they must
/// agree.
fn row_term<'t>(
  index: usize,
  term: Option<&'t String>,
  pattern: Option<&'t SearchPattern>,
) -> Result<Option<&'t str>> {
  match (term, pattern.map(pattern_text)) {
    (Some(term), Some(text)) if term != text => Err(Error::InvalidStaticData {
      field: "gazetteer_data.terms",
      reason: format!("row {index} differs from its search pattern"),
    }),
    (Some(term), _) => Ok(Some(term)),
    (None, text) => Ok(text),
  }
}

/// A fuzzy row for `term`. An automatic distance follows the same length
/// scale as the assembled patterns, so short entries accept folded hits
/// only; a caller-supplied distance is capped at the supported maximum.
fn fuzzy_row(term: &str, distance: Option<u8>) -> RowKind {
  let folded = fold_word_chars(term);
  let short_shape = (folded.len() < MIN_FUZZY_LETTERS)
    .then(|| case_shape(term.trim()))
    .flatten();
  // Shorter entries match only exactly; a short entry without a
  // proper-noun shape too.
  let cap = match folded.len() {
    letters if letters < MIN_SHORT_FUZZY_LETTERS => 0,
    letters if letters < MIN_FUZZY_LETTERS => {
      usize::from(short_shape.is_some())
    }
    _ => MAX_FUZZY_DISTANCE,
  };
  RowKind::Fuzzy {
    words: tokenize(term).len(),
    max_distance: usize::from(
      distance
        .or_else(|| gazetteer_fuzzy_distance(term))
        .unwrap_or(0),
    )
    .min(cap),
    folded,
    short_shape,
  }
}

/// Whether a fuzzy span may stand for a short entry of `letters` letters
/// spelled in `shape`: a whole token of as many letters (a substitution, so
/// added endings stay with inflection), in the same proper-noun case, not
/// opening a sentence, where ordinary words are capitalized too
/// (`Nová smlouva`).
fn short_typo_fits(
  text: &str,
  (start, end): (usize, usize),
  shape: CaseShape,
  letters: usize,
) -> bool {
  let span = text.get(start..end).unwrap_or_default();
  // A whole token: no digits glued on either side (`Orbys2`).
  let glued = previous_char(text, start).is_some_and(is_word_char)
    || next_char(text, end).is_some_and(is_word_char);
  !glued
    && fold_word_chars(span).len() == letters
    && case_shape(span) == Some(shape)
    && !opens_sentence(text, start)
}

/// Whether `start` begins a sentence or a line: only whitespace and opening
/// quotes or brackets separate it from the text start, a line break, or
/// sentence-final punctuation.
fn opens_sentence(text: &str, start: usize) -> bool {
  // Quotes and brackets that may sit between a terminal and the next
  // sentence (`skončil.) Orbit`, `„Orbit`).
  const OPENERS: [char; 16] = [
    '"', '\'', '„', '“', '”', '‘', '’', '«', '»', '(', ')', '[', ']', '{', '}',
    '¿',
  ];
  // Sentence terminals (Unicode Sentence_Terminal, plus `…` and `:`) of
  // the scripts in common use: Latin, CJK fullwidth, Arabic, Devanagari,
  // Armenian, Ethiopic, Myanmar.
  const TERMINALS: [char; 20] = [
    '.', '!', '?', '…', ':', '‼', '⁇', '⁈', '⁉', '。', '．', '！', '？', '؟',
    '۔', '।', '॥', '։', '።', '။',
  ];
  for ch in text.get(..start).unwrap_or_default().chars().rev().take(32) {
    if is_line_break(ch) {
      return true;
    }
    if ch.is_whitespace() || OPENERS.contains(&ch) {
      continue;
    }
    return TERMINALS.contains(&ch);
  }
  true
}

/// The entry text a gazetteer search pattern carries.
fn pattern_text(pattern: &SearchPattern) -> &str {
  match pattern {
    SearchPattern::Literal(text)
    | SearchPattern::LiteralWithOptions { pattern: text, .. }
    | SearchPattern::Fuzzy { pattern: text, .. }
    | SearchPattern::Regex(text)
    | SearchPattern::RegexWithOptions { pattern: text, .. } => text,
  }
}

/// Whether the span's first and last whitespace-free parts are whole: a part
/// that holds a dot (a dotted abbreviation such as `s.r.o` or `a.s.`) must
/// not continue with a word character or a dot and a word character
/// outside the span, as in `s.r.o.y`. Without a dot the joiner rules of
/// [`Guard::in_identifier`] apply (`acme.cz` keeps `acme`).
fn dotted_edges_close(text: &str, start: usize, end: usize) -> bool {
  let span = text.get(start..end).unwrap_or_default();
  let last = span.rsplit(char::is_whitespace).next().unwrap_or_default();
  let first = span.split(char::is_whitespace).next().unwrap_or_default();
  let open_after = last.contains('.')
    && continues_chain(text.get(end..).unwrap_or_default().chars());
  let open_before = first.contains('.')
    && continues_chain(text.get(..start).unwrap_or_default().chars().rev());
  !(open_after || open_before)
}

/// Whether `chars`, read away from a span, continue a word or a dotted
/// chain: a word character, or a dot and a word character.
fn continues_chain(chars: impl Iterator<Item = char>) -> bool {
  let mut chars = chars.peekable();
  match chars.next() {
    Some(ch) if is_word_char(ch) => true,
    Some('.') => chars.peek().copied().is_some_and(is_word_char),
    _ => false,
  }
}

/// Whether a fuzzy span of `tokens` tokens may stand for an entry of `words`
/// words: as many, or one fewer when a typo joins two words. A span with
/// more tokens would let the edit budget absorb a neighbouring short word
/// (`Harriet a` for `Harriet`).
const fn token_count_fits(tokens: usize, words: usize) -> bool {
  tokens <= words && tokens.saturating_add(1) >= words
}

/// Every string reachable from `letters` by deleting at most `max` of them,
/// `letters` included.
fn deletion_variants(letters: &[char], max: usize) -> HashSet<Vec<char>> {
  let mut variants = HashSet::from([letters.to_vec()]);
  let mut frontier = vec![letters.to_vec()];
  for _ in 0..max {
    let mut next = Vec::new();
    for variant in &frontier {
      for index in 0..variant.len() {
        let mut shorter = variant.clone();
        shorter.remove(index);
        if variants.insert(shorter.clone()) {
          next.push(shorter);
        }
      }
    }
    frontier = next;
  }
  variants
}

/// A fuzzy window may open on the separator before a name (` Beta Tradng`);
/// drop leading non-word and trailing whitespace characters.
fn trim_fuzzy_span(text: &str, (start, end): (usize, usize)) -> (usize, usize) {
  let window = text.get(start..end).unwrap_or_default();
  let trimmed_start = window.trim_start_matches(|ch: char| !is_word_char(ch));
  let trimmed = trimmed_start.trim_end();
  let start =
    start.saturating_add(window.len().saturating_sub(trimmed_start.len()));
  (start, start.saturating_add(trimmed.len()))
}

/// Neighbourhood checks for candidate spans in one document. `⟦…⟧` marker
/// runs are indexed once, so no check rescans an unbounded run of text; the
/// other scans stop at the first character outside the span's own adjacent
/// glue, joiners, and one joined segment.
struct Guard<'t> {
  text: &'t str,
  policy: CandidatePolicy<'t>,
  /// Deletion lookups and distance checks of the fuzzy fallback.
  fuzzy_steps: Cell<usize>,
  /// Fuzzy rows already found for a folded spelling.
  fuzzy_memo: RefCell<HashMap<FuzzyMemoKey, Vec<usize>>>,
}

/// Folded letters, token count, and lookup distance of a re-checked span.
type FuzzyMemoKey = (Vec<char>, usize, usize);

impl<'t> Guard<'t> {
  fn new(text: &'t str) -> Self {
    Self {
      text,
      policy: CandidatePolicy::new(text),
      fuzzy_steps: Cell::new(0),
      fuzzy_memo: RefCell::new(HashMap::new()),
    }
  }

  fn count_fuzzy_step(&self) {
    self
      .fuzzy_steps
      .set(self.fuzzy_steps.get().saturating_add(1));
  }

  fn edges_are_free(&self, start: usize, end: usize) -> bool {
    self.policy.edges_are_free(start, end)
  }

  /// Fuzzy windows are rejected, not grown, when they cut into a token.
  fn fuzzy_span_is_whole_words(&self, start: usize, end: usize) -> bool {
    next_char(self.text, start).is_some_and(is_word_char)
      && previous_char(self.text, end).is_some_and(|ch| !ch.is_whitespace())
      && self.edges_are_free(start, end)
  }

  fn in_identifier(&self, start: usize, end: usize) -> bool {
    self.policy.in_identifier(start, end)
  }

  fn in_entry_identifier(&self, hit: &Hit<'_>) -> bool {
    self.policy.identifier(hit.start..hit.end, || {
      hit.spelling.is_some_and(|spelling| {
        self
          .text
          .get(hit.start..hit.end)
          .is_some_and(|surface| spelling.spells(surface))
      })
    })
  }
}

fn edit_distance(left: &[char], right: &[char]) -> usize {
  let mut previous = (0..=right.len()).collect::<Vec<_>>();
  let mut current = vec![0_usize; right.len().saturating_add(1)];
  for (row, left_char) in left.iter().enumerate() {
    if let Some(first) = current.first_mut() {
      *first = row.saturating_add(1);
    }
    for (column, right_char) in right.iter().enumerate() {
      let substitution = previous
        .get(column)
        .copied()
        .unwrap_or(usize::MAX)
        .saturating_add(usize::from(left_char != right_char));
      let deletion = previous
        .get(column.saturating_add(1))
        .copied()
        .unwrap_or(usize::MAX)
        .saturating_add(1);
      let insertion = current
        .get(column)
        .copied()
        .unwrap_or(usize::MAX)
        .saturating_add(1);
      if let Some(cell) = current.get_mut(column.saturating_add(1)) {
        *cell = substitution.min(deletion).min(insertion);
      }
    }
    std::mem::swap(&mut previous, &mut current);
  }
  previous.last().copied().unwrap_or(usize::MAX)
}

fn byte_span(text: &str, found: &SearchMatch) -> Result<(usize, usize)> {
  let start = byte_offset(text, found.start())?;
  let end = byte_offset(text, found.end())?;
  if start > end {
    return Err(Error::InvalidSpan {
      start: found.start(),
      end: found.end(),
    });
  }
  Ok((start, end))
}

fn byte_offset(text: &str, offset: u32) -> Result<usize> {
  let index = usize::try_from(offset)
    .map_err(|_| Error::ByteOffsetOutOfBounds { offset })?;
  if index > text.len() {
    return Err(Error::ByteOffsetOutOfBounds { offset });
  }
  if !text.is_char_boundary(index) {
    return Err(Error::ByteOffsetInsideCodepoint { offset });
  }
  Ok(index)
}

fn offset_u32(offset: usize) -> Result<u32> {
  u32::try_from(offset)
    .map_err(|_| Error::ByteOffsetOutOfBounds { offset: u32::MAX })
}

fn validate_length(
  field: &'static str,
  slice: PatternSlice,
  actual: usize,
) -> Result<()> {
  let expected = usize::try_from(slice.len()).unwrap_or(usize::MAX);
  if actual == expected {
    return Ok(());
  }
  Err(Error::StaticDataLengthMismatch {
    field,
    expected,
    actual,
  })
}

#[cfg(test)]
#[path = "../tests/support/gazetteer_template_oracle.rs"]
mod fuzz_policy;

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

  use proptest::prelude::*;
  use proptest::test_runner::RngSeed;

  use super::*;
  use crate::name_joiners::NAME_JOINERS;

  const ORGANIZATION: &str = "organization";
  const PERSON: &str = PERSON_LABEL;
  const LEGAL_FORMS: &[&str] = &[
    "spol. s r.o.",
    "s. r. o.",
    "s.r.o.",
    "v.o.s.",
    "a. s.",
    "a.s.",
    "k.s.",
    "z.s.",
    "š.p.",
    "SE",
  ];

  struct Entry<'a> {
    term: &'a str,
    label: &'a str,
    fuzzy_distance: Option<u8>,
  }

  const fn exact<'a>(term: &'a str, label: &'a str) -> Entry<'a> {
    Entry {
      term,
      label,
      fuzzy_distance: None,
    }
  }

  /// Exact rows for every entry, then fuzzy rows, as the assembler orders
  /// them, with Czech/Slovak forms in scope.
  fn prepare(
    entries: &[Entry<'_>],
  ) -> (PreparedGazetteerMatchData, Vec<String>) {
    prepare_with(entries, GazetteerInflection::CzechSlovak)
  }

  fn prepare_with(
    entries: &[Entry<'_>],
    inflection: GazetteerInflection,
  ) -> (PreparedGazetteerMatchData, Vec<String>) {
    let mut labels = Vec::new();
    let mut is_fuzzy = Vec::new();
    let mut patterns = Vec::new();
    let mut terms = Vec::new();
    for entry in entries {
      labels.push(entry.label.to_owned());
      is_fuzzy.push(false);
      terms.push(entry.term.to_owned());
      patterns.push(SearchPattern::LiteralWithOptions {
        pattern: entry.term.to_owned(),
        case_insensitive: None,
        whole_words: Some(false),
      });
    }
    for entry in entries {
      let Some(distance) = entry.fuzzy_distance else {
        continue;
      };
      labels.push(entry.label.to_owned());
      is_fuzzy.push(true);
      terms.push(entry.term.to_owned());
      patterns.push(SearchPattern::Fuzzy {
        pattern: entry.term.to_owned(),
        distance: Some(distance),
      });
    }
    let slice = PatternSlice {
      start: 0,
      end: u32::try_from(patterns.len()).unwrap(),
    };
    let data = GazetteerMatchData {
      labels,
      is_fuzzy,
      legal_form_suffixes: LEGAL_FORMS
        .iter()
        .map(|form| (*form).to_owned())
        .collect(),
      inflection,
      terms: Vec::new(),
      person_forms: Vec::new(),
    };
    (
      PreparedGazetteerMatchData::new(data, slice, Some(&patterns)).unwrap(),
      terms,
    )
  }

  /// Literal hits the search index reports: every case-insensitive
  /// occurrence of an exact row's term, inside tokens included.
  fn literal_hits(
    text: &str,
    terms: &[String],
    exact_rows: usize,
  ) -> Vec<SearchMatch> {
    let lower = text.to_lowercase();
    if lower.len() != text.len() {
      return Vec::new();
    }
    let mut hits = Vec::new();
    for (pattern, term) in terms.iter().take(exact_rows).enumerate() {
      for (start, found) in lower.match_indices(&term.to_lowercase()) {
        hits.push(SearchMatch::Literal {
          pattern: u32::try_from(pattern).unwrap(),
          start: u32::try_from(start).unwrap(),
          end: u32::try_from(start.saturating_add(found.len())).unwrap(),
        });
      }
    }
    hits
  }

  fn found(entries: &[Entry<'_>], text: &str) -> Vec<String> {
    let (prepared, terms) = prepare(entries);
    let hits = literal_hits(text, &terms, entries.len());
    prepared
      .detect(&hits, text)
      .unwrap()
      .into_iter()
      .map(|entity| entity.text)
      .collect()
  }

  fn assert_found(entries: &[Entry<'_>], text: &str, expected: &str) {
    assert!(
      found(entries, text).iter().any(|text| text == expected),
      "{expected:?} not found in {text:?}: {:?}",
      found(entries, text)
    );
  }

  fn assert_nothing(entries: &[Entry<'_>], text: &str) {
    assert!(
      found(entries, text).is_empty(),
      "unexpected hits in {text:?}: {:?}",
      found(entries, text)
    );
  }

  #[test]
  fn diacritics_and_case_fold_both_ways() {
    for (term, surface) in [
      ("Novák", "Novak"),
      ("Novák", "NOVÁK"),
      ("Novak", "Novák"),
      ("Acme", "Acmé"),
      ("Acmé", "Acme"),
      ("Acme A", "ACMÉ a"),
      ("Ľubomír Šťastný", "Lubomir Stastny"),
      ("Lubomir Stastny", "Ľubomír Šťastný"),
      ("Łukasz", "Lukasz"),
    ] {
      assert_found(
        &[exact(term, PERSON)],
        &format!("Podpis {surface} dnes."),
        surface,
      );
    }
  }

  #[test]
  fn czech_and_slovak_case_forms_match() {
    for (term, surface) in [
      ("Novák", "Nováka"),
      ("Novák", "Novákovi"),
      ("Novák", "Novakem"),
      ("Novák", "Novákom"),
      ("Novák", "Nováková"),
      ("Novák", "Novákovou"),
      ("Novák", "Novákův"),
      ("Novák", "Novákových"),
      ("Novák", "Nováků"),
      ("Svoboda", "Svobodovi"),
      ("Svoboda", "Svobodou"),
      ("Svoboda", "Svobodě"),
      ("Svoboda", "Svobodová"),
      ("Kubíček", "Kubíčka"),
      ("Kubíček", "Kubíčkovi"),
      ("Kubíček", "Kubickova"),
      ("Marie", "Marii"),
      ("Jiří", "Jiřímu"),
      ("Tomáš Kubíček", "Tomášovi Kubíčkovi"),
      ("Tomáš Kubíček", "Tomase Kubicka"),
      ("Ľubomír Šťastný", "Ľubomírovi Šťastnému"),
      ("Ľubomír Šťastný", "Lubomirovi Stastnemu"),
      ("Beta Trading", "Beta Tradingem"),
      ("Beta Trading", "Beta Tradingu"),
    ] {
      assert_found(
        &[exact(term, PERSON)],
        &format!("Předáno: {surface} včera."),
        surface,
      );
    }
  }

  #[test]
  fn lookalike_words_do_not_match() {
    for (term, text) in [
      ("Novák", "Nová smlouva"),
      ("Novák", "Pan Nováček přišel"),
      ("Novák", "Novátor přišel"),
      ("Novák", "Pan Kováč přišel"),
      ("Orbis", "The orbit and orbitu"),
      ("Acme", "acmes, Acmeco and acne"),
      ("Acme", "The clause came"),
      ("Acme A", "Akce a slevy"),
      ("Zeta", "Žena, zebra, data"),
      ("Marie", "Marže je nízká"),
      ("Beta Trading s.r.o.", "Beta verze vyšla"),
      ("Ľubomír Šťastný", "Bol šťastný, mala šťastnú ruku"),
    ] {
      assert_nothing(&[exact(term, PERSON)], text);
    }
  }

  #[test]
  fn legal_form_spellings_are_interchangeable() {
    let spellings = [
      " s.r.o.",
      " s. r. o.",
      ", s.r.o.",
      ", s. r. o.",
      " spol. s r.o.",
      ", spol. s r. o.",
    ];
    for entry_form in spellings {
      for text_form in spellings {
        let term = format!("Beta Trading{entry_form}");
        let surface = format!("Beta Trading{text_form}");
        assert_found(
          &[exact(&term, ORGANIZATION)],
          &format!("Strana {surface} souhlasí."),
          &surface,
        );
      }
    }
    for (term, surface) in [
      ("Acme a.s.", "ACME, a. s."),
      ("Acme a. s.", "Acme a.s."),
      ("Omega v.o.s.", "Omega, v. o. s."),
      ("Omega k.s.", "Omega k. s."),
      ("Omega z.s.", "Omega, z. s."),
      ("Omega š.p.", "Omega š. p."),
      ("Acme", "Acme SE"),
    ] {
      assert_found(
        &[exact(term, ORGANIZATION)],
        &format!("Strana {surface} souhlasí."),
        surface,
      );
    }
  }

  #[test]
  fn company_name_matches_without_its_legal_form() {
    assert_found(
      &[exact("Beta Trading s.r.o.", ORGANIZATION)],
      "Strana Beta Trading souhlasí.",
      "Beta Trading",
    );
  }

  #[test]
  fn hits_cover_the_name_and_legal_form_only() {
    for (term, text, expected) in [
      ("Acme A", "Acme A signed the deal.", "Acme A"),
      ("Acme", "Acme signed the deal.", "Acme"),
      ("Acme", "Acme se dohodla.", "Acme"),
      ("Novák", "Novák podepsal.", "Novák"),
      ("Acme", "Acme a. s. podepsala.", "Acme a. s."),
    ] {
      assert_eq!(
        found(&[exact(term, ORGANIZATION)], text),
        [expected],
        "{text}"
      );
    }
  }

  #[test]
  fn persons_match_surname_first() {
    let entries = [exact("Marie Dvořáková", PERSON)];
    assert_found(
      &entries,
      "Podpis: Dvořáková, Marie, jednatelka.",
      "Dvořáková, Marie",
    );
    assert_found(&entries, "Podpis: Dvořáková Marie.", "Dvořáková Marie");
    assert_nothing(
      &[exact("Beta Trading", ORGANIZATION)],
      "Trading, Beta and more.",
    );
  }

  #[test]
  fn identifier_compounds_never_match() {
    let entries = [exact("Acme", ORGANIZATION), exact("Novák", PERSON)];
    for text in [
      "id 9b1d0c3e-acme-4c1b",
      "id acme.4c1b9d2e",
      "pole ⟦field-acme-01⟧",
      "pole ⟦acme⟧",
      "sloupec acmeA_total",
      "kód acme0a1b",
      "kód 3f2aacme",
      "kód 2024acmes",
      "blob acme/QWNtZUEvb3JiaXM9",
    ] {
      assert_nothing(&entries, text);
    }
  }

  #[test]
  fn names_next_to_numbers_and_words_match() {
    let entries = [exact("Acme", ORGANIZATION), exact("Novák", PERSON)];
    for (text, expected) in [
      ("Smlouva Acme/2024 platí.", "Acme"),
      ("Spis Novák-1 založen.", "Novák"),
      ("Verze Acme-2 vyšla.", "Acme"),
      ("Smlouva Acme 2024/5 platí.", "Acme"),
      ("Pište na novak2@acme.cz dnes.", "novak"),
      ("Pište na novak2@acme.cz dnes.", "acme"),
      ("Pište na j.novak@acme-2.cz dnes.", "acme"),
      ("Pište na acme2024@example.cz dnes.", "acme"),
      ("Soubor Novak_smlouva_2024.pdf přiložen.", "Novak"),
      ("Soubor Acme_v2.docx přiložen.", "Acme"),
      ("Web https://acme.cz/kontakt uveden.", "acme"),
      ("Tag #Acme2024 platí.", "Acme"),
      ("Spis Nováka2024 založen.", "Nováka"),
      ("Pole acme-01 a 01.acme.", "acme"),
      ("Acme-Beta a Novák.", "Acme"),
    ] {
      assert_found(&entries, text, expected);
    }
  }

  #[test]
  fn identifiers_match_only_exactly() {
    let id = "9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0e";
    let entries = [exact(id, "registration number")];
    assert_eq!(found(&entries, &format!("Record {id} archived.")), [id]);
    assert_nothing(
      &entries,
      "Record 9b1d0c3e-acfe-4c1b-9d2e-5f6a7b8c9d0f archived.",
    );
    // A plain number next to the value is not part of it; redact anyway.
    assert_eq!(found(&entries, &format!("Record {id}-2 archived.")), [id]);
  }

  #[test]
  fn fuzzy_hits_are_rejected_inside_tokens_and_beyond_distance() {
    let entries = [Entry {
      term: "Wintermute",
      label: PERSON,
      fuzzy_distance: Some(1),
    }];
    let (prepared, _) = prepare(&entries);
    let detect = |text: &str, start: usize, end: usize| {
      let hit = SearchMatch::Fuzzy {
        pattern: 1,
        start: u32::try_from(start).unwrap(),
        end: u32::try_from(end).unwrap(),
        distance: 1,
      };
      prepared
        .detect(&[hit], text)
        .unwrap()
        .into_iter()
        .map(|entity| entity.text)
        .collect::<Vec<_>>()
    };
    assert_eq!(detect("by Wintermte today", 3, 12), ["Wintermte"]);
    assert_eq!(detect("by  Wintermte today", 3, 13), ["Wintermte"]);
    assert!(detect("by xWintermte today", 4, 13).is_empty());
    assert!(detect("by Wintermtex today", 3, 12).is_empty());
    assert!(detect("by Winterbite today", 3, 13).is_empty());
  }

  fn found_with(
    entries: &[Entry<'_>],
    inflection: GazetteerInflection,
    text: &str,
  ) -> Vec<String> {
    let (prepared, terms) = prepare_with(entries, inflection);
    let hits = literal_hits(text, &terms, entries.len());
    prepared
      .detect(&hits, text)
      .unwrap()
      .into_iter()
      .map(|entity| entity.text)
      .collect()
  }

  #[test]
  fn czech_slovak_forms_follow_the_language_scope() {
    let entries = [exact("Ana", PERSON)];
    assert!(
      found_with(&entries, GazetteerInflection::None, "Is there any news?")
        .is_empty()
    );
    assert_eq!(
      found_with(&entries, GazetteerInflection::None, "Ana arrived."),
      ["Ana"]
    );
    assert_eq!(
      found_with(&entries, GazetteerInflection::None, "ANA, ána"),
      ["ANA", "ána"]
    );
    for surface in ["Aně", "Anou", "Any"] {
      assert_eq!(
        found_with(
          &entries,
          GazetteerInflection::CzechSlovak,
          &format!("Patří {surface} dnes."),
        ),
        [surface]
      );
    }
  }

  fn short_entry(term: &str) -> Entry<'_> {
    Entry {
      term,
      label: ORGANIZATION,
      fuzzy_distance: gazetteer_fuzzy_distance(term),
    }
  }

  #[test]
  fn five_letter_entries_take_one_typo_on_a_proper_noun() {
    assert_eq!(gazetteer_fuzzy_distance("Orbis"), Some(1));
    assert_eq!(gazetteer_fuzzy_distance("ORBIS"), Some(1));
    assert_eq!(gazetteer_fuzzy_distance("orbis"), None);
    assert_eq!(gazetteer_fuzzy_distance("Zeta"), None);
    let entries = [short_entry("Orbis")];
    for (text, expected) in [
      ("Klient Orbys zaplatil.", "Orbys"),
      ("Klient Orbís zaplatil.", "Orbís"),
      ("Klient Orbisu zaplatil.", "Orbisu"),
    ] {
      assert!(
        engine_found(&entries, text)
          .iter()
          .any(|hit| hit == expected),
        "{text}"
      );
    }
    for text in [
      "The orbit is stable.",
      "Vstoupil na orbitu.",
      "Klient ORBYS zaplatil.",
      "Orbit zaplatil.",
      "Klient Orbys2 zaplatil.",
    ] {
      assert!(engine_found(&entries, text).is_empty(), "{text}");
    }
    let upper = [short_entry("ORBIS")];
    assert_eq!(engine_found(&upper, "Klient ORBYS zaplatil."), ["ORBYS"]);
    assert!(engine_found(&upper, "Klient Orbys zaplatil.").is_empty());
  }

  #[test]
  fn four_letter_entries_stay_exact() {
    let entries = [short_entry("Zeta")];
    assert!(engine_found(&entries, "Klient Zeda zaplatil.").is_empty());
  }

  #[test]
  fn automatic_edit_budget_grows_with_letter_count() {
    for (term, expected) in [
      ("Zeta", None),
      ("Orbis", Some(1)),
      ("orbis", None),
      ("Lindqvist", Some(1)),
      ("Wintermute", Some(2)),
      ("Acme2024", None),
    ] {
      assert_eq!(gazetteer_fuzzy_distance(term), expected, "{term}");
    }
    let longest = format!("W{}", "a".repeat(63));
    assert_eq!(gazetteer_fuzzy_distance(&longest), Some(2));
    assert_eq!(gazetteer_fuzzy_distance(&format!("{longest}b")), None);
    let nine = [fuzzy_entry("Lindqvist")];
    assert_eq!(
      engine_found(&nine, "Signed by Lindqvyst today."),
      ["Lindqvyst"]
    );
    assert!(engine_found(&nine, "Signed by Lyndqvyst today.").is_empty());
    let ten = [fuzzy_entry("Wintermute")];
    assert_eq!(
      engine_found(&ten, "Signed by Wyntermyte today."),
      ["Wyntermyte"]
    );
    assert!(engine_found(&ten, "Signed by Wyntarmyte today.").is_empty());
  }

  #[test]
  fn many_open_delimiters_on_a_line_stay_linear() {
    let text =
      format!("{} Acme {}", "<< ⟦".repeat(50_000), ">>".repeat(50_000));
    let found_markers = markers(&text);
    assert_eq!(found_markers.template.len(), 1);
    assert!(found_markers.opaque.is_empty());
    for repeats in [1_000, 10_000, 100_000] {
      for unit in ["<< ⟦", "⟦<<\u{a0}", "{{[[ ⟦⟦ ", "⟦ << \n"] {
        let repeated = unit.repeat(repeats);
        let mut work = 0;
        for kind in [MarkerKind::Opaque, MarkerKind::Template] {
          marker_spans(&repeated, kind, &mut work);
        }
        let chars = repeated.chars().count();
        assert!(
          work <= chars.saturating_mul(4),
          "{unit:?} x{repeats}: {work}"
        );
      }
    }
  }

  #[test]
  fn opaque_markers_win_inside_templates() {
    let entries = [exact("Zeta", ORGANIZATION), exact("Acme", ORGANIZATION)];
    for text in ["see [[⟦Zeta⟧]] below", "see {{⟦Zeta⟧}} below"] {
      assert!(found(&entries, text).is_empty(), "{text}");
    }
    assert_eq!(found(&entries, "see {{Acme:⟦Zeta⟧}} below"), ["Acme"]);
  }

  #[test]
  fn templates_stay_open_across_spaces_on_their_line() {
    let entries = [exact("Zeta", ORGANIZATION), exact("Jan Novák", PERSON)];
    for text in ["see <<token: zeta9>> below", "see {{ field zeta9 }} below"] {
      assert!(found(&entries, text).is_empty(), "{text}");
    }
    for (text, expected) in [
      ("see << Jan Novák2024 here", "Jan Novák"),
      ("see <<token:\nzeta9>> below", "zeta"),
      ("see {{ Jan Novák }} below", "Jan Novák"),
    ] {
      assert_eq!(found(&entries, text), [expected], "{text:?}");
    }
  }

  #[test]
  fn short_typos_skip_sentence_starts_in_other_scripts() {
    let entries = [short_entry("Orbis")];
    for text in [
      "Předtím skončil。 Orbit zůstal.",
      "Předtím skončil؟ Orbit zůstal.",
      "Předtím skončil। Orbit zůstal.",
    ] {
      assert!(engine_found(&entries, text).is_empty(), "{text}");
    }
    for text in [
      "Předtím skončil.) Orbit zůstal.",
      "Předtím skončil.] Orbit zůstal.",
      "Předtím skončil.“) Orbit zůstal.",
    ] {
      assert!(engine_found(&entries, text).is_empty(), "{text}");
    }
    for text in [
      "Předtím skončil, Orbys zůstal.",
      "Předtím (skončil) Orbys zůstal.",
    ] {
      assert_eq!(engine_found(&entries, text), ["Orbys"], "{text}");
    }
  }

  #[test]
  fn template_placeholders_keep_names_but_not_identifier_fields() {
    let entries = [exact("Zeta", ORGANIZATION), exact("Jan Novák", PERSON)];
    for text in [
      "see <<token:zeta9>> below",
      "see {{zeta_01}} below",
      "see [[zeta2024]] below",
      "see ⟦Zeta⟧ below",
      "see ⟦Zeta2024⟧ below",
    ] {
      assert!(found(&entries, text).is_empty(), "{text}");
    }
    for (text, expected) in [
      ("see {{Zeta}} below", "Zeta"),
      ("see <<Zeta>> below", "Zeta"),
      ("see [[Zeta]] below", "Zeta"),
      ("see <<token:Zeta>> below", "Zeta"),
      ("note [[Jan Novák]] here", "Jan Novák"),
      ("see [Zeta] below", "Zeta"),
      ("Pište na zeta9@example.cz.", "zeta"),
    ] {
      assert_eq!(found(&entries, text), [expected], "{text}");
    }
  }

  #[test]
  fn template_names_in_unicameral_scripts_match_their_spelling() {
    let entries = [
      exact("თბილისი", ORGANIZATION),
      exact("Zeta ქუთაისი", ORGANIZATION),
      exact("orbis", ORGANIZATION),
      exact("acme ბათუმი", ORGANIZATION),
    ];
    for (text, expected) in [
      ("see [[თბილისი2024]] below", "თბილისი"),
      ("see {{2024თბილისი}} below", "თბილისი"),
      ("note [[Zeta ქუთაისი2024]] here", "Zeta ქუთაისი"),
    ] {
      assert_eq!(found(&entries, text), [expected], "{text}");
    }
    // Lowercase Latin still shows no name, alone or beside Georgian.
    for text in ["see [[orbis2024]] below", "note [[acme ბათუმი2024]] here"]
    {
      assert!(found(&entries, text).is_empty(), "{text}");
    }
  }

  #[test]
  fn template_names_glued_to_digits_keep_their_entry_case() {
    let entries = [
      exact("Zeta", ORGANIZATION),
      exact("Jan Novák", PERSON),
      exact("ACME", ORGANIZATION),
      exact("orbis", ORGANIZATION),
      exact("McDonald", PERSON),
      exact("Jan van Dijk", PERSON),
      exact("J. Dvořák", PERSON),
      exact("محمد", PERSON),
      exact("東京", ORGANIZATION),
      exact("דוד", PERSON),
      exact("Ahmed علي", PERSON),
      exact("hasan علي", PERSON),
    ];
    for (text, expected) in [
      ("see [[Zeta2024]] below", "Zeta"),
      ("see {{Zeta2024}} below", "Zeta"),
      ("see <<2024Zeta>> below", "Zeta"),
      ("see {{Zeta_01}} below", "Zeta"),
      ("note [[Jan Novák2024]] here", "Jan Novák"),
      ("see {{ACME2024}} below", "ACME"),
      ("see [[McDonald2024]] below", "McDonald"),
      ("note [[Jan van Dijk2024]] here", "Jan van Dijk"),
      ("note [[J. Dvořák2024]] here", "J. Dvořák"),
      ("note [[J. Dvorak2024]] here", "J. Dvorak"),
      ("see [[McDonalda2024]] below", "McDonalda"),
      ("see {{McDonaldovi2024}} below", "McDonaldovi"),
      ("note [[Jan van Dijka2024]] here", "Jan van Dijka"),
      ("note [[Jana van Dijka2024]] here", "Jana van Dijka"),
      ("see [[محمد2024]] below", "محمد"),
      ("see {{東京2024}} below", "東京"),
      ("see <<דוד2024>> below", "דוד"),
      ("note [[Ahmed علي2024]] here", "Ahmed علي"),
    ] {
      assert_eq!(found(&entries, text), [expected], "{text}");
    }
    for text in [
      "see <<token:zeta9>> below",
      "see {{ZETA2024}} below",
      "see {{Acme2024}} below",
      "note [[Jan novák2024]] here",
      "see [[orbis2024]] below",
      "see [[Orbis2024]] below",
      "see [[mcdonald2024]] below",
      "see [[MCDONALD2024]] below",
      "note [[Jan Van Dijk2024]] here",
      "note [[j. Dvořák2024]] here",
      "see [[mcdonalda2024]] below",
      "note [[Jan Van Dijka2024]] here",
      "note [[hasan علي2024]] here",
    ] {
      assert!(found(&entries, text).is_empty(), "{text}");
    }
  }

  #[test]
  fn template_names_compare_letters_with_strokes_as_fold_does() {
    for (entry, text, expected) in [
      ("McDønałd", "see [[McDonald2024]] below", "McDonald"),
      ("McDØNAŁD", "see [[McDONALD2024]] below", "McDONALD"),
      ("McDonald", "see [[McDønałd2024]] below", "McDønałd"),
      (
        "Đorđe McKay",
        "note {{Dorde McKay2024}} here",
        "Dorde McKay",
      ),
    ] {
      assert_eq!(found(&[exact(entry, PERSON)], text), [expected], "{text}");
      assert_eq!(
        found(&[exact(entry, PERSON)], &text.replace("2024", "")),
        [expected]
      );
    }
    for (entry, text) in [
      ("McDønałd", "see [[mcdonald2024]] below"),
      ("McDØNAŁD", "see [[McDonald2024]] below"),
    ] {
      assert!(found(&[exact(entry, PERSON)], text).is_empty(), "{text}");
    }
  }

  #[test]
  fn edge_punctuation_stays_part_of_the_entry() {
    let entries = [exact("C++", ORGANIZATION), exact("@alice", PERSON)];
    assert!(found(&entries, "Plan C and alice agreed.").is_empty());
    assert_eq!(found(&entries, "Use C++ today."), ["C++"]);
    assert_eq!(found(&entries, "Ping @alice today."), ["@alice"]);
  }

  #[test]
  fn punctuated_entries_fold_like_any_other() {
    let entries = [exact("@álîce", PERSON), exact(".NÉT", ORGANIZATION)];
    for (text, expected) in [
      ("Ping @alice today.", "@alice"),
      ("Ping @Alice today.", "@Alice"),
      ("Ping @ÁLÎCE today.", "@ÁLÎCE"),
      ("Built on .net today.", ".net"),
    ] {
      assert_eq!(found(&entries, text), [expected], "{text}");
    }
    for text in ["alice agreed.", "Ping #alice today.", "the net result"] {
      assert!(found(&entries, text).is_empty(), "{text}");
    }
  }

  #[test]
  fn automatic_fuzzy_distance_follows_the_length_scale() {
    let data = GazetteerMatchData {
      labels: vec![PERSON.to_owned(), PERSON.to_owned()],
      is_fuzzy: vec![true, true],
      legal_form_suffixes: Vec::new(),
      inflection: GazetteerInflection::CzechSlovak,
      terms: Vec::new(),
      person_forms: Vec::new(),
    };
    let patterns = ["Wintermute", "Acme"].map(|term| SearchPattern::Fuzzy {
      pattern: term.to_owned(),
      distance: None,
    });
    let prepared = PreparedGazetteerMatchData::new(
      data,
      PatternSlice { start: 0, end: 2 },
      Some(&patterns),
    )
    .unwrap();
    let fuzzy = |pattern: u32, text: &str, end: usize| {
      prepared
        .detect(
          &[SearchMatch::Fuzzy {
            pattern,
            start: 3,
            end: u32::try_from(end).unwrap(),
            distance: 1,
          }],
          text,
        )
        .unwrap()
        .into_iter()
        .map(|entity| entity.text)
        .collect::<Vec<_>>()
    };
    assert_eq!(fuzzy(0, "by Wintermte today", 12), ["Wintermte"]);
    assert!(fuzzy(1, "by acne today", 7).is_empty());
  }

  #[test]
  fn same_prefix_entries_share_one_trie_walk() {
    const ENTRIES: usize = 2_000;
    // `Acme Holding7` pairs, two tokens each.
    const PAIRS: usize = 2_500;
    const TOKENS: usize = 5_000;
    const MAX_STEPS: usize = 10_000;
    let terms = (0..ENTRIES)
      .map(|index| format!("Acme Holding{index}"))
      .collect::<Vec<_>>();
    let entries = terms
      .iter()
      .map(|term| exact(term, ORGANIZATION))
      .collect::<Vec<_>>();
    let (prepared, _) = prepare(&entries);
    let text = "Acme Holding7 ".repeat(PAIRS);
    let mut steps = 0_usize;
    let hits = prepared.sequences.hits(&text, &mut steps);
    assert_eq!(hits.len(), PAIRS);
    // A scan of same-prefix entries would take ENTRIES steps per `Acme`; the
    // trie takes a constant number per token.
    assert!(steps <= MAX_STEPS, "{steps} trie steps for {TOKENS} tokens");
  }

  #[test]
  fn same_prefix_entries_with_many_separators_share_one_walk() {
    const SEPARATORS: [&str; 12] = [
      "-", "--", "---", "----", ".", "/", "//", "-.", "-/", "./", " & ", "+",
    ];
    const ENTRIES: usize = 2_400;
    const PAIRS: usize = 2_500;
    const TOKENS: usize = 5_000;
    const MAX_STEPS: usize = 10_000;
    let terms = (0..ENTRIES)
      .map(|index| {
        let separator =
          SEPARATORS[index.checked_rem(SEPARATORS.len()).unwrap()];
        format!("Acme{separator}Holding{index}")
      })
      .collect::<Vec<_>>();
    let entries = terms
      .iter()
      .map(|term| exact(term, ORGANIZATION))
      .collect::<Vec<_>>();
    let (prepared, _) = prepare(&entries);
    let text = "Acme Holding7 ".repeat(PAIRS);
    let mut steps = 0_usize;
    let hits = prepared.sequences.hits(&text, &mut steps);
    assert_eq!(hits.len(), PAIRS);
    assert!(steps <= MAX_STEPS, "{steps} trie steps for {TOKENS} tokens");
  }

  #[test]
  fn words_that_fold_alike_share_one_walk() {
    const ENTRIES: usize = 2_000;
    const PAIRS: usize = 2_500;
    const TOKENS: usize = 5_000;
    const MAX_STEPS: usize = 10_000;
    let terms = (0..ENTRIES)
      .map(|index| {
        let mark = u32::try_from(index.checked_rem(112).unwrap()).unwrap();
        let mark = char::from_u32(0x0300_u32.saturating_add(mark)).unwrap();
        format!("Acm{mark}e Holding{index}")
      })
      .collect::<Vec<_>>();
    let entries = terms
      .iter()
      .map(|term| exact(term, ORGANIZATION))
      .collect::<Vec<_>>();
    let (prepared, _) = prepare(&entries);
    let text = "Acme Holding7 ".repeat(PAIRS);
    let mut steps = 0_usize;
    let hits = prepared.sequences.hits(&text, &mut steps);
    assert_eq!(hits.len(), PAIRS);
    assert!(steps <= MAX_STEPS, "{steps} trie steps for {TOKENS} tokens");
  }

  #[test]
  fn whitespace_free_runs_are_checked_in_linear_time() {
    const NAMES: usize = 20_000;
    // `Acme,` per name: five chars.
    const TEXT_CHARS: usize = 100_000;
    const MAX_VISITS: usize = 300_000;
    let entries = [exact("Acme", ORGANIZATION)];
    let (prepared, terms) = prepare(&entries);
    for text in [
      "Acme,".repeat(NAMES),
      format!("⟦{}", "Acme,".repeat(NAMES)),
      format!("{}⟧", "Acme,".repeat(NAMES)),
    ] {
      let hits = literal_hits(&text, &terms, entries.len());
      let guard = Guard::new(&text);
      let entities = prepared.detect_with_guard(&hits, &guard).unwrap();
      assert_eq!(entities.len(), NAMES);
      assert!(
        guard.policy.visits.get() <= MAX_VISITS,
        "{} chars visited for {TEXT_CHARS} chars",
        guard.policy.visits.get()
      );
    }
    let marked = format!("x ⟦{}⟧ y", "Acme,".repeat(NAMES));
    assert!(found(&entries, &marked).is_empty());
  }

  #[test]
  fn markers_enclose_only_their_own_content() {
    let entries = [exact("Acme", ORGANIZATION)];
    assert_eq!(found(&entries, "⟦field-1⟧Acme⟦field-2⟧"), ["Acme"]);
    assert_eq!(found(&entries, "x ⟦a⟦b⟧Acme⟧ y").len(), 0);
    assert_eq!(found(&entries, "x ⟦Acme⟧⟧ y").len(), 0);
    assert_eq!(found(&entries, "x Acme⟧ ⟦y"), ["Acme"]);
    assert_eq!(found(&entries, "x ⟦Acme y⟧"), ["Acme"]);
  }

  #[test]
  fn windows_line_endings_count_as_one_break() {
    let entries = [exact("Marie Dvořáková", PERSON)];
    for text in [
      "Marie\nDvořáková podepsala.",
      "Marie\r\nDvořáková podepsala.",
      "Marie\rDvořáková podepsala.",
    ] {
      assert_eq!(found(&entries, text).len(), 1, "{text:?}");
    }
    assert!(found(&entries, "Marie\r\n\r\nDvořáková").is_empty());
  }

  /// Hits the real search index reports for `entries`, with the options the
  /// assembler uses for gazetteer patterns.
  fn engine_hits(entries: &[Entry<'_>], text: &str) -> Vec<SearchMatch> {
    let mut patterns = entries
      .iter()
      .map(|entry| SearchPattern::LiteralWithOptions {
        pattern: entry.term.to_owned(),
        case_insensitive: None,
        whole_words: Some(false),
      })
      .collect::<Vec<_>>();
    patterns.extend(entries.iter().filter_map(|entry| {
      entry.fuzzy_distance.map(|distance| SearchPattern::Fuzzy {
        pattern: entry.term.to_owned(),
        distance: Some(distance),
      })
    }));
    let options = crate::search::SearchOptions {
      literal: crate::search::LiteralSearchOptions {
        case_insensitive: true,
        whole_words: false,
      },
      fuzzy: crate::search::FuzzySearchOptions {
        case_insensitive: true,
        whole_words: false,
        normalize_diacritics: true,
      },
      ..crate::search::SearchOptions::default()
    };
    crate::search::SearchIndex::new(patterns, options)
      .unwrap()
      .find_iter(text)
      .unwrap()
  }

  fn engine_found(entries: &[Entry<'_>], text: &str) -> Vec<String> {
    let (prepared, _) = prepare(entries);
    prepared
      .detect(&engine_hits(entries, text), text)
      .unwrap()
      .into_iter()
      .map(|entity| entity.text)
      .collect()
  }

  fn fuzzy_entry(term: &str) -> Entry<'_> {
    Entry {
      term,
      label: PERSON,
      fuzzy_distance: gazetteer_fuzzy_distance(term),
    }
  }

  #[test]
  fn overlapping_fuzzy_windows_do_not_hide_a_match() {
    let entries = [fuzzy_entry("Wintermte"), fuzzy_entry("WintermteY")];
    assert!(
      engine_found(&entries, "Signed by WintermteX today.")
        .iter()
        .any(|hit| hit == "WintermteX")
    );
    assert!(
      engine_found(&entries[..1], "Signed by WintermteX today.")
        .iter()
        .any(|hit| hit == "WintermteX")
    );
  }

  #[test]
  fn fuzzy_fallback_cost_does_not_grow_with_unrelated_entries() {
    const ENTRIES: u32 = 3_000;
    const WINDOWS: usize = 2_000;
    // Deletion variants of a 9-letter span at distance 1 (1 + 9) plus a few
    // distance checks, per span, for the few spans near each window.
    const MAX_STEPS_PER_WINDOW: usize = 4 * 64;
    // Unrelated 8-letter names: `b` followed by the base-26 digits of the
    // index, padded with `q`.
    let terms = (0..ENTRIES)
      .map(|index| {
        let mut name = String::from("B");
        let mut rest = index;
        for _ in 0..7 {
          let digit = u8::try_from(rest.checked_rem(26).unwrap()).unwrap();
          name.push(char::from(b'a'.saturating_add(digit)));
          rest = rest.checked_div(26).unwrap();
        }
        name
      })
      .collect::<Vec<_>>();
    let entries = terms
      .iter()
      .map(|term| Entry {
        term,
        label: PERSON,
        fuzzy_distance: Some(1),
      })
      .collect::<Vec<_>>();
    let (prepared, _) = prepare(&entries);
    let fuzzy_pattern = u32::try_from(terms.len()).unwrap();
    // Each distinct `Z…X` token, one letter longer than the entries, yields
    // a window that cuts into it.
    let text = (0..WINDOWS)
      .map(|window| {
        let mut token = String::from("Z");
        let mut rest = window;
        for _ in 0..7 {
          let digit = u8::try_from(rest.checked_rem(26).unwrap()).unwrap();
          token.push(char::from(b'a'.saturating_add(digit)));
          rest = rest.checked_div(26).unwrap();
        }
        token.push_str("X ");
        token
      })
      .collect::<String>();
    let hits = (0..WINDOWS)
      .map(|window| {
        let start = u32::try_from(window.checked_mul(10).unwrap()).unwrap();
        SearchMatch::Fuzzy {
          pattern: fuzzy_pattern,
          start,
          end: start.saturating_add(8),
          distance: 1,
        }
      })
      .collect::<Vec<_>>();
    let guard = Guard::new(&text);
    assert!(
      prepared
        .detect_with_guard(&hits, &guard)
        .unwrap()
        .is_empty()
    );
    let steps = guard.fuzzy_steps.get();
    assert!(
      steps >= WINDOWS,
      "the fallback ran for every window: {steps}"
    );
    assert!(
      steps <= WINDOWS.saturating_mul(MAX_STEPS_PER_WINDOW),
      "{steps} fallback steps for {WINDOWS} windows"
    );
  }

  /// A fuzzy window over `text[start..end]` that its own entry rejects, so
  /// the fallback re-checks the span against every fuzzy entry.
  fn fallback_texts(
    prepared: &PreparedGazetteerMatchData,
    pattern: u32,
    text: &str,
  ) -> Vec<(String, String)> {
    let hit = SearchMatch::Fuzzy {
      pattern,
      start: 0,
      end: u32::try_from(text.len()).unwrap(),
      distance: 1,
    };
    prepared
      .detect(&[hit], text)
      .unwrap()
      .into_iter()
      .map(|entity| (entity.text, entity.label))
      .collect()
  }

  #[test]
  fn fuzzy_fallback_checks_every_entry_sharing_a_variant_in_order() {
    // 300 entries within two edits of `Wintermute`, all sharing the
    // variant `wintermu`; only the last one is an organization.
    let mut terms = vec![String::from("Zzzzzzzzzz")];
    for first in 'a'..='z' {
      for second in 'a'..='z' {
        if terms.len() <= 300 {
          terms.push(format!("Wintermu{first}{second}"));
        }
      }
    }
    let entries = terms
      .iter()
      .enumerate()
      .map(|(index, term)| Entry {
        term,
        label: if index == 300 { ORGANIZATION } else { PERSON },
        fuzzy_distance: Some(2),
      })
      .collect::<Vec<_>>();
    let pattern = u32::try_from(entries.len()).unwrap();
    let first = fallback_texts(&prepare(&entries).0, pattern, "Wintermute");
    assert!(
      first
        .iter()
        .any(|(text, label)| text == "Wintermute" && label == ORGANIZATION),
      "{first:?}"
    );
    // A fresh build hashes differently; the output must not change.
    let second = fallback_texts(&prepare(&entries).0, pattern, "Wintermute");
    assert_eq!(first, second);
  }

  #[test]
  fn caller_fuzzy_distances_are_capped() {
    let term = "Abcdefghijklmnopqrstuvwxyzabcd";
    let entries = [Entry {
      term,
      label: PERSON,
      fuzzy_distance: Some(15),
    }];
    let (prepared, _) = prepare(&entries);
    // One-letter-deletion and two-letter-deletion variants of 30 letters.
    assert!(prepared.fuzzy_deletions.len() <= 1 + 30 + 435);
    assert!(prepared.rows.iter().all(|row| match &row.kind {
      RowKind::Fuzzy { max_distance, .. } => *max_distance <= 2,
      RowKind::Exact => true,
    }));
  }

  #[test]
  fn a_shorter_accepted_match_does_not_hide_a_longer_one() {
    let entries = [fuzzy_entry("Wintermute"), fuzzy_entry("Wintermute X")];
    let found = engine_found(&entries, "Signed by Wintermute Y today.");
    assert!(found.iter().any(|hit| hit == "Wintermute Y"), "{found:?}");
    // The exact `Wintermute` hit stays inside it for resolution to merge.
    assert!(
      found
        .iter()
        .all(|hit| "Wintermute Y".starts_with(hit.as_str())),
      "{found:?}"
    );
  }

  #[test]
  fn window_tokens_stop_within_their_reach() {
    let text = format!("Acme {}", "x".repeat(100_000));
    let window = window_tokens(&text, 0, 4, 10);
    assert!(
      window.tokens.iter().all(|token| token.end <= 40),
      "{:?}",
      window
        .tokens
        .iter()
        .map(|token| token.end)
        .collect::<Vec<_>>()
    );
  }

  #[test]
  fn recovered_fuzzy_spans_do_not_absorb_a_short_word() {
    let entries = [fuzzy_entry("Wintermute"), fuzzy_entry("Wintermutes")];
    let found = engine_found(&entries, "Wintermute a Novák podepsali.");
    assert!(found.iter().all(|hit| hit == "Wintermute"), "{found:?}");
  }

  #[test]
  fn spans_never_end_inside_a_dotted_chain() {
    let entries = [fuzzy_entry("Luma s.r.o.")];
    let text = "archived Luma s.r.o. reviewed xLuma s.r.o.y e\u{301} konec";
    let found = engine_found(&entries, text);
    assert_eq!(found, ["Luma s.r.o."], "{text:?}");
  }

  /// Word boundaries per UAX #29.
  fn word_boundaries(text: &str) -> HashSet<usize> {
    use unicode_segmentation::UnicodeSegmentation;
    let mut boundaries = HashSet::from([0, text.len()]);
    for (start, segment) in text.split_word_bound_indices() {
      boundaries.insert(start);
      boundaries.insert(start.saturating_add(segment.len()));
    }
    boundaries
  }

  /// Byte offsets the gazetteer covers in `text` for `entries`.
  fn coverage(entries: &[Entry<'_>], text: &str) -> Vec<bool> {
    let (prepared, _) = prepare(entries);
    let mut covered = vec![false; text.len()];
    for entity in prepared.detect(&engine_hits(entries, text), text).unwrap() {
      let start = usize::try_from(entity.start).unwrap();
      let end = usize::try_from(entity.end).unwrap();
      for slot in covered.iter_mut().take(end).skip(start) {
        *slot = true;
      }
    }
    covered
  }

  /// Entry spellings derived from a base name: itself, a near duplicate, a
  /// prefix extension, and a multiword extension.
  fn derived_entry(
    base: &str,
    kind: usize,
    letter: char,
    word: &str,
  ) -> String {
    match kind % 4 {
      0 => base.to_owned(),
      1 => {
        let mut chars = base.chars().collect::<Vec<_>>();
        if let Some(last) = chars.last_mut() {
          *last = letter;
        }
        chars.into_iter().collect()
      }
      2 => format!("{base}{letter}"),
      _ => format!("{base} {word}"),
    }
  }

  /// A document spelling of `entry`: as written, with a letter appended or
  /// replaced or dropped, or followed by another word.
  fn perturbed(entry: &str, kind: usize, letter: char, word: &str) -> String {
    let chars = entry.chars().collect::<Vec<_>>();
    match kind % 5 {
      0 => entry.to_owned(),
      1 => format!("{entry}{letter}"),
      2 => chars
        .iter()
        .take(chars.len().saturating_sub(1))
        .chain(std::iter::once(&letter))
        .collect(),
      3 => chars.iter().skip(1).collect(),
      _ => format!("{entry} {word}"),
    }
  }

  #[test]
  fn fuzz_joined_identifier_regression_rejects_the_bad_span() {
    let text = "dead1234-a1b2";
    assert!(
      fuzz_policy::edges_are_free(text, 0, 4),
      "numeric glue is allowed at a word edge"
    );
    assert!(
      fuzz_policy::touches_identifier(text, 0, 4),
      "oracle must reject the partial joined identifier"
    );
    assert!(
      Guard::new(text).in_identifier(0, 4),
      "production must agree with the oracle"
    );
  }

  proptest! {
    #![proptest_config(ProptestConfig {
      cases: 256,
      rng_seed: RngSeed::Fixed(0x636f_7665_7261_6765),
      failure_persistence: None,
      ..ProptestConfig::default()
    })]

    #[test]
    fn fuzz_marker_oracle_matches_production(
      text in "[⟦⟧<>{}\\[\\]a \t\n\r\u{00a0}\u{2028}]{0,128}",
    ) {
      let found = markers(&text);
      let opaque = found
        .opaque
        .iter()
        .map(|(start, close)| (*start, close.saturating_add('⟧'.len_utf8())))
        .collect::<Vec<_>>();
      prop_assert_eq!(fuzz_policy::marker_ranges(&text), opaque);
      let templates = found
        .template
        .iter()
        .map(|(start, close)| (*start, close.saturating_add(2)))
        .collect::<Vec<_>>();
      prop_assert_eq!(fuzz_policy::template_ranges(&text), templates);
    }

    #[test]
    fn fuzz_acceptance_predicates_match_production(
      characters in prop::collection::vec(any::<char>(), 0..80),
      character in any::<char>(),
      left in any::<usize>(),
      right in any::<usize>(),
      identifier in ".{0,40}",
      spelling in "[A-Za-zŽžÁá\u{301}محد東京თბილᲗᲑ0-9 _-]{0,16}",
      entry in "[A-Za-zŽžÁá\u{301}محد東京თბილᲗᲑ .-]{1,16}",
      glue in prop::collection::vec(any::<char>(), 0..40),
      edge in prop::option::of(any::<char>()),
    ) {
      prop_assert_eq!(fuzz_policy::glue_is_free(&glue, edge), glue_is_free(glue.into_iter(), edge));
      prop_assert_eq!(fuzz_policy::is_word_interior(character), is_word_char(character));
      prop_assert_eq!(fuzz_policy::is_unspaced_script(character), is_unspaced_script(character));
      prop_assert_eq!(fuzz_policy::is_compound_joiner(character), COMPOUND_JOINERS.contains(&character));
      prop_assert_eq!(fuzz_policy::is_identifier_segment(&identifier), is_identifier_segment(&identifier));
      // A template field is only kept as a name that shows one.
      let signature = Spelling::of(&entry, GazetteerInflection::CzechSlovak);
      for surface in [&identifier, &spelling] {
        prop_assert_eq!(fuzz_policy::shows_a_name(surface), shows_a_name(surface));
        if signature.as_ref().is_some_and(|signature| signature.spells(surface)) {
          prop_assert!(fuzz_policy::shows_a_name(surface));
        }
      }
      prop_assert!(signature.is_none_or(|signature| signature.spells(&entry)));
      // Structured envelopes ensure numeric glue, joined segments, markers,
      // and their interactions are exercised alongside arbitrary Unicode.
      let arbitrary = characters.into_iter().collect::<String>();
      for text in [
        arbitrary,
        format!("⟦a1b2-1234{identifier}1234-a1b2⟧"),
        format!("<<a1b2:{identifier}>> [[{identifier}]]"),
      ] {
        let offsets = text.char_indices().map(|(offset, _)| offset)
          .chain(std::iter::once(text.len())).collect::<Vec<_>>();
        let first = offsets[left.checked_rem(offsets.len()).unwrap()];
        let second = offsets[right.checked_rem(offsets.len()).unwrap()];
        let (start, end) = (first.min(second), first.max(second));
        let guard = Guard::new(&text);
        prop_assert_eq!(fuzz_policy::edges_are_free(&text, start, end), guard.edges_are_free(start, end));
        prop_assert_eq!(fuzz_policy::in_marker(&text, start, end), encloses(&guard.policy.markers.opaque, start, end));
        prop_assert_eq!(
          fuzz_policy::touches_identifier(&text, start, end)
            || fuzz_policy::in_marker(&text, start, end)
            || fuzz_policy::in_template_field(&text, start, end),
          guard.in_identifier(start, end)
        );
        let mut joined_guard = Guard::new(&text);
        joined_guard.policy.markers = Markers::default();
        prop_assert_eq!(fuzz_policy::touches_identifier(&text, start, end), joined_guard.in_identifier(start, end));
      }
    }

    #[test]
    fn fuzz_joined_identifier_predicate_skips_numeric_glue(
      digits in "[0-9]{0,20}",
      segment in "[a-f][0-9][a-f][0-9]{1,12}",
      joiner in prop::sample::select(COMPOUND_JOINERS.to_vec()),
    ) {
      for text in [format!("dead{digits}{joiner}{segment}"), format!("{segment}{joiner}{digits}dead")] {
        let start = text.find("dead").unwrap();
        let end = start.checked_add("dead".len()).unwrap();
        prop_assert!(fuzz_policy::touches_identifier(&text, start, end));
        prop_assert_eq!(fuzz_policy::touches_identifier(&text, start, end), Guard::new(&text).in_identifier(start, end));
      }
    }

    #[test]
    fn spaced_spans_sit_on_unicode_word_boundaries(
      names in prop::collection::vec(
        prop_oneof![
          prop::sample::select(vec!["Zy", "Dab", "Luma", "Velomír", "Žilora", "Ľunora"])
            .prop_map(str::to_owned),
          (
            prop::sample::select(vec!["Luma", "Bex", "Mivo", "Wintermute"]),
            prop::sample::select(vec!["Labs", "s.r.o.", "a.s.", "GmbH", "Ltd"]),
          )
            .prop_map(|(name, suffix)| format!("{name} {suffix}")),
        ],
        1..4,
      ),
      separator in prop::sample::select(vec![" ", ", ", "\n", "\u{a0}", "\u{1f980}"]),
    ) {
      let entries = names.iter().map(|name| fuzzy_entry(name)).collect::<Vec<_>>();
      let text = names
        .iter()
        .map(|name| format!("archived{separator}{name}{separator}reviewed x{name}y e\u{301} Ελληνικά 界"))
        .collect::<Vec<_>>()
        .join(separator);
      let boundaries = word_boundaries(&text);
      let (prepared, _) = prepare(&entries);
      let entities = prepared.detect(&engine_hits(&entries, &text), &text).unwrap();
      prop_assert!(!entities.is_empty());
      for entity in entities {
        let start = usize::try_from(entity.start).unwrap();
        let end = usize::try_from(entity.end).unwrap();
        prop_assert!(
          boundaries.contains(&start) && boundaries.contains(&end),
          "{:?} at {start}..{end} in {text:?}",
          entity.text
        );
      }
    }

    #[test]
    fn adding_entries_never_reduces_coverage(
      bases in prop::collection::vec("[A-Z][a-z]{3,9}", 1..3),
      derivations in prop::collection::vec(
        (any::<usize>(), any::<usize>(), "[a-z]", "[A-Z][a-z]{1,5}"),
        1..5,
      ),
      spellings in prop::collection::vec(
        (any::<usize>(), any::<usize>(), "[a-z]", "[a-z]{1,6}"),
        1..5,
      ),
    ) {
      let mut terms = Vec::new();
      for (base, kind, letter, word) in &derivations {
        let base = &bases[base.checked_rem(bases.len()).unwrap()];
        let letter = letter.chars().next().unwrap();
        let term = derived_entry(base, *kind, letter, word);
        if !terms.contains(&term) {
          terms.push(term);
        }
      }
      let text = spellings
        .iter()
        .map(|(entry, kind, letter, word)| {
          let entry = &terms[entry.checked_rem(terms.len()).unwrap()];
          perturbed(entry, *kind, letter.chars().next().unwrap(), word)
        })
        .collect::<Vec<_>>()
        .join(" a ");
      let text = format!("Ref {text} konec.");
      let all = terms.iter().map(|term| fuzzy_entry(term)).collect::<Vec<_>>();
      let together = coverage(&all, &text);
      for entry in &all {
        let alone = coverage(std::slice::from_ref(entry), &text);
        for (offset, (single, joint)) in alone.iter().zip(&together).enumerate() {
          prop_assert!(
            !single || *joint,
            "{:?} alone covers byte {offset} of {text:?}, all of {terms:?} do not",
            entry.term
          );
        }
      }
    }
  }

  #[test]
  fn separators_accept_whitespace_and_their_own_punctuation() {
    let entries = [exact("A.B. & Co Holding", ORGANIZATION)];
    for text in [
      "Firma A.B. & Co Holding dnes",
      "Firma A B Co Holding dnes",
      "Firma A. B. & Co Holding dnes",
      "Firma A.B & Co Holding dnes",
    ] {
      assert_eq!(found(&entries, text).len(), 1, "{text}");
    }
    assert!(found(&entries, "Firma A/B Co Holding dnes").is_empty());
  }

  #[test]
  fn legal_forms_need_a_boundary_after_them() {
    let entries = [exact("Acme", ORGANIZATION)];
    assert_eq!(found(&entries, "Acme s.r.o.foo dnes"), ["Acme"]);
    assert_eq!(found(&entries, "Acme a.s.2024 dnes"), ["Acme"]);
    assert_eq!(found(&entries, "Acme s.r.o., dnes"), ["Acme s.r.o."]);
    assert_eq!(found(&entries, "Acme s.r.o./2024"), ["Acme s.r.o."]);
  }

  #[test]
  fn every_name_joiner_matches_an_entry_spelled_with_another() {
    for (spelling, joiner) in NAME_JOINERS {
      assert_eq!(canonical_punctuation(spelling), joiner.canonical());
      // MODIFIER LETTER APOSTROPHE is a letter: it never splits a word, so
      // an entry spelled with it matches only that spelling.
      let entry = if spelling.is_alphanumeric() {
        format!("Tarsk{spelling}Velmor")
      } else {
        format!("Tarsk{}Velmor", joiner.canonical())
      };
      let surname = format!("Tarsk{spelling}Velmor");
      assert_eq!(
        found(
          &[exact(&entry, PERSON)],
          &format!("Smlouvu podepsal {surname} dnes"),
        ),
        [surname],
        "{spelling:?}"
      );
    }
    for other in ['\u{2014}', '"', '\u{201c}', '\u{2018}'] {
      assert_eq!(canonical_punctuation(other), other);
    }
  }

  #[test]
  fn names_in_unspaced_scripts_keep_matching_as_substrings() {
    assert_eq!(found(&[exact("東京", ORGANIZATION)], "東京都に"), ["東京"]);
    assert_eq!(
      found(&[exact("佐々木", PERSON)], "売主佐々木は"),
      ["佐々木"]
    );
    // Characters of those scripts are not word characters, so a name of any
    // script inside such a run sits on token edges.
    for text in [
      "界Luma界",
      "ภาษาLumaไทย",
      "ខ្មែរLumaខ្មែរ",
      "ᄀLumaᄀ",
      "ㄱLumaㄱ",
      "ꥠLumaꥠ",
      "ힰLumaힰ",
      "ｶLumaｶ",
      "ﾡLumaﾡ",
      "ㇰLumaㇰ",
      "ꩠLumaꩠ",
      "𛀁Luma𛀁",
      "々Luma々",
      "〻Luma〻",
    ] {
      assert_eq!(
        found(&[exact("Luma", ORGANIZATION)], text),
        ["Luma"],
        "{text}"
      );
    }
  }

  #[test]
  fn carried_terms_must_agree_with_their_patterns() {
    let data = GazetteerMatchData {
      labels: vec![ORGANIZATION.to_owned()],
      is_fuzzy: vec![false],
      legal_form_suffixes: Vec::new(),
      inflection: GazetteerInflection::CzechSlovak,
      terms: vec!["Other".to_owned()],
      person_forms: Vec::new(),
    };
    let literal = [SearchPattern::Literal("Acme".to_owned())];
    let slice = PatternSlice { start: 0, end: 1 };
    assert!(matches!(
      PreparedGazetteerMatchData::new(data, slice, Some(&literal)),
      Err(Error::InvalidStaticData {
        field: "gazetteer_data.terms",
        ..
      })
    ));
  }

  #[test]
  fn row_kinds_must_match_their_patterns() {
    let data = GazetteerMatchData {
      labels: vec![ORGANIZATION.to_owned()],
      is_fuzzy: vec![false],
      legal_form_suffixes: Vec::new(),
      inflection: GazetteerInflection::CzechSlovak,
      terms: Vec::new(),
      person_forms: Vec::new(),
    };
    let fuzzy = [SearchPattern::Fuzzy {
      pattern: "Acme".to_owned(),
      distance: Some(1),
    }];
    let slice = PatternSlice { start: 0, end: 1 };
    assert!(
      PreparedGazetteerMatchData::new(data.clone(), slice, Some(&fuzzy))
        .is_err()
    );
    assert!(PreparedGazetteerMatchData::new(data, slice, Some(&[])).is_err());
  }

  const SAMPLE_NAMES: &[&str] = &[
    "Acme",
    "Novák",
    "Orbis",
    "Zeta",
    "Harriet",
    "Wintermute",
    "Svoboda",
    "Kubíček",
    "Ľubomír",
  ];

  /// A name from the samples or a generated capitalized one.
  fn name() -> impl Strategy<Value = String> {
    prop_oneof![
      prop::sample::select(SAMPLE_NAMES).prop_map(str::to_owned),
      "[A-Z][a-z]{2,11}",
    ]
  }

  /// A spelling of `name` that matches it when it stands alone: as written,
  /// in another case, without diacritics, or declined.
  fn surface(name: &str, choice: usize) -> String {
    let mut spellings = vec![
      name.to_owned(),
      name.to_uppercase(),
      name.to_lowercase(),
      fold(name),
    ];
    spellings.extend(expand_name_declensions(name));
    spellings.extend(expand_surname_derivations(name));
    spellings[choice.checked_rem(spellings.len()).unwrap()].clone()
  }

  /// Wraps `surface` into an identifier-shaped token.
  fn identifier_token(
    surface: &str,
    shape: usize,
    left: &str,
    right: &str,
  ) -> String {
    match shape % 6 {
      0 => format!("{left}{surface}"),
      1 => format!("{surface}{right}"),
      2 => format!("{left}-{surface}-{right}"),
      3 => format!("⟦field-{surface}-{right}⟧"),
      4 => format!("{left}{surface}/{right}=="),
      _ => format!("{surface}_{left}"),
    }
  }

  /// An identifier-shaped hex run: at least four chars, a digit followed by
  /// a hex letter.
  fn hex_id() -> impl Strategy<Value = String> {
    ("[0-9a-f]{2,6}", "[0-9]", "[a-f]", "[0-9a-f]{0,6}").prop_map(
      |(head, digit, letter, tail)| format!("{head}{digit}{letter}{tail}"),
    )
  }

  /// `surface` next to a plain number or word, as in file names, emails,
  /// URLs, and references.
  fn beside_plain_token(
    surface: &str,
    shape: usize,
    number: &str,
    word: &str,
  ) -> String {
    match shape % 6 {
      0 => format!("{surface}/{number}"),
      1 => format!("{number}-{surface}"),
      2 => format!("{surface}{number}"),
      3 => format!("{surface}_{word}_{number}.pdf"),
      4 => format!("{word}.{word}{number}@{surface}.cz"),
      _ => format!("https://{surface}.cz/{word}"),
    }
  }

  proptest! {
    #![proptest_config(ProptestConfig {
      cases: 512,
      rng_seed: RngSeed::Fixed(0x6761_7a65_7474_6565),
      failure_persistence: None,
      ..ProptestConfig::default()
    })]

    #[test]
    fn names_match_alone_but_never_inside_identifier_tokens(
      name in name(),
      choice in any::<usize>(),
      shape in any::<usize>(),
      left in hex_id(),
      right in hex_id(),
      fuzzy in any::<bool>(),
    ) {
      let entries = [Entry {
        term: &name,
        label: PERSON,
        fuzzy_distance: (fuzzy && name.chars().count() >= 6).then_some(1),
      }];
      let (prepared, terms) = prepare(&entries);
      let surface = surface(&name, choice);

      let alone = format!("Ref {surface} uložen.");
      let start = "Ref ".len();
      let alone_hits = literal_hits(&alone, &terms, 1);
      let alone_entities = prepared.detect(&alone_hits, &alone).unwrap();
      prop_assert!(
        alone_entities.iter().any(|entity| entity.text == surface),
        "{surface:?} alone: {alone_entities:?}"
      );

      let token = identifier_token(&surface, shape, &left, &right);
      let inside = format!("Ref {token} uložen.");
      let token_end = start.saturating_add(token.len());
      // The engines report the name wherever it occurs, also inside tokens.
      let mut hits = literal_hits(&inside, &terms, 1);
      if let Some(offset) = inside.find(&surface) {
        hits.push(SearchMatch::Fuzzy {
          pattern: u32::try_from(entries.len()).unwrap(),
          start: u32::try_from(offset).unwrap(),
          end: u32::try_from(offset.saturating_add(surface.len())).unwrap(),
          distance: 0,
        });
      }
      if entries[0].fuzzy_distance.is_none() {
        hits.retain(|hit| matches!(hit, SearchMatch::Literal { .. }));
      }
      let entities = prepared.detect(&hits, &inside).unwrap();
      prop_assert!(
        entities.iter().all(|entity| {
          usize::try_from(entity.end).unwrap() <= start
            || usize::try_from(entity.start).unwrap() >= token_end
        }),
        "{token:?}: {entities:?}"
      );
    }

    #[test]
    fn names_beside_plain_numbers_and_words_still_match(
      name in name(),
      choice in any::<usize>(),
      shape in any::<usize>(),
      number in "[0-9]{1,4}",
      word in "[a-z]{2,8}",
    ) {
      let entries = [exact(&name, PERSON)];
      let (prepared, terms) = prepare(&entries);
      let surface = surface(&name, choice);
      let text = format!(
        "Ref {} uložen.",
        beside_plain_token(&surface, shape, &number, &word)
      );
      let hits = literal_hits(&text, &terms, 1);
      let entities = prepared.detect(&hits, &text).unwrap();
      prop_assert!(
        entities.iter().any(|entity| entity.text == surface),
        "{text:?}: {entities:?}"
      );
    }

    #[test]
    fn span_index_matches_a_linear_overlap_scan(
      spans in prop::collection::vec((0_usize..64, 1_usize..16), 0..24),
      query_start in 0_usize..80,
      query_len in 1_usize..16,
    ) {
      let hits = spans
        .iter()
        .map(|(start, len)| Hit {
          start: *start,
          end: start.saturating_add(*len),
          label: ORGANIZATION,
          score: EXACT_SCORE,
          spelling: None,
        })
        .collect::<Vec<_>>();
      let start = query_start;
      let end = query_start.saturating_add(query_len);
      let linear = hits.iter().any(|hit| hit.start <= start && end <= hit.end);
      prop_assert_eq!(SpanIndex::new(&hits).contains(start, end), linear);
    }

    #[test]
    fn a_longer_near_duplicate_entry_never_removes_a_match(
      name in "[A-Z][a-z]{5,10}",
      extra in "[a-z]{1,2}",
      typo in 0_usize..4,
      glued in "[a-z]?",
    ) {
      let surface = match typo {
        0 => name.clone(),
        1 => format!("{name}{glued}"),
        2 => name.chars().skip(1).collect::<String>(),
        _ => format!("{}x", name.chars().take(name.chars().count().saturating_sub(1)).collect::<String>()),
      };
      let text = format!("Podpis {surface} dnes.");
      let longer = format!("{name}{extra}");
      let alone = [fuzzy_entry(&name)];
      let both = [fuzzy_entry(&name), fuzzy_entry(&longer)];
      let found_alone = engine_found(&alone, &text);
      let found_both = engine_found(&both, &text);
      for hit in &found_alone {
        prop_assert!(found_both.contains(hit), "{text:?}: {found_alone:?} vs {found_both:?}");
      }
    }

    #[test]
    fn hits_never_absorb_a_following_word(
      name in name(),
      word in "[a-zA-Z]{1,8}",
    ) {
      prop_assume!(!LEGAL_FORMS.contains(&word.as_str()));
      let text = format!("{name} {word} today");
      let found = found(&[exact(&name, ORGANIZATION)], &text);
      prop_assert!(
        found.iter().all(|hit| hit == &name),
        "{text:?}: {found:?}"
      );
    }
  }
}
