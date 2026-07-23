//! Optional native Nym ONNX adapter for the German legal benchmark.
//!
//! The tokenization, windowing and BIO-decoding structure is derived from
//! byteowlz/nym's MIT-licensed `src/engine/ner_token.rs` at commit
//! 56f6dac6454edb6349e60a8366047577ab10b4f5. This adapter intentionally keeps
//! only the model-neutral token classifier needed by the benchmark.

use std::collections::{BTreeMap, BTreeSet};
use std::env;
use std::fs::{self, File};
use std::io::{self, BufReader, Read};
use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{Context, Result, bail, ensure};
use ort::session::Session;
use ort::value::Tensor;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokenizers::Tokenizer;

const WINDOW_TOKENS: usize = 480;
const WINDOW_OVERLAP: usize = 64;
const THRESHOLD: f32 = 0.5;

const MODEL_MANIFEST_JSON: &str = include_str!("../model-manifest.json");

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ModelManifest {
  repo: String,
  revision: String,
  subfolder: String,
  provider_id: String,
  provider_name: String,
  license: String,
  artifacts: Vec<ModelArtifact>,
}

impl ModelManifest {
  fn version(&self) -> String {
    format!("{}@{}/{}", self.repo, self.revision, self.subfolder)
  }
}

#[derive(Deserialize)]
struct ModelArtifact {
  name: String,
  bytes: u64,
  sha256: String,
}

#[derive(Deserialize)]
struct Job {
  docs: Vec<Document>,
}

#[derive(Deserialize)]
struct Document {
  id: String,
  language: String,
  text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Output {
  version: String,
  init_seconds: f64,
  cold_seconds: f64,
  warm_seconds: f64,
  results: Vec<DocumentResult>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct DocumentResult {
  id: String,
  batch_json: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExternalDetectionBatch {
  version: u8,
  document: DocumentDigest,
  offset_unit: &'static str,
  provider: Provider,
  label_map: Vec<LabelMapping>,
  detections: Vec<ExternalDetection>,
}

#[derive(Serialize)]
struct DocumentDigest {
  sha256: String,
}

#[derive(Serialize)]
struct Provider {
  id: String,
  name: String,
  version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LabelMapping {
  provider_label: String,
  entity_label: &'static str,
}

#[derive(Serialize)]
struct ExternalDetection {
  id: String,
  start: usize,
  end: usize,
  label: String,
  score: f32,
}

#[derive(Clone, Debug, PartialEq)]
struct ProviderSpan {
  label: String,
  start: usize,
  end: usize,
  score: f32,
}

struct DecodedSpan {
  label: String,
  start: usize,
  end: usize,
  probability_sum: f32,
  token_count: usize,
}

struct NymModel {
  session: Session,
  tokenizer: Tokenizer,
  id_to_label: Vec<String>,
  needs_token_type_ids: bool,
}

impl NymModel {
  fn load(model_dir: &Path, manifest: &ModelManifest) -> Result<Self> {
    verify_artifacts(model_dir, manifest)?;
    let id_to_label = load_labels(&model_dir.join("config.json"))?;
    let mut tokenizer = Tokenizer::from_file(model_dir.join("tokenizer.json"))
      .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    tokenizer
      .with_truncation(None)
      .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let session = Session::builder()?
      .commit_from_file(model_dir.join("model_int8.onnx"))?;
    let needs_token_type_ids = session
      .inputs()
      .iter()
      .any(|input| input.name() == "token_type_ids");
    Ok(Self {
      session,
      tokenizer,
      id_to_label,
      needs_token_type_ids,
    })
  }

  fn detect(&mut self, text: &str) -> Result<Vec<ProviderSpan>> {
    let mut found = Vec::new();
    for (chunk, offset) in self.chunks(text)? {
      found.extend(self.detect_chunk(chunk, offset)?);
    }
    found.sort_by(|left, right| {
      left
        .start
        .cmp(&right.start)
        .then_with(|| left.end.cmp(&right.end))
        .then_with(|| left.label.cmp(&right.label))
    });
    let mut deduplicated: Vec<ProviderSpan> = Vec::with_capacity(found.len());
    for span in found {
      if let Some(previous) = deduplicated.last_mut()
        && previous.start == span.start
        && previous.end == span.end
        && previous.label == span.label
      {
        if span.score > previous.score {
          *previous = span;
        }
      } else {
        deduplicated.push(span);
      }
    }
    Ok(deduplicated)
  }

  fn chunks<'a>(&self, text: &'a str) -> Result<Vec<(&'a str, usize)>> {
    let encoding = self
      .tokenizer
      .encode(text, false)
      .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let offsets = encoding.get_offsets();
    if offsets.is_empty() {
      return Ok(Vec::new());
    }
    if offsets.len() <= WINDOW_TOKENS {
      return Ok(vec![(text, 0)]);
    }

    let step = WINDOW_TOKENS.saturating_sub(WINDOW_OVERLAP).max(1);
    let mut chunks = Vec::new();
    let mut token_index = 0;
    while token_index < offsets.len() {
      let end_index = (token_index + WINDOW_TOKENS).min(offsets.len());
      let start = offsets[token_index].0;
      let end = offsets[end_index - 1].1;
      if start < end
        && text.is_char_boundary(start)
        && text.is_char_boundary(end)
      {
        chunks.push((&text[start..end], start));
      }
      if end_index >= offsets.len() {
        break;
      }
      token_index += step;
    }
    Ok(chunks)
  }

  fn detect_chunk(
    &mut self,
    text: &str,
    chunk_offset: usize,
  ) -> Result<Vec<ProviderSpan>> {
    let encoding = self
      .tokenizer
      .encode(text, true)
      .map_err(|error| anyhow::anyhow!(error.to_string()))?;
    let ids = encoding.get_ids();
    if ids.is_empty() {
      return Ok(Vec::new());
    }
    let sequence_length = ids.len();
    let label_count = self.id_to_label.len();
    let shape = vec![1_i64, i64::try_from(sequence_length)?];
    let input_ids = ids.iter().map(|&id| i64::from(id)).collect::<Vec<_>>();
    let attention_mask = encoding
      .get_attention_mask()
      .iter()
      .map(|&mask| i64::from(mask))
      .collect::<Vec<_>>();
    let ids_tensor = Tensor::from_array((shape.clone(), input_ids))?;
    let mask_tensor = Tensor::from_array((shape.clone(), attention_mask))?;
    let outputs = if self.needs_token_type_ids {
      let type_ids = Tensor::from_array((shape, vec![0_i64; sequence_length]))?;
      self.session.run(ort::inputs![
        "input_ids" => ids_tensor,
        "attention_mask" => mask_tensor,
        "token_type_ids" => type_ids,
      ])?
    } else {
      self.session.run(ort::inputs![
        "input_ids" => ids_tensor,
        "attention_mask" => mask_tensor,
      ])?
    };
    let (_, logits) = outputs["logits"].try_extract_tensor::<f32>()?;
    ensure!(
      logits.len() == sequence_length * label_count,
      "unexpected ONNX logits shape"
    );

    let special_mask = encoding.get_special_tokens_mask();
    let mut decoded = Vec::new();
    let mut current: Option<DecodedSpan> = None;
    for (token_index, &(start, end)) in
      encoding.get_offsets().iter().enumerate()
    {
      if special_mask.get(token_index).copied().unwrap_or(0) == 1
        || start == end
      {
        continue;
      }
      let row =
        &logits[token_index * label_count..(token_index + 1) * label_count];
      let (best_index, probability) = argmax_softmax(row);
      let label = self
        .id_to_label
        .get(best_index)
        .context("model emitted an unknown label index")?;
      if label == "O" || probability < THRESHOLD {
        push_decoded(&mut decoded, &mut current);
        continue;
      }
      let (inside, base_label) = split_bio(label);
      if let Some(span) = current.as_mut()
        && inside
        && span.label == base_label
      {
        span.end = end;
        span.probability_sum += probability;
        span.token_count += 1;
      } else {
        push_decoded(&mut decoded, &mut current);
        current = Some(DecodedSpan {
          label: base_label.to_owned(),
          start,
          end,
          probability_sum: probability,
          token_count: 1,
        });
      }
    }
    push_decoded(&mut decoded, &mut current);

    let mut output = Vec::new();
    for span in merge_provider_fragments(decoded, text) {
      let (start, end) = trim_ascii_whitespace(text, span.start, span.end);
      if start < end {
        output.push(ProviderSpan {
          label: span.label,
          start: start + chunk_offset,
          end: end + chunk_offset,
          score: span.probability_sum / span.token_count as f32,
        });
      }
    }
    Ok(output)
  }
}

fn push_decoded(
  output: &mut Vec<DecodedSpan>,
  current: &mut Option<DecodedSpan>,
) {
  if let Some(span) = current.take() {
    output.push(span);
  }
}

fn split_bio(label: &str) -> (bool, &str) {
  if let Some(base) = label.strip_prefix("I-") {
    (true, base)
  } else if let Some(base) = label.strip_prefix("B-") {
    (false, base)
  } else {
    (false, label)
  }
}

fn merge_provider_fragments(
  spans: Vec<DecodedSpan>,
  text: &str,
) -> Vec<DecodedSpan> {
  let mut merged: Vec<DecodedSpan> = Vec::with_capacity(spans.len());
  for span in spans {
    if let Some(previous) = merged.last_mut() {
      let blank_gap = span.start >= previous.end
        && text
          .get(previous.end..span.start)
          .is_some_and(|gap| gap.chars().all(char::is_whitespace));
      if previous.label == span.label && blank_gap {
        previous.end = span.end;
        previous.probability_sum += span.probability_sum;
        previous.token_count += span.token_count;
        continue;
      }
    }
    merged.push(span);
  }
  merged
}

fn argmax_softmax(row: &[f32]) -> (usize, f32) {
  let mut best_index = 0;
  let mut maximum = f32::NEG_INFINITY;
  for (index, &value) in row.iter().enumerate() {
    if value > maximum {
      maximum = value;
      best_index = index;
    }
  }
  let denominator = row
    .iter()
    .map(|&value| (value - maximum).exp())
    .sum::<f32>();
  let probability = if denominator > 0.0 {
    1.0 / denominator
  } else {
    0.0
  };
  (best_index, probability)
}

fn trim_ascii_whitespace(
  text: &str,
  mut start: usize,
  mut end: usize,
) -> (usize, usize) {
  let bytes = text.as_bytes();
  while start < end && bytes[start].is_ascii_whitespace() {
    start += 1;
  }
  while end > start && bytes[end - 1].is_ascii_whitespace() {
    end -= 1;
  }
  (start, end)
}

fn canonical_label(provider_label: &str) -> Option<&'static str> {
  match provider_label {
    "ACCOUNT_NUMBER" => Some("bank account number"),
    "BUILDING_NUMBER" | "CITY" | "SECONDARY_ADDRESS" | "STATE"
    | "STREET_ADDRESS" | "STREET_NAME" | "ZIP_CODE" => Some("address"),
    "COMPANY_NAME" => Some("organization"),
    "COUNTRY" => Some("country"),
    "CREDIT_DEBIT_CARD" => Some("credit card number"),
    "DATE" => Some("date"),
    "DATE_OF_BIRTH" => Some("date of birth"),
    "DRIVERS_LICENSE" => Some("identity card number"),
    "EMAIL" => Some("email address"),
    "FAX_NUMBER" | "PHONE" => Some("phone number"),
    "GIVEN_NAME" | "SURNAME" => Some("person"),
    "GOVERNMENT_ID" => Some("national identification number"),
    "IBAN" => Some("iban"),
    "PASSPORT" => Some("passport number"),
    "SSN" => Some("social security number"),
    "TAX_ID" => Some("tax identification number"),
    _ => None,
  }
}

fn batch_for(
  text: &str,
  provider_spans: Vec<ProviderSpan>,
  manifest: &ModelManifest,
) -> Result<ExternalDetectionBatch> {
  let mut mapped = provider_spans
    .into_iter()
    .filter_map(|span| {
      canonical_label(&span.label).map(|entity| (span, entity))
    })
    .collect::<Vec<_>>();
  mapped.sort_by(|(left, _), (right, _)| {
    left
      .start
      .cmp(&right.start)
      .then_with(|| right.end.cmp(&left.end))
  });
  let mut merged: Vec<(ProviderSpan, &'static str)> =
    Vec::with_capacity(mapped.len());
  for (span, entity_label) in mapped {
    if let Some((previous, previous_entity)) = merged.last_mut() {
      let blank_gap = span.start >= previous.end
        && text
          .get(previous.end..span.start)
          .is_some_and(|gap| gap.chars().all(char::is_whitespace));
      if *previous_entity == entity_label && blank_gap {
        previous.end = span.end;
        previous.score = previous.score.min(span.score);
        continue;
      }
    }
    merged.push((span, entity_label));
  }

  let mut label_map = BTreeMap::new();
  let mut detections = Vec::with_capacity(merged.len());
  for (index, (span, entity_label)) in merged.into_iter().enumerate() {
    ensure!(
      text.is_char_boundary(span.start) && text.is_char_boundary(span.end),
      "tokenizer emitted a non-character boundary"
    );
    label_map.insert(span.label.clone(), entity_label);
    detections.push(ExternalDetection {
      id: format!("nym-{}", index + 1),
      start: text[..span.start].chars().count(),
      end: text[..span.end].chars().count(),
      label: span.label,
      score: span.score,
    });
  }

  Ok(ExternalDetectionBatch {
    version: 1,
    document: DocumentDigest {
      sha256: sha256_hex(text.as_bytes()),
    },
    offset_unit: "unicode-code-point",
    provider: Provider {
      id: manifest.provider_id.clone(),
      name: manifest.provider_name.clone(),
      version: manifest.version(),
    },
    label_map: label_map
      .into_iter()
      .map(|(provider_label, entity_label)| LabelMapping {
        provider_label,
        entity_label,
      })
      .collect(),
    detections,
  })
}

fn run_documents(
  model: &mut NymModel,
  documents: &[Document],
  manifest: &ModelManifest,
) -> Result<Vec<DocumentResult>> {
  let mut ids = BTreeSet::new();
  let mut results = Vec::with_capacity(documents.len());
  for document in documents {
    ensure!(!document.id.is_empty(), "document id must not be empty");
    ensure!(ids.insert(&document.id), "duplicate document id");
    ensure!(
      document.language == "de",
      "Nym assisted lane accepts German only"
    );
    let batch =
      batch_for(&document.text, model.detect(&document.text)?, manifest)?;
    results.push(DocumentResult {
      id: document.id.clone(),
      batch_json: serde_json::to_string(&batch)?,
    });
  }
  Ok(results)
}

fn load_labels(path: &Path) -> Result<Vec<String>> {
  #[derive(Deserialize)]
  struct Config {
    id2label: BTreeMap<usize, String>,
  }
  let config: Config = serde_json::from_slice(&fs::read(path)?)?;
  let mut labels = Vec::with_capacity(config.id2label.len());
  for (expected, (index, label)) in config.id2label.into_iter().enumerate() {
    ensure!(index == expected, "model labels are not contiguous");
    labels.push(label);
  }
  Ok(labels)
}

fn verify_artifacts(model_dir: &Path, manifest: &ModelManifest) -> Result<()> {
  ensure!(manifest.license == "MIT", "unexpected model license");
  for artifact in &manifest.artifacts {
    let path = model_dir.join(&artifact.name);
    let (bytes, sha256) = sha256_file(&path)
      .with_context(|| format!("missing model artifact: {}", artifact.name))?;
    ensure!(
      bytes == artifact.bytes,
      "model artifact size mismatch: {}",
      artifact.name
    );
    ensure!(
      sha256 == artifact.sha256,
      "model artifact SHA-256 mismatch: {}",
      artifact.name
    );
  }
  Ok(())
}

fn sha256_file(path: &Path) -> Result<(u64, String)> {
  let file = File::open(path)?;
  let bytes = file.metadata()?.len();
  let mut reader = BufReader::new(file);
  let mut buffer = vec![0_u8; 1024 * 1024];
  let mut hasher = Sha256::new();
  loop {
    let read = reader.read(&mut buffer)?;
    if read == 0 {
      break;
    }
    hasher.update(&buffer[..read]);
  }
  let sha256 = hasher
    .finalize()
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect();
  Ok((bytes, sha256))
}

fn sha256_hex(bytes: &[u8]) -> String {
  Sha256::digest(bytes)
    .iter()
    .map(|byte| format!("{byte:02x}"))
    .collect()
}

fn model_directory() -> Result<PathBuf> {
  let mut arguments = env::args_os();
  let _program = arguments.next();
  let path = arguments
    .next()
    .context("usage: stella-nym-adapter <model-dir>")?;
  if arguments.next().is_some() {
    bail!("usage: stella-nym-adapter <model-dir>");
  }
  Ok(PathBuf::from(path))
}

fn main() -> Result<()> {
  let model_dir = model_directory()?;
  let manifest: ModelManifest = serde_json::from_str(MODEL_MANIFEST_JSON)?;
  let mut input = Vec::new();
  io::stdin().read_to_end(&mut input)?;
  let job: Job = serde_json::from_slice(&input)?;

  let init_start = Instant::now();
  let mut model = NymModel::load(&model_dir, &manifest)?;
  let init_seconds = init_start.elapsed().as_secs_f64();

  let cold_start = Instant::now();
  let results = run_documents(&mut model, &job.docs, &manifest)?;
  let cold_seconds = cold_start.elapsed().as_secs_f64();

  let warm_start = Instant::now();
  let warm_results = run_documents(&mut model, &job.docs, &manifest)?;
  let warm_seconds = warm_start.elapsed().as_secs_f64();
  ensure!(
    results == warm_results,
    "ONNX inference was not deterministic"
  );

  serde_json::to_writer(
    io::stdout(),
    &Output {
      version: manifest.version(),
      init_seconds,
      cold_seconds,
      warm_seconds,
      results,
    },
  )?;
  Ok(())
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn batch_maps_utf8_model_offsets_to_unicode_code_points() -> Result<()> {
    let text = "😀Mara Winterfeld";
    let manifest: ModelManifest = serde_json::from_str(MODEL_MANIFEST_JSON)?;
    let batch = batch_for(
      text,
      vec![
        ProviderSpan {
          label: "GIVEN_NAME".to_owned(),
          start: 4,
          end: 8,
          score: 0.91,
        },
        ProviderSpan {
          label: "SURNAME".to_owned(),
          start: 9,
          end: 19,
          score: 0.84,
        },
      ],
      &manifest,
    )?;
    assert_eq!(batch.offset_unit, "unicode-code-point");
    assert_eq!(batch.detections.len(), 1);
    assert_eq!(batch.detections[0].start, 1);
    assert_eq!(batch.detections[0].end, 16);
    assert_eq!(batch.detections[0].label, "GIVEN_NAME");
    assert_eq!(batch.label_map.len(), 1);
    assert_eq!(batch.label_map[0].entity_label, "person");
    Ok(())
  }

  #[test]
  fn batch_drops_unsupported_labels_instead_of_gaming_coverage() -> Result<()> {
    let manifest: ModelManifest = serde_json::from_str(MODEL_MANIFEST_JSON)?;
    let batch = batch_for(
      "Alter 41",
      vec![ProviderSpan {
        label: "AGE".to_owned(),
        start: 6,
        end: 8,
        score: 0.99,
      }],
      &manifest,
    )?;
    assert!(batch.detections.is_empty());
    assert!(batch.label_map.is_empty());
    Ok(())
  }
}
