pub(crate) fn validate_named_id(validator: &str, value: &str) -> bool {
  stella_stdnum_core::validate_named_id(validator, value)
}

pub(crate) fn validate_id(
  validator: &str,
  value: &str,
  input: Option<&str>,
) -> bool {
  stella_stdnum_core::validate_id(validator, value, input)
}
