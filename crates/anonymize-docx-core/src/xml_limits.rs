use quick_xml::{Reader, events::Event};

use super::{DOCX_XML_MAX_DEPTH, DocxError, DocxErrorCode, error};

// roxmltree recursively parses element content. Bound its input with an
// iterative reader before it can consume one stack frame per nested element.
pub(super) fn validate_xml_depth(bytes: &[u8]) -> Result<(), DocxError> {
  let mut reader = Reader::from_reader(bytes);
  let mut depth = 0_usize;
  loop {
    let event = reader.read_event().map_err(|_| {
      error(DocxErrorCode::InvalidXml, "DOCX part is not valid XML")
    })?;
    match event {
      Event::Start(_) | Event::Empty(_) => {
        let next_depth = depth.saturating_add(1);
        if next_depth >= DOCX_XML_MAX_DEPTH {
          return Err(error(
            DocxErrorCode::UncompressedLimitExceeded,
            format!(
              "DOCX XML must contain fewer than {DOCX_XML_MAX_DEPTH} nested elements"
            ),
          ));
        }
        if matches!(event, Event::Start(_)) {
          depth = next_depth;
        }
      }
      Event::End(_) => {
        depth = depth.checked_sub(1).ok_or_else(|| {
          error(DocxErrorCode::InvalidXml, "DOCX part is not valid XML")
        })?;
      }
      Event::DocType(_) => {
        return Err(error(
          DocxErrorCode::InvalidPackage,
          "DOCX XML must not contain a document type declaration",
        ));
      }
      Event::Eof => {
        if depth != 0 {
          return Err(error(
            DocxErrorCode::InvalidXml,
            "DOCX part is not valid XML",
          ));
        }
        return Ok(());
      }
      Event::Text(_)
      | Event::CData(_)
      | Event::Comment(_)
      | Event::Decl(_)
      | Event::PI(_)
      | Event::GeneralRef(_) => {}
    }
  }
}

#[cfg(test)]
mod tests {
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
}
