//! Serde input struct for workspace gazetteer entries.
//!
//! Mirrors `GazetteerEntry` in `types.ts`.

use serde::{Deserialize, Serialize};

/// Origin of a gazetteer entry.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GazetteerSource {
  Manual,
  ConfirmedFromModel,
}

/// A single entry in the workspace-scoped gazetteer (deny list).
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GazetteerEntry {
  pub id: String,
  pub canonical: String,
  pub label: String,
  pub variants: Vec<String>,
  pub workspace_id: String,
  pub created_at: i64,
  pub source: GazetteerSource,
}
