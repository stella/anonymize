use std::borrow::Cow;
use std::collections::{HashMap, HashSet};

use crate::byte_offsets::ByteOffsets;
use crate::processors::PatternSlice;
use crate::resolution::{DetectionSource, PipelineEntity};
use crate::types::{Result, SearchMatch};

const LEGAL_FORM_SCORE: f64 = 0.95;
const HEAD_TOKEN_CAP: usize = 20;
const MAX_LOWER_BRIDGE: usize = 4;
const MAX_NAME_LOOKBACK: usize = 32;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct LegalFormData {
  pub suffixes: Vec<String>,
  pub normalized_boundary_suffixes: Vec<String>,
  pub normalized_in_name_words: Vec<String>,
  pub normalized_suffix_words: Vec<String>,
  pub role_heads: Vec<String>,
  pub sentence_verb_indicators: Vec<String>,
  pub clause_noun_heads: Vec<String>,
  pub connector_prose_heads: Vec<String>,
  pub structural_single_cap_prefixes: Vec<String>,
  pub leading_clause_phrases: Vec<String>,
  pub leading_clause_direct_prefixes: Vec<String>,
  pub connector_words: Vec<String>,
  pub and_connector_words: Vec<String>,
  pub in_name_prepositions: Vec<String>,
  pub company_suffix_words: Vec<String>,
  pub comma_gated_direct_prefixes: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct PreparedLegalFormData {
  suffixes: Vec<String>,
  list_suffix_indices: Vec<usize>,
  suffix_indices_by_last_char: HashMap<char, Vec<usize>>,
  normalized_boundary_suffixes: HashSet<String>,
  normalized_in_name_words: HashSet<String>,
  normalized_suffix_words: HashSet<String>,
  role_heads: HashSet<String>,
  sentence_verb_indicators: HashSet<String>,
  clause_noun_heads: HashSet<String>,
  connector_prose_heads: HashSet<String>,
  structural_single_cap_prefixes: HashSet<String>,
  leading_clause_phrases: Vec<String>,
  leading_clause_direct_prefixes: Vec<String>,
  connector_words: HashSet<String>,
  and_connector_words: HashSet<String>,
  in_name_prepositions: HashSet<String>,
  company_suffix_words: HashSet<String>,
  comma_gated_direct_prefixes: HashSet<String>,
}

impl PreparedLegalFormData {
  pub(crate) fn new(data: LegalFormData) -> Self {
    let LegalFormData {
      suffixes,
      normalized_boundary_suffixes,
      normalized_in_name_words,
      normalized_suffix_words,
      role_heads,
      sentence_verb_indicators,
      clause_noun_heads,
      connector_prose_heads,
      structural_single_cap_prefixes,
      leading_clause_phrases,
      leading_clause_direct_prefixes,
      connector_words,
      and_connector_words,
      in_name_prepositions,
      company_suffix_words,
      comma_gated_direct_prefixes,
    } = data;
    let list_suffix_indices = list_suffix_indices(&suffixes);
    let suffix_indices_by_last_char = suffix_indices_by_last_char(&suffixes);

    Self {
      suffixes,
      list_suffix_indices,
      suffix_indices_by_last_char,
      normalized_boundary_suffixes: lower_set(normalized_boundary_suffixes),
      normalized_in_name_words: lower_set(normalized_in_name_words),
      normalized_suffix_words: lower_set(normalized_suffix_words),
      role_heads: lower_set(role_heads),
      sentence_verb_indicators: lower_set(sentence_verb_indicators),
      clause_noun_heads: lower_set(clause_noun_heads),
      connector_prose_heads: lower_set(connector_prose_heads),
      structural_single_cap_prefixes: lower_set(structural_single_cap_prefixes),
      leading_clause_phrases: lower_vec(leading_clause_phrases),
      leading_clause_direct_prefixes: lower_vec(leading_clause_direct_prefixes),
      connector_words: lower_set(connector_words),
      and_connector_words: lower_set(and_connector_words),
      in_name_prepositions: lower_set(in_name_prepositions),
      company_suffix_words: lower_set(company_suffix_words),
      comma_gated_direct_prefixes: lower_set(comma_gated_direct_prefixes),
    }
  }
}

fn list_suffix_indices(suffixes: &[String]) -> Vec<usize> {
  suffixes
    .iter()
    .enumerate()
    .filter_map(|(index, suffix)| {
      (!is_roman_legal_suffix(suffix)).then_some(index)
    })
    .collect()
}

fn suffix_indices_by_last_char(
  suffixes: &[String],
) -> HashMap<char, Vec<usize>> {
  let mut by_char = HashMap::<char, Vec<usize>>::new();
  for (index, suffix) in suffixes.iter().enumerate() {
    let Some(last) = suffix.chars().next_back() else {
      continue;
    };
    by_char.entry(last).or_default().push(index);
  }
  by_char
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct Candidate {
  start: usize,
  suffix_start: usize,
  end: usize,
  trimmed: bool,
}

pub(crate) fn process_legal_form_matches(
  matches: &[SearchMatch],
  slice: PatternSlice,
  full_text: &str,
  data: &PreparedLegalFormData,
) -> Result<Vec<PipelineEntity>> {
  if data.suffixes.is_empty() {
    return Ok(Vec::new());
  }

  let offsets = ByteOffsets::new(full_text);
  let mut candidates = Vec::new();
  for found in matches {
    if slice.local_index(found.pattern()).is_none() {
      continue;
    }

    let suffix_start = offsets.validate_offset(found.start())?;
    let suffix_end = offsets.validate_offset(found.end())?;
    let effective_suffix_start =
      effective_line_wrapped_suffix_start(full_text, suffix_start);
    if !is_leading_separator(full_text, suffix_start)
      || !is_trailing_boundary(full_text, suffix_end)
    {
      continue;
    }

    let Some(walker_start) =
      walk_backward(full_text, effective_suffix_start, data)
    else {
      continue;
    };
    if walker_start >= effective_suffix_start {
      continue;
    }

    // Narrow to the org name before the sentence check. The walker bridges
    // lowercase words (up to MAX_LOWER_BRIDGE) and can reach back over a verb
    // clause into a prior sentence ("Initech term sheet. This deed is made by
    // Initech Corporation"). trim_to_first_cap_after_verb drops that prose, so
    // the sentence-boundary guard must run on the trimmed span or it rejects a
    // candidate that would have trimmed cleanly to a single-sentence org.
    let candidate_start = trim_to_first_cap_after_verb(
      full_text,
      walker_start,
      effective_suffix_start,
      data,
    );
    if candidate_start >= effective_suffix_start {
      continue;
    }
    // A sentence break inside the candidate ("Acme Inc. Beta LLC") no longer
    // drops the whole thing: re-clip to just after the break and re-validate
    // the trimmed remainder so the later org ("Beta LLC") still gets emitted.
    let Some(clipped_start) = clip_past_sentence_breaks(
      full_text,
      candidate_start,
      effective_suffix_start,
    ) else {
      continue;
    };
    // The clipped remainder can open with lowercase bridge prose that was
    // only reachable because the backward walk had seen a capitalized token
    // before the break ("Acme Inc. the supplier Beta LLC"): re-anchor it at
    // the first token that can start an org name, exactly like the walk
    // would have if it had started inside this sentence.
    let candidate_start = if clipped_start == candidate_start {
      candidate_start
    } else {
      trim_to_first_name_token(
        full_text,
        clipped_start,
        effective_suffix_start,
        data,
      )
    };
    if candidate_start >= effective_suffix_start {
      continue;
    }

    candidates.push(Candidate {
      start: candidate_start,
      suffix_start: effective_suffix_start,
      end: suffix_end,
      trimmed: candidate_start != walker_start,
    });
  }

  let candidates = drop_overlapping(candidates);
  let mut entities = Vec::new();
  for candidate in candidates {
    process_candidate(&mut entities, full_text, &candidate, data);
  }

  Ok(entities)
}

fn effective_line_wrapped_suffix_start(
  text: &str,
  suffix_start: usize,
) -> usize {
  let mut scan = suffix_start;
  while let Some((prev_start, ch)) = previous_char(text, scan) {
    if matches!(ch, ' ' | '\t') {
      scan = prev_start;
      continue;
    }
    break;
  }

  let Some((newline_start, '\n')) = previous_char(text, scan) else {
    return suffix_start;
  };
  let mut before = newline_start;
  while let Some((prev_start, ch)) = previous_char(text, before) {
    if ch == ' ' {
      before = prev_start;
      continue;
    }
    return if ch == '.' { before } else { suffix_start };
  }

  suffix_start
}

fn is_trailing_boundary(text: &str, end: usize) -> bool {
  text
    .get(end..)
    .and_then(|suffix| suffix.chars().next())
    .is_none_or(|ch| !ch.is_alphanumeric())
}

fn is_leading_separator(text: &str, suffix_start: usize) -> bool {
  let Some((prev_start, prev)) = previous_char(text, suffix_start) else {
    return true;
  };
  if prev.is_alphanumeric() {
    return false;
  }
  if prev != '.' {
    return true;
  }
  previous_char(text, prev_start).is_none_or(|(_, ch)| !ch.is_alphabetic())
}

fn walk_backward(
  text: &str,
  suffix_start: usize,
  data: &PreparedLegalFormData,
) -> Option<usize> {
  let mut pos = suffix_start;
  let mut steps = 0;
  let mut leftmost_cap = None::<usize>;
  let mut lower_bridge_run = 0_usize;

  while steps < HEAD_TOKEN_CAP {
    let Some(token) = token_before(text, pos) else {
      break;
    };
    if !is_acceptable_token(token.text, data) {
      break;
    }

    if starts_lower(token.text) && leftmost_cap.is_some() {
      let after_token = text.get(token.end..pos).unwrap_or_default();
      if starts_with_list_separator(after_token)
        && is_legal_form_suffix_word(token.text, data)
      {
        break;
      }
    }

    if contains_lowercase(&data.connector_words, token.text) {
      let previous = token_before(text, token.start);
      if previous
        .as_ref()
        .is_some_and(|found| is_legal_form_suffix_word(found.text, data))
      {
        break;
      }
      if data
        .and_connector_words
        .contains(lowercase_lookup(token.text).as_ref())
      {
        let upper_before = count_upper_before(text, token.start);
        if upper_before <= 2 || has_middle_initial_before(text, token.start) {
          break;
        }
      }
    }

    if starts_upper(token.text) {
      leftmost_cap = Some(token.start);
      lower_bridge_run = 0;
    } else if starts_lower(token.text) {
      if leftmost_cap.is_some() {
        lower_bridge_run = lower_bridge_run.saturating_add(1);
        if lower_bridge_run > MAX_LOWER_BRIDGE {
          break;
        }
      }
    } else {
      lower_bridge_run = 0;
    }

    pos = token.start;
    steps = steps.saturating_add(1);
  }

  leftmost_cap
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct Token<'a> {
  start: usize,
  end: usize,
  text: &'a str,
}

fn token_before(text: &str, pos: usize) -> Option<Token<'_>> {
  let mut end = pos;
  while let Some((prev_start, ch)) = previous_char(text, end) {
    if ch == '\n' {
      return None;
    }
    if is_inter_token_space(ch) || matches!(ch, ',' | ';') {
      end = prev_start;
      continue;
    }
    break;
  }
  if end == 0 {
    return None;
  }

  let mut start = end;
  while let Some((prev_start, ch)) = previous_char(text, start) {
    if ch == '\n' || !is_token_char(ch) {
      break;
    }
    start = prev_start;
  }

  (start < end).then(|| Token {
    start,
    end,
    text: text.get(start..end).unwrap_or_default(),
  })
}

const fn is_inter_token_space(ch: char) -> bool {
  matches!(ch, ' ' | '\t' | '\u{00a0}' | '\u{202f}')
}

fn is_token_char(ch: char) -> bool {
  ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '.' | '&' | '-')
}

fn is_acceptable_token(token: &str, data: &PreparedLegalFormData) -> bool {
  token.chars().next().is_some_and(|ch| {
    ch.is_uppercase() || ch.is_lowercase() || ch.is_ascii_digit()
  }) || contains_lowercase(&data.connector_words, token)
}

fn starts_upper(text: &str) -> bool {
  text.chars().next().is_some_and(char::is_uppercase)
}

fn starts_lower(text: &str) -> bool {
  text.chars().next().is_some_and(char::is_lowercase)
}

fn starts_with_list_separator(text: &str) -> bool {
  text
    .chars()
    .next()
    .is_some_and(|ch| matches!(ch, ',' | ';'))
}

fn normalize_suffix_token(text: &str) -> Cow<'_, str> {
  if !text
    .chars()
    .any(|ch| is_suffix_ignored_char(ch) || ch.is_uppercase())
  {
    return Cow::Borrowed(text);
  }

  let mut normalized = String::with_capacity(text.len());
  for ch in text.chars() {
    if is_suffix_ignored_char(ch) {
      continue;
    }
    normalized.extend(ch.to_lowercase());
  }
  Cow::Owned(normalized)
}

const fn is_suffix_ignored_char(ch: char) -> bool {
  matches!(ch, '.' | ',' | ' ' | '\t' | '\u{00a0}' | '\u{202f}')
}

fn is_legal_form_suffix_word(word: &str, data: &PreparedLegalFormData) -> bool {
  let normalized = normalize_suffix_token(word);
  !normalized.is_empty()
    && data.normalized_suffix_words.contains(normalized.as_ref())
}

fn is_known_boundary_suffix(word: &str, data: &PreparedLegalFormData) -> bool {
  let normalized = normalize_suffix_token(word);
  !normalized.is_empty()
    && data
      .normalized_boundary_suffixes
      .contains(normalized.as_ref())
}

fn is_in_name_legal_form_word(
  word: &str,
  data: &PreparedLegalFormData,
) -> bool {
  let normalized = normalize_suffix_token(word);
  !normalized.is_empty()
    && data.normalized_in_name_words.contains(normalized.as_ref())
}

fn count_upper_before(text: &str, pos: usize) -> usize {
  let mut scan = pos;
  let mut count = 0_usize;
  while let Some(token) = token_before(text, scan) {
    if !starts_upper(token.text) {
      break;
    }
    count = count.saturating_add(1);
    scan = token.start;
  }
  count
}

fn has_middle_initial_before(text: &str, pos: usize) -> bool {
  let start = pos.saturating_sub(MAX_NAME_LOOKBACK);
  let Some(slice) = text.get(start..pos) else {
    return false;
  };
  let trimmed = slice.trim_end_matches(is_inter_token_space);
  let Some(last_word) = trailing_word(trimmed) else {
    return false;
  };
  let before_word = trimmed.get(..last_word.start).unwrap_or_default();
  let before_word = before_word.trim_end_matches(is_inter_token_space);
  let Some((dot_start, '.')) = previous_char(before_word, before_word.len())
  else {
    return false;
  };
  previous_char(before_word, dot_start).is_some_and(|(_, ch)| ch.is_uppercase())
}

fn trailing_word(text: &str) -> Option<Token<'_>> {
  let mut end = text.len();
  while let Some((prev_start, ch)) = previous_char(text, end) {
    if ch.is_alphabetic() || matches!(ch, '\'' | '’') {
      break;
    }
    end = prev_start;
  }
  let mut start = end;
  while let Some((prev_start, ch)) = previous_char(text, start) {
    if !(ch.is_alphabetic() || matches!(ch, '\'' | '’')) {
      break;
    }
    start = prev_start;
  }
  (start < end).then(|| Token {
    start,
    end,
    text: text.get(start..end).unwrap_or_default(),
  })
}

/// Scans `text[start..suffix_start]` for a sentence-ending `. ` boundary and,
/// if one is found, returns the byte offset immediately after it (the start
/// of the next word). `None` means the whole span reads as a single
/// sentence.
fn crosses_sentence_end(
  text: &str,
  start: usize,
  suffix_start: usize,
) -> Option<usize> {
  let slice = text.get(start..suffix_start)?;
  let mut previous = None::<char>;
  let mut lowercase_run = 0_usize;
  let mut uppercase_run = 0_usize;

  for (offset, ch) in slice.char_indices() {
    if ch.is_uppercase() {
      // An interior dot delimits a word, so a capital right after one starts
      // a fresh run. This keeps compact initials ("J.P.") from looking like a
      // two-letter acronym followed by a sentence break, while a real acronym
      // ("INC.") still accumulates its run before the trailing period. The
      // lowercase branch below already gates on the previous char, so only the
      // uppercase run needs this guard.
      uppercase_run = if previous == Some('.') {
        1
      } else {
        uppercase_run.saturating_add(1)
      };
      lowercase_run = 0;
      previous = Some(ch);
      continue;
    }
    if ch.is_lowercase() {
      if previous.is_some_and(char::is_uppercase) || lowercase_run > 0 {
        lowercase_run = lowercase_run.saturating_add(1);
      }
      uppercase_run = 0;
      previous = Some(ch);
      continue;
    }
    if ch == '.' {
      previous = Some(ch);
      continue;
    }
    if ch.is_whitespace() && previous == Some('.') {
      if lowercase_run >= 2 || uppercase_run >= 2 {
        return Some(
          start.saturating_add(offset).saturating_add(ch.len_utf8()),
        );
      }
      lowercase_run = 0;
      uppercase_run = 0;
    }
    previous = Some(ch);
  }

  None
}

/// Re-clips `candidate_start` past every sentence break found before
/// `suffix_start`, re-validating the trimmed remainder each time, instead of
/// discarding the whole candidate the way a single `crosses_sentence_end`
/// check used to. For "Acme Inc. Beta LLC", this narrows the `LLC` candidate
/// from "Acme Inc. Beta " down to "Beta " rather than dropping it outright,
/// so the later org is still emitted. Returns `None` only when no text is
/// left before `suffix_start` once every break has been clipped past.
fn clip_past_sentence_breaks(
  text: &str,
  start: usize,
  suffix_start: usize,
) -> Option<usize> {
  let mut candidate_start = start;
  while let Some(break_end) =
    crosses_sentence_end(text, candidate_start, suffix_start)
  {
    candidate_start = break_end;
    if candidate_start >= suffix_start {
      return None;
    }
  }
  Some(candidate_start)
}

/// Advances to the first token that can legitimately start an org name: an
/// uppercase-leading token that is not a role/clause head, or a
/// digit-leading token ("360 Ventures LLC", mirroring `trim_role_head`'s
/// digit acceptance). Used after clipping past a sentence break, where the
/// remainder may open with lowercase prose the backward walk only bridged
/// because of a capitalized token before the break. Returns `suffix_start`
/// (an empty candidate) when no such token exists.
fn trim_to_first_name_token(
  text: &str,
  start: usize,
  suffix_start: usize,
  data: &PreparedLegalFormData,
) -> usize {
  for token in word_tokens(text, start, suffix_start) {
    let starts_digit = token
      .text
      .chars()
      .next()
      .is_some_and(|ch| ch.is_ascii_digit());
    if !starts_upper(token.text) && !starts_digit {
      continue;
    }
    let lower = lowercase_lookup(token.text);
    if data.role_heads.contains(lower.as_ref())
      || data.clause_noun_heads.contains(lower.as_ref())
    {
      continue;
    }
    return token.start;
  }
  suffix_start
}

fn trim_to_first_cap_after_verb(
  text: &str,
  candidate_start: usize,
  suffix_start: usize,
  data: &PreparedLegalFormData,
) -> usize {
  if candidate_start >= suffix_start {
    return candidate_start;
  }
  let mut last_verb_end = None::<usize>;
  for token in word_tokens(text, candidate_start, suffix_start) {
    if starts_lower(token.text)
      && contains_lowercase(&data.sentence_verb_indicators, token.text)
    {
      last_verb_end = Some(token.end);
    }
  }

  let Some(scan_start) = last_verb_end else {
    return candidate_start;
  };
  for token in word_tokens(text, scan_start, suffix_start) {
    if !starts_upper(token.text) {
      continue;
    }
    let lower = lowercase_lookup(token.text);
    if data.role_heads.contains(lower.as_ref())
      || data.clause_noun_heads.contains(lower.as_ref())
    {
      continue;
    }
    return token.start;
  }

  suffix_start
}

const fn word_tokens(text: &str, start: usize, end: usize) -> WordTokens<'_> {
  WordTokens {
    text,
    end,
    cursor: start,
  }
}

struct WordTokens<'a> {
  text: &'a str,
  end: usize,
  cursor: usize,
}

impl<'a> Iterator for WordTokens<'a> {
  type Item = Token<'a>;

  fn next(&mut self) -> Option<Self::Item> {
    while self.cursor < self.end {
      let Some((ch_start, ch)) = next_char(self.text, self.cursor) else {
        self.cursor = self.end;
        return None;
      };
      if !is_word_token_char(ch) {
        self.cursor = ch_start.saturating_add(ch.len_utf8());
        continue;
      }

      let token_start = ch_start;
      let mut token_end = ch_start.saturating_add(ch.len_utf8());
      while token_end < self.end {
        let Some((next_start, next)) = next_char(self.text, token_end) else {
          break;
        };
        if !is_word_token_char(next) {
          break;
        }
        token_end = next_start.saturating_add(next.len_utf8());
      }
      self.cursor = token_end;
      let token_text = self.text.get(token_start..token_end)?;
      return Some(Token {
        start: token_start,
        end: token_end,
        text: token_text,
      });
    }
    None
  }
}

fn is_word_token_char(ch: char) -> bool {
  ch.is_alphanumeric() || matches!(ch, '\'' | '’' | '-')
}

fn drop_overlapping(candidates: Vec<Candidate>) -> Vec<Candidate> {
  let mut sorted = candidates;
  sorted.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| right.end.cmp(&left.end))
  });

  let mut out = Vec::<Candidate>::new();
  for candidate in sorted {
    if out.last().is_some_and(|last| {
      candidate.start >= last.start && candidate.end <= last.end
    }) {
      continue;
    }
    out.push(candidate);
  }
  out
}

fn process_candidate(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  candidate: &Candidate,
  data: &PreparedLegalFormData,
) {
  let Some(raw_text) = full_text.get(candidate.start..candidate.end) else {
    return;
  };
  let processed_end = candidate.start.saturating_add(trim_end_byte(raw_text));
  if processed_end <= candidate.start {
    return;
  }
  let Some(text) = full_text.get(candidate.start..processed_end) else {
    return;
  };
  if text.len() < 5 {
    return;
  }

  let mut processed_start = candidate.start;
  let mut processed_text = text;
  if is_structural_single_cap_match(processed_text, data)
    || is_bare_single_cap_structural_inner_match(
      full_text,
      candidate.start,
      processed_text,
      data,
    )
  {
    return;
  }

  let role_trimmed = if let Some(trimmed) = trim_role_head(
    full_text,
    processed_start,
    processed_text,
    candidate.suffix_start,
    data,
  ) {
    let Some(next_text) = full_text.get(trimmed.start..processed_end) else {
      return;
    };
    processed_start = trimmed.start;
    processed_text = next_text;
    true
  } else {
    false
  };

  if processed_text.contains('\n') && has_disallowed_line_break(processed_text)
  {
    return;
  }

  let (entity_start, entity_text) = candidate_entity_span(
    full_text,
    candidate,
    processed_start,
    processed_end,
    processed_text,
    role_trimmed,
    data,
  );
  emit_candidate_segments(
    results,
    candidate,
    text,
    entity_start,
    entity_text,
    data,
  );
}

fn candidate_entity_span<'a>(
  full_text: &'a str,
  candidate: &Candidate,
  processed_start: usize,
  processed_end: usize,
  processed_text: &'a str,
  role_trimmed: bool,
  data: &PreparedLegalFormData,
) -> (usize, &'a str) {
  if candidate.trimmed
    || role_trimmed
    || is_bare_single_cap_legal_form(processed_text)
  {
    return (processed_start, processed_text);
  }

  let extended = extend_backward(full_text, processed_start, data, false);
  if extended < processed_start
    && let Some(extended_text) = full_text.get(extended..processed_end)
  {
    return (extended, extended_text.trim_end());
  }

  (processed_start, processed_text)
}

fn emit_candidate_segments(
  results: &mut Vec<PipelineEntity>,
  candidate: &Candidate,
  original_text: &str,
  entity_start: usize,
  entity_text: &str,
  data: &PreparedLegalFormData,
) {
  for segment in split_embedded_legal_form_list(entity_start, entity_text, data)
  {
    let (mut segment_start, mut segment_text) =
      trim_embedded_legal_form_list_prefix(segment.start, segment.text, data);
    let leading = trim_leading_clause(segment_text, data);
    if leading.offset > 0
      && let Some(trimmed) = segment_text.get(leading.offset..)
    {
      segment_start = segment_start.saturating_add(leading.offset);
      segment_text = trimmed.trim_start();
      segment_start = segment_start.saturating_add(leading_ws_len(trimmed));
    }

    if segment_text.contains('\n') && has_disallowed_line_break(segment_text) {
      continue;
    }

    let mut emit_start = segment_start;
    let mut emit_text = segment_text;
    let prefix = prefix_info(emit_text);
    let all_caps_match =
      prefix.part.len() > 2 && prefix.part == prefix.part.to_uppercase();
    if all_caps_match {
      let word_count = if prefix.end > 0 {
        emit_text
          .get(..prefix.end)
          .unwrap_or_default()
          .split_whitespace()
          .count()
      } else {
        emit_text.split_whitespace().count()
      };
      if word_count > 3 {
        emit_start = candidate.start;
        emit_text = original_text;
      }
    }

    if has_roman_numeral_suffix(emit_text) {
      continue;
    }
    if short_ascii_suffix_collides_with_non_ascii_prefix(emit_text) {
      continue;
    }

    let end = emit_start.saturating_add(emit_text.len());
    results.push(PipelineEntity::detected(
      u32::try_from(emit_start).unwrap_or(u32::MAX),
      u32::try_from(end).unwrap_or(u32::MAX),
      "organization",
      emit_text,
      LEGAL_FORM_SCORE,
      DetectionSource::LegalForm,
    ));
  }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct TrimmedStart {
  start: usize,
}

fn trim_role_head(
  full_text: &str,
  match_start: usize,
  text: &str,
  suffix_start: usize,
  data: &PreparedLegalFormData,
) -> Option<TrimmedStart> {
  let first = first_role_word(text)?;
  let first_lower = lowercase_lookup(first.text);
  let first_leading = first.text.split('-').next().unwrap_or_default();
  let first_leading = lowercase_lookup(first_leading);
  if !data.role_heads.contains(first_lower.as_ref())
    && !data.role_heads.contains(first_leading.as_ref())
  {
    return None;
  }

  let suffix_offset = suffix_start.checked_sub(match_start)?;
  if suffix_offset >= text.len() {
    return None;
  }
  let mid_start = first.end;
  if mid_start >= suffix_offset {
    return None;
  }
  let mid = text.get(mid_start..suffix_offset).unwrap_or_default();
  let mut last_verb_end = None::<usize>;
  for token in word_tokens(text, mid_start, suffix_offset) {
    if data
      .sentence_verb_indicators
      .contains(lowercase_lookup(token.text).as_ref())
    {
      last_verb_end = Some(token.end);
    }
  }
  let digit_after_role = mid
    .trim_start()
    .chars()
    .next()
    .is_some_and(|ch| ch.is_ascii_digit());
  let appositive_role_head = !digit_after_role
    && last_verb_end.is_none()
    && preceding_word_is_sentence_verb(full_text, match_start, data);

  if last_verb_end.is_none() && !digit_after_role && !appositive_role_head {
    return None;
  }

  let scan_start = last_verb_end.unwrap_or(mid_start);
  for token in word_tokens(text, scan_start, suffix_offset) {
    // A digit-leading token ("360", "1") is a valid span start alongside an
    // uppercase-leading one: "Client 360 LLC" / "Vendor 1 LLC" put the
    // digit right after the role word with no later capitalized word to
    // recover on, so restricting the scan to starts_upper alone clipped the
    // whole name down to the bare suffix.
    let starts_digit = token
      .text
      .chars()
      .next()
      .is_some_and(|ch| ch.is_ascii_digit());
    if !starts_upper(token.text) && !starts_digit {
      continue;
    }
    let lower = lowercase_lookup(token.text);
    if data.role_heads.contains(lower.as_ref())
      || data.clause_noun_heads.contains(lower.as_ref())
    {
      continue;
    }
    return Some(TrimmedStart {
      start: match_start.saturating_add(token.start),
    });
  }

  Some(TrimmedStart {
    start: match_start.saturating_add(suffix_offset),
  })
}

fn first_role_word(text: &str) -> Option<Token<'_>> {
  let mut end = 0_usize;
  let mut saw = false;
  let mut previous_was_hyphen = false;
  while let Some((start, ch)) = next_char(text, end) {
    if ch.is_alphabetic() {
      saw = true;
      previous_was_hyphen = false;
      end = start.saturating_add(ch.len_utf8());
      continue;
    }
    if ch == '-' && saw {
      previous_was_hyphen = true;
      end = start.saturating_add(ch.len_utf8());
      continue;
    }
    if previous_was_hyphen {
      end = start.saturating_sub('-'.len_utf8());
    }
    break;
  }
  (saw && end > 0).then(|| Token {
    start: 0,
    end,
    text: text.get(..end).unwrap_or_default(),
  })
}

fn preceding_word_is_sentence_verb(
  full_text: &str,
  match_start: usize,
  data: &PreparedLegalFormData,
) -> bool {
  let window_start = match_start.saturating_sub(40);
  let Some(before) = full_text.get(window_start..match_start) else {
    return false;
  };
  trailing_word(before).is_some_and(|word| {
    data
      .sentence_verb_indicators
      .contains(lowercase_lookup(word.text).as_ref())
  })
}

fn is_structural_single_cap_match(
  text: &str,
  data: &PreparedLegalFormData,
) -> bool {
  let mut tokens = text.split_whitespace();
  let Some(first) = tokens.next() else {
    return false;
  };
  let Some(second) = tokens.next() else {
    return false;
  };
  data
    .structural_single_cap_prefixes
    .contains(lowercase_lookup(first).as_ref())
    && is_single_cap_token(second.trim_matches(','))
}

fn is_bare_single_cap_structural_inner_match(
  full_text: &str,
  match_start: usize,
  text: &str,
  data: &PreparedLegalFormData,
) -> bool {
  if !is_bare_single_cap_legal_form(text) {
    return false;
  }
  token_before(full_text, match_start).is_some_and(|token| {
    data
      .structural_single_cap_prefixes
      .contains(lowercase_lookup(token.text).as_ref())
  })
}

fn is_bare_single_cap_legal_form(text: &str) -> bool {
  let Some(first) = text.chars().next() else {
    return false;
  };
  if !first.is_uppercase() {
    return false;
  }
  let after_first = text.get(first.len_utf8()..).unwrap_or_default();
  after_first
    .chars()
    .next()
    .is_some_and(|ch| is_inter_token_space(ch) || ch == ',')
}

fn is_single_cap_token(text: &str) -> bool {
  let mut chars = text.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  first.is_uppercase() && chars.next().is_none()
}

fn has_disallowed_line_break(text: &str) -> bool {
  let mut search_start = 0_usize;
  while let Some(relative) =
    text.get(search_start..).and_then(|tail| tail.find('\n'))
  {
    let index = search_start.saturating_add(relative);
    let before = text.get(..index).unwrap_or_default();
    let after = text.get(index.saturating_add(1)..).unwrap_or_default();
    let dotted_designator_before =
      before.trim_end_matches(is_inter_token_space).ends_with('.');
    let after_trimmed = after.trim_matches(is_inter_token_space);
    let legal_suffix_after = is_dotted_upper_suffix(after_trimmed);
    let all_caps_suffix_after = after_trimmed
      .trim_end_matches('.')
      .chars()
      .all(char::is_uppercase)
      && after_trimmed.chars().any(char::is_uppercase);
    if !dotted_designator_before
      || (!legal_suffix_after && !all_caps_suffix_after)
    {
      return true;
    }
    search_start = index.saturating_add(1);
  }
  false
}

fn is_dotted_upper_suffix(text: &str) -> bool {
  let mut saw_upper = false;
  for part in text.split('.') {
    if part.is_empty() {
      continue;
    }
    if !part.chars().all(char::is_uppercase) {
      return false;
    }
    saw_upper = true;
  }
  saw_upper
}

fn extend_backward(
  full_text: &str,
  match_start: usize,
  data: &PreparedLegalFormData,
  force_suffix_mode: bool,
) -> usize {
  let head_word = leading_entity_word(full_text, match_start);
  let suffix_mode = force_suffix_mode
    || head_word
      .as_ref()
      .is_some_and(|word| contains_lowercase(&data.company_suffix_words, word));
  let mut pos = match_start;

  while let Some(found) = simple_word_before(full_text, pos) {
    let word = found.text;
    let lower = lowercase_lookup(word);
    let is_upper = starts_upper(word);
    let is_connector = data.connector_words.contains(lower.as_ref());
    let is_in_name_prep =
      suffix_mode && data.in_name_prepositions.contains(lower.as_ref());

    if is_upper {
      pos = found.start;
      continue;
    }

    if is_connector {
      let Some(previous) = simple_word_before(full_text, found.start) else {
        break;
      };
      if !starts_upper(previous.text)
        || is_known_boundary_suffix(previous.text, data)
      {
        break;
      }
      if data.and_connector_words.contains(lower.as_ref()) {
        let upper_before =
          count_upper_words_before(full_text, found.start, suffix_mode, data);
        let middle_initial = has_middle_initial_before(full_text, found.start);
        if upper_before <= 1
          && (data
            .clause_noun_heads
            .contains(lowercase_lookup(previous.text).as_ref())
            || data
              .connector_prose_heads
              .contains(lowercase_lookup(previous.text).as_ref()))
        {
          break;
        }
        // A bare "exactly two capitalized words" run before the connector is
        // not, by itself, evidence of a person name: it equally matches a
        // two-word company prefix ("Acme Widgets and Bar, Inc."), and
        // blocking on word count alone left that prefix unredacted. Require
        // actual person-name evidence (a dotted middle initial, optionally
        // paired with a single-cap lead-in for the suffix-first case) before
        // refusing to extend across the connector. Even then, a connector
        // word already known to be a legal-form word inside a name (e.g.
        // "Trust") overrides the initial and lets the walk continue, since
        // that is corroborating evidence for a company name, not a person.
        let person_name_boundary = if suffix_mode {
          middle_initial && has_single_cap_prefix_before(full_text, match_start)
        } else {
          middle_initial && !is_in_name_legal_form_word(previous.text, data)
        };
        if person_name_boundary {
          break;
        }
      }
      pos = previous.start;
      continue;
    }

    if is_in_name_prep {
      let Some(previous) = simple_word_before(full_text, found.start) else {
        break;
      };
      if !starts_upper(previous.text) {
        break;
      }
      pos = previous.start;
      continue;
    }

    break;
  }

  skip_initials_backward(full_text, pos)
}

fn simple_word_before(text: &str, pos: usize) -> Option<Token<'_>> {
  let mut end = pos;
  while let Some((prev_start, ch)) = previous_char(text, end) {
    if ch == '\n' {
      return None;
    }
    if ch.is_whitespace() {
      end = prev_start;
      continue;
    }
    break;
  }

  let mut start = end;
  while let Some((prev_start, ch)) = previous_char(text, start) {
    if !(ch.is_alphabetic() || ch == '&') {
      break;
    }
    start = prev_start;
  }

  (start < end).then(|| Token {
    start,
    end,
    text: text.get(start..end).unwrap_or_default(),
  })
}

fn leading_entity_word(text: &str, start: usize) -> Option<String> {
  let mut end = start;
  while let Some((ch_start, ch)) = next_char(text, end) {
    if !(ch.is_alphabetic() || ch == '&') {
      break;
    }
    end = ch_start.saturating_add(ch.len_utf8());
  }
  (end > start).then(|| text.get(start..end).unwrap_or_default().to_owned())
}

fn count_upper_words_before(
  full_text: &str,
  pos: usize,
  cross_in_name_preps: bool,
  data: &PreparedLegalFormData,
) -> usize {
  let mut count = 0_usize;
  let mut scan = pos;
  while scan > 0 {
    let Some(found) = simple_word_before(full_text, scan) else {
      break;
    };
    if starts_upper(found.text) {
      count = count.saturating_add(1);
      scan = found.start;
      continue;
    }
    if cross_in_name_preps
      && data
        .in_name_prepositions
        .contains(lowercase_lookup(found.text).as_ref())
    {
      let Some(previous) = simple_word_before(full_text, found.start) else {
        break;
      };
      if !starts_upper(previous.text) {
        break;
      }
      scan = found.start;
      continue;
    }
    break;
  }
  count
}

fn has_single_cap_prefix_before(full_text: &str, match_start: usize) -> bool {
  simple_word_before(full_text, match_start)
    .is_some_and(|word| is_single_cap_token(word.text))
}

fn skip_initials_backward(full_text: &str, pos: usize) -> usize {
  let mut scan = pos;
  while let Some((prev_start, ch)) = previous_char(full_text, scan) {
    if ch == '\n' || !ch.is_whitespace() {
      break;
    }
    scan = prev_start;
  }
  let Some((dot_start, '.')) = previous_char(full_text, scan) else {
    return pos;
  };

  let mut cursor = dot_start;
  let mut start = dot_start;
  let mut saw_two = false;
  while let Some((letter_start, letter)) = previous_char(full_text, cursor) {
    if !letter.is_uppercase() {
      break;
    }
    start = letter_start;
    let before_letter = previous_char(full_text, letter_start);
    match before_letter {
      Some((space_start, ch)) if is_inter_token_space(ch) => {
        cursor = space_start;
      }
      Some((prev_dot_start, '.')) => {
        saw_two = true;
        cursor = prev_dot_start;
      }
      _ => break,
    }
  }

  if saw_two
    && previous_char(full_text, start)
      .is_none_or(|(_, ch)| !ch.is_alphanumeric())
  {
    return start;
  }
  pos
}

#[derive(Clone, Copy, Debug)]
struct Segment<'a> {
  start: usize,
  text: &'a str,
}

fn split_embedded_legal_form_list<'a>(
  entity_start: usize,
  entity_text: &'a str,
  data: &PreparedLegalFormData,
) -> Vec<Segment<'a>> {
  if !entity_text.contains([',', ';']) {
    return vec![Segment {
      start: entity_start,
      text: entity_text,
    }];
  }

  let mut cuts = vec![0_usize];
  for suffix in list_suffixes(data) {
    let mut search_from = 0_usize;
    while let Some(relative) = entity_text
      .get(search_from..)
      .and_then(|tail| tail.find(suffix))
    {
      let suffix_start = search_from.saturating_add(relative);
      let suffix_end = suffix_start.saturating_add(suffix.len());
      search_from = suffix_end;
      if suffix_end >= entity_text.len().saturating_sub(1) {
        continue;
      }
      let Some(after) = entity_text.get(suffix_end..) else {
        continue;
      };
      let boundary_len = legal_list_boundary_len(after);
      if boundary_len > 0 {
        cuts.push(suffix_end.saturating_add(boundary_len));
      }
    }
  }

  cuts.sort_unstable();
  cuts.dedup();
  if cuts.len() == 1 {
    return vec![Segment {
      start: entity_start,
      text: entity_text,
    }];
  }

  let mut segments = Vec::new();
  for (index, start) in cuts.iter().enumerate() {
    let end = cuts
      .get(index.saturating_add(1))
      .copied()
      .unwrap_or(entity_text.len());
    if *start >= end {
      continue;
    }
    let Some(segment) = entity_text.get(*start..end) else {
      continue;
    };
    let trimmed = segment.trim_end_matches(|ch: char| {
      ch.is_whitespace() || matches!(ch, ',' | ';')
    });
    if trimmed.is_empty() || !ends_with_legal_suffix(trimmed, data) {
      continue;
    }
    segments.push(Segment {
      start: entity_start.saturating_add(*start),
      text: trimmed,
    });
  }

  segments
}

fn legal_list_boundary_len(text: &str) -> usize {
  let mut chars = text.char_indices();
  let Some((_, first)) = chars.next() else {
    return 0;
  };
  if !matches!(first, ',' | ';') {
    return 0;
  }
  let mut end = first.len_utf8();
  let mut saw_space = false;
  for (index, ch) in chars {
    if ch.is_whitespace() {
      saw_space = true;
      end = index.saturating_add(ch.len_utf8());
      continue;
    }
    if saw_space && (ch.is_uppercase() || ch == '.') {
      return end;
    }
    return 0;
  }
  0
}

fn ends_with_legal_suffix(text: &str, data: &PreparedLegalFormData) -> bool {
  let Some(last) = text.chars().next_back() else {
    return false;
  };
  data
    .suffix_indices_by_last_char
    .get(&last)
    .is_some_and(|indices| {
      indices.iter().any(|index| {
        data
          .suffixes
          .get(*index)
          .is_some_and(|suffix| text.ends_with(suffix))
      })
    })
}

fn trim_embedded_legal_form_list_prefix<'a>(
  entity_start: usize,
  entity_text: &'a str,
  data: &PreparedLegalFormData,
) -> (usize, &'a str) {
  if !entity_text.contains(',') {
    return (entity_start, entity_text);
  }

  let mut cut = 0_usize;
  for suffix in list_suffixes(data) {
    let mut search_from = 0_usize;
    while let Some(relative) = entity_text
      .get(search_from..)
      .and_then(|tail| tail.find(suffix))
    {
      let suffix_start = search_from.saturating_add(relative);
      let suffix_end = suffix_start.saturating_add(suffix.len());
      search_from = suffix_end;
      if suffix_end >= entity_text.len().saturating_sub(1) {
        continue;
      }
      let Some(after) = entity_text.get(suffix_end..) else {
        continue;
      };
      let boundary_len = comma_upper_boundary_len(after);
      if boundary_len == 0 {
        continue;
      }
      let next_start = suffix_end.saturating_add(boundary_len);
      if entity_text
        .get(next_start..)
        .is_some_and(|remainder| ends_with_legal_suffix(remainder, data))
      {
        cut = cut.max(next_start);
      }
    }
  }

  if cut == 0 {
    return (entity_start, entity_text);
  }
  (
    entity_start.saturating_add(cut),
    entity_text.get(cut..).unwrap_or_default(),
  )
}

fn comma_upper_boundary_len(text: &str) -> usize {
  let Some(stripped) = text.strip_prefix(',') else {
    return 0;
  };
  let ws_len = leading_ws_len(stripped);
  if ws_len == 0 {
    return 0;
  }
  let after_ws = stripped.get(ws_len..).unwrap_or_default();
  if after_ws.chars().next().is_some_and(char::is_uppercase) {
    return ','.len_utf8().saturating_add(ws_len);
  }
  0
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LeadingTrim {
  offset: usize,
}

fn trim_leading_clause(
  text: &str,
  data: &PreparedLegalFormData,
) -> LeadingTrim {
  // Search on a lowercased copy for case-insensitive matching, but keep a map
  // back to original byte offsets. `to_lowercase()` can change byte lengths
  // ("İ" U+0130 -> "i" + U+0307), so any offset taken from `lower` must be
  // translated before it is used to slice the original `text` or returned as a
  // cut (the caller slices the original with it).
  let (lower, lower_to_orig) = lowercase_with_offset_map(text);
  let to_orig =
    |offset: usize| lower_to_orig.get(offset).copied().unwrap_or(text.len());
  let mut cut = 0_usize;

  for phrase in &data.leading_clause_phrases {
    let mut search_from = 0_usize;
    while let Some(relative) =
      lower.get(search_from..).and_then(|tail| tail.find(phrase))
    {
      let start = search_from.saturating_add(relative);
      let end = start.saturating_add(phrase.len());
      search_from = end;
      let before_ok = start == 0
        || lower
          .get(..start)
          .and_then(|prefix| prefix.chars().next_back())
          .is_some_and(char::is_whitespace);
      let after_ws = lower.get(end..).map(leading_ws_len).unwrap_or_default();
      if before_ok && after_ws > 0 {
        cut = cut.max(to_orig(end.saturating_add(after_ws)));
      }
    }
  }

  for prefix in &data.leading_clause_direct_prefixes {
    let mut search_from = 0_usize;
    while let Some(relative) = lower
      .get(search_from..)
      .and_then(|tail| find_word_at_boundary(tail, prefix))
    {
      let start = search_from.saturating_add(relative);
      let end = start.saturating_add(prefix.len());
      search_from = end;
      let after_ws = lower.get(end..).map(leading_ws_len).unwrap_or_default();
      let after_orig = to_orig(end.saturating_add(after_ws));
      // The company name after the prefix must be capitalized. Read the
      // original text (in original byte offsets), not the lowercased copy, or
      // this check never passes.
      let after = text
        .get(after_orig..)
        .and_then(|suffix| suffix.chars().next());
      if after_ws == 0 || !after.is_some_and(char::is_uppercase) {
        continue;
      }

      let before = text.get(..to_orig(start)).unwrap_or_default();
      let prefix_lower = prefix.to_lowercase();
      if data.comma_gated_direct_prefixes.contains(&prefix_lower) {
        let has_comma = before.trim_end().ends_with(',');
        let has_sentence_verb =
          word_tokens(before, 0, before.len()).any(|word| {
            starts_lower(word.text)
              && data
                .sentence_verb_indicators
                .contains(lowercase_lookup(word.text).as_ref())
          });
        if !has_comma && !has_sentence_verb {
          continue;
        }
      }

      let mut word_count = 0_usize;
      let mut has_lower_word = false;
      for word in word_tokens(before, 0, before.len()) {
        word_count = word_count.saturating_add(1);
        has_lower_word |= starts_lower(word.text);
      }
      let has_prose_prefix = word_count >= 3 && has_lower_word;
      if has_prose_prefix {
        cut = cut.max(after_orig);
      }
    }
  }

  for (comma, _) in text.match_indices(',') {
    let before = text.get(..comma).unwrap_or_default();
    if !before.chars().any(|ch| ch.is_ascii_digit()) {
      continue;
    }
    let after = text.get(comma.saturating_add(1)..).unwrap_or_default();
    let ws = leading_ws_len(after);
    let candidate = after.get(ws..).unwrap_or_default();
    let upper_words = word_tokens(candidate, 0, candidate.len())
      .filter(|word| starts_upper(word.text))
      .count();
    if upper_words >= 3 {
      cut = cut.max(comma.saturating_add(1).saturating_add(ws));
    }
  }

  LeadingTrim { offset: cut }
}

/// Lowercase `text`, returning the folded string plus a table that maps each
/// byte offset in the folded string back to the byte offset of the original
/// character that produced it. The final entry maps the end of the folded
/// string to `text.len()`. Case folding can change byte lengths, so offsets
/// found in the folded copy must be translated through this table before they
/// index or slice the original text.
fn lowercase_with_offset_map(text: &str) -> (String, Vec<usize>) {
  let mut lower = String::with_capacity(text.len());
  let mut lower_to_orig = Vec::with_capacity(text.len().saturating_add(1));
  for (orig_idx, ch) in text.char_indices() {
    for folded in ch.to_lowercase() {
      lower.push(folded);
      lower_to_orig.resize(lower.len(), orig_idx);
    }
  }
  lower_to_orig.push(text.len());
  (lower, lower_to_orig)
}

fn find_word_at_boundary(haystack: &str, needle: &str) -> Option<usize> {
  let mut from = 0_usize;
  while let Some(relative) = haystack.get(from..)?.find(needle) {
    let start = from.saturating_add(relative);
    let end = start.saturating_add(needle.len());
    let left_ok = previous_char(haystack, start)
      .is_none_or(|(_, ch)| !ch.is_alphanumeric());
    let right_ok = haystack
      .get(end..)
      .and_then(|suffix| suffix.chars().next())
      .is_none_or(|ch| !ch.is_alphanumeric());
    if left_ok && right_ok {
      return Some(start);
    }
    from = end;
  }
  None
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct PrefixInfo {
  end: usize,
  part: String,
}

fn prefix_info(text: &str) -> PrefixInfo {
  let end = text.rfind(',').or_else(|| text.rfind(' ')).unwrap_or(0);
  let source = if end > 0 {
    text.get(..end).unwrap_or_default()
  } else {
    text
  };
  PrefixInfo {
    end,
    part: source.chars().filter(|ch| ch.is_alphabetic()).collect(),
  }
}

fn has_roman_numeral_suffix(text: &str) -> bool {
  let separator = last_suffix_separator(text);
  let raw_suffix = separator
    .and_then(|index| text.get(index.saturating_add(1)..))
    .unwrap_or_default();
  let suffix = clean_suffix(raw_suffix);
  !suffix.is_empty() && is_roman_numeral(&suffix)
}

fn short_ascii_suffix_collides_with_non_ascii_prefix(text: &str) -> bool {
  let separator = last_suffix_separator(text);
  let raw_suffix = separator
    .and_then(|index| text.get(index.saturating_add(1)..))
    .unwrap_or_default();
  let suffix = clean_suffix(raw_suffix);
  if suffix.len() > 2 || raw_suffix.contains('.') {
    return false;
  }
  let prefix = separator
    .and_then(|index| text.get(..index))
    .unwrap_or(text)
    .chars()
    .filter(|ch| !matches!(ch, '\u{00a0}' | '\u{202f}'))
    .collect::<String>();
  !prefix.is_ascii()
}

fn last_suffix_separator(text: &str) -> Option<usize> {
  text
    .char_indices()
    .filter_map(|(index, ch)| {
      matches!(ch, ' ' | '\t' | '\u{00a0}' | '\u{202f}' | ',').then_some(index)
    })
    .next_back()
}

fn clean_suffix(text: &str) -> String {
  text.chars().filter(|ch| !matches!(ch, '.' | ',')).collect()
}

fn is_roman_legal_suffix(text: &str) -> bool {
  let suffix = clean_suffix(text);
  !suffix.is_empty() && is_roman_numeral(&suffix)
}

fn list_suffixes(
  data: &PreparedLegalFormData,
) -> impl Iterator<Item = &str> + '_ {
  data.list_suffix_indices.iter().filter_map(|index| {
    data.suffixes.get(*index).map(std::string::String::as_str)
  })
}

fn is_roman_numeral(text: &str) -> bool {
  if text.is_empty()
    || !text.chars().next().is_some_and(|ch| {
      ch == 'I'
        || ch == 'V'
        || ch == 'X'
        || ch == 'L'
        || ch == 'C'
        || ch == 'D'
        || ch == 'M'
    })
  {
    return false;
  }

  let bytes = text.as_bytes();
  let mut index = 0_usize;

  let _ = take_repeated(bytes, &mut index, b'M', 3);

  if consume_pair(bytes, &mut index, b'C', b'M')
    || consume_pair(bytes, &mut index, b'C', b'D')
  {
  } else {
    let _ = consume(bytes, &mut index, b'D');
    let _ = take_repeated(bytes, &mut index, b'C', 3);
  }

  if consume_pair(bytes, &mut index, b'X', b'C')
    || consume_pair(bytes, &mut index, b'X', b'L')
  {
  } else {
    let _ = consume(bytes, &mut index, b'L');
    let _ = take_repeated(bytes, &mut index, b'X', 3);
  }

  if consume_pair(bytes, &mut index, b'I', b'X')
    || consume_pair(bytes, &mut index, b'I', b'V')
  {
  } else {
    let _ = consume(bytes, &mut index, b'V');
    let _ = take_repeated(bytes, &mut index, b'I', 3);
  }

  index == bytes.len()
}

fn take_repeated(
  bytes: &[u8],
  index: &mut usize,
  target: u8,
  max: usize,
) -> usize {
  let mut count = 0_usize;
  while count < max && bytes.get(*index) == Some(&target) {
    *index = index.saturating_add(1);
    count = count.saturating_add(1);
  }
  count
}

fn consume_pair(
  bytes: &[u8],
  index: &mut usize,
  first: u8,
  second: u8,
) -> bool {
  if bytes.get(*index) != Some(&first)
    || bytes.get(index.saturating_add(1)) != Some(&second)
  {
    return false;
  }
  *index = index.saturating_add(2);
  true
}

fn consume(bytes: &[u8], index: &mut usize, target: u8) -> bool {
  if bytes.get(*index) != Some(&target) {
    return false;
  }
  *index = index.saturating_add(1);
  true
}

fn trim_end_byte(text: &str) -> usize {
  text.trim_end().len()
}

fn leading_ws_len(text: &str) -> usize {
  let mut len = 0_usize;
  for ch in text.chars() {
    if !ch.is_whitespace() {
      break;
    }
    len = len.saturating_add(ch.len_utf8());
  }
  len
}

fn previous_char(text: &str, pos: usize) -> Option<(usize, char)> {
  text.get(..pos)?.char_indices().next_back()
}

fn next_char(text: &str, pos: usize) -> Option<(usize, char)> {
  text
    .get(pos..)?
    .char_indices()
    .next()
    .map(|(relative, ch)| (pos.saturating_add(relative), ch))
}

fn lower_set(values: Vec<String>) -> HashSet<String> {
  values
    .into_iter()
    .filter(|value| !value.is_empty())
    .map(|value| value.to_lowercase())
    .collect()
}

fn lower_vec(values: Vec<String>) -> Vec<String> {
  values
    .into_iter()
    .filter(|value| !value.is_empty())
    .map(|value| value.to_lowercase())
    .collect()
}

fn lowercase_lookup(text: &str) -> Cow<'_, str> {
  if text.chars().any(char::is_uppercase) {
    Cow::Owned(text.to_lowercase())
  } else {
    Cow::Borrowed(text)
  }
}

fn contains_lowercase(set: &HashSet<String>, text: &str) -> bool {
  set.contains(lowercase_lookup(text).as_ref())
}

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used, clippy::unwrap_used)]

  use super::{
    LegalFormData, PreparedLegalFormData, crosses_sentence_end,
    extend_backward, process_legal_form_matches, trim_leading_clause,
    trim_role_head,
  };
  use crate::processors::PatternSlice;
  use crate::types::SearchMatch;

  fn leading_clause_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      leading_clause_phrases: vec![
        String::from("by and among"),
        String::from("by and between"),
        String::from("is between"),
      ],
      leading_clause_direct_prefixes: vec![
        String::from("by"),
        String::from("among"),
        String::from("amongst"),
        String::from("between"),
      ],
      comma_gated_direct_prefixes: vec![
        String::from("among"),
        String::from("amongst"),
        String::from("between"),
      ],
      ..LegalFormData::default()
    })
  }

  #[test]
  fn comma_gated_prefix_trims_long_preamble() {
    // A long comma-laden preamble before a comma-gated direct prefix must trim
    // back to the company name, not drop the whole candidate. The capital-word
    // check after the prefix has to read the original text, not the lowercased
    // copy, or it never fires.
    let data = leading_clause_data();
    let text =
      "Investment Agreement, dated as of March 9, 2020, among Twitter, Inc.";
    let trim = trim_leading_clause(text, &data);
    assert_eq!(text.get(trim.offset..), Some("Twitter, Inc."));
  }

  #[test]
  fn direct_prefix_offset_survives_turkish_dotted_capital() {
    // `to_lowercase()` expands "İ" (U+0130) to "i" + U+0307, so a byte offset
    // taken from the lowercased copy drifts one byte past the original once an
    // İ precedes the clause. The recovered company name must be sliced in
    // original-text space: the Turkish input yields the same result as its
    // ASCII twin, with no mis-slice, panic, or None-degradation.
    let data = leading_clause_data();
    let ascii = "Istanbul Holding A.S. Investment Agreement, dated as of March 9, 2020, among Twitter, Inc.";
    let turkish = "İstanbul Holding A.Ş. Investment Agreement, dated as of March 9, 2020, among Twitter, Inc.";
    let ascii_trim = trim_leading_clause(ascii, &data);
    let turkish_trim = trim_leading_clause(turkish, &data);
    assert_eq!(ascii.get(ascii_trim.offset..), Some("Twitter, Inc."));
    assert_eq!(turkish.get(turkish_trim.offset..), Some("Twitter, Inc."));
  }

  #[test]
  fn comma_gated_prefix_keeps_in_name_capitalised_word() {
    // "Stand By Me LLC": "By" is capitalized and mid-name, and the text before
    // it is not prose, so the direct prefix must not trim.
    let data = leading_clause_data();
    let text = "Stand By Me LLC";
    let trim = trim_leading_clause(text, &data);
    assert_eq!(trim.offset, 0);
  }

  fn crosses(text: &str, prefix: &str) -> bool {
    // Treat the org candidate as spanning the whole text up to the trailing
    // legal-form suffix (the caller passes walker_start and suffix_start).
    let suffix_start = text.rfind(prefix).unwrap_or(text.len());
    crosses_sentence_end(text, 0, suffix_start).is_some()
  }

  #[test]
  fn compact_initials_are_not_a_sentence_break() {
    // "J.P. Morgan Securities LLC" — the interior dot must not make "J.P."
    // read as a two-letter acronym followed by a sentence end.
    assert!(!crosses("J.P. Morgan Securities LLC", "LLC"));
    assert!(!crosses("U.S. Robotics Corp LLC", "LLC"));
  }

  #[test]
  fn dotted_geo_acronym_joins_like_a_name_initial() {
    // A two-letter dotted acronym is structurally identical whether it is a
    // geographic prefix ("U.S. Bancorp Inc.") or a person-name initial ("J.P.
    // Morgan Securities LLC"). The recovered TypeScript detector absorbed both
    // unconditionally (skipInitialsBackward: `(?:\p{Lu}\.\s?){2,}`, no
    // known-acronym exception list), so "U.S. Beta LLC" joins the same way.
    // Splitting it would regress the real "U.S. Bancorp"/"U.S. Robotics"
    // orgs, which share the exact same shape.
    assert!(!crosses("U.S. Beta LLC", "LLC"));
    assert!(!crosses("U.S. Bancorp Inc.", "Inc."));
  }

  #[test]
  fn spaced_initials_stay_a_single_candidate() {
    assert!(!crosses("J. P. Morgan Securities LLC", "LLC"));
  }

  #[test]
  fn genuine_sentence_break_still_detected() {
    // A real 2+ letter word (any case) before ". " remains a boundary.
    assert!(crosses("Price. LLC", "LLC"));
    assert!(crosses("Acme INC. Beta LLC", "LLC"));
  }

  fn legal_form_test_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      suffixes: vec![String::from("LLC"), String::from("Inc.")],
      ..LegalFormData::default()
    })
  }

  #[test]
  fn sentence_break_reclips_instead_of_dropping_the_candidate() {
    // "Acme Inc. Beta LLC signed the agreement." — the LLC candidate's
    // backward walk reaches all the way to "Acme", crossing the "Inc. "
    // sentence break along the way. The old code dropped the whole
    // candidate via `continue`, so "Beta LLC" was never emitted. It now
    // re-clips forward past the break and re-validates the remainder, so
    // both the sentence-preceding "Acme Inc." and the later "Beta LLC" are
    // detected.
    let data = legal_form_test_data();
    let text = "Acme Inc. Beta LLC signed the agreement.";
    let inc_start = text.find("Inc.").unwrap();
    let inc_end = inc_start + "Inc.".len();
    let llc_start = text.find("LLC").unwrap();
    let llc_end = llc_start + "LLC".len();
    let matches = [
      SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(inc_start).unwrap(),
        end: u32::try_from(inc_end).unwrap(),
      },
      SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(llc_start).unwrap(),
        end: u32::try_from(llc_end).unwrap(),
      },
    ];
    let slice = PatternSlice { start: 0, end: 1 };
    let entities =
      process_legal_form_matches(&matches, slice, text, &data).unwrap();
    let texts: Vec<&str> =
      entities.iter().map(|entity| entity.text.as_str()).collect();
    assert!(texts.contains(&"Acme Inc."), "{texts:?}");
    assert!(texts.contains(&"Beta LLC"), "{texts:?}");
  }

  #[test]
  fn sentence_break_clip_retrims_leading_lowercase_prose() {
    // "Acme Inc. the supplier Beta LLC ..." — the LLC candidate's backward
    // walk bridges "the supplier" and reaches "Acme" across the "Inc. "
    // break. Clipping past the break used to leave the candidate anchored
    // on the lowercase prose ("the supplier Beta LLC"); the remainder is
    // now re-anchored at the first org-name-capable token, so only
    // "Beta LLC" is emitted for the second sentence.
    let data = legal_form_test_data();
    let text = "Acme Inc. the supplier Beta LLC signed the agreement.";
    let inc_start = text.find("Inc.").unwrap();
    let inc_end = inc_start + "Inc.".len();
    let llc_start = text.find("LLC").unwrap();
    let llc_end = llc_start + "LLC".len();
    let matches = [
      SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(inc_start).unwrap(),
        end: u32::try_from(inc_end).unwrap(),
      },
      SearchMatch::Literal {
        pattern: 0,
        start: u32::try_from(llc_start).unwrap(),
        end: u32::try_from(llc_end).unwrap(),
      },
    ];
    let slice = PatternSlice { start: 0, end: 1 };
    let entities =
      process_legal_form_matches(&matches, slice, text, &data).unwrap();
    let texts: Vec<&str> =
      entities.iter().map(|entity| entity.text.as_str()).collect();
    assert!(texts.contains(&"Acme Inc."), "{texts:?}");
    assert!(texts.contains(&"Beta LLC"), "{texts:?}");
    assert!(
      !texts.iter().any(|candidate| candidate.contains("supplier")),
      "leading prose must be trimmed from the clipped candidate: {texts:?}"
    );
  }

  fn connector_test_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      connector_words: vec![String::from("and")],
      and_connector_words: vec![String::from("and")],
      ..LegalFormData::default()
    })
  }

  #[test]
  fn connector_boundary_extends_across_two_word_company_prefix() {
    // "Acme Widgets and Bar, Inc." — "Widgets" is not a recognized in-name
    // legal-form word and there is no middle initial, so the old
    // "exactly two capitalized words" check alone stopped the walk at
    // "and" and left "Acme Widgets and" unredacted. Corroborating
    // person-name evidence is now required to block the walk, so absent
    // any it continues across the connector and recovers the full prefix.
    let data = connector_test_data();
    let text = "Acme Widgets and Bar, Inc.";
    let match_start = text.find("Bar").unwrap();
    assert_eq!(extend_backward(text, match_start, &data, false), 0);
  }

  #[test]
  fn connector_boundary_still_protects_an_initialed_person_name() {
    // "Paul J. Newman and Apple, Inc." — a genuine dotted middle initial is
    // real person-name evidence, so the walk must still stop at "and"
    // rather than swallowing the person's name into the org span. (The
    // bare "Paul Newman and Apple, Inc." form carries no local signal that
    // distinguishes it from a genuine two-word company prefix like "Acme
    // Widgets and Bar, Inc." above — this initialed variant is the
    // preserved case the guard can still tell apart.)
    let data = connector_test_data();
    let text = "Paul J. Newman and Apple, Inc.";
    let match_start = text.find("Apple").unwrap();
    assert_eq!(
      extend_backward(text, match_start, &data, false),
      match_start
    );
  }

  fn role_head_test_data() -> PreparedLegalFormData {
    PreparedLegalFormData::new(LegalFormData {
      role_heads: vec![String::from("client"), String::from("vendor")],
      ..LegalFormData::default()
    })
  }

  #[test]
  fn role_head_digit_trim_recovers_digit_led_name() {
    // "Client 360 LLC" / "Vendor 1 LLC" — the role word is immediately
    // followed by a digit with no verb in between, so trim_role_head's
    // recovery scan has to find where the real name resumes. Restricting
    // the scan to uppercase-leading tokens skipped the digit-leading token
    // entirely and, with no later uppercase word to recover on, collapsed
    // the span down to the bare "LLC" suffix. A digit-leading token is now
    // accepted too, so "360"/"1" anchors the recovered span instead of
    // losing the name.
    let data = role_head_test_data();

    let client_text = "Client 360 LLC";
    let client_suffix_start = client_text.find("LLC").unwrap();
    let client_trim =
      trim_role_head(client_text, 0, client_text, client_suffix_start, &data)
        .expect("digit-after-role should still trim");
    assert_eq!(client_text.get(client_trim.start..), Some("360 LLC"));

    let vendor_text = "Vendor 1 LLC";
    let vendor_suffix_start = vendor_text.find("LLC").unwrap();
    let vendor_trim =
      trim_role_head(vendor_text, 0, vendor_text, vendor_suffix_start, &data)
        .expect("digit-after-role should still trim");
    assert_eq!(vendor_text.get(vendor_trim.start..), Some("1 LLC"));
  }
}
