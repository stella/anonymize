#![allow(clippy::redundant_pub_crate)]

//! Core anonymization contracts shared by host-language bindings.

mod address_context;
mod address_seeds;
mod anchored;
mod artifact_bytes;
pub(crate) mod byte_offsets;
mod coreference;
mod dates;
mod diagnostics;
/// Cross-crate concurrency seam: scoped OS threads on native, sequential
/// execution on WebAssembly. Public for reuse by workspace binding crates.
#[doc(hidden)]
pub mod exec;
mod false_positives;
mod hotwords;
mod legal_forms;
mod money;
mod name_corpus;
pub(crate) mod normalize;
mod placeholders;
mod prepared;
mod processors;
mod redact;
mod resolution;
mod search;
mod signatures;
mod triggers;
mod types;
mod validators;
mod zones;

pub use address_context::AddressContextData;
pub use address_seeds::AddressSeedData;
pub use coreference::{CoreferenceData, CoreferencePatternData};
pub use dates::DateData;
pub use diagnostics::{
  DiagnosticDetail, DiagnosticEvent, DiagnosticEventKind, DiagnosticPhase,
  DiagnosticScope, DiagnosticStage, StaticRedactionDiagnostics,
};
pub use hotwords::{HotwordRule, HotwordRuleData};
pub use legal_forms::LegalFormData;
pub use money::{
  AmountWordsData, CurrencyData, MagnitudeSuffixData, MonetaryData,
  ShareQuantityTermData, WrittenAmountPatternData,
};
pub use name_corpus::{NameCorpusData, NameCorpusMode, PreparedNameCorpusData};
pub use normalize::normalize_for_search;
pub use placeholders::build_placeholder_map;
pub use prepared::{
  PreparedEngine, PreparedEngineArtifacts, PreparedEngineArtifactsView,
  PreparedEngineBuildResult, PreparedEngineConfig,
  PreparedEngineDetectorConfig, PreparedEngineMatches,
  PreparedEnginePolicyConfig, PreparedEngineSearchConfig, PreparedEngineSlices,
  StaticDetectionResult, StaticEntityLayers, StaticRedactionDiagnosticResult,
  StaticRedactionResult, StaticRedactionStreamEvent,
};
pub use processors::{
  CountryMatchData, DenyListFilterData, DenyListMatchData, DenyListPatternMeta,
  DenyListPatternMetaSet, GazetteerMatchData, PatternSlice, RegexMatchMeta,
  SigningPlaceGuardData, StringGroups, process_country_matches,
  process_deny_list_matches, process_gazetteer_matches, process_regex_matches,
};
pub use redact::{deanonymise, redact_text};
pub use resolution::{
  DetectionSource, PipelineEntity, SourceDetail, enforce_boundary_consistency,
  merge_and_dedup, sanitize_entities,
};
pub use search::{
  FuzzySearchOptions, LiteralSearchOptions, PreparedArtifactPolicy,
  RegexArtifactPolicy, RegexSearchOptions, SearchIndex, SearchIndexArtifacts,
  SearchOptions, SearchPattern,
};
pub use signatures::SignatureData;
pub use triggers::{
  TriggerData, TriggerRule, TriggerStrategy, TriggerValidation,
};
pub use types::{
  Entity, EntityKind, Error, OperatorConfig, OperatorEntry, OperatorType,
  PlaceholderEntry, PlaceholderMap, RedactionEntry, RedactionResult, Result,
  SearchEngine, SearchMatch,
};
pub use zones::{ZoneData, ZonePatternData, ZoneSigningClauseData};
