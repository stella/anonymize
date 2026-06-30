macro_rules! prepared_config {
  ($($field:ident: $value:expr,)* ..$base:expr $(,)?) => {{
    let mut config = $base;
    $(prepared_config!(@set config, $field, $value);)*
    config
  }};
  ($($field:ident: $value:expr),* $(,)?) => {{
    let mut config = stella_anonymize_core::PreparedEngineConfig::default();
    $(prepared_config!(@set config, $field, $value);)*
    config
  }};
  (@set $config:ident, regex_patterns, $value:expr) => {
    $config.search.regex_patterns = $value;
  };
  (@set $config:ident, custom_regex_patterns, $value:expr) => {
    $config.search.custom_regex_patterns = $value;
  };
  (@set $config:ident, literal_patterns, $value:expr) => {
    $config.search.literal_patterns = $value;
  };
  (@set $config:ident, regex_options, $value:expr) => {
    $config.search.regex_options = $value;
  };
  (@set $config:ident, custom_regex_options, $value:expr) => {
    $config.search.custom_regex_options = $value;
  };
  (@set $config:ident, literal_options, $value:expr) => {
    $config.search.literal_options = $value;
  };
  (@set $config:ident, slices, $value:expr) => {
    $config.search.slices = $value;
  };
  (@set $config:ident, regex_meta, $value:expr) => {
    $config.search.regex_meta = $value;
  };
  (@set $config:ident, custom_regex_meta, $value:expr) => {
    $config.search.custom_regex_meta = $value;
  };
  (@set $config:ident, allowed_labels, $value:expr) => {
    $config.policy.allowed_labels = $value;
  };
  (@set $config:ident, threshold, $value:expr) => {
    $config.policy.threshold = $value;
  };
  (@set $config:ident, confidence_boost, $value:expr) => {
    $config.policy.confidence_boost = $value;
  };
  (@set $config:ident, deny_list_data, $value:expr) => {
    $config.detectors.deny_list_data = $value;
  };
  (@set $config:ident, false_positive_filters, $value:expr) => {
    $config.detectors.false_positive_filters = $value;
  };
  (@set $config:ident, gazetteer_data, $value:expr) => {
    $config.detectors.gazetteer_data = $value;
  };
  (@set $config:ident, country_data, $value:expr) => {
    $config.detectors.country_data = $value;
  };
  (@set $config:ident, hotword_data, $value:expr) => {
    $config.detectors.hotword_data = $value;
  };
  (@set $config:ident, trigger_data, $value:expr) => {
    $config.detectors.trigger_data = $value;
  };
  (@set $config:ident, legal_form_data, $value:expr) => {
    $config.detectors.legal_form_data = $value;
  };
  (@set $config:ident, address_seed_data, $value:expr) => {
    $config.detectors.address_seed_data = $value;
  };
  (@set $config:ident, zone_data, $value:expr) => {
    $config.detectors.zone_data = $value;
  };
  (@set $config:ident, address_context_data, $value:expr) => {
    $config.detectors.address_context_data = $value;
  };
  (@set $config:ident, coreference_data, $value:expr) => {
    $config.detectors.coreference_data = $value;
  };
  (@set $config:ident, name_corpus_data, $value:expr) => {
    $config.detectors.name_corpus_data = $value;
  };
  (@set $config:ident, signature_data, $value:expr) => {
    $config.detectors.signature_data = $value;
  };
  (@set $config:ident, date_data, $value:expr) => {
    $config.detectors.date_data = $value;
  };
  (@set $config:ident, monetary_data, $value:expr) => {
    $config.detectors.monetary_data = $value;
  };
}

pub(crate) use prepared_config;
