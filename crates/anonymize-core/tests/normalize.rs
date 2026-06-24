use stella_anonymize_core::normalize_for_search;

#[test]
fn normalize_for_search_matches_ts_replacements() {
  assert_eq!(normalize_for_search("hello\u{00a0}world"), "hello world");
  assert_eq!(normalize_for_search("1\u{2007}000"), "1 000");
  assert_eq!(normalize_for_search("a\u{202f}b"), "a b");
  assert_eq!(normalize_for_search("2020\u{2013}2024"), "2020-2024");
  assert_eq!(normalize_for_search("a\u{2014}b"), "a-b");
  assert_eq!(normalize_for_search("\u{201c}hello\u{201d}"), "\"hello\"");
}

#[test]
fn normalize_for_search_does_not_preserve_byte_width() {
  let input = "a\u{00a0}\u{1f600}\u{2013}b";
  let output = normalize_for_search(input);

  assert_eq!(output, "a \u{1f600}-b");
  assert_ne!(output.len(), input.len());
}
