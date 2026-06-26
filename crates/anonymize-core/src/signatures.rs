use crate::resolution::{DetectionSource, PipelineEntity};

const PERSON_LABEL: &str = "person";
const MAX_NAME_LEN: usize = 60;
const MAX_WITNESS_SCAN_BYTES: usize = 600;
const NAME_PARTICLES: &[&str] = &[
  "de",
  "del",
  "della",
  "der",
  "den",
  "di",
  "du",
  "da",
  "das",
  "do",
  "dos",
  "el",
  "la",
  "le",
  "van",
  "von",
  "y",
  "zu",
  "af",
  "ben",
  "bin",
  "al",
  "d'",
  "d\u{2019}",
];
const POST_NOMINAL_SUFFIXES: &[&str] = &[
  "jr", "sr", "ii", "iii", "iv", "v", "esq", "esquire", "md", "phd", "jd",
  "llm", "mba", "cpa", "pe", "rn", "dds", "dvm", "do", "cfa", "cfp",
];
const ORG_SUFFIXES: &[&str] = &[
  "inc",
  "inc.",
  "llc",
  "llp",
  "lp",
  "corp",
  "corp.",
  "corporation",
  "ltd",
  "ltd.",
  "gmbh",
  "ag",
  "se",
  "kg",
  "ohg",
  "sa",
  "sas",
  "sarl",
  "s.a",
  "s.a.",
  "s.p.a",
  "s.p.a.",
  "plc",
  "n.a",
  "n.a.",
  "n.v",
  "n.v.",
  "b.v",
  "b.v.",
  "pty ltd",
  "pty ltd.",
  "co",
  "co.",
  "s.r.o",
  "s.r.o.",
  "a.s",
  "a.s.",
  "z.s",
  "z.s.",
  "s.p",
  "s.p.",
  "s. p.",
  "ltda",
  "ltda.",
  "eireli",
  "epp",
  "s/a",
];

#[must_use]
pub(crate) fn detect_signatures(full_text: &str) -> Vec<PipelineEntity> {
  let mut results = Vec::new();
  detect_slash_s(full_text, &mut results);
  detect_labelled_names(full_text, &mut results);
  detect_witness_blocks(full_text, &mut results);
  results
}

fn detect_slash_s(full_text: &str, results: &mut Vec<PipelineEntity>) {
  let mut cursor = 0usize;
  while let Some(relative) =
    full_text.get(cursor..).and_then(|tail| tail.find("/s/"))
  {
    let mark_start = cursor.saturating_add(relative);
    let mut after_mark = mark_start.saturating_add("/s/".len());
    after_mark = skip_horizontal_ws(full_text, after_mark);
    let line_end = find_line_end(full_text, after_mark);
    let same_line = full_text
      .get(after_mark..line_end)
      .unwrap_or_default()
      .trim();
    if same_line.is_empty() {
      try_emit_forward_lines(
        results,
        full_text,
        line_end.saturating_add(1),
        4,
        0.9,
      );
    } else {
      let first_cell_end = after_mark.saturating_add(
        full_text
          .get(after_mark..line_end)
          .and_then(first_column_end)
          .unwrap_or_else(|| line_end.saturating_sub(after_mark)),
      );
      try_emit(results, full_text, after_mark, first_cell_end, 0.95);
    }

    if let Some((prev_start, prev_end)) = find_prev_line(full_text, mark_start)
    {
      try_emit(results, full_text, prev_start, prev_end, 0.85);
    }
    cursor = mark_start.saturating_add("/s/".len());
  }
}

fn detect_labelled_names(full_text: &str, results: &mut Vec<PipelineEntity>) {
  let mut line_start = 0usize;
  while line_start <= full_text.len() {
    let line_end = find_line_end(full_text, line_start);
    if let Some(line) = full_text.get(line_start..line_end) {
      detect_labelled_names_in_line(full_text, line_start, line, results);
    }
    if line_end >= full_text.len() {
      break;
    }
    line_start = line_end.saturating_add(1);
  }
}

fn detect_labelled_names_in_line(
  full_text: &str,
  line_start: usize,
  line: &str,
  results: &mut Vec<PipelineEntity>,
) {
  let mut cursor = 0usize;
  while let Some(label) = find_label(line, cursor) {
    let mut value_start = label.value_start;
    if let Some(after_slash) = slash_s_prefix_end(line, value_start) {
      value_start = after_slash;
    }
    let value_end = value_start.saturating_add(
      line
        .get(value_start..)
        .and_then(first_column_end)
        .unwrap_or_else(|| line.len().saturating_sub(value_start)),
    );
    let global_start = line_start.saturating_add(value_start);
    let global_end = line_start.saturating_add(value_end);
    let value_is_empty = line
      .get(value_start..value_end)
      .unwrap_or_default()
      .trim()
      .is_empty();
    if value_is_empty {
      try_emit_forward_lines(
        results,
        full_text,
        global_end.saturating_add(1),
        3,
        0.9,
      );
    } else {
      try_emit(results, full_text, global_start, global_end, 0.95);
    }
    cursor = value_end.max(label.next_cursor);
  }
}

fn detect_witness_blocks(full_text: &str, results: &mut Vec<PipelineEntity>) {
  let mut cursor = 0usize;
  while let Some(relative) = find_ascii_case_insensitive(
    full_text.get(cursor..).unwrap_or_default(),
    "in witness whereof",
  ) {
    let anchor = cursor.saturating_add(relative);
    if !has_word_boundaries(full_text, anchor, "in witness whereof".len()) {
      cursor = anchor.saturating_add(1);
      continue;
    }
    let anchor_line_end = find_line_end(full_text, anchor);
    if anchor_line_end >= full_text.len() {
      break;
    }
    let limit =
      advance_char_boundary(full_text, anchor, MAX_WITNESS_SCAN_BYTES);
    if let Some(scan_from) = find_witness_sentence_end(full_text, anchor, limit)
    {
      try_emit_forward_lines(results, full_text, scan_from, 6, 0.85);
    }
    cursor = anchor.saturating_add("in witness whereof".len());
  }
}

fn try_emit_forward_lines(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  from_pos: usize,
  max_lines: usize,
  score: f64,
) -> bool {
  let mut pos = from_pos;
  for _ in 0..max_lines {
    if pos >= full_text.len() {
      return false;
    }
    let line_end = find_line_end(full_text, pos);
    let line = full_text.get(pos..line_end).unwrap_or_default().trim();
    if !line.is_empty()
      && !is_image_stub(line)
      && try_emit(results, full_text, pos, line_end, score)
    {
      return true;
    }
    pos = line_end.saturating_add(1);
  }
  false
}

fn try_emit(
  results: &mut Vec<PipelineEntity>,
  full_text: &str,
  start: usize,
  end: usize,
  score: f64,
) -> bool {
  let raw = full_text.get(start..end).unwrap_or_default();
  if contains_org_suffix(raw) {
    return false;
  }
  let candidate = normalise_candidate(raw);
  if !is_name_shape(&candidate) {
    return false;
  }
  let Some(offset) = raw.find(&candidate) else {
    return false;
  };
  let abs_start = start.saturating_add(offset);
  let abs_end = abs_start.saturating_add(candidate.len());
  let Ok(start_u32) = u32::try_from(abs_start) else {
    return false;
  };
  let Ok(end_u32) = u32::try_from(abs_end) else {
    return false;
  };
  results.push(PipelineEntity::detected(
    start_u32,
    end_u32,
    PERSON_LABEL,
    candidate,
    score,
    DetectionSource::Trigger,
  ));
  true
}

fn normalise_candidate(text: &str) -> String {
  let stripped = strip_post_nominal_suffix(text.trim());
  let first_cell_end = first_column_end(stripped).unwrap_or(stripped.len());
  stripped
    .get(..first_cell_end)
    .unwrap_or(stripped)
    .trim()
    .to_owned()
}

fn strip_post_nominal_suffix(text: &str) -> &str {
  let Some(comma) = text.rfind(',') else {
    return text;
  };
  let suffix = text
    .get(comma.saturating_add(1)..)
    .unwrap_or_default()
    .trim()
    .trim_end_matches('.');
  let compact = suffix
    .chars()
    .filter(|ch| *ch != '.')
    .collect::<String>()
    .to_lowercase();
  if POST_NOMINAL_SUFFIXES.contains(&compact.as_str()) {
    return text.get(..comma).unwrap_or(text).trim();
  }
  text
}

fn is_name_shape(text: &str) -> bool {
  let text_len = text.chars().map(char::len_utf16).sum::<usize>();
  if !(3..=MAX_NAME_LEN).contains(&text_len) {
    return false;
  }
  let tokens = text.split([' ', '\t']).filter(|token| !token.is_empty());
  let tokens = tokens.collect::<Vec<_>>();
  if !(2..=5).contains(&tokens.len()) {
    return false;
  }
  let Some(first) = tokens.first() else {
    return false;
  };
  if !is_cap_token(first) {
    return false;
  }
  tokens
    .iter()
    .skip(1)
    .all(|token| is_name_particle(token) || is_cap_token(token))
}

fn is_cap_token(token: &str) -> bool {
  let mut chars = token.chars();
  let Some(first) = chars.next() else {
    return false;
  };
  first.is_uppercase()
    && chars.take(30).all(|ch| {
      ch.is_alphabetic()
        || matches!(ch, '\u{0300}'..='\u{036f}' | '.' | '\'' | '-' | '’')
    })
}

fn is_name_particle(token: &str) -> bool {
  NAME_PARTICLES.contains(&token)
}

fn contains_org_suffix(text: &str) -> bool {
  let lower = text.to_lowercase();
  ORG_SUFFIXES
    .iter()
    .any(|suffix| contains_bounded(&lower, suffix))
}

fn contains_bounded(text: &str, needle: &str) -> bool {
  let mut cursor = 0usize;
  while let Some(relative) =
    text.get(cursor..).and_then(|tail| tail.find(needle))
  {
    let start = cursor.saturating_add(relative);
    let end = start.saturating_add(needle.len());
    if boundary_before(text, start) && boundary_after(text, end) {
      return true;
    }
    cursor = start.saturating_add(1);
  }
  false
}

fn boundary_before(text: &str, byte: usize) -> bool {
  char_before(text, byte).is_none_or(|ch| !ch.is_alphanumeric())
}

fn boundary_after(text: &str, byte: usize) -> bool {
  char_after(text, byte).is_none_or(|ch| !ch.is_alphanumeric())
}

fn first_column_end(text: &str) -> Option<usize> {
  let mut run_start = None::<usize>;
  let mut run_len = 0usize;
  for (index, ch) in text.char_indices() {
    if ch == '\t' {
      return Some(index);
    }
    if ch.is_whitespace() {
      if run_start.is_none() {
        run_start = Some(index);
      }
      run_len = run_len.saturating_add(1);
      if run_len >= 3 {
        return run_start;
      }
      continue;
    }
    run_start = None;
    run_len = 0;
  }
  None
}

#[derive(Clone, Copy)]
struct LabelMatch {
  value_start: usize,
  next_cursor: usize,
}

fn find_label(line: &str, from: usize) -> Option<LabelMatch> {
  let mut cursor = from;
  while cursor < line.len() {
    if !line.is_char_boundary(cursor) {
      cursor = cursor.saturating_add(1);
      continue;
    }
    if let Some(after_label) = label_end_at(line, cursor) {
      let mut after_spaces = skip_horizontal_ws(line, after_label);
      if line.get(after_spaces..)?.starts_with(':') {
        after_spaces = skip_horizontal_ws(line, after_spaces.saturating_add(1));
        return Some(LabelMatch {
          value_start: after_spaces,
          next_cursor: after_spaces.saturating_add(1),
        });
      }
    }
    cursor = cursor.saturating_add(1);
  }
  None
}

fn label_end_at(line: &str, start: usize) -> Option<usize> {
  if !boundary_before(line, start) {
    return None;
  }
  if starts_with_ascii_ci(line.get(start..)?, "by") {
    let end = start.saturating_add("by".len());
    return label_tail_is_valid(line, end).then_some(end);
  }
  if starts_with_ascii_ci(line.get(start..)?, "name") {
    let end = start.saturating_add("name".len());
    return label_tail_is_valid(line, end).then_some(end);
  }
  None
}

fn label_tail_is_valid(line: &str, end: usize) -> bool {
  line
    .get(end..)
    .and_then(|tail| tail.chars().next())
    .is_some_and(|ch| ch == ':' || ch == ' ' || ch == '\t')
}

fn slash_s_prefix_end(line: &str, start: usize) -> Option<usize> {
  let tail = line.get(start..)?;
  if !tail.starts_with("/s/") {
    return None;
  }
  let after = start.saturating_add("/s/".len());
  let has_space = line
    .get(after..)
    .and_then(|value| value.chars().next())
    .is_some_and(|ch| ch == ' ' || ch == '\t');
  has_space.then(|| skip_horizontal_ws(line, after))
}

fn skip_horizontal_ws(text: &str, from: usize) -> usize {
  let mut cursor = from;
  while let Some(ch) = text.get(cursor..).and_then(|tail| tail.chars().next()) {
    if ch != ' ' && ch != '\t' {
      break;
    }
    cursor = cursor.saturating_add(ch.len_utf8());
  }
  cursor
}

fn find_line_end(text: &str, pos: usize) -> usize {
  text
    .get(pos..)
    .and_then(|tail| tail.find('\n'))
    .map_or(text.len(), |relative| pos.saturating_add(relative))
}

fn find_prev_line(full_text: &str, pos: usize) -> Option<(usize, usize)> {
  if pos == 0 {
    return None;
  }
  let bytes = full_text.as_bytes();
  let mut cursor = pos.saturating_sub(1);
  while cursor > 0 && bytes.get(cursor).copied() != Some(b'\n') {
    cursor = cursor.saturating_sub(1);
  }
  if bytes.get(cursor).copied() != Some(b'\n') {
    return None;
  }

  while cursor > 0 {
    let line_end = cursor;
    let mut line_start = line_end;
    while line_start > 0
      && bytes.get(line_start.saturating_sub(1)).copied() != Some(b'\n')
    {
      line_start = line_start.saturating_sub(1);
    }
    let line = full_text
      .get(line_start..line_end)
      .unwrap_or_default()
      .trim();
    if !line.is_empty() && !is_image_stub(line) {
      return Some((line_start, line_end));
    }
    if line_start == 0 {
      break;
    }
    cursor = line_start.saturating_sub(1);
  }
  None
}

fn find_witness_sentence_end(
  full_text: &str,
  from: usize,
  limit: usize,
) -> Option<usize> {
  let mut line_start = from;
  while line_start < limit {
    let line_end = find_line_end(full_text, line_start).min(limit);
    let line = full_text
      .get(line_start..line_end)
      .unwrap_or_default()
      .trim_end();
    if line.ends_with('.') || line.ends_with(':') || line.ends_with(';') {
      return Some(line_end.saturating_add(1));
    }
    let next_start = line_end.saturating_add(1);
    if next_start >= limit {
      return None;
    }
    let next_end = find_line_end(full_text, next_start).min(limit);
    let next_line_empty = full_text
      .get(next_start..next_end)
      .unwrap_or_default()
      .trim()
      .is_empty();
    if next_line_empty {
      return Some(next_end.saturating_add(1));
    }
    line_start = next_start;
  }
  None
}

fn advance_char_boundary(text: &str, start: usize, max_bytes: usize) -> usize {
  let limit = start.saturating_add(max_bytes).min(text.len());
  if text.is_char_boundary(limit) {
    return limit;
  }
  let mut cursor = limit;
  while cursor > start && !text.is_char_boundary(cursor) {
    cursor = cursor.saturating_sub(1);
  }
  cursor
}

fn find_ascii_case_insensitive(text: &str, needle: &str) -> Option<usize> {
  let needle_len = needle.len();
  if needle_len == 0 || text.len() < needle_len {
    return None;
  }
  let mut cursor = 0usize;
  while cursor.saturating_add(needle_len) <= text.len() {
    if text.is_char_boundary(cursor)
      && starts_with_ascii_ci(text.get(cursor..)?, needle)
    {
      return Some(cursor);
    }
    cursor = cursor.saturating_add(1);
  }
  None
}

fn starts_with_ascii_ci(text: &str, prefix: &str) -> bool {
  let Some(candidate) = text.get(..prefix.len()) else {
    return false;
  };
  candidate.eq_ignore_ascii_case(prefix)
}

fn has_word_boundaries(text: &str, start: usize, len: usize) -> bool {
  boundary_before(text, start)
    && boundary_after(text, start.saturating_add(len))
}

fn char_before(text: &str, byte: usize) -> Option<char> {
  text.get(..byte)?.chars().next_back()
}

fn char_after(text: &str, byte: usize) -> Option<char> {
  text.get(byte..)?.chars().next()
}

fn is_image_stub(line: &str) -> bool {
  let lower = line.trim_start().to_lowercase();
  lower.starts_with("[img")
    || lower.starts_with("[image")
    || lower.starts_with("[logo")
    || lower.starts_with("(logo")
}

#[cfg(test)]
mod tests {
  use super::detect_signatures;

  #[test]
  fn detects_slash_signature_same_line() {
    let entities = detect_signatures("/s/ Jane Doe   Chief Executive Officer");

    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities.first().map(|entity| entity.text.as_str()),
      Some("Jane Doe")
    );
  }

  #[test]
  fn counts_signature_name_length_in_text_units() {
    let name = "Élodie ŽluťoučkýKůňÚpělĎábelskéÓdyÁÉÍÓÚÝČĎĚŇŘŠŤŽ";
    assert!(name.len() > super::MAX_NAME_LEN);
    assert!(
      name.chars().map(char::len_utf16).sum::<usize>() <= super::MAX_NAME_LEN
    );

    let entities = detect_signatures(&format!("/s/ {name}"));

    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities.first().map(|entity| entity.text.as_str()),
      Some(name)
    );
  }

  #[test]
  fn detects_multiple_labelled_name_columns() {
    let entities =
      detect_signatures("Name: Priya Ramanathan   Name: Jonathan H. Whitaker");

    assert_eq!(
      entities
        .iter()
        .map(|entity| entity.text.as_str())
        .collect::<Vec<_>>(),
      vec!["Priya Ramanathan", "Jonathan H. Whitaker"]
    );
  }

  #[test]
  fn skips_organization_caption_before_signature_mark() {
    let entities = detect_signatures("TWITTER, INC.\n/s/ Jane Doe");

    assert_eq!(entities.len(), 1);
    assert_eq!(
      entities.first().map(|entity| entity.text.as_str()),
      Some("Jane Doe")
    );
  }
}
