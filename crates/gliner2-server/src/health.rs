use axum::{Json, extract::State};
use serde::Serialize;
use std::sync::Arc;

use crate::engine;
use crate::infer::AppState;

#[derive(Serialize)]
pub(crate) struct HealthResponse {
  pub(crate) status: String,
  pub(crate) model_loaded: bool,
  pub(crate) version: String,
}

pub(crate) async fn health_handler(
  State(_): State<Arc<AppState>>,
) -> Json<HealthResponse> {
  let model_loaded = engine::is_initialized();
  Json(HealthResponse {
    status: "ok".into(),
    model_loaded,
    version: "0.1.0".into(),
  })
}
