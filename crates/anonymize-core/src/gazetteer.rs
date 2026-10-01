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

use std::cell::Cell;
use std::collections::{BTreeMap, HashMap, HashSet};

use unicode_normalization::char::{decompose_canonical, is_combining_mark};

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

/// Characters that join word runs into one compound (`9b1d0c3e-acfe`,
/// `novak@acme.cz`, `Acme_v2`).
const COMPOUND_JOINERS: [char; 10] =
  ['-', '_', '.', '/', '+', '=', ':', '@', '#', '\\'];

/// Shortest hex run read as an identifier segment (`4c1b`, `9b1d0c3e`).
const MIN_HEX_SEGMENT_CHARS: usize = 4;

/// Shortest mixed-case alphanumeric run read as a base64 segment.
const MIN_BASE64_SEGMENT_CHARS: usize = 12;

/// Fewer letters than this match only exactly (after folding and declension):
/// one edit turns a short name into an ordinary word (`Acme` -> `acne`).
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
    letters if letters < MIN_FUZZY_LETTERS => None,
    letters if letters < MIN_TWO_EDIT_LETTERS => Some(1),
    _ => Some(2),
  }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedGazetteerMatchData {
  slice: PatternSlice,
  rows: Vec<GazetteerRow>,
  /// Fuzzy rows by folded letter count, for re-checking a token-aligned span.
  fuzzy_by_letters: BTreeMap<usize, Vec<usize>>,
  sequences: SequenceTrie,
  legal_forms: Vec<LegalFormSuffix>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct GazetteerRow {
  label: String,
  kind: RowKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RowKind {
  Exact,
  Fuzzy {
    folded: Vec<char>,
    max_distance: usize,
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

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct TrieNode {
  /// Labels of the entries that end here.
  labels: Vec<String>,
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
}

impl PreparedGazetteerMatchData {
  /// Prepares gazetteer rows from the assembled data and the search patterns
  /// of the gazetteer slice, which carry each row's entry text.
  pub(crate) fn new(
    data: GazetteerMatchData,
    slice: PatternSlice,
    patterns: &[SearchPattern],
  ) -> Result<Self> {
    validate_length("gazetteer_data.labels", slice, data.labels.len())?;
    validate_length("gazetteer_data.is_fuzzy", slice, data.is_fuzzy.len())?;
    validate_length("gazetteer patterns", slice, patterns.len())?;
    let legal_forms = data
      .legal_form_suffixes
      .iter()
      .filter(|suffix| !suffix.trim().is_empty())
      .map(|suffix| LegalFormSuffix::new(suffix))
      .collect::<Vec<_>>();
    let mut prepared = Self {
      slice,
      rows: Vec::with_capacity(patterns.len()),
      fuzzy_by_letters: BTreeMap::new(),
      sequences: SequenceTrie::new(data.inflection),
      legal_forms,
    };
    for (index, ((label, is_fuzzy), pattern)) in data
      .labels
      .into_iter()
      .zip(data.is_fuzzy)
      .zip(patterns)
      .enumerate()
    {
      let kind = match (is_fuzzy, pattern) {
        (
          false,
          SearchPattern::Literal(term)
          | SearchPattern::LiteralWithOptions { pattern: term, .. },
        ) => {
          prepared.add_sequences(term, &label);
          RowKind::Exact
        }
        (
          true,
          SearchPattern::Fuzzy {
            pattern: term,
            distance,
          },
        ) => RowKind::Fuzzy {
          folded: fold_word_chars(term),
          // An automatic distance follows the same length scale as the
          // assembled patterns; short entries then accept folded hits only.
          max_distance: usize::from(
            distance
              .or_else(|| gazetteer_fuzzy_distance(term))
              .unwrap_or(0),
          ),
        },
        _ => {
          return Err(Error::InvalidStaticData {
            field: "gazetteer_data.is_fuzzy",
            reason: format!(
              "row {index} does not match the kind of its search pattern"
            ),
          });
        }
      };
      if let RowKind::Fuzzy { folded, .. } = &kind {
        prepared
          .fuzzy_by_letters
          .entry(folded.len())
          .or_default()
          .push(prepared.rows.len());
      }
      prepared.rows.push(GazetteerRow { label, kind });
    }
    Ok(prepared)
  }

  fn row(&self, pattern: u32) -> Option<&GazetteerRow> {
    self
      .slice
      .local_index(pattern)
      .and_then(|index| self.rows.get(index))
  }

  fn add_sequences(&mut self, term: &str, label: &str) {
    let core = self.strip_legal_form(term);
    let Some((words, gaps)) = split_term(core) else {
      return;
    };
    let reorderable = label == PERSON_LABEL
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
      self.sequences.insert(&reordered, reordered_gaps, label);
    }
    self.sequences.insert(&words, gaps, label);
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
        });
      }
    }
    exact.retain(|hit| !guard.in_identifier(hit.start, hit.end));
    let exact_spans = SpanIndex::new(&exact);

    let mut fuzzy = Vec::new();
    for found in matches {
      let Some(GazetteerRow {
        label,
        kind:
          RowKind::Fuzzy {
            folded,
            max_distance,
          },
      }) = self.row(found.pattern())
      else {
        continue;
      };
      let (start, end) = trim_fuzzy_span(text, byte_span(text, found)?);
      if exact_spans.overlaps(start, end) || guard.in_identifier(start, end) {
        continue;
      }
      let surface = text.get(start..end).unwrap_or_default();
      if guard.fuzzy_span_is_whole_words(start, end)
        && edit_distance(&fold_word_chars(surface), folded) <= *max_distance
      {
        fuzzy.push(Hit {
          start,
          end,
          label,
          score: FUZZY_SCORE,
        });
        continue;
      }
      // The engine keeps one non-overlapping window per region across all
      // fuzzy patterns, so a rejected window may hide another entry's match
      // on the tokens around or inside it (`WintermteX`, `s Novakova` for
      // `Novakova`). Re-check those token-aligned spans against the fuzzy
      // entries of a similar length.
      for span in fallback_spans(text, start, end) {
        if !exact_spans.overlaps(span.0, span.1)
          && guard.fuzzy_span_is_whole_words(span.0, span.1)
          && !guard.in_identifier(span.0, span.1)
        {
          self.push_fuzzy_rows(text, span, &mut fuzzy);
        }
      }
    }

    let mut seen = HashSet::new();
    let mut entities =
      Vec::with_capacity(exact.len().saturating_add(fuzzy.len()));
    for hit in exact.into_iter().chain(fuzzy) {
      let legal_form_end = self.legal_form_end(text, hit.end);
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
      entities.push(entity);
    }
    Ok(entities)
  }

  /// Fuzzy entries within their edit distance of `text[start..end]`.
  /// Entries more than the largest distance longer or shorter are skipped by
  /// the length index.
  fn push_fuzzy_rows<'a>(
    &'a self,
    text: &str,
    (start, end): (usize, usize),
    hits: &mut Vec<Hit<'a>>,
  ) {
    let folded = fold_word_chars(text.get(start..end).unwrap_or_default());
    let lengths = folded.len().saturating_sub(MAX_FUZZY_DISTANCE)
      ..=folded.len().saturating_add(MAX_FUZZY_DISTANCE);
    for row in self
      .fuzzy_by_letters
      .range(lengths)
      .flat_map(|(_, rows)| rows)
      .filter_map(|row| self.rows.get(*row))
    {
      let RowKind::Fuzzy {
        folded: entry,
        max_distance,
      } = &row.kind
      else {
        continue;
      };
      if edit_distance(&folded, entry) <= *max_distance {
        hits.push(Hit {
          start,
          end,
          label: &row.label,
          score: FUZZY_SCORE,
        });
      }
    }
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

  fn insert(&mut self, words: &[String], gaps: Vec<GapRule>, label: &str) {
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
    if let Some(end) = self.nodes.get_mut(node)
      && !end.labels.iter().any(|known| known == label)
    {
      end.labels.push(label.to_owned());
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
    for label in &current.labels {
      hits.push(Hit {
        start: walk.start,
        end,
        label,
        score: EXACT_SCORE,
      });
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
/// checks overlap in logarithmic time.
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

  fn overlaps(&self, start: usize, end: usize) -> bool {
    let opened_before_end = self.starts.partition_point(|open| *open < end);
    opened_before_end
      .checked_sub(1)
      .and_then(|last| self.max_ends.get(last))
      .is_some_and(|max_end| *max_end > start)
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

/// Splits an entry into words and the separators between them. Entries in
/// scripts written without spaces, and entries whose edges are punctuation
/// (`C++`, `@alice`, `.NET`), stay on the literal path only: dropping that
/// punctuation would let the bare word match.
fn split_term(term: &str) -> Option<(Vec<String>, Vec<GapRule>)> {
  let trimmed = term.trim();
  let significant_edge =
    |edge: Option<char>| edge.is_some_and(|ch| !is_word_char(ch));
  if trimmed.chars().any(is_unspaced_script)
    || significant_edge(trimmed.chars().next())
    || significant_edge(trimmed.chars().next_back())
  {
    return None;
  }
  let mut words = Vec::new();
  let mut gaps = Vec::new();
  let mut word = String::new();
  let mut gap = String::new();
  for ch in term.chars() {
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
  Some((words, gaps))
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

/// Word characters for token boundaries. Scripts written without spaces never
/// form tokens, so a name inside them keeps matching as a substring.
fn is_word_char(ch: char) -> bool {
  !is_unspaced_script(ch) && (ch.is_alphanumeric() || is_combining_mark(ch))
}

fn is_unspaced_script(ch: char) -> bool {
  matches!(u32::from(ch),
    0x0E00..=0x0EFF // Thai, Lao
    | 0x1000..=0x109F // Myanmar
    | 0x1780..=0x17FF // Khmer
    | 0x3040..=0x30FF // Hiragana, Katakana
    | 0x3400..=0x4DBF // CJK Extension A
    | 0x4E00..=0x9FFF // CJK Unified Ideographs
    | 0xAC00..=0xD7AF // Hangul Syllables
    | 0xF900..=0xFAFF // CJK Compatibility
    | 0x20000..=0x323AF // CJK Extensions B-I
  )
}

const fn is_line_break(ch: char) -> bool {
  matches!(ch, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

const fn is_horizontal_space(ch: char) -> bool {
  ch.is_whitespace() && !is_line_break(ch)
}

const fn canonical_punctuation(ch: char) -> char {
  match ch {
    '\u{2019}' | '\u{02bc}' | '`' => '\'',
    '\u{2010}' | '\u{2011}' | '\u{2013}' => '-',
    other => other,
  }
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
        out.push(match lower {
          'ł' => 'l',
          'đ' => 'd',
          'ø' => 'o',
          other => other,
        });
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

/// The span widened to the whole tokens it cuts into, when that adds at most
/// [`MAX_FUZZY_PATTERN_CHARS`] characters on each side: no fuzzy entry is
/// longer, and the bound keeps a huge token from being rescanned per window.
fn token_aligned(
  text: &str,
  start: usize,
  end: usize,
) -> Option<(usize, usize)> {
  let head = text.get(..start)?;
  let tail = text.get(end..)?;
  let before = head
    .chars()
    .rev()
    .take(MAX_FUZZY_PATTERN_CHARS.saturating_add(1))
    .take_while(|ch| is_word_char(*ch))
    .collect::<Vec<_>>();
  let after = tail
    .chars()
    .take(MAX_FUZZY_PATTERN_CHARS.saturating_add(1))
    .take_while(|ch| is_word_char(*ch))
    .collect::<Vec<_>>();
  if before.len() > MAX_FUZZY_PATTERN_CHARS
    || after.len() > MAX_FUZZY_PATTERN_CHARS
  {
    return None;
  }
  let grown_start =
    start.saturating_sub(before.iter().map(|ch| ch.len_utf8()).sum::<usize>());
  let grown_end =
    end.saturating_add(after.iter().map(|ch| ch.len_utf8()).sum::<usize>());
  Some((grown_start, grown_end))
}

/// Token-aligned spans near a rejected fuzzy window: each edge either widened
/// to the whole token it cuts into or narrowed to the nearest token boundary
/// inside the window. At most four spans, each found within the window plus
/// [`MAX_FUZZY_PATTERN_CHARS`] on either side.
fn fallback_spans(text: &str, start: usize, end: usize) -> Vec<(usize, usize)> {
  let window = text.get(start..end).unwrap_or_default();
  let (outer_start, outer_end) =
    token_aligned(text, start, end).unwrap_or((start, end));
  // First token start after `start` that lies inside the window.
  let inner_start = window
    .char_indices()
    .skip_while(|(_, ch)| is_word_char(*ch))
    .find(|(_, ch)| is_word_char(*ch))
    .map(|(offset, _)| start.saturating_add(offset));
  // Last token end before `end` that lies inside the window.
  let inner_end = window
    .char_indices()
    .rev()
    .skip_while(|(_, ch)| is_word_char(*ch))
    .find(|(_, ch)| is_word_char(*ch))
    .map(|(offset, ch)| {
      start.saturating_add(offset).saturating_add(ch.len_utf8())
    });
  let starts = [Some(outer_start), inner_start];
  let ends = [Some(outer_end), inner_end];
  let mut spans = Vec::with_capacity(4);
  for span_start in starts.into_iter().flatten() {
    for span_end in ends.into_iter().flatten() {
      if span_start < span_end && !spans.contains(&(span_start, span_end)) {
        spans.push((span_start, span_end));
      }
    }
  }
  spans
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
  /// Outermost balanced `⟦…⟧` markers, sorted and disjoint.
  markers: Vec<(usize, usize)>,
  /// Characters the scans have looked at, for scaling tests.
  visits: Cell<usize>,
}

impl<'t> Guard<'t> {
  fn new(text: &'t str) -> Self {
    Self {
      text,
      markers: markers(text),
      visits: Cell::new(0),
    }
  }

  fn visit<I: Iterator<Item = char>>(
    &self,
    chars: I,
  ) -> impl Iterator<Item = char> {
    chars.inspect(|_| self.visits.set(self.visits.get().saturating_add(1)))
  }

  /// Whether the span's edges sit on token boundaries. Digits glued to a
  /// letter edge are allowed (`Acme2024`, `novak2`); letters, or digit runs
  /// mixed with letters (`acme0a1b`), are not.
  fn edges_are_free(&self, start: usize, end: usize) -> bool {
    let head = self.text.get(..start).unwrap_or_default();
    let tail = self.text.get(end..).unwrap_or_default();
    let span = self.text.get(start..end).unwrap_or_default();
    glue_is_free(
      self
        .visit(head.chars().rev())
        .take_while(|ch| is_word_char(*ch)),
      span.chars().next(),
    ) && glue_is_free(
      self.visit(tail.chars()).take_while(|ch| is_word_char(*ch)),
      span.chars().next_back(),
    )
  }

  /// Fuzzy windows are rejected, not grown, when they cut into a token.
  fn fuzzy_span_is_whole_words(&self, start: usize, end: usize) -> bool {
    next_char(self.text, start).is_some_and(is_word_char)
      && previous_char(self.text, end).is_some_and(|ch| !ch.is_whitespace())
      && self.edges_are_free(start, end)
  }

  /// Whether the span belongs to an identifier: it sits inside a `⟦…⟧`
  /// marker, or a compound joiner links it to an identifier-shaped segment
  /// (`9b1d0c3e-acfe-4c1b`). Plain numbers, years, and words next to a name
  /// (`Acme/2024`, `Novák-1`, `acme.cz`) do not count.
  fn in_identifier(&self, start: usize, end: usize) -> bool {
    let head = self.text.get(..start).unwrap_or_default();
    let tail = self.text.get(end..).unwrap_or_default();
    self.in_marker(start, end)
      || joined_segment(
        self
          .visit(head.chars().rev())
          .skip_while(|ch| is_word_char(*ch)),
      )
      .is_some_and(|segment| is_identifier_segment(&segment))
      || joined_segment(
        self.visit(tail.chars()).skip_while(|ch| is_word_char(*ch)),
      )
      .is_some_and(|segment| is_identifier_segment(&segment))
  }

  /// Whether a balanced `⟦…⟧` marker encloses the span: one binary search
  /// over the indexed markers.
  fn in_marker(&self, start: usize, end: usize) -> bool {
    let opened_before = self.markers.partition_point(|(open, _)| *open < start);
    opened_before
      .checked_sub(1)
      .and_then(|index| self.markers.get(index))
      .is_some_and(|(_, close)| *close >= end)
  }
}

/// Outermost balanced `⟦…⟧` markers as `(open, close)` byte offsets, in one
/// pass. Markers never contain whitespace, so whitespace drops any bracket
/// still open; a `⟧` without an open `⟦` is ignored.
fn markers(text: &str) -> Vec<(usize, usize)> {
  let mut markers = Vec::new();
  if !text.contains('⟦') {
    return markers;
  }
  let mut open = Vec::new();
  for (index, ch) in text.char_indices() {
    match ch {
      '⟦' => open.push(index),
      '⟧' => {
        if let Some(start) = open.pop()
          && open.is_empty()
        {
          markers.push((start, index));
        }
      }
      _ if ch.is_whitespace() => open.clear(),
      _ => {}
    }
  }
  markers
}

fn glue_is_free(
  mut glue: impl Iterator<Item = char>,
  edge: Option<char>,
) -> bool {
  let Some(first) = glue.next() else {
    return true;
  };
  // A span ending in punctuation (`Inc.`) does not cut into the next token.
  if !edge.is_some_and(is_word_char) {
    return true;
  }
  edge.is_some_and(char::is_alphabetic)
    && first.is_numeric()
    && glue.all(char::is_numeric)
}

/// The word run behind one or more compound joiners at the start of `chars`.
/// The run comes back reversed when `chars` walks backwards; the shape test
/// does not depend on order.
fn joined_segment(chars: impl Iterator<Item = char>) -> Option<String> {
  let mut chars = chars.peekable();
  let mut joined = false;
  while chars.next_if(|ch| COMPOUND_JOINERS.contains(ch)).is_some() {
    joined = true;
  }
  let segment = chars.take_while(|ch| is_word_char(*ch)).collect::<String>();
  (joined && !segment.is_empty()).then_some(segment)
}

/// Hex with both digits and hex letters (`4c1b`, `9b1d0c3e`), or a long
/// mixed-case alphanumeric run (`QWNtZUEvb3Ji`).
fn is_identifier_segment(segment: &str) -> bool {
  let chars = segment.chars().count();
  let has_digit = segment.chars().any(|ch| ch.is_ascii_digit());
  let hex = chars >= MIN_HEX_SEGMENT_CHARS
    && has_digit
    && segment.chars().all(|ch| ch.is_ascii_hexdigit())
    && segment.chars().any(|ch| ch.is_ascii_alphabetic());
  let base64 = chars >= MIN_BASE64_SEGMENT_CHARS
    && has_digit
    && segment.chars().any(char::is_uppercase)
    && segment.chars().any(char::is_lowercase);
  hex || base64
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
mod tests {
  #![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

  use proptest::prelude::*;
  use proptest::test_runner::RngSeed;

  use super::*;

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
    };
    (
      PreparedGazetteerMatchData::new(data, slice, &patterns).unwrap(),
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

  #[test]
  fn edge_punctuation_stays_part_of_the_entry() {
    let entries = [exact("C++", ORGANIZATION), exact("@alice", PERSON)];
    assert!(found(&entries, "Plan C and alice agreed.").is_empty());
    assert_eq!(found(&entries, "Use C++ today."), ["C++"]);
    assert_eq!(found(&entries, "Ping @alice today."), ["@alice"]);
  }

  #[test]
  fn automatic_fuzzy_distance_follows_the_length_scale() {
    let data = GazetteerMatchData {
      labels: vec![PERSON.to_owned(), PERSON.to_owned()],
      is_fuzzy: vec![true, true],
      legal_form_suffixes: Vec::new(),
      inflection: GazetteerInflection::CzechSlovak,
    };
    let patterns = ["Wintermute", "Acme"].map(|term| SearchPattern::Fuzzy {
      pattern: term.to_owned(),
      distance: None,
    });
    let prepared = PreparedGazetteerMatchData::new(
      data,
      PatternSlice { start: 0, end: 2 },
      &patterns,
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
        guard.visits.get() <= MAX_VISITS,
        "{} chars visited for {TEXT_CHARS} chars",
        guard.visits.get()
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
  fn names_in_unspaced_scripts_keep_matching_as_substrings() {
    assert_eq!(found(&[exact("東京", ORGANIZATION)], "東京都に"), ["東京"]);
  }

  #[test]
  fn row_kinds_must_match_their_patterns() {
    let data = GazetteerMatchData {
      labels: vec![ORGANIZATION.to_owned()],
      is_fuzzy: vec![false],
      legal_form_suffixes: Vec::new(),
      inflection: GazetteerInflection::CzechSlovak,
    };
    let fuzzy = [SearchPattern::Fuzzy {
      pattern: "Acme".to_owned(),
      distance: Some(1),
    }];
    let slice = PatternSlice { start: 0, end: 1 };
    assert!(
      PreparedGazetteerMatchData::new(data.clone(), slice, &fuzzy).is_err()
    );
    assert!(PreparedGazetteerMatchData::new(data, slice, &[]).is_err());
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
        })
        .collect::<Vec<_>>();
      let start = query_start;
      let end = query_start.saturating_add(query_len);
      let linear = hits.iter().any(|hit| start < hit.end && end > hit.start);
      prop_assert_eq!(SpanIndex::new(&hits).overlaps(start, end), linear);
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
