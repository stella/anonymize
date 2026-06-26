use regex::{Regex, RegexBuilder};

use crate::resolution::PipelineEntity;
use crate::types::{Error, Result};

const MIN_TABS_FOR_TABLE: usize = 2;

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct ZoneData {
  #[serde(default)]
  pub section_heading_patterns: Vec<ZonePatternData>,
  #[serde(default)]
  pub signing_clauses: Vec<ZoneSigningClauseData>,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Deserialize, serde::Serialize)]
pub struct ZonePatternData {
  pub pattern: String,
  #[serde(default)]
  pub flags: String,
}

#[derive(
  Clone, Debug, Default, Eq, PartialEq, serde::Deserialize, serde::Serialize,
)]
pub struct ZoneSigningClauseData {
  #[serde(default)]
  pub prefix: String,
  #[serde(default)]
  pub suffix: String,
  #[serde(default)]
  pub prepositions: Vec<String>,
}

pub(crate) struct PreparedZoneData {
  section_heading_patterns: Vec<Regex>,
  signing_clause_patterns: Vec<Regex>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DocumentZone {
  Header,
  Signature,
  Body,
  Table,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct ZoneSpan {
  zone: DocumentZone,
  start: u32,
  end: u32,
}

struct Line<'a> {
  text: &'a str,
  start: usize,
}

pub(crate) struct ZoneAdjustmentResult {
  pub(crate) entities: Vec<PipelineEntity>,
  pub(crate) boosted: usize,
}

impl PreparedZoneData {
  pub(crate) fn new(data: &ZoneData) -> Result<Self> {
    Ok(Self {
      section_heading_patterns: data
        .section_heading_patterns
        .iter()
        .map(|pattern| {
          compile_pattern("zone_data.section_heading_patterns", pattern)
        })
        .collect::<Result<Vec<_>>>()?,
      signing_clause_patterns: data
        .signing_clauses
        .iter()
        .map(compile_signing_clause_pattern)
        .collect::<Result<Vec<_>>>()?,
    })
  }

  pub(crate) fn adjust_entities(
    &self,
    full_text: &str,
    entities: Vec<PipelineEntity>,
  ) -> Result<ZoneAdjustmentResult> {
    if entities.is_empty() {
      return Ok(ZoneAdjustmentResult {
        entities,
        boosted: 0,
      });
    }

    let zones = self.classify(full_text)?;
    let mut boosted: usize = 0;
    let adjusted = entities
      .into_iter()
      .map(|mut entity| {
        let zone = zone_for_entity(&zones, &entity);
        let adjustment = score_adjustment(zone);
        if adjustment > 0.0 {
          let score = f64::min(1.0, entity.score + adjustment);
          if score > entity.score {
            boosted = boosted.saturating_add(1);
            entity.score = score;
          }
        }
        entity
      })
      .collect();

    Ok(ZoneAdjustmentResult {
      entities: adjusted,
      boosted,
    })
  }

  fn classify(&self, full_text: &str) -> Result<Vec<ZoneSpan>> {
    if full_text.is_empty() {
      return Ok(Vec::new());
    }

    let lines = split_lines(full_text);
    let header_end_line =
      first_matching_line(&lines, &self.section_heading_patterns);
    let signature_start_line =
      last_matching_line(&lines, &self.signing_clause_patterns);

    let mut header_end_offset = header_end_line
      .and_then(|line| lines.get(line))
      .map_or(0, |line| line.start);
    let signature_start_offset = signature_start_line
      .and_then(|line| lines.get(line))
      .map_or(full_text.len(), |line| line.start);

    let mut header_line = header_end_line;
    if header_end_line.is_some_and(|line| line > 0)
      && signature_start_line.is_some()
      && header_end_offset > signature_start_offset
    {
      header_line = None;
      header_end_offset = 0;
    }

    let mut zones = Vec::new();
    if header_line.is_some_and(|line| line > 0) {
      zones.push(ZoneSpan {
        zone: DocumentZone::Header,
        start: usize_to_u32("zone.header.start", 0)?,
        end: usize_to_u32("zone.header.end", header_end_offset)?,
      });
    }

    let body_start = if header_line.is_some_and(|line| line > 0) {
      header_end_offset
    } else {
      0
    };
    let body_end = signature_start_offset;
    add_table_zones(
      &mut zones,
      &lines,
      header_line.unwrap_or(0),
      signature_start_line.unwrap_or(lines.len()),
      body_end,
    )?;
    add_body_zones(&mut zones, body_start, body_end)?;

    if signature_start_line.is_some() {
      zones.push(ZoneSpan {
        zone: DocumentZone::Signature,
        start: usize_to_u32("zone.signature.start", signature_start_offset)?,
        end: usize_to_u32("zone.signature.end", full_text.len())?,
      });
    }

    zones.sort_by_key(|zone| zone.start);
    Ok(zones)
  }
}

fn first_matching_line(
  lines: &[Line<'_>],
  patterns: &[Regex],
) -> Option<usize> {
  for (index, line) in lines.iter().enumerate() {
    if patterns.iter().any(|pattern| pattern.is_match(line.text)) {
      return Some(index);
    }
  }
  None
}

fn last_matching_line(lines: &[Line<'_>], patterns: &[Regex]) -> Option<usize> {
  for (index, line) in lines.iter().enumerate().rev() {
    if patterns.iter().any(|pattern| pattern.is_match(line.text)) {
      return Some(index);
    }
  }
  None
}

fn add_table_zones(
  zones: &mut Vec<ZoneSpan>,
  lines: &[Line<'_>],
  start_line: usize,
  end_line: usize,
  body_end: usize,
) -> Result<()> {
  let mut table_start = None;
  for line in lines
    .iter()
    .enumerate()
    .skip(start_line)
    .take(end_line.saturating_sub(start_line))
    .map(|(_, line)| line)
  {
    if is_table_line(line.text) {
      table_start.get_or_insert(line.start);
      continue;
    }

    if let Some(start) = table_start.take() {
      zones.push(ZoneSpan {
        zone: DocumentZone::Table,
        start: usize_to_u32("zone.table.start", start)?,
        end: usize_to_u32("zone.table.end", line.start)?,
      });
    }
  }

  if let Some(start) = table_start {
    zones.push(ZoneSpan {
      zone: DocumentZone::Table,
      start: usize_to_u32("zone.table.start", start)?,
      end: usize_to_u32("zone.table.end", body_end)?,
    });
  }

  Ok(())
}

fn add_body_zones(
  zones: &mut Vec<ZoneSpan>,
  body_start: usize,
  body_end: usize,
) -> Result<()> {
  let mut special = zones.clone();
  special.sort_by_key(|zone| zone.start);

  let mut cursor = usize_to_u32("zone.body.start", body_start)?;
  let body_end = usize_to_u32("zone.body.end", body_end)?;
  for span in special {
    if span.zone == DocumentZone::Header {
      continue;
    }
    if span.start > cursor {
      zones.push(ZoneSpan {
        zone: DocumentZone::Body,
        start: cursor,
        end: span.start,
      });
    }
    cursor = u32::max(cursor, span.end);
  }

  if cursor < body_end {
    zones.push(ZoneSpan {
      zone: DocumentZone::Body,
      start: cursor,
      end: body_end,
    });
  }

  Ok(())
}

fn zone_for_entity(
  zones: &[ZoneSpan],
  entity: &PipelineEntity,
) -> DocumentZone {
  let midpoint = f64::midpoint(f64::from(entity.start), f64::from(entity.end));
  for zone in zones {
    if midpoint >= f64::from(zone.start) && midpoint < f64::from(zone.end) {
      return zone.zone;
    }
  }
  DocumentZone::Body
}

const fn score_adjustment(zone: DocumentZone) -> f64 {
  match zone {
    DocumentZone::Header => 0.1,
    DocumentZone::Signature => 0.15,
    DocumentZone::Body => 0.0,
    DocumentZone::Table => 0.05,
  }
}

fn split_lines(full_text: &str) -> Vec<Line<'_>> {
  let mut offset: usize = 0;
  let mut lines = Vec::new();
  for line in full_text.split('\n') {
    let start = offset;
    let end = start.saturating_add(line.len());
    lines.push(Line { text: line, start });
    offset = end.saturating_add(1);
  }
  lines
}

fn is_table_line(line: &str) -> bool {
  line
    .chars()
    .filter(|ch| *ch == '\t')
    .take(MIN_TABS_FOR_TABLE)
    .count()
    >= MIN_TABS_FOR_TABLE
}

fn compile_pattern(
  field: &'static str,
  data: &ZonePatternData,
) -> Result<Regex> {
  let mut builder = RegexBuilder::new(&data.pattern);
  for flag in data.flags.chars() {
    match flag {
      'u' => {}
      'i' => {
        builder.case_insensitive(true);
      }
      'm' => {
        builder.multi_line(true);
      }
      's' => {
        builder.dot_matches_new_line(true);
      }
      _ => {
        return Err(Error::InvalidStaticData {
          field,
          reason: format!("unsupported regex flag '{flag}'"),
        });
      }
    }
  }
  builder.build().map_err(|error| Error::InvalidStaticData {
    field,
    reason: error.to_string(),
  })
}

fn compile_signing_clause_pattern(
  data: &ZoneSigningClauseData,
) -> Result<Regex> {
  let place = if data.prepositions.is_empty() {
    String::from(r"\p{Lu}\p{Ll}+(?:[- ]\p{Lu}\p{Ll}+)*")
  } else {
    format!(
      r"\p{{Lu}}\p{{Ll}}+(?:\s+(?:{})\s+\p{{Lu}}\p{{Ll}}+)*(?:\s+\p{{Lu}}\p{{Ll}}+)*",
      data.prepositions.join("|")
    )
  };
  let pattern = format!(r"^\s*(?:{}{}{})", data.prefix, place, data.suffix);
  compile_pattern(
    "zone_data.signing_clauses",
    &ZonePatternData {
      pattern,
      flags: String::new(),
    },
  )
}

fn usize_to_u32(field: &'static str, value: usize) -> Result<u32> {
  u32::try_from(value).map_err(|_| Error::InvalidStaticData {
    field,
    reason: String::from("offset exceeds u32 range"),
  })
}

#[cfg(test)]
mod tests {
  #![allow(clippy::expect_used, clippy::indexing_slicing, clippy::unwrap_used)]

  use super::*;
  use crate::resolution::{DetectionSource, PipelineEntity};

  fn test_data() -> PreparedZoneData {
    PreparedZoneData::new(&ZoneData {
      section_heading_patterns: vec![ZonePatternData {
        pattern: String::from(r"^\s*(?:Article|Článek)\s*1"),
        flags: String::from("iu"),
      }],
      signing_clauses: vec![ZoneSigningClauseData {
        prefix: String::from(r"(?:V|Ve)\s+"),
        suffix: String::from(r"\s*,?\s*dne"),
        prepositions: vec![String::from("nad")],
      }],
    })
    .unwrap()
  }

  #[test]
  fn classifies_header_table_and_signature_zones() {
    let data = test_data();
    let text = [
      "Parties",
      "Alice",
      "Article 1",
      "Name\tAddress\tId",
      "Alice\tPrague\t123",
      "Body",
      "V Praze dne 1.1.2024",
      "Alice",
    ]
    .join("\n");

    let zones = data.classify(&text).unwrap();

    assert_eq!(zones.first().unwrap().zone, DocumentZone::Header);
    assert!(zones.iter().any(|zone| zone.zone == DocumentZone::Table));
    assert_eq!(zones.last().unwrap().zone, DocumentZone::Signature);
    assert_eq!(zones.first().unwrap().start, 0);
    assert_eq!(
      zones.last().unwrap().end,
      u32::try_from(text.len()).unwrap()
    );
  }

  #[test]
  fn boosts_scores_for_pii_dense_zones() {
    let data = test_data();
    let text = ["Alice", "Article 1"].join("\n");
    let entities = vec![PipelineEntity::detected(
      0,
      5,
      "person",
      "Alice",
      0.45,
      DetectionSource::Regex,
    )];

    let adjusted = data.adjust_entities(&text, entities).unwrap();

    assert_eq!(adjusted.boosted, 1);
    assert!((adjusted.entities[0].score - 0.55).abs() < 1e-12);
  }
}
