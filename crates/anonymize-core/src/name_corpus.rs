use std::collections::HashSet;

use crate::resolution::{DetectionSource, PipelineEntity};
use crate::types::{Error, Result};

mod cjk;

const PERSON_LABEL: &str = "person";
const HIGH_CONFIDENCE_NAME_SCORE: f64 = 0.9;
const TITLE_NAME_SCORE: f64 = 0.95;
const LOW_CONFIDENCE_NAME_SCORE: f64 = 0.5;
const MAX_CHAIN: usize = 5;
const ALL_CAPS_NAME_LINE_RATIO: f64 = 0.9;
const ALL_CAPS_NAME_LINE_MIN_LETTERS: usize = 3;
const ALL_CAPS_NAME_LINE_MAX_TOKENS: usize = 6;
const MAX_HORIZONTAL_CHAIN_GAP: usize = 4;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct NameCorpusData {
  #[serde(default)]
  pub mode: NameCorpusMode,
  #[serde(default)]
  pub first_names: Vec<String>,
  #[serde(default)]
  pub surnames: Vec<String>,
  #[serde(default)]
  pub title_tokens: Vec<String>,
  #[serde(default)]
  pub title_abbreviations: Vec<String>,
  #[serde(default)]
  pub excluded_words: Vec<String>,
  #[serde(default)]
  pub common_words: Vec<String>,
  #[serde(default)]
  pub non_western_names: Vec<String>,
  #[serde(default)]
  pub excluded_all_caps: Vec<String>,
  #[serde(default)]
  pub ja_suffixes: Vec<String>,
  #[serde(default)]
  pub arabic_connectors: Vec<String>,
  #[serde(default)]
  pub relation_connectors: Vec<String>,
  #[serde(default)]
  pub hyphenated_prefixes: Vec<String>,
  #[serde(default)]
  pub cjk_non_person_terms: Vec<String>,
  #[serde(default)]
  pub cjk_surname_starters: Vec<String>,
  #[serde(default)]
  pub organization_terms: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct PreparedNameCorpusData {
  mode: NameCorpusMode,
  first_names: HashSet<String>,
  surnames: HashSet<String>,
  title_tokens: HashSet<String>,
  title_abbreviations: HashSet<String>,
  excluded_words: HashSet<String>,
  common_words: HashSet<String>,
  non_western_names: HashSet<String>,
  excluded_all_caps: HashSet<String>,
  ja_suffixes: HashSet<String>,
  arabic_connectors: HashSet<String>,
  relation_connectors: HashSet<String>,
  relation_connector_prefixes: HashSet<String>,
  hyphenated_prefixes: HashSet<String>,
  cjk_non_person_terms: HashSet<String>,
  cjk_surname_starters: HashSet<char>,
  organization_terms: HashSet<String>,
}

#[derive(
  Clone,
  Copy,
  Debug,
  Default,
  Eq,
  PartialEq,
  serde::Deserialize,
  serde::Serialize,
)]
#[serde(rename_all = "snake_case")]
pub enum NameCorpusMode {
  Full,
  #[default]
  Supplemental,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TokenKind {
  Name,
  Surname,
  Title,
  Abbreviation,
  JaSuffix,
  ArabicConnector,
  Capitalized,
  Other,
}

#[derive(Clone, Debug)]
struct WordSegment<'a> {
  text: &'a str,
  start: usize,
  end: usize,
}

#[derive(Clone, Debug)]
struct ClassifiedToken<'a> {
  text: &'a str,
  kind: TokenKind,
  start: usize,
  end: usize,
  non_western: bool,
  title_abbreviation: bool,
}

impl PreparedNameCorpusData {
  #[must_use]
  pub fn new(data: NameCorpusData) -> Self {
    let relation_connectors = lower_string_set(data.relation_connectors);
    let relation_connector_prefixes =
      relation_connector_prefixes(&relation_connectors);

    Self {
      mode: data.mode,
      first_names: string_set(data.first_names),
      surnames: string_set(data.surnames),
      title_tokens: lower_string_set(data.title_tokens),
      title_abbreviations: lower_string_set(data.title_abbreviations),
      excluded_words: lower_string_set(data.excluded_words),
      common_words: lower_string_set(data.common_words),
      non_western_names: string_set(data.non_western_names),
      excluded_all_caps: string_set(data.excluded_all_caps),
      ja_suffixes: lower_string_set(data.ja_suffixes),
      arabic_connectors: lower_string_set(data.arabic_connectors),
      relation_connectors,
      relation_connector_prefixes,
      hyphenated_prefixes: lower_string_set(data.hyphenated_prefixes),
      cjk_non_person_terms: string_set(data.cjk_non_person_terms),
      cjk_surname_starters: data
        .cjk_surname_starters
        .into_iter()
        .filter_map(|value| value.chars().next())
        .collect(),
      organization_terms: lower_string_set(data.organization_terms),
    }
  }

  pub fn detect_supplemental(
    &self,
    full_text: &str,
    deny_list_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    self.detect(full_text, NameCorpusMode::Supplemental, deny_list_entities)
  }

  pub fn detect_configured(
    &self,
    full_text: &str,
    deny_list_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    self.detect(full_text, self.mode, deny_list_entities)
  }

  pub fn detect(
    &self,
    full_text: &str,
    mode: NameCorpusMode,
    deny_list_entities: &[PipelineEntity],
  ) -> Result<Vec<PipelineEntity>> {
    let mut entities = cjk::detect(self, full_text)?;
    entities.extend(self.detect_token_names(full_text, mode)?);
    let mut entities = deduplicate_spans(entities);
    if mode == NameCorpusMode::Supplemental {
      entities.retain(|entity| {
        !deny_list_entities
          .iter()
          .any(|deny| covers_same_label(entity, deny))
      });
    }
    Ok(entities)
  }

  fn detect_token_names(
    &self,
    full_text: &str,
    mode: NameCorpusMode,
  ) -> Result<Vec<PipelineEntity>> {
    let words = segment_words(full_text);
    if mode == NameCorpusMode::Supplemental
      && !self.has_supplemental_seed(&words)
    {
      return Ok(Vec::new());
    }

    let mut tokens = Vec::with_capacity(words.len());
    let mut word_index = 0usize;
    while let Some(word) = words.get(word_index) {
      if let Some((connector, end, consumed)) =
        relation_connector(word, &words, word_index, full_text, self)
      {
        tokens.push(ClassifiedToken {
          text: connector,
          kind: TokenKind::ArabicConnector,
          start: word.start,
          end,
          non_western: false,
          title_abbreviation: false,
        });
        word_index = word_index.saturating_add(consumed);
        continue;
      }
      tokens.push(self.classify_token(word, full_text));
      word_index = word_index.saturating_add(1);
    }

    let mut consumed = vec![false; tokens.len()];
    let mut entities = Vec::new();
    for index in 0..tokens.len() {
      if consumed.get(index).copied().unwrap_or(false) {
        continue;
      }
      let Some(token) = tokens.get(index) else {
        continue;
      };
      if !is_chain_start(token.kind) {
        continue;
      }

      let chain = Self::build_chain(full_text, &tokens, index);
      let Some(score) = chain_score(full_text, &chain, self, mode) else {
        continue;
      };
      let Some(first) = chain.first() else {
        continue;
      };
      let Some(last) = chain.last() else {
        continue;
      };
      let Some(text) = full_text.get(first.start..last.end) else {
        return Err(invalid_name_data("name span is not a UTF-8 boundary"));
      };
      if self.is_organization(text) {
        continue;
      }
      for slot in index..index.saturating_add(chain.len()) {
        if let Some(value) = consumed.get_mut(slot) {
          *value = true;
        }
      }
      entities.push(PipelineEntity::detected(
        usize_to_u32(first.start, "name_corpus.start")?,
        usize_to_u32(last.end, "name_corpus.end")?,
        PERSON_LABEL,
        text,
        score,
        DetectionSource::Regex,
      ));
    }

    Ok(entities)
  }

  fn classify_token<'a>(
    &self,
    word: &WordSegment<'a>,
    full_text: &str,
  ) -> ClassifiedToken<'a> {
    let text = word.text;
    let lower = text.to_lowercase();
    let stripped = lower.strip_suffix('.').unwrap_or(&lower);
    if self.title_tokens.contains(stripped) {
      return ClassifiedToken {
        text,
        kind: TokenKind::Title,
        start: word.start,
        end: word.end,
        non_western: false,
        title_abbreviation: self.title_abbreviations.contains(stripped),
      };
    }
    if self.ja_suffixes.contains(&lower) {
      return classified(word, TokenKind::JaSuffix, false);
    }
    if self.arabic_connectors.contains(&lower) {
      return classified(word, TokenKind::ArabicConnector, false);
    }
    if self.is_hyphenated_prefix_name(text) {
      return classified(word, TokenKind::Name, true);
    }
    if is_abbreviation(text) || is_multi_dot_abbreviation(text) {
      return classified(word, TokenKind::Abbreviation, false);
    }
    if is_single_letter_initial(text, word.end, full_text)
      && self.initial_has_name_context(word, full_text)
    {
      return classified(word, TokenKind::Abbreviation, false);
    }
    if self.excluded_words.contains(&lower) || text.chars().count() < 2 {
      return classified(word, TokenKind::Other, false);
    }
    let short_token_allowed = self.is_non_western_name_token(text)
      || self.ja_suffixes.contains(&lower)
      || self.arabic_connectors.contains(&lower)
      || (is_all_upper(text) && !self.excluded_all_caps.contains(text));
    if text.chars().count() < 3 && !short_token_allowed {
      return classified(word, TokenKind::Other, false);
    }
    if text.chars().count() >= 3 && is_all_upper(text) {
      if self.excluded_all_caps.contains(text) {
        return classified(word, TokenKind::Other, false);
      }
      let title_cased = title_case_simple(text);
      let non_western = self.is_non_western_name_token(&title_cased);
      if non_western && !self.is_first_name_token(&title_cased) {
        return classified(word, TokenKind::Name, true);
      }
      if is_all_caps_context_line(full_text, word.start)
        && is_all_caps_line_name_shaped(full_text, word.start)
      {
        if self.is_first_name_token(&title_cased) {
          return classified(word, TokenKind::Name, non_western);
        }
        if self.is_surname_token(&title_cased) {
          return classified(word, TokenKind::Surname, non_western);
        }
        if non_western {
          return classified(word, TokenKind::Name, true);
        }
      }
      return classified(word, TokenKind::Other, false);
    }
    if !starts_uppercase(text) {
      return classified(word, TokenKind::Other, false);
    }
    if self.is_first_name_token(text) {
      return classified(
        word,
        TokenKind::Name,
        self.is_non_western_name_token(text),
      );
    }
    if self.is_surname_token(text) {
      return classified(
        word,
        TokenKind::Surname,
        self.is_non_western_name_token(text),
      );
    }
    if self.is_non_western_name_token(text) {
      return classified(word, TokenKind::Name, true);
    }
    classified(word, TokenKind::Capitalized, false)
  }

  fn has_supplemental_seed(&self, words: &[WordSegment<'_>]) -> bool {
    words.iter().any(|word| {
      if self.is_non_western_name_token(word.text)
        || self.is_hyphenated_prefix_name(word.text)
      {
        return true;
      }
      if word.text.chars().count() < 3 || !is_all_upper(word.text) {
        return false;
      }
      if self.excluded_all_caps.contains(word.text) {
        return false;
      }
      self.is_non_western_name_token(&title_case_simple(word.text))
    })
  }

  fn build_chain<'a>(
    full_text: &str,
    tokens: &'a [ClassifiedToken<'a>],
    start: usize,
  ) -> Vec<&'a ClassifiedToken<'a>> {
    let mut chain = Vec::new();
    let Some(first) = tokens.get(start) else {
      return chain;
    };
    chain.push(first);
    let mut index = start.saturating_add(1);
    while index < tokens.len() && chain.len() < MAX_CHAIN {
      let Some(next) = tokens.get(index) else {
        break;
      };
      let Some(previous) = chain.last().copied() else {
        break;
      };
      let Some(gap) = full_text.get(previous.end..next.start) else {
        break;
      };
      if horizontal_gap_width(gap) > MAX_HORIZONTAL_CHAIN_GAP {
        break;
      }
      let period_is_part_of_previous = previous.kind == TokenKind::Abbreviation
        || (previous.kind == TokenKind::Title && previous.title_abbreviation);
      let breaks_on_period = gap.contains('.')
        && !is_initial_continuation_gap(previous.text, gap)
        && !period_is_part_of_previous;
      if gap.contains('\n')
        || gap.contains('!')
        || gap.contains('?')
        || gap.contains(';')
        || gap.contains(':')
        || breaks_on_period
      {
        break;
      }
      if next.kind == TokenKind::JaSuffix
        && gap != "-"
        && !gap.trim().is_empty()
      {
        break;
      }
      if next.kind == TokenKind::Other {
        break;
      }
      chain.push(next);
      index = index.saturating_add(1);
    }
    chain
  }

  pub(super) fn is_likely_cjk_person_name(&self, text: &str) -> bool {
    if self.cjk_non_person_terms.contains(text) {
      return false;
    }
    text
      .chars()
      .next()
      .is_some_and(|first| self.cjk_surname_starters.contains(&first))
  }

  pub(super) fn is_organization(&self, text: &str) -> bool {
    segment_words(text)
      .iter()
      .any(|word| self.organization_terms.contains(&word.text.to_lowercase()))
  }

  fn is_hyphenated_prefix_name(&self, text: &str) -> bool {
    let Some((prefix, tail)) = text.split_once('-') else {
      return false;
    };
    self.hyphenated_prefixes.contains(&prefix.to_lowercase())
      && tail.chars().next().is_some_and(char::is_uppercase)
  }

  fn is_first_name_token(&self, token: &str) -> bool {
    self.first_names.contains(token)
  }

  fn is_surname_token(&self, token: &str) -> bool {
    self.surnames.contains(token)
  }

  fn is_non_western_name_token(&self, token: &str) -> bool {
    self.non_western_names.contains(token)
      || self
        .non_western_names
        .contains(&title_case_with_apostrophe(token))
  }

  fn initial_has_name_context(
    &self,
    word: &WordSegment<'_>,
    full_text: &str,
  ) -> bool {
    let line = line_before(full_text, word.start);
    if let Some(last_word) = trailing_word(line)
      && self.lookup_name_token(last_word)
    {
      return true;
    }
    let after_dot_start = word.end.saturating_add(1);
    let after_dot = full_text
      .get(after_dot_start..)
      .unwrap_or_default()
      .trim_start();
    let Some(next_word) = leading_word(after_dot) else {
      return false;
    };
    self.lookup_name_token(next_word)
      || (next_word.chars().count() == 1 && starts_uppercase(next_word))
  }

  fn lookup_name_token(&self, token: &str) -> bool {
    self.is_first_name_token(token)
      || self.is_first_name_token(&title_case_simple(token))
      || self.is_non_western_name_token(token)
  }
}

fn chain_score(
  full_text: &str,
  chain: &[&ClassifiedToken<'_>],
  data: &PreparedNameCorpusData,
  mode: NameCorpusMode,
) -> Option<f64> {
  let has_title = chain.iter().any(|token| token.kind == TokenKind::Title);
  let has_corpus_name = chain.iter().any(|token| is_corpus_match(token.kind));
  let has_first_name = chain.iter().any(|token| token.kind == TokenKind::Name);
  let has_abbreviation = chain
    .iter()
    .any(|token| token.kind == TokenKind::Abbreviation);
  let has_non_western = chain.iter().any(|token| token.non_western);
  let has_ja_suffix =
    chain.iter().any(|token| token.kind == TokenKind::JaSuffix);
  let has_arabic_connector = chain
    .iter()
    .any(|token| token.kind == TokenKind::ArabicConnector);
  let capitalized_count = chain
    .iter()
    .filter(|token| token.kind == TokenKind::Capitalized)
    .count();
  let corpus_count = chain
    .iter()
    .filter(|token| is_corpus_match(token.kind))
    .count();
  let non_western_count =
    chain.iter().filter(|token| token.non_western).count();
  let chain_all_common_words = chain
    .iter()
    .all(|token| data.common_words.contains(&token.text.to_lowercase()));
  if has_non_western {
    let title_confidence =
      has_title && (non_western_count > 0 || capitalized_count > 0);
    let high_confidence = (has_ja_suffix
      && (capitalized_count > 0 || non_western_count > 0))
      || (has_arabic_connector && non_western_count > 0)
      || non_western_count >= 2
      || (non_western_count > 0
        && (capitalized_count > 0 || has_abbreviation)
        && !chain_all_common_words);
    let score = if title_confidence {
      TITLE_NAME_SCORE
    } else if high_confidence {
      HIGH_CONFIDENCE_NAME_SCORE
    } else if non_western_count == 1
      && chain.len() == 1
      && !is_sentence_start(full_text, chain.first()?.start)
    {
      LOW_CONFIDENCE_NAME_SCORE
    } else {
      return None;
    };
    if mode == NameCorpusMode::Supplemental
      && score < HIGH_CONFIDENCE_NAME_SCORE
    {
      return None;
    }
    return Some(score);
  }

  if mode == NameCorpusMode::Supplemental {
    return None;
  }

  if has_title && has_corpus_name {
    return Some(TITLE_NAME_SCORE);
  }
  if corpus_count >= 2 {
    return Some(HIGH_CONFIDENCE_NAME_SCORE);
  }
  if has_corpus_name && capitalized_count > 0 {
    return Some(0.7);
  }
  if has_abbreviation && has_corpus_name {
    return Some(0.7);
  }
  if has_first_name && chain.len() == 1 {
    let first = chain.first()?;
    if is_sentence_start(full_text, first.start)
      || (is_all_upper(first.text) && first.text.chars().count() >= 3)
    {
      return None;
    }
    return Some(LOW_CONFIDENCE_NAME_SCORE);
  }
  if !has_first_name
    && chain.len() == 1
    && chain.first()?.kind == TokenKind::Surname
  {
    return None;
  }
  if has_title && chain.len() == 1 {
    return None;
  }
  if has_ja_suffix || has_arabic_connector {
    if !has_corpus_name && !has_first_name {
      return None;
    }
    return Some(LOW_CONFIDENCE_NAME_SCORE);
  }
  has_corpus_name.then_some(LOW_CONFIDENCE_NAME_SCORE)
}

const fn is_corpus_match(kind: TokenKind) -> bool {
  matches!(kind, TokenKind::Name | TokenKind::Surname)
}

fn segment_words(full_text: &str) -> Vec<WordSegment<'_>> {
  let mut words = Vec::new();
  let mut start = None;
  let mut end = 0usize;
  for (index, ch) in full_text.char_indices() {
    if is_word_char(ch) {
      if start.is_none() {
        start = Some(index);
      }
      end = index.saturating_add(ch.len_utf8());
      continue;
    }
    if let Some(word_start) = start.take()
      && let Some(text) = full_text.get(word_start..end)
    {
      words.push(WordSegment {
        text,
        start: word_start,
        end,
      });
    }
  }
  if let Some(word_start) = start
    && let Some(text) = full_text.get(word_start..end)
  {
    words.push(WordSegment {
      text,
      start: word_start,
      end,
    });
  }
  words
}

fn relation_connector<'a>(
  word: &WordSegment<'a>,
  words: &[WordSegment<'a>],
  index: usize,
  full_text: &'a str,
  data: &PreparedNameCorpusData,
) -> Option<(&'a str, usize, usize)> {
  let lower = word.text.to_lowercase();
  if !data.relation_connector_prefixes.contains(&lower) {
    return None;
  }
  let next = words.get(index.saturating_add(1))?;
  if full_text.get(word.end..next.start)? != "/"
    || !next.text.eq_ignore_ascii_case("o")
  {
    return None;
  }
  let connector = full_text.get(word.start..next.end)?;
  data
    .relation_connectors
    .contains(&connector.to_lowercase())
    .then_some((connector, next.end, 2))
}

const fn classified<'a>(
  word: &WordSegment<'a>,
  kind: TokenKind,
  non_western: bool,
) -> ClassifiedToken<'a> {
  ClassifiedToken {
    text: word.text,
    kind,
    start: word.start,
    end: word.end,
    non_western,
    title_abbreviation: false,
  }
}

const fn is_chain_start(kind: TokenKind) -> bool {
  matches!(
    kind,
    TokenKind::Title
      | TokenKind::Name
      | TokenKind::Surname
      | TokenKind::Abbreviation
      | TokenKind::ArabicConnector
  )
}

fn covers_same_label(entity: &PipelineEntity, deny: &PipelineEntity) -> bool {
  entity.label == deny.label
    && deny.start <= entity.start
    && deny.end >= entity.end
}

fn deduplicate_spans(mut entities: Vec<PipelineEntity>) -> Vec<PipelineEntity> {
  entities.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| right.end.cmp(&left.end))
  });
  let mut result = Vec::new();
  for entity in entities {
    let keep = result
      .last()
      .is_none_or(|last: &PipelineEntity| entity.start >= last.end);
    if keep {
      result.push(entity);
    }
  }
  result
}

fn title_case_with_apostrophe(text: &str) -> String {
  let mut result = String::new();
  let mut uppercase_next = true;
  for ch in text.chars() {
    if uppercase_next {
      result.extend(ch.to_uppercase());
      uppercase_next = false;
    } else {
      result.extend(ch.to_lowercase());
    }
    if ch == '\'' {
      uppercase_next = true;
    }
  }
  result
}

fn title_case_simple(text: &str) -> String {
  let mut chars = text.chars();
  let Some(first) = chars.next() else {
    return String::new();
  };
  let mut result = String::new();
  result.extend(first.to_uppercase());
  result.push_str(&chars.as_str().to_lowercase());
  result
}

fn starts_uppercase(text: &str) -> bool {
  text.chars().next().is_some_and(char::is_uppercase)
}

fn is_all_upper(text: &str) -> bool {
  let mut letters = 0usize;
  for ch in text.chars() {
    if ch.is_alphabetic() {
      letters = letters.saturating_add(1);
      if !ch.is_uppercase() {
        return false;
      }
    }
  }
  letters > 0
}

fn is_abbreviation(text: &str) -> bool {
  let mut chars = text.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  chars.next() == Some('.') && chars.next().is_none() && first.is_uppercase()
}

fn is_multi_dot_abbreviation(text: &str) -> bool {
  let mut saw_upper = false;
  let mut previous_dot = true;
  for ch in text.chars() {
    if previous_dot {
      if !ch.is_uppercase() {
        return false;
      }
      saw_upper = true;
      previous_dot = false;
      continue;
    }
    if ch != '.' {
      return false;
    }
    previous_dot = true;
  }
  saw_upper
}

fn is_single_letter_initial(text: &str, end: usize, full_text: &str) -> bool {
  text.chars().count() == 1
    && starts_uppercase(text)
    && full_text
      .get(end..)
      .is_some_and(|tail| tail.starts_with('.'))
}

fn is_initial_continuation_gap(text: &str, gap: &str) -> bool {
  if text.chars().count() == 1 && starts_uppercase(text) {
    let Some(rest) = gap.strip_prefix('.') else {
      return false;
    };
    let spaces = rest
      .chars()
      .take_while(|ch| ch.is_whitespace() && *ch != '\n')
      .count();
    return (1..=2).contains(&spaces) && rest.chars().count() == spaces;
  }
  false
}

fn horizontal_gap_width(gap: &str) -> usize {
  if gap.chars().any(|ch| ch == '\n' || !ch.is_whitespace()) {
    return 0;
  }
  gap.chars().count()
}

fn is_sentence_start(text: &str, pos: usize) -> bool {
  if pos == 0 {
    return true;
  }
  let Some(before) = text.get(..pos) else {
    return false;
  };
  for ch in before.chars().rev() {
    if ch.is_whitespace() {
      continue;
    }
    return matches!(ch, '.' | '!' | '?');
  }
  true
}

fn is_all_caps_context_line(full_text: &str, start: usize) -> bool {
  let line = current_line(full_text, start);
  let mut letters = 0usize;
  let mut upper = 0usize;
  for ch in line.chars() {
    if ch.is_alphabetic() {
      letters = letters.saturating_add(1);
      if ch.is_uppercase() {
        upper = upper.saturating_add(1);
      }
    }
  }
  if letters < ALL_CAPS_NAME_LINE_MIN_LETTERS {
    return false;
  }
  let upper =
    u32::try_from(upper).map_or_else(|_| f64::from(u32::MAX), f64::from);
  let letters =
    u32::try_from(letters).map_or_else(|_| f64::from(u32::MAX), f64::from);
  upper / letters >= ALL_CAPS_NAME_LINE_RATIO
}

fn is_all_caps_line_name_shaped(full_text: &str, start: usize) -> bool {
  let line = current_line(full_text, start);
  if line.chars().any(|ch| ch.is_ascii_digit()) {
    return false;
  }
  let tokens = segment_words(line).len();
  tokens > 0 && tokens <= ALL_CAPS_NAME_LINE_MAX_TOKENS
}

fn current_line(full_text: &str, start: usize) -> &str {
  let line_start = full_text
    .get(..start)
    .and_then(|head| head.rfind('\n').map(|index| index.saturating_add(1)))
    .unwrap_or(0);
  let line_end = full_text
    .get(start..)
    .and_then(|tail| tail.find('\n').map(|index| start.saturating_add(index)))
    .unwrap_or(full_text.len());
  full_text.get(line_start..line_end).unwrap_or_default()
}

fn line_before(full_text: &str, start: usize) -> &str {
  let line_start = full_text
    .get(..start)
    .and_then(|head| head.rfind('\n').map(|index| index.saturating_add(1)))
    .unwrap_or(0);
  full_text.get(line_start..start).unwrap_or_default()
}

fn trailing_word(text: &str) -> Option<&str> {
  segment_words(text).last().map(|word| word.text)
}

fn leading_word(text: &str) -> Option<&str> {
  segment_words(text).first().map(|word| word.text)
}

fn is_word_char(ch: char) -> bool {
  ch.is_alphanumeric() || ch == '\''
}

fn string_set(values: Vec<String>) -> HashSet<String> {
  values.into_iter().collect()
}

fn lower_string_set(values: Vec<String>) -> HashSet<String> {
  values
    .into_iter()
    .map(|value| value.to_lowercase())
    .collect()
}

fn relation_connector_prefixes(
  relation_connectors: &HashSet<String>,
) -> HashSet<String> {
  relation_connectors
    .iter()
    .filter_map(|connector| connector.split_once('/').map(|(prefix, _)| prefix))
    .filter(|prefix| !prefix.is_empty())
    .map(ToOwned::to_owned)
    .collect()
}

fn usize_to_u32(value: usize, field: &'static str) -> Result<u32> {
  u32::try_from(value).map_err(|_| Error::InvalidStaticData {
    field,
    reason: String::from("offset exceeds u32 range"),
  })
}

fn invalid_name_data(reason: &'static str) -> Error {
  Error::InvalidStaticData {
    field: "name_corpus",
    reason: String::from(reason),
  }
}

#[cfg(test)]
#[allow(clippy::expect_used, clippy::indexing_slicing)]
mod tests {
  use super::*;

  #[test]
  fn full_mode_detects_western_corpus_chain() {
    let data = PreparedNameCorpusData::new(NameCorpusData {
      first_names: vec![String::from("Mina")],
      surnames: vec![String::from("Roe")],
      ..NameCorpusData::default()
    });

    let entities = data
      .detect("Agreement signed by Mina Roe.", NameCorpusMode::Full, &[])
      .expect("full name-corpus detection should succeed");

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Mina Roe");
    assert!(
      (entities[0].score - HIGH_CONFIDENCE_NAME_SCORE).abs() < f64::EPSILON
    );
  }

  #[test]
  fn supplemental_mode_rejects_western_only_chain() {
    let data = PreparedNameCorpusData::new(NameCorpusData {
      first_names: vec![String::from("Mina")],
      surnames: vec![String::from("Roe")],
      ..NameCorpusData::default()
    });

    let entities = data
      .detect_supplemental("Agreement signed by Mina Roe.", &[])
      .expect("supplemental name-corpus detection should succeed");

    assert!(entities.is_empty());
  }

  #[test]
  fn supplemental_detects_cjk_name_with_configured_surname() {
    let data = PreparedNameCorpusData::new(NameCorpusData {
      cjk_surname_starters: vec![String::from("王")],
      ..NameCorpusData::default()
    });

    let entities = data
      .detect_supplemental("Signed by 王小明 today.", &[])
      .expect("cjk detection should succeed");

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "王小明");
    assert!((entities[0].score - cjk::SCORE).abs() < f64::EPSILON);
  }

  #[test]
  fn supplemental_skips_names_covered_by_deny_list() {
    let data = PreparedNameCorpusData::new(NameCorpusData {
      cjk_surname_starters: vec![String::from("王")],
      ..NameCorpusData::default()
    });
    let text = "Signed by 王小明 today.";
    let start =
      u32::try_from(text.find("王小明").expect("fixture contains name"))
        .expect("offset fits");
    let end = start.saturating_add(
      u32::try_from("王小明".len()).expect("fixture span length fits"),
    );
    let deny = PipelineEntity::detected(
      start,
      end,
      PERSON_LABEL,
      "王小明",
      0.9,
      DetectionSource::DenyList,
    );

    let entities = data
      .detect_supplemental(text, &[deny])
      .expect("cjk detection should succeed");

    assert!(entities.is_empty());
  }

  #[test]
  fn supplemental_detects_non_western_chain() {
    let data = PreparedNameCorpusData::new(NameCorpusData {
      non_western_names: vec![String::from("Sato"), String::from("Kenji")],
      ja_suffixes: vec![String::from("san")],
      ..NameCorpusData::default()
    });

    let entities = data
      .detect_supplemental("The signer is Sato Kenji.", &[])
      .expect("name detection should succeed");

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Sato Kenji");
    assert!(
      (entities[0].score - HIGH_CONFIDENCE_NAME_SCORE).abs() < f64::EPSILON
    );
  }

  #[test]
  fn relation_connector_prefixes_come_from_data() {
    let data = PreparedNameCorpusData::new(NameCorpusData {
      non_western_names: vec![
        String::from("Rahul"),
        String::from("Kumar"),
        String::from("Vikram"),
      ],
      relation_connectors: vec![String::from("x/o")],
      ..NameCorpusData::default()
    });

    let entities = data
      .detect_supplemental("Rahul Kumar x/o Vikram Kumar signed.", &[])
      .expect("name detection should succeed");

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Rahul Kumar x/o Vikram Kumar");
  }

  #[test]
  fn supplemental_does_not_cross_signature_column_gap() {
    let data = PreparedNameCorpusData::new(NameCorpusData {
      non_western_names: vec![
        String::from("Priya"),
        String::from("Ramanathan"),
      ],
      ..NameCorpusData::default()
    });

    let entities = data
      .detect_supplemental(
        "Name: Priya Ramanathan                   Name: Jonathan",
        &[],
      )
      .expect("name detection should succeed");

    assert_eq!(entities.len(), 1);
    assert_eq!(entities[0].text, "Priya Ramanathan");
  }
}
