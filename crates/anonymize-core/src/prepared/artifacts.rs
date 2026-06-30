use crate::artifact_bytes::{ArtifactReader, ArtifactWriter};
use crate::search::{SearchIndexArtifacts, SearchIndexArtifactsView};
use crate::types::Result;

const PREPARED_SEARCH_ARTIFACTS_HEADER: [u8; 8] = *b"ANONPSR1";
const PREPARED_SEARCH_ARTIFACTS_VERSION: u32 = 1;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PreparedSearchArtifacts {
  pub regex: SearchIndexArtifacts,
  pub custom_regex: SearchIndexArtifacts,
  pub legal_forms: SearchIndexArtifacts,
  pub triggers: SearchIndexArtifacts,
  pub literals: SearchIndexArtifacts,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PreparedSearchArtifactsView<'a> {
  pub regex: SearchIndexArtifactsView<'a>,
  pub custom_regex: SearchIndexArtifactsView<'a>,
  pub legal_forms: SearchIndexArtifactsView<'a>,
  pub triggers: SearchIndexArtifactsView<'a>,
  pub literals: SearchIndexArtifactsView<'a>,
}

impl PreparedSearchArtifacts {
  pub fn to_bytes(&self) -> Result<Vec<u8>> {
    let mut writer = ArtifactWriter::new(
      PREPARED_SEARCH_ARTIFACTS_HEADER,
      PREPARED_SEARCH_ARTIFACTS_VERSION,
    );
    write_index_artifacts(&mut writer, "prepared.regex", &self.regex)?;
    write_index_artifacts(
      &mut writer,
      "prepared.custom_regex",
      &self.custom_regex,
    )?;
    write_index_artifacts(
      &mut writer,
      "prepared.legal_forms",
      &self.legal_forms,
    )?;
    write_index_artifacts(&mut writer, "prepared.triggers", &self.triggers)?;
    write_index_artifacts(&mut writer, "prepared.literals", &self.literals)?;
    Ok(writer.into_bytes())
  }

  pub fn from_bytes(bytes: &[u8]) -> Result<Self> {
    Ok(PreparedSearchArtifactsView::from_bytes(bytes)?.into_owned())
  }

  #[must_use]
  pub fn as_view(&self) -> PreparedSearchArtifactsView<'_> {
    PreparedSearchArtifactsView {
      regex: self.regex.as_view(),
      custom_regex: self.custom_regex.as_view(),
      legal_forms: self.legal_forms.as_view(),
      triggers: self.triggers.as_view(),
      literals: self.literals.as_view(),
    }
  }
}

impl<'a> PreparedSearchArtifactsView<'a> {
  pub fn from_bytes(bytes: &'a [u8]) -> Result<Self> {
    let mut reader = ArtifactReader::new(
      bytes,
      PREPARED_SEARCH_ARTIFACTS_HEADER,
      PREPARED_SEARCH_ARTIFACTS_VERSION,
      "prepared_search_artifacts",
    )?;
    let artifacts = Self {
      regex: read_index_artifact_view(&mut reader)?,
      custom_regex: read_index_artifact_view(&mut reader)?,
      legal_forms: read_index_artifact_view(&mut reader)?,
      triggers: read_index_artifact_view(&mut reader)?,
      literals: read_index_artifact_view(&mut reader)?,
    };
    reader.finish()?;
    Ok(artifacts)
  }

  #[must_use]
  pub fn into_owned(self) -> PreparedSearchArtifacts {
    PreparedSearchArtifacts {
      regex: self.regex.into_owned(),
      custom_regex: self.custom_regex.into_owned(),
      legal_forms: self.legal_forms.into_owned(),
      triggers: self.triggers.into_owned(),
      literals: self.literals.into_owned(),
    }
  }
}

fn write_index_artifacts(
  writer: &mut ArtifactWriter,
  field: &'static str,
  artifacts: &SearchIndexArtifacts,
) -> Result<()> {
  writer.write_len_prefixed_bytes(field, &artifacts.to_bytes()?)
}

fn read_index_artifact_view<'a>(
  reader: &mut ArtifactReader<'a>,
) -> Result<SearchIndexArtifactsView<'a>> {
  SearchIndexArtifactsView::from_bytes(reader.read_len_prefixed_bytes()?)
}
