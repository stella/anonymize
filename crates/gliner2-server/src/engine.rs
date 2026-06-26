use gliner2_inference::{Gliner2Engine, ModelType};
use std::sync::Arc;
use tokio::sync::OnceCell;

static ENGINE: OnceCell<Arc<Gliner2Engine>> = OnceCell::const_new();

pub(crate) async fn get_or_init(
  model_id: &str,
  variant: Option<&str>,
) -> anyhow::Result<Arc<Gliner2Engine>> {
  let model_id = model_id.to_string();
  let variant = variant.map(|s| s.to_string());
  ENGINE
    .get_or_try_init(|| async move {
      ort::init().with_name("GLiNER2_Engine").commit()?;
      let engine = Gliner2Engine::from_pretrained(
        &model_id,
        variant.as_deref(),
        ModelType::HuggingFace,
      )?;
      Ok(Arc::new(engine))
    })
    .await
    .map(Arc::clone)
}

pub(crate) fn is_initialized() -> bool {
  ENGINE.initialized()
}
