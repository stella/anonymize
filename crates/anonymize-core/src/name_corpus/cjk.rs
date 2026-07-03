use crate::resolution::{DetectionSource, PipelineEntity};
use crate::types::Result;

use super::{
  PERSON_LABEL, PreparedNameCorpusData, invalid_name_data, usize_to_u32,
};

const HAN_RATIO_NUMERATOR: usize = 15;
const HAN_RATIO_DENOMINATOR: usize = 100;
pub(super) const SCORE: f64 = 0.95;

pub(super) fn detect(
  data: &PreparedNameCorpusData,
  full_text: &str,
) -> Result<Vec<PipelineEntity>> {
  if data.cjk_surname_starters.is_empty() {
    return Ok(Vec::new());
  }

  let mut text_len = 0usize;
  let mut han_count = 0usize;
  let mut runs = Vec::new();
  let mut run_start = None;
  let mut run_chars = 0usize;
  let mut previous_end = 0usize;

  for (index, ch) in full_text.char_indices() {
    text_len = text_len.saturating_add(1);
    if is_han(ch) {
      han_count = han_count.saturating_add(1);
      if run_start.is_none() {
        run_start = Some(index);
      }
      run_chars = run_chars.saturating_add(1);
      previous_end = index.saturating_add(ch.len_utf8());
      continue;
    }

    push_run_candidate(run_start, previous_end, run_chars, &mut runs);
    run_start = None;
    run_chars = 0;
  }
  push_run_candidate(run_start, full_text.len(), run_chars, &mut runs);
  let threshold =
    ceil_ratio(text_len, HAN_RATIO_NUMERATOR, HAN_RATIO_DENOMINATOR).max(1);
  if text_len >= 100 && han_count >= threshold {
    return Ok(Vec::new());
  }

  let mut entities = Vec::with_capacity(runs.len());
  for run in runs {
    push_run(data, full_text, run, &mut entities)?;
  }
  Ok(entities)
}

#[derive(Clone, Copy)]
struct HanRun {
  start: usize,
  end: usize,
}

fn push_run_candidate(
  start: Option<usize>,
  end: usize,
  char_count: usize,
  runs: &mut Vec<HanRun>,
) {
  if !(2..=4).contains(&char_count) {
    return;
  }
  let Some(start) = start else {
    return;
  };
  runs.push(HanRun { start, end });
}

fn push_run(
  data: &PreparedNameCorpusData,
  full_text: &str,
  run: HanRun,
  entities: &mut Vec<PipelineEntity>,
) -> Result<()> {
  let Some(text) = full_text.get(run.start..run.end) else {
    return Err(invalid_name_data("cjk span is not a UTF-8 boundary"));
  };
  if !data.is_likely_cjk_person_name(text) || data.is_organization(text) {
    return Ok(());
  }
  entities.push(PipelineEntity::detected(
    usize_to_u32(run.start, "name_corpus.cjk.start")?,
    usize_to_u32(run.end, "name_corpus.cjk.end")?,
    PERSON_LABEL,
    text,
    SCORE,
    DetectionSource::Regex,
  ));
  Ok(())
}

const fn ceil_ratio(
  value: usize,
  numerator: usize,
  denominator: usize,
) -> usize {
  value.saturating_mul(numerator).div_ceil(denominator)
}

const fn is_han(ch: char) -> bool {
  matches!(
    ch,
    '\u{3400}'..='\u{4DBF}'
      | '\u{4E00}'..='\u{9FFF}'
      | '\u{F900}'..='\u{FAFF}'
      | '\u{20000}'..='\u{2A6DF}'
      | '\u{2A700}'..='\u{2B73F}'
      | '\u{2B740}'..='\u{2B81F}'
      | '\u{2B820}'..='\u{2CEAF}'
      | '\u{2CEB0}'..='\u{2EBEF}'
      | '\u{30000}'..='\u{3134F}'
  )
}
