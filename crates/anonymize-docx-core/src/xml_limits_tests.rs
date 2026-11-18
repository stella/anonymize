use super::{DOCX_XML_MAX_DEPTH, DocxErrorCode, validate_xml_depth};
use crate::parse_xml;

#[test]
fn rejects_over_limit_depth_before_recursive_parsing()
-> Result<(), Box<dyn std::error::Error>> {
  for depth in [DOCX_XML_MAX_DEPTH, 300, 10_000] {
    let xml = format!("{}{}", "<n>".repeat(depth), "</n>".repeat(depth));
    let failure = parse_xml(xml.as_bytes(), "synthetic.xml")
      .err()
      .ok_or("over-depth XML was accepted")?;
    assert_eq!(
      failure.code(),
      DocxErrorCode::UncompressedLimitExceeded,
      "over-depth XML must return its resource-limit error"
    );
  }
  Ok(())
}

#[test]
fn preserves_depth_boundary_and_ignores_markup_in_text()
-> Result<(), Box<dyn std::error::Error>> {
  let depth = DOCX_XML_MAX_DEPTH.saturating_sub(1);
  let xml = format!("{}{}", "<n>".repeat(depth), "</n>".repeat(depth));
  let parsed = parse_xml(xml.as_bytes(), "synthetic.xml")?;
  assert_eq!(
    parsed
      .descendants()
      .filter(roxmltree::Node::is_element)
      .count(),
    depth,
    "all permitted nested elements must survive parsing"
  );
  let apparent_tags = "<n>".repeat(10_000);
  let text =
    format!("<n><![CDATA[{apparent_tags}]]><!--{apparent_tags}--><e/></n>");
  validate_xml_depth(text.as_bytes())?;
  let parsed_text = parse_xml(text.as_bytes(), "synthetic.xml")?;
  assert_eq!(
    parsed_text.root_element().text(),
    Some(apparent_tags.as_str()),
    "CDATA must remain text rather than increasing element depth"
  );
  Ok(())
}
