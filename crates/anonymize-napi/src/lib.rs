use std::{
  collections::{BTreeMap, VecDeque},
  sync::{Arc, LazyLock, Mutex},
  time::Instant,
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use stella_anonymize_adapter_contract::{
  BindingOperatorConfig, BindingOperatorEntry, BindingPreparedSearchConfig,
  BindingRedactionResult, BindingStaticRedactionResult, ContractError,
  PreparedSearchPackageDecodeTimings, assemble_static_search_config,
  diagnostic_events_to_utf16_binding, diagnostic_stage_event,
  operator_config_from_binding, prepared_search_config_from_binding,
  prepared_search_core_package_to_bytes,
  prepared_search_core_package_to_compressed_bytes,
  prepared_search_core_package_view_from_bytes_with_timings,
  prepared_search_core_package_view_trusted_from_bytes_with_timings,
  prepared_search_package_decode_timing_events, prepared_search_package_digest,
  prepared_search_package_from_bytes, prepared_search_package_has_core_payload,
  prepared_search_package_verify_digest_with_timings,
  static_redaction_diagnostic_result_to_utf16_binding,
  static_redaction_diagnostics_to_binding,
  static_redaction_result_to_utf16_binding,
  static_redaction_stream_event_to_utf16_binding,
};
use stella_anonymize_core::{
  DiagnosticDetail, DiagnosticEvent, DiagnosticStage, Error as CoreError,
  OperatorConfig, PreparedEngine, PreparedEngineArtifactsView,
  PreparedEngineConfig, StaticRedactionDiagnostics,
  assemble::{AssembleError, Dictionaries, GazetteerEntry, PipelineConfig},
};

const PREPARED_SEARCH_CACHE_LIMIT: usize = 8;

static PREPARED_SEARCH_CACHE: LazyLock<Mutex<PreparedSearchCache>> =
  LazyLock::new(|| Mutex::new(PreparedSearchCache::new()));

struct PreparedSearchCache {
  entries: BTreeMap<[u8; 32], Arc<PreparedEngine>>,
  order: VecDeque<[u8; 32]>,
}

impl PreparedSearchCache {
  const fn new() -> Self {
    Self {
      entries: BTreeMap::new(),
      order: VecDeque::new(),
    }
  }

  fn get(&mut self, key: &[u8; 32]) -> Option<Arc<PreparedEngine>> {
    let entry = self.entries.get(key).cloned()?;
    self.retain_order_without(key);
    self.order.push_back(*key);
    Some(entry)
  }

  fn insert(&mut self, key: [u8; 32], value: Arc<PreparedEngine>) {
    self.entries.insert(key, value);
    self.retain_order_without(&key);
    self.order.push_back(key);

    while self.order.len() > PREPARED_SEARCH_CACHE_LIMIT {
      if let Some(evicted) = self.order.pop_front() {
        self.entries.remove(&evicted);
      }
    }
  }

  fn retain_order_without(&mut self, key: &[u8; 32]) {
    self.order.retain(|entry| entry != key);
  }
}

#[napi(object)]
pub struct JsSearchPattern {
  pub kind: String,
  pub pattern: String,
  pub distance: Option<u32>,
  pub case_insensitive: Option<bool>,
  pub whole_words: Option<bool>,
  pub lazy: Option<bool>,
  pub prefilter_any: Option<Vec<String>>,
  pub prefilter_case_insensitive: Option<bool>,
  pub prefilter_regex: Option<String>,
  pub prefilter_window_bytes: Option<u32>,
  pub prepared_artifact_policy: Option<String>,
}

#[napi(object)]
pub struct JsSearchOptions {
  pub literal_case_insensitive: Option<bool>,
  pub literal_whole_words: Option<bool>,
  pub regex_whole_words: Option<bool>,
  pub regex_overlap_all: Option<bool>,
  pub regex_artifact_policy: Option<String>,
  pub fuzzy_case_insensitive: Option<bool>,
  pub fuzzy_whole_words: Option<bool>,
  pub fuzzy_normalize_diacritics: Option<bool>,
}

#[napi(object)]
pub struct JsPatternSlice {
  pub start: u32,
  pub end: u32,
}

#[napi(object)]
pub struct JsPreparedSearchSlices {
  pub regex: Option<JsPatternSlice>,
  pub custom_regex: Option<JsPatternSlice>,
  pub legal_forms: Option<JsPatternSlice>,
  pub triggers: Option<JsPatternSlice>,
  pub deny_list: Option<JsPatternSlice>,
  pub street_types: Option<JsPatternSlice>,
  pub gazetteer: Option<JsPatternSlice>,
  pub countries: Option<JsPatternSlice>,
}

#[napi(object)]
pub struct JsRegexMatchMeta {
  pub label: String,
  pub score: f64,
  pub source_detail: Option<String>,
  pub requires_validation: Option<bool>,
  pub validator_id: Option<String>,
  pub validator_input: Option<String>,
  pub min_byte_length: Option<u32>,
}

#[napi(object)]
pub struct JsGazetteerMatchData {
  pub labels: Vec<String>,
  pub is_fuzzy: Vec<bool>,
}

#[napi(object)]
pub struct JsCountryMatchData {
  pub labels: Vec<String>,
}

#[napi(object)]
pub struct JsDenyListMatchData {
  pub labels: Vec<Vec<String>>,
  pub custom_labels: Vec<Vec<String>>,
  pub originals: Vec<String>,
  pub sources: Vec<Vec<String>>,
  pub filters: Option<JsDenyListFilterData>,
}

#[napi(object)]
pub struct JsDenyListFilterData {
  pub stopwords: Vec<String>,
  pub allow_list: Vec<String>,
  pub person_stopwords: Vec<String>,
  pub person_trailing_nouns: Vec<String>,
  pub address_stopwords: Vec<String>,
  pub address_jurisdiction_prefixes: Vec<String>,
  pub street_types: Vec<String>,
  pub first_names: Vec<String>,
  pub generic_roles: Vec<String>,
  pub sentence_starters: Vec<String>,
  pub trailing_address_word_exclusions: Vec<String>,
  pub defined_term_cues: Vec<String>,
  pub signing_place_guards: Vec<JsSigningPlaceGuardData>,
}

#[napi(object)]
pub struct JsSigningPlaceGuardData {
  pub prefix_phrases: Vec<String>,
  pub suffix_phrases: Vec<String>,
}

#[napi(object)]
pub struct JsPreparedSearchConfig {
  pub regex_patterns: Vec<JsSearchPattern>,
  pub custom_regex_patterns: Vec<JsSearchPattern>,
  pub literal_patterns: Vec<JsSearchPattern>,
  pub regex_options: Option<JsSearchOptions>,
  pub custom_regex_options: Option<JsSearchOptions>,
  pub literal_options: Option<JsSearchOptions>,
  pub slices: JsPreparedSearchSlices,
  pub regex_meta: Vec<JsRegexMatchMeta>,
  pub custom_regex_meta: Vec<JsRegexMatchMeta>,
  pub deny_list_data: Option<JsDenyListMatchData>,
  pub gazetteer_data: Option<JsGazetteerMatchData>,
  pub country_data: Option<JsCountryMatchData>,
}

#[napi(object)]
pub struct JsOperatorConfig {
  pub operators: Option<BTreeMap<String, String>>,
  pub redact_string: Option<String>,
}

#[napi(object)]
pub struct JsRedactionEntry {
  pub placeholder: String,
  pub original: String,
}

#[napi(object)]
pub struct JsOperatorEntry {
  pub placeholder: String,
  pub operator: String,
}

#[napi(object)]
pub struct JsRedactionResult {
  pub redacted_text: String,
  pub redaction_map: Vec<JsRedactionEntry>,
  pub operator_map: Vec<JsOperatorEntry>,
  pub entity_count: u32,
}

#[napi(object)]
pub struct JsPipelineEntity {
  pub start: u32,
  pub end: u32,
  pub label: String,
  pub text: String,
  pub score: f64,
  pub source: String,
  pub source_detail: Option<String>,
}

#[napi(object)]
pub struct JsStaticRedactionResult {
  pub resolved_entities: Vec<JsPipelineEntity>,
  pub redaction: JsRedactionResult,
}

#[napi]
#[must_use]
#[allow(clippy::needless_pass_by_value)]
pub fn normalize_for_search(text: String) -> String {
  stella_anonymize_core::normalize_for_search(&text)
}

#[napi]
#[must_use]
pub fn native_package_version() -> String {
  String::from(env!("CARGO_PKG_VERSION"))
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn redact_static_entities_json(
  config_json: String,
  full_text: String,
  operators_json: Option<String>,
) -> Result<String> {
  let config =
    serde_json::from_str::<BindingPreparedSearchConfig>(&config_json)
      .map_err(|error| to_napi_serde_error(&error))?;
  let operators = operators_json
    .as_deref()
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()
    .map_err(|error| to_napi_serde_error(&error))?;
  let prepared = PreparedEngine::new(
    prepared_search_config_from_binding(config)
      .map_err(|error| to_napi_contract_error(&error))?,
  )
  .map_err(|error| to_napi_core_error(&error))?;
  let result = prepared
    .redact_static_entities(
      &full_text,
      &operator_config_from_binding(operators)
        .map_err(|error| to_napi_contract_error(&error))?,
    )
    .map_err(|error| to_napi_core_error(&error))?;
  let result = static_redaction_result_to_utf16_binding(result, &full_text)
    .map_err(|error| to_napi_contract_error(&error))?;

  serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn redact_static_entities_diagnostics_json(
  config_json: String,
  full_text: String,
  operators_json: Option<String>,
) -> Result<String> {
  redact_static_entities_diagnostics_json_with_detail(
    &config_json,
    &full_text,
    operators_json.as_deref(),
    DiagnosticDetail::Detailed,
  )
}

#[napi]
#[allow(clippy::needless_pass_by_value)]
pub fn redact_static_entities_summary_diagnostics_json(
  config_json: String,
  full_text: String,
  operators_json: Option<String>,
) -> Result<String> {
  redact_static_entities_diagnostics_json_with_detail(
    &config_json,
    &full_text,
    operators_json.as_deref(),
    DiagnosticDetail::Summary,
  )
}

fn redact_static_entities_diagnostics_json_with_detail(
  config_json: &str,
  full_text: &str,
  operators_json: Option<&str>,
  detail: DiagnosticDetail,
) -> Result<String> {
  let config = serde_json::from_str::<BindingPreparedSearchConfig>(config_json)
    .map_err(|error| to_napi_serde_error(&error))?;
  let operators = operators_json
    .map(serde_json::from_str::<BindingOperatorConfig>)
    .transpose()
    .map_err(|error| to_napi_serde_error(&error))?;
  let prepared = PreparedEngine::new_with_diagnostics(
    prepared_search_config_from_binding(config)
      .map_err(|error| to_napi_contract_error(&error))?,
  )
  .map_err(|error| to_napi_core_error(&error))?;
  let mut diagnostics = prepared.diagnostics;
  let operators = operator_config_from_binding(operators)
    .map_err(|error| to_napi_contract_error(&error))?;
  let mut result = match detail {
    DiagnosticDetail::Detailed => prepared
      .prepared
      .redact_static_entities_with_diagnostics(full_text, &operators),
    DiagnosticDetail::Summary => prepared
      .prepared
      .redact_static_entities_with_summary_diagnostics(full_text, &operators),
  }
  .map_err(|error| to_napi_core_error(&error))?;
  diagnostics.extend(result.diagnostics);
  result.diagnostics = diagnostics;
  let result =
    static_redaction_diagnostic_result_to_utf16_binding(result, full_text)
      .map_err(|error| to_napi_contract_error(&error))?;

  serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
}

#[napi(js_name = "prepareStaticSearchArtifactsBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn prepare_static_search_artifacts_bytes(
  config_json: BufferSlice<'_>,
) -> Result<Buffer> {
  let config =
    serde_json::from_slice::<BindingPreparedSearchConfig>(config_json.as_ref())
      .map_err(|error| to_napi_serde_error(&error))?;
  let config = prepared_search_config_from_binding(config)
    .map_err(|error| to_napi_contract_error(&error))?;
  PreparedEngine::prepare_artifacts(config)
    .and_then(|artifacts| artifacts.to_bytes())
    .map(Buffer::from)
    .map_err(|error| to_napi_core_error(&error))
}

#[napi(js_name = "prepareStaticSearchPackageBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn prepare_static_search_package_bytes(
  config_json: BufferSlice<'_>,
) -> Result<Buffer> {
  prepare_static_search_package_bytes_with(config_json.as_ref(), false)
}

#[napi(js_name = "prepareStaticSearchCompressedPackageBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn prepare_static_search_compressed_package_bytes(
  config_json: BufferSlice<'_>,
) -> Result<Buffer> {
  prepare_static_search_package_bytes_with(config_json.as_ref(), true)
}

fn prepare_static_search_package_bytes_with(
  config_json: &[u8],
  compressed: bool,
) -> Result<Buffer> {
  let binding_config =
    serde_json::from_slice::<BindingPreparedSearchConfig>(config_json)
      .map_err(|error| to_napi_serde_error(&error))?;
  let core_config = prepared_search_config_from_binding(binding_config)
    .map_err(|error| to_napi_contract_error(&error))?;
  let artifacts = PreparedEngine::prepare_artifacts(core_config.clone())
    .map_err(|error| to_napi_core_error(&error))?;
  let artifact_bytes = artifacts
    .to_bytes()
    .map_err(|error| to_napi_core_error(&error))?;
  let package = if compressed {
    prepared_search_core_package_to_compressed_bytes(
      &core_config,
      &artifact_bytes,
    )
  } else {
    prepared_search_core_package_to_bytes(&core_config, &artifact_bytes)
  };
  let package = package.map_err(|error| to_napi_contract_error(&error))?;
  let prepared = PreparedEngine::new_with_artifacts(core_config, &artifacts)
    .map_err(|error| to_napi_core_error(&error))?;
  let cache_key = prepared_search_package_digest(&package)
    .map_err(|error| to_napi_contract_error(&error))?;
  prepared_search_cache_insert(cache_key, Arc::new(prepared));
  Ok(Buffer::from(package))
}

/// Assembles a prepared static-search config (slice A: trivial fields) and
/// returns it as JSON bytes, ready to feed the prepare/package path.
#[napi(js_name = "assembleStaticSearchConfigJson")]
#[allow(clippy::needless_pass_by_value)]
pub fn assemble_static_search_config_json(
  pipeline_config_json: BufferSlice<'_>,
  dictionaries_json: Option<BufferSlice<'_>>,
  gazetteer_json: Option<BufferSlice<'_>>,
) -> Result<Buffer> {
  let config = assemble_binding_config(
    pipeline_config_json.as_ref(),
    dictionaries_json.as_ref().map(AsRef::as_ref),
    gazetteer_json.as_ref().map(AsRef::as_ref),
  )?;
  serde_json::to_vec(&config)
    .map(Buffer::from)
    .map_err(|error| to_napi_serde_error(&error))
}

/// Assembles the config and chains it through the existing prepare/package
/// path, returning ready-to-load core package bytes.
#[napi(js_name = "assembleStaticSearchPackageBytes")]
#[allow(clippy::needless_pass_by_value)]
pub fn assemble_static_search_package_bytes(
  pipeline_config_json: BufferSlice<'_>,
  dictionaries_json: Option<BufferSlice<'_>>,
  gazetteer_json: Option<BufferSlice<'_>>,
) -> Result<Buffer> {
  let binding_config = assemble_binding_config(
    pipeline_config_json.as_ref(),
    dictionaries_json.as_ref().map(AsRef::as_ref),
    gazetteer_json.as_ref().map(AsRef::as_ref),
  )?;
  let core_config = prepared_search_config_from_binding(binding_config)
    .map_err(|error| to_napi_contract_error(&error))?;
  let artifacts = PreparedEngine::prepare_artifacts(core_config.clone())
    .map_err(|error| to_napi_core_error(&error))?;
  let artifact_bytes = artifacts
    .to_bytes()
    .map_err(|error| to_napi_core_error(&error))?;
  prepared_search_core_package_to_bytes(&core_config, &artifact_bytes)
    .map(Buffer::from)
    .map_err(|error| to_napi_contract_error(&error))
}

fn assemble_binding_config(
  pipeline_config_json: &[u8],
  dictionaries_json: Option<&[u8]>,
  gazetteer_json: Option<&[u8]>,
) -> Result<BindingPreparedSearchConfig> {
  let config = serde_json::from_slice::<PipelineConfig>(pipeline_config_json)
    .map_err(|error| to_napi_serde_error(&error))?;
  let dictionaries = match dictionaries_json {
    Some(bytes) => Some(
      serde_json::from_slice::<Dictionaries>(bytes)
        .map_err(|error| to_napi_serde_error(&error))?,
    ),
    None => None,
  };
  let gazetteer = match gazetteer_json {
    Some(bytes) => serde_json::from_slice::<Vec<GazetteerEntry>>(bytes)
      .map_err(|error| to_napi_serde_error(&error))?,
    None => Vec::new(),
  };
  assemble_static_search_config(&config, dictionaries.as_ref(), &gazetteer)
    .map_err(|error| to_napi_assemble_error(&error))
}

#[napi]
pub struct NativePreparedSearch {
  inner: Arc<PreparedEngine>,
  prepare_diagnostics: StaticRedactionDiagnostics,
}

#[derive(Clone, Copy)]
struct PrepareContext {
  input_bytes_len: usize,
  cache: PrepareCache,
  parse_elapsed: u64,
  parse_stage: DiagnosticStage,
  package_decode_timings: Option<PreparedSearchPackageDecodeTimings>,
}

#[derive(Clone, Copy)]
enum PrepareCache {
  Reuse {
    key: [u8; 32],
    key_elapsed: u64,
    lookup_elapsed: u64,
  },
  Bypass,
}

#[derive(Clone, Copy)]
enum PackageCacheMode {
  Reuse,
  Bypass,
}

#[derive(Clone, Copy)]
enum PackageDecodeMode {
  Verified,
  Trusted,
}

#[derive(Clone, Copy)]
struct CacheLookup {
  key: [u8; 32],
  key_elapsed: u64,
  lookup_elapsed: u64,
}

#[napi]
impl NativePreparedSearch {
  #[napi(constructor)]
  pub fn new(config_json: String) -> Result<Self> {
    let config_bytes = config_json.into_bytes();
    Self::from_config_bytes(&config_bytes, None)
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_config_json_bytes(config_json: BufferSlice<'_>) -> Result<Self> {
    Self::from_config_bytes(config_json.as_ref(), None)
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_config_json_and_artifact_bytes(
    config_json: BufferSlice<'_>,
    artifact_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_config_bytes(config_json.as_ref(), Some(artifact_bytes.as_ref()))
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_prepared_package_bytes(
    package_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_package_bytes(
      package_bytes.as_ref(),
      PackageCacheMode::Reuse,
      PackageDecodeMode::Verified,
    )
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_prepared_package_bytes_without_cache(
    package_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_package_bytes(
      package_bytes.as_ref(),
      PackageCacheMode::Bypass,
      PackageDecodeMode::Verified,
    )
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_trusted_prepared_package_bytes(
    package_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_package_bytes(
      package_bytes.as_ref(),
      PackageCacheMode::Reuse,
      PackageDecodeMode::Trusted,
    )
  }

  #[napi(factory)]
  #[allow(clippy::needless_pass_by_value)]
  pub fn from_trusted_prepared_package_bytes_without_cache(
    package_bytes: BufferSlice<'_>,
  ) -> Result<Self> {
    Self::from_package_bytes(
      package_bytes.as_ref(),
      PackageCacheMode::Bypass,
      PackageDecodeMode::Trusted,
    )
  }

  fn from_config_bytes(
    config_bytes: &[u8],
    artifact_bytes: Option<&[u8]>,
  ) -> Result<Self> {
    let input_bytes_len = config_bytes
      .len()
      .saturating_add(artifact_bytes.map_or(0, <[u8]>::len));
    let cache_key_start = Instant::now();
    let cache_key = prepared_search_cache_key(config_bytes, artifact_bytes);
    let cache_key_elapsed = elapsed_us(cache_key_start);
    let cache_start = Instant::now();
    if let Some(inner) = prepared_search_cache_get(&cache_key) {
      let cache = CacheLookup {
        key: cache_key,
        key_elapsed: cache_key_elapsed,
        lookup_elapsed: elapsed_us(cache_start),
      };
      return Ok(Self {
        inner,
        prepare_diagnostics: StaticRedactionDiagnostics {
          events: cache_hit_events(&cache, input_bytes_len),
          ..StaticRedactionDiagnostics::default()
        },
      });
    }
    let cache = CacheLookup {
      key: cache_key,
      key_elapsed: cache_key_elapsed,
      lookup_elapsed: elapsed_us(cache_start),
    };

    let parse_start = Instant::now();
    let config =
      serde_json::from_slice::<BindingPreparedSearchConfig>(config_bytes)
        .map_err(|error| to_napi_serde_error(&error))?;
    let parse_elapsed = elapsed_us(parse_start);
    let context = PrepareContext {
      input_bytes_len,
      cache: PrepareCache::Reuse {
        key: cache.key,
        key_elapsed: cache.key_elapsed,
        lookup_elapsed: cache.lookup_elapsed,
      },
      parse_elapsed,
      parse_stage: DiagnosticStage::PrepareBindingParse,
      package_decode_timings: None,
    };
    Self::from_binding_config(config, artifact_bytes, &context)
  }

  fn from_package_bytes(
    package_bytes: &[u8],
    cache_mode: PackageCacheMode,
    decode_mode: PackageDecodeMode,
  ) -> Result<Self> {
    let input_bytes_len = package_bytes.len();
    let cache = match cache_mode {
      PackageCacheMode::Reuse => {
        let cache_key_start = Instant::now();
        let cache_key = prepared_search_package_digest(package_bytes)
          .map_err(|error| to_napi_contract_error(&error))?;
        let cache_key_elapsed = elapsed_us(cache_key_start);
        let cache_start = Instant::now();
        if let Some(inner) = prepared_search_cache_get(&cache_key) {
          let cache = CacheLookup {
            key: cache_key,
            key_elapsed: cache_key_elapsed,
            lookup_elapsed: elapsed_us(cache_start),
          };
          let mut events = cache_hit_events(&cache, input_bytes_len);
          if matches!(decode_mode, PackageDecodeMode::Verified) {
            let verify_timings =
              prepared_search_package_verify_digest_with_timings(package_bytes)
                .map_err(|error| to_napi_contract_error(&error))?;
            append_package_decode_timing_events_for_input(
              &mut events,
              verify_timings,
              input_bytes_len,
            );
          }
          return Ok(Self {
            inner,
            prepare_diagnostics: StaticRedactionDiagnostics {
              events,
              ..StaticRedactionDiagnostics::default()
            },
          });
        }
        let cache = CacheLookup {
          key: cache_key,
          key_elapsed: cache_key_elapsed,
          lookup_elapsed: elapsed_us(cache_start),
        };
        PrepareCache::Reuse {
          key: cache.key,
          key_elapsed: cache.key_elapsed,
          lookup_elapsed: cache.lookup_elapsed,
        }
      }
      PackageCacheMode::Bypass => PrepareCache::Bypass,
    };
    let parse_start = Instant::now();
    if prepared_search_package_has_core_payload(package_bytes) {
      let (package, package_decode_timings) = match decode_mode {
        PackageDecodeMode::Verified => {
          prepared_search_core_package_view_from_bytes_with_timings(
            package_bytes,
          )
        }
        PackageDecodeMode::Trusted => {
          prepared_search_core_package_view_trusted_from_bytes_with_timings(
            package_bytes,
          )
        }
      }
      .map_err(|error| to_napi_contract_error(&error))?;
      let parse_elapsed = elapsed_us(parse_start);
      let config = package.config;
      let context = PrepareContext {
        input_bytes_len,
        cache,
        parse_elapsed,
        parse_stage: DiagnosticStage::PreparePackageDecode,
        package_decode_timings: Some(package_decode_timings),
      };
      return Self::from_core_config(
        config,
        Some(package.artifacts.as_bytes()),
        &context,
        None,
      );
    }

    let package = prepared_search_package_from_bytes(package_bytes)
      .map_err(|error| to_napi_contract_error(&error))?;
    let parse_elapsed = elapsed_us(parse_start);
    let config = package.config;
    let artifacts = package.artifacts;
    let context = PrepareContext {
      input_bytes_len,
      cache,
      parse_elapsed,
      parse_stage: DiagnosticStage::PreparePackageDecode,
      package_decode_timings: None,
    };
    Self::from_binding_config(config, Some(&artifacts), &context)
  }

  fn from_binding_config(
    config: BindingPreparedSearchConfig,
    artifact_bytes: Option<&[u8]>,
    context: &PrepareContext,
  ) -> Result<Self> {
    let convert_start = Instant::now();
    let config = prepared_search_config_from_binding(config)
      .map_err(|error| to_napi_contract_error(&error))?;
    let pattern_count = prepared_search_pattern_count(&config);
    let convert_elapsed = elapsed_us(convert_start);
    Self::from_core_config(
      config,
      artifact_bytes,
      context,
      Some((pattern_count, convert_elapsed)),
    )
  }

  fn from_core_config(
    config: PreparedEngineConfig,
    artifact_bytes: Option<&[u8]>,
    context: &PrepareContext,
    binding_convert: Option<(usize, u64)>,
  ) -> Result<Self> {
    let artifact_decode_start = Instant::now();
    let artifacts = artifact_bytes
      .map(PreparedEngineArtifactsView::from_bytes)
      .transpose()
      .map_err(|error| to_napi_core_error(&error))?;
    let artifact_decode_elapsed =
      artifact_bytes.map(|_| elapsed_us(artifact_decode_start));
    let artifact_decode = match (artifact_decode_elapsed, artifact_bytes) {
      (Some(elapsed), Some(bytes)) => Some((elapsed, bytes.len())),
      _ => None,
    };
    Self::from_core_config_with_artifacts(
      config,
      artifacts.as_ref(),
      artifact_decode,
      context,
      binding_convert,
    )
  }

  fn from_core_config_with_artifacts(
    config: PreparedEngineConfig,
    artifacts: Option<&PreparedEngineArtifactsView<'_>>,
    artifact_decode: Option<(u64, usize)>,
    context: &PrepareContext,
    binding_convert: Option<(usize, u64)>,
  ) -> Result<Self> {
    let result = if let Some(artifacts) = artifacts {
      PreparedEngine::new_with_artifact_view_diagnostics(config, artifacts)
    } else {
      PreparedEngine::new_with_diagnostics(config)
    }
    .map_err(|error| to_napi_core_error(&error))?;
    let inner = Arc::new(result.prepared);
    let mut events = cache_miss_events(context);
    events.push(diagnostic_stage_event(
      context.parse_stage,
      None,
      Some(context.parse_elapsed),
      Some(context.input_bytes_len),
    ));
    append_package_decode_timing_events(&mut events, context);
    let mut diagnostics = StaticRedactionDiagnostics {
      events,
      ..StaticRedactionDiagnostics::default()
    };
    if let Some((pattern_count, convert_elapsed)) = binding_convert {
      diagnostics.events.push(diagnostic_stage_event(
        DiagnosticStage::PrepareBindingConvert,
        Some(pattern_count),
        Some(convert_elapsed),
        None,
      ));
    }
    if let Some((elapsed, bytes)) = artifact_decode {
      diagnostics.events.push(diagnostic_stage_event(
        DiagnosticStage::PrepareArtifactsDecode,
        None,
        Some(elapsed),
        Some(bytes),
      ));
    }
    diagnostics.extend(result.diagnostics);
    if let PrepareCache::Reuse { key, .. } = context.cache {
      prepared_search_cache_insert(key, Arc::clone(&inner));
    }
    Ok(Self {
      inner,
      prepare_diagnostics: diagnostics,
    })
  }

  #[napi]
  pub fn prepare_diagnostics_json(&self) -> Result<String> {
    let diagnostics =
      static_redaction_diagnostics_to_binding(self.prepare_diagnostics.clone());

    serde_json::to_string(&diagnostics)
      .map_err(|error| to_napi_serde_error(&error))
  }

  #[napi]
  pub fn warm_lazy_regex(&self) -> Result<()> {
    self
      .inner
      .warm_lazy_regex()
      .map_err(|error| to_napi_core_error(&error))
  }

  #[napi]
  pub fn warm_lazy_regex_diagnostics_json(&self) -> Result<String> {
    let diagnostics = self
      .inner
      .warm_lazy_regex_diagnostics()
      .map_err(|error| to_napi_core_error(&error))?;
    let diagnostics = static_redaction_diagnostics_to_binding(diagnostics);

    serde_json::to_string(&diagnostics)
      .map_err(|error| to_napi_serde_error(&error))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<JsStaticRedactionResult> {
    let operators =
      operator_config_from_binding(operators.map(to_binding_operator_config))
        .map_err(|error| to_napi_contract_error(&error))?;
    let result = self
      .inner
      .redact_static_entities(&full_text, &operators)
      .map_err(|error| to_napi_core_error(&error))?;
    static_redaction_result_to_utf16_binding(result, &full_text)
      .map_err(|error| to_napi_contract_error(&error))
      .and_then(to_js_static_redaction_result)
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    let operators =
      operator_config_from_binding(operators.map(to_binding_operator_config))
        .map_err(|error| to_napi_contract_error(&error))?;
    let result = self
      .inner
      .redact_static_entities(&full_text, &operators)
      .map_err(|error| to_napi_core_error(&error))?;
    let result = static_redaction_result_to_utf16_binding(result, &full_text)
      .map_err(|error| to_napi_contract_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_result_stream_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
    on_event: Function<'_, (String,), ()>,
  ) -> Result<String> {
    let operators =
      operator_config_from_binding(operators.map(to_binding_operator_config))
        .map_err(|error| to_napi_contract_error(&error))?;
    let result = self
      .inner
      .redact_static_entities_with_result_observer(
        &full_text,
        &operators,
        |event| {
          let event_json = result_stream_event_json(event, &full_text)?;
          on_event
            .call((event_json,))
            .map_err(|error| core_result_observer_error(error.to_string()))?;
          Ok(())
        },
      )
      .map_err(|error| to_napi_core_error(&error))?;
    let result = static_redaction_result_to_utf16_binding(result, &full_text)
      .map_err(|error| to_napi_contract_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_diagnostics_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    let operators =
      operator_config_from_binding(operators.map(to_binding_operator_config))
        .map_err(|error| to_napi_contract_error(&error))?;
    self.redact_static_entities_diagnostics_json_inner(
      &full_text,
      &operators,
      DiagnosticDetail::Detailed,
    )
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_summary_diagnostics_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
  ) -> Result<String> {
    let operators =
      operator_config_from_binding(operators.map(to_binding_operator_config))
        .map_err(|error| to_napi_contract_error(&error))?;
    self.redact_static_entities_diagnostics_json_inner(
      &full_text,
      &operators,
      DiagnosticDetail::Summary,
    )
  }

  #[napi]
  #[allow(clippy::needless_pass_by_value)]
  pub fn redact_static_entities_diagnostics_stream_json(
    &self,
    full_text: String,
    operators: Option<JsOperatorConfig>,
    on_batch: Function<'_, (String,), ()>,
  ) -> Result<String> {
    let operators =
      operator_config_from_binding(operators.map(to_binding_operator_config))
        .map_err(|error| to_napi_contract_error(&error))?;
    emit_prepare_diagnostics_batch(&self.prepare_diagnostics, &on_batch)?;
    let mut result = self
      .inner
      .redact_static_entities_with_diagnostics_observer(
        &full_text,
        &operators,
        |events| {
          let batch_json = diagnostic_event_batch_json(events, &full_text)?;
          on_batch
            .call((batch_json,))
            .map_err(|error| core_observer_error(error.to_string()))?;
          Ok(())
        },
      )
      .map_err(|error| to_napi_core_error(&error))?;
    let mut diagnostics = self.prepare_diagnostics.clone();
    diagnostics.extend(result.diagnostics);
    result.diagnostics = diagnostics;
    let result =
      static_redaction_diagnostic_result_to_utf16_binding(result, &full_text)
        .map_err(|error| to_napi_contract_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
  }

  fn redact_static_entities_diagnostics_json_inner(
    &self,
    full_text: &str,
    operators: &OperatorConfig,
    detail: DiagnosticDetail,
  ) -> Result<String> {
    let mut result = match detail {
      DiagnosticDetail::Detailed => self
        .inner
        .redact_static_entities_with_diagnostics(full_text, operators),
      DiagnosticDetail::Summary => self
        .inner
        .redact_static_entities_with_summary_diagnostics(full_text, operators),
    }
    .map_err(|error| to_napi_core_error(&error))?;
    let mut diagnostics = self.prepare_diagnostics.clone();
    diagnostics.extend(result.diagnostics);
    result.diagnostics = diagnostics;
    let result =
      static_redaction_diagnostic_result_to_utf16_binding(result, full_text)
        .map_err(|error| to_napi_contract_error(&error))?;

    serde_json::to_string(&result).map_err(|error| to_napi_serde_error(&error))
  }
}

fn emit_prepare_diagnostics_batch(
  diagnostics: &StaticRedactionDiagnostics,
  on_batch: &Function<'_, (String,), ()>,
) -> Result<()> {
  if diagnostics.events.is_empty() {
    return Ok(());
  }
  let diagnostics =
    static_redaction_diagnostics_to_binding(diagnostics.clone());
  let batch_json = serde_json::to_string(&diagnostics)
    .map_err(|error| to_napi_serde_error(&error))?;
  on_batch.call((batch_json,))
}

fn diagnostic_event_batch_json(
  events: &[DiagnosticEvent],
  full_text: &str,
) -> stella_anonymize_core::Result<String> {
  let diagnostics = diagnostic_events_to_utf16_binding(events, full_text)
    .map_err(|error| {
      core_observer_error(format!(
        "diagnostic batch conversion failed: {error}"
      ))
    })?;
  serde_json::to_string(&diagnostics).map_err(|error| {
    core_observer_error(format!(
      "diagnostic batch serialization failed: {error}"
    ))
  })
}

fn result_stream_event_json(
  event: stella_anonymize_core::StaticRedactionStreamEvent<'_>,
  full_text: &str,
) -> stella_anonymize_core::Result<String> {
  let event = static_redaction_stream_event_to_utf16_binding(event, full_text)
    .map_err(|error| {
      core_result_observer_error(format!(
        "result event conversion failed: {error}"
      ))
    })?;
  serde_json::to_string(&event).map_err(|error| {
    core_result_observer_error(format!(
      "result event serialization failed: {error}"
    ))
  })
}

const fn core_result_observer_error(reason: String) -> CoreError {
  CoreError::InvalidStaticData {
    field: "result.observer",
    reason,
  }
}

const fn core_observer_error(reason: String) -> CoreError {
  CoreError::InvalidStaticData {
    field: "diagnostics.observer",
    reason,
  }
}

const fn prepared_search_pattern_count(config: &PreparedEngineConfig) -> usize {
  config
    .search
    .regex_patterns
    .len()
    .saturating_add(config.search.custom_regex_patterns.len())
    .saturating_add(config.search.literal_patterns.len())
}

fn prepared_search_cache_get(key: &[u8; 32]) -> Option<Arc<PreparedEngine>> {
  with_prepared_search_cache(|cache| cache.get(key))
}

fn prepared_search_cache_insert(key: [u8; 32], value: Arc<PreparedEngine>) {
  with_prepared_search_cache(|cache| cache.insert(key, value));
}

fn cache_hit_events(
  cache: &CacheLookup,
  input_bytes_len: usize,
) -> Vec<DiagnosticEvent> {
  vec![
    diagnostic_stage_event(
      DiagnosticStage::PrepareCacheKey,
      None,
      Some(cache.key_elapsed),
      Some(input_bytes_len),
    ),
    diagnostic_stage_event(
      DiagnosticStage::PrepareCacheHit,
      Some(1),
      Some(cache.lookup_elapsed),
      Some(input_bytes_len),
    ),
  ]
}

fn cache_miss_events(context: &PrepareContext) -> Vec<DiagnosticEvent> {
  match context.cache {
    PrepareCache::Reuse {
      key_elapsed,
      lookup_elapsed,
      ..
    } => vec![
      diagnostic_stage_event(
        DiagnosticStage::PrepareCacheKey,
        None,
        Some(key_elapsed),
        Some(context.input_bytes_len),
      ),
      diagnostic_stage_event(
        DiagnosticStage::PrepareCacheMiss,
        Some(0),
        Some(lookup_elapsed),
        Some(context.input_bytes_len),
      ),
    ],
    PrepareCache::Bypass => vec![diagnostic_stage_event(
      DiagnosticStage::PrepareCacheBypass,
      Some(0),
      Some(0),
      Some(context.input_bytes_len),
    )],
  }
}

fn append_package_decode_timing_events(
  events: &mut Vec<DiagnosticEvent>,
  context: &PrepareContext,
) {
  let Some(timings) = context.package_decode_timings else {
    return;
  };
  append_package_decode_timing_events_for_input(
    events,
    timings,
    context.input_bytes_len,
  );
}

fn append_package_decode_timing_events_for_input(
  events: &mut Vec<DiagnosticEvent>,
  timings: PreparedSearchPackageDecodeTimings,
  input_bytes_len: usize,
) {
  events.extend(prepared_search_package_decode_timing_events(
    timings,
    input_bytes_len,
  ));
}

fn prepared_search_cache_key(
  config_bytes: &[u8],
  artifact_bytes: Option<&[u8]>,
) -> [u8; 32] {
  let mut hasher = blake3::Hasher::new();
  hasher.update(b"config");
  hasher.update(config_bytes);
  match artifact_bytes {
    Some(bytes) => {
      hasher.update(b"artifacts");
      hasher.update(bytes);
    }
    None => {
      hasher.update(b"no-artifacts");
    }
  }
  *hasher.finalize().as_bytes()
}

fn with_prepared_search_cache<T>(
  action: impl FnOnce(&mut PreparedSearchCache) -> T,
) -> T {
  let mut cache = match PREPARED_SEARCH_CACHE.lock() {
    Ok(cache) => cache,
    Err(poisoned) => poisoned.into_inner(),
  };
  action(&mut cache)
}

fn to_binding_operator_config(
  config: JsOperatorConfig,
) -> BindingOperatorConfig {
  BindingOperatorConfig {
    operators: config.operators,
    redact_string: config.redact_string,
  }
}

fn to_js_static_redaction_result(
  result: BindingStaticRedactionResult,
) -> Result<JsStaticRedactionResult> {
  Ok(JsStaticRedactionResult {
    resolved_entities: result
      .resolved_entities
      .into_iter()
      .map(|entity| JsPipelineEntity {
        start: entity.start,
        end: entity.end,
        label: entity.label,
        text: entity.text,
        score: entity.score,
        source: entity.source,
        source_detail: entity.source_detail,
      })
      .collect(),
    redaction: to_js_redaction_result(result.redaction)?,
  })
}

fn to_js_redaction_result(
  result: BindingRedactionResult,
) -> Result<JsRedactionResult> {
  Ok(JsRedactionResult {
    redacted_text: result.redacted_text,
    redaction_map: result
      .redaction_map
      .into_iter()
      .map(|entry| JsRedactionEntry {
        placeholder: entry.placeholder,
        original: entry.original,
      })
      .collect(),
    operator_map: to_js_operator_entries(result.operator_map),
    entity_count: u32::try_from(result.entity_count).map_err(|_| {
      Error::from_reason(format!(
        "Entity count exceeds u32 range: {}",
        result.entity_count
      ))
    })?,
  })
}

fn to_js_operator_entries(
  entries: Vec<BindingOperatorEntry>,
) -> Vec<JsOperatorEntry> {
  entries
    .into_iter()
    .map(|entry| JsOperatorEntry {
      placeholder: entry.placeholder,
      operator: entry.operator,
    })
    .collect()
}

fn elapsed_us(start: Instant) -> u64 {
  let micros = start.elapsed().as_micros();
  u64::try_from(micros).unwrap_or(u64::MAX)
}

fn to_napi_core_error(error: &stella_anonymize_core::Error) -> Error {
  Error::from_reason(error.to_string())
}

fn to_napi_contract_error(error: &ContractError) -> Error {
  Error::from_reason(error.to_string())
}

fn to_napi_serde_error(error: &serde_json::Error) -> Error {
  Error::from_reason(error.to_string())
}

fn to_napi_assemble_error(error: &AssembleError) -> Error {
  Error::from_reason(error.to_string())
}
