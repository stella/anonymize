use crate::resolution::PipelineEntity;
use crate::search::{SearchIndex, SearchOptions, SearchPattern};
use crate::types::{Result, SearchMatch};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct AnchorSpan {
  pub start: usize,
  pub end: usize,
}

pub(crate) struct AnchorTerm {
  text: String,
  case_insensitive: bool,
  whole_words: bool,
}

impl AnchorTerm {
  pub(crate) const fn new(
    text: String,
    case_insensitive: bool,
    whole_words: bool,
  ) -> Self {
    Self {
      text,
      case_insensitive,
      whole_words,
    }
  }

  pub(crate) const fn word_case_insensitive(text: String) -> Self {
    Self {
      text,
      case_insensitive: true,
      whole_words: true,
    }
  }

  pub(crate) const fn word_case_sensitive(text: String) -> Self {
    Self {
      text,
      case_insensitive: false,
      whole_words: true,
    }
  }

  pub(crate) const fn symbol(text: String) -> Self {
    Self {
      text,
      case_insensitive: false,
      whole_words: false,
    }
  }
}

pub(crate) trait AnchoredRule {
  fn anchor_terms(&self) -> Vec<AnchorTerm>;

  fn extract(
    &self,
    full_text: &str,
    anchor: AnchorSpan,
  ) -> Result<Vec<PipelineEntity>>;
}

pub(crate) struct AnchoredExtractor<R> {
  search: SearchIndex,
  rule: R,
}

impl<R: AnchoredRule> AnchoredExtractor<R> {
  pub(crate) fn new(rule: R) -> Result<Option<Self>> {
    let anchors = rule.anchor_terms();
    if anchors.is_empty() {
      return Ok(None);
    }

    Ok(Some(Self {
      search: SearchIndex::new(
        anchors
          .into_iter()
          .map(|anchor| SearchPattern::LiteralWithOptions {
            pattern: anchor.text,
            case_insensitive: Some(anchor.case_insensitive),
            whole_words: Some(anchor.whole_words),
          })
          .collect(),
        SearchOptions::default(),
      )?,
      rule,
    }))
  }

  pub(crate) fn extract(&self, full_text: &str) -> Result<Vec<PipelineEntity>> {
    let mut entities = Vec::new();
    for found in self.search.find_iter(full_text)? {
      let anchor = anchor_span(&found);
      entities.extend(self.rule.extract(full_text, anchor)?);
    }
    Ok(select_anchored_entities(entities))
  }
}

fn anchor_span(found: &SearchMatch) -> AnchorSpan {
  AnchorSpan {
    start: usize::try_from(found.start()).unwrap_or(usize::MAX),
    end: usize::try_from(found.end()).unwrap_or(usize::MAX),
  }
}

fn select_anchored_entities(
  mut entities: Vec<PipelineEntity>,
) -> Vec<PipelineEntity> {
  if entities.len() < 2 {
    return entities;
  }

  entities.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| right.end.cmp(&left.end))
      .then_with(|| left.label.cmp(&right.label))
  });

  let mut selected = Vec::new();
  for entity in entities {
    if selected.iter().any(|existing| {
      same_bucket(existing, &entity) && contains(existing, &entity)
    }) {
      continue;
    }

    selected.retain(|existing| {
      !same_bucket(&entity, existing) || !contains(&entity, existing)
    });
    selected.push(entity);
  }

  selected.sort_by(|left, right| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| left.end.cmp(&right.end))
      .then_with(|| left.label.cmp(&right.label))
  });
  selected
}

fn same_bucket(left: &PipelineEntity, right: &PipelineEntity) -> bool {
  left.label == right.label
    && left.source == right.source
    && left.source_detail == right.source_detail
    && left.kind == right.kind
}

const fn contains(outer: &PipelineEntity, inner: &PipelineEntity) -> bool {
  outer.start <= inner.start && outer.end >= inner.end
}
