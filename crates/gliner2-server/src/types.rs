use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
pub(crate) struct InferRequest {
  pub(crate) text: String,
  pub(crate) labels: Vec<String>,
  pub(crate) threshold: Option<f32>,
}

#[derive(Debug, Serialize)]
pub(crate) struct EntityOutput {
  pub(crate) text: String,
  pub(crate) start: usize,
  pub(crate) end: usize,
  pub(crate) label: String,
  pub(crate) score: f32,
}

#[derive(Debug, Serialize)]
pub(crate) struct InferResponse {
  pub(crate) entities: Vec<EntityOutput>,
}
