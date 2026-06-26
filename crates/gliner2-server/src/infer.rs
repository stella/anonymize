use axum::{Json, extract::State, http::StatusCode};
use gliner2_inference::{InferenceParams, SchemaTask};
use std::sync::Arc;

use crate::engine;
use crate::types::{EntityOutput, InferRequest, InferResponse};

pub(crate) struct AppState {
  pub model_id: String,
  pub variant: Option<String>,
}

pub(crate) async fn infer_handler(
  State(state): State<Arc<AppState>>,
  Json(req): Json<InferRequest>,
) -> Result<Json<InferResponse>, (StatusCode, String)> {
  let engine = engine::get_or_init(&state.model_id, state.variant.as_deref())
    .await
    .map_err(|e| {
      (
        StatusCode::SERVICE_UNAVAILABLE,
        format!("model not ready: {e}"),
      )
    })?;

  let tasks = vec![SchemaTask::Entities(req.labels)];
  let params = InferenceParams {
    threshold: req.threshold.unwrap_or(0.5),
    flat_ner: true,
  };

  let (entities, _, _) = engine
    .extract(&req.text, &tasks, Some(params))
    .map_err(|e| {
      (
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("inference failed: {e}"),
      )
    })?;

  let output: Vec<EntityOutput> = entities
    .into_iter()
    .map(|e| EntityOutput {
      text: e.text,
      start: e.start_char,
      end: e.end_char,
      label: e.label,
      score: e.score,
    })
    .collect();

  Ok(Json(InferResponse { entities: output }))
}
