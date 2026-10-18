use super::{
  ArchiveEntry, DocxRewriteError, HashMap, Node, WORDPROCESSING_NAMESPACES,
  conventional_supported_path, parse_export_xml, removed_content_type,
  unsupported, word_local,
};

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub(super) enum IdentifierSpace {
  Footnote,
  Endnote,
  Numbering,
  AbstractNumbering,
  EastAsianLayout,
}

#[derive(Debug, Default)]
pub(super) struct NumericIdentifiers {
  values: HashMap<IdentifierSpace, HashMap<i32, i32>>,
}

const IDENTIFIER_MAX: i32 = 1_000_000;

fn identifier(value: &str, space: IdentifierSpace) -> Option<i32> {
  let number = value.parse::<i32>().ok()?;
  let minimum = match space {
    IdentifierSpace::Footnote | IdentifierSpace::Endnote => -1,
    IdentifierSpace::Numbering
    | IdentifierSpace::AbstractNumbering
    | IdentifierSpace::EastAsianLayout => 0,
  };
  ((minimum..=IDENTIFIER_MAX).contains(&number) && number.to_string() == value)
    .then_some(number)
}

fn word_attribute<'a>(node: Node<'a, '_>, name: &str) -> Option<&'a str> {
  node.attributes().find_map(|attribute| {
    (attribute.name() == name
      && attribute.namespace().is_some_and(|namespace| {
        WORDPROCESSING_NAMESPACES.contains(&namespace)
      }))
    .then(|| attribute.value())
  })
}

impl NumericIdentifiers {
  pub(super) fn collect(
    entries: &[ArchiveEntry],
    content_types: &HashMap<&str, &str>,
    names: &super::PackageNames,
  ) -> Result<Self, DocxRewriteError> {
    let mut identifiers = Self::default();
    let mut next_ids = HashMap::new();
    let mut ordered_entries = entries.iter().collect::<Vec<_>>();
    ordered_entries.sort_by_key(|entry| names.path(&entry.path));
    for entry in ordered_entries {
      let Some(content_type) = content_types.get(entry.path.as_str()) else {
        continue;
      };
      if removed_content_type(content_type)
        || !conventional_supported_path(&entry.path, content_type)
      {
        continue;
      }
      let xml = std::str::from_utf8(&entry.bytes)
        .map_err(|_| unsupported("DOCX identifier part is not UTF-8"))?;
      let parsed = parse_export_xml(xml, "identifier part")?;
      let mut pending = vec![parsed.root_element()];
      while let Some(node) = pending.pop() {
        if word_local(node).is_some_and(|local| {
          super::identifier_subtree_is_removed(local, content_type)
        }) {
          continue;
        }
        pending.extend(node.children().rev().filter(Node::is_element));
        let parent = node.parent().and_then(word_local);
        let (space, attribute) = match (word_local(node), parent) {
          (Some("footnote"), Some("footnotes")) => {
            (IdentifierSpace::Footnote, "id")
          }
          (Some("endnote"), Some("endnotes")) => {
            (IdentifierSpace::Endnote, "id")
          }
          (Some("num"), Some("numbering")) => {
            (IdentifierSpace::Numbering, "numId")
          }
          (Some("abstractNum"), Some("numbering")) => {
            (IdentifierSpace::AbstractNumbering, "abstractNumId")
          }
          (Some("eastAsianLayout"), _)
            if word_attribute(node, "id").is_some() =>
          {
            (IdentifierSpace::EastAsianLayout, "id")
          }
          _ => continue,
        };
        let value = word_attribute(node, attribute)
          .and_then(|value| identifier(value, space))
          .ok_or_else(|| unsupported("Invalid DOCX identifier definition"))?;
        match space {
          IdentifierSpace::Numbering if value == 0 => {
            return Err(unsupported(
              "DOCX numbering definition uses reserved zero",
            ));
          }
          IdentifierSpace::Footnote
          | IdentifierSpace::Endnote
          | IdentifierSpace::Numbering
          | IdentifierSpace::AbstractNumbering
          | IdentifierSpace::EastAsianLayout => {}
        }
        let values = identifiers.values.entry(space).or_default();
        if values.contains_key(&value) {
          if space == IdentifierSpace::EastAsianLayout {
            continue;
          }
          return Err(unsupported("Duplicate DOCX identifier definition"));
        }
        let mapped = if value <= 0
          && matches!(
            space,
            IdentifierSpace::Footnote | IdentifierSpace::Endnote
          ) {
          value
        } else {
          let start = match space {
            IdentifierSpace::AbstractNumbering => 0,
            _ => 1,
          };
          let next = next_ids.entry(space).or_insert(start);
          if *next > IDENTIFIER_MAX {
            return Err(unsupported("DOCX identifier space exhausted"));
          }
          let mapped = *next;
          *next = next
            .checked_add(1)
            .ok_or_else(|| unsupported("DOCX identifier space exhausted"))?;
          mapped
        };
        values.insert(value, mapped);
      }
    }
    Ok(identifiers)
  }

  pub(super) fn resolve(
    &self,
    space: IdentifierSpace,
    value: &str,
  ) -> Option<String> {
    let value = identifier(value, space)?;
    if space == IdentifierSpace::Numbering && value == 0 {
      return Some("0".to_owned());
    }
    self.values.get(&space)?.get(&value).map(i32::to_string)
  }

  pub(super) fn is_identity(&self) -> bool {
    self
      .values
      .values()
      .all(|values| values.iter().all(|(original, mapped)| original == mapped))
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn collect(xml: &str) -> Result<NumericIdentifiers, DocxRewriteError> {
    let entries = [ArchiveEntry {
      path: "word/numbering.xml".to_owned(),
      bytes: format!(
        "<x:root xmlns:x=\"{}\"><x:footnotes>{xml}</x:footnotes><x:endnotes>{xml}</x:endnotes><x:numbering>{xml}</x:numbering></x:root>",
        WORDPROCESSING_NAMESPACES[0]
      )
      .into_bytes(),
    }];
    let content_types = HashMap::from([(
      "word/numbering.xml",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml",
    )]);
    let names =
      super::super::package_names(&entries, &std::collections::HashSet::new())?;
    NumericIdentifiers::collect(&entries, &content_types, &names)
  }

  #[test]
  fn definitions_use_independent_spaces_and_preserve_reserved_ids()
  -> Result<(), DocxRewriteError> {
    let identifiers = collect(
      "<x:footnote x:id=\"-1\" x:type=\"separator\"/><x:footnote x:id=\"0\" x:type=\"continuationSeparator\"/><x:footnote x:id=\"202555\"/><x:endnote x:id=\"202555\"/><x:num x:numId=\"202555\"/><x:abstractNum x:abstractNumId=\"202555\"/><x:footnote x:id=\"9\"/>",
    )?;
    for space in [
      IdentifierSpace::Footnote,
      IdentifierSpace::Endnote,
      IdentifierSpace::Numbering,
    ] {
      assert_eq!(identifiers.resolve(space, "202555"), Some("1".to_owned()));
    }
    assert_eq!(
      identifiers.resolve(IdentifierSpace::AbstractNumbering, "202555"),
      Some("0".to_owned())
    );
    assert_eq!(
      identifiers.resolve(IdentifierSpace::Footnote, "9"),
      Some("2".to_owned())
    );
    assert_eq!(
      identifiers.resolve(IdentifierSpace::Footnote, "-1"),
      Some("-1".to_owned())
    );
    assert_eq!(
      identifiers.resolve(IdentifierSpace::Footnote, "0"),
      Some("0".to_owned())
    );
    assert_eq!(
      identifiers.resolve(IdentifierSpace::Numbering, "0"),
      Some("0".to_owned())
    );
    assert_eq!(identifiers.resolve(IdentifierSpace::Endnote, "9"), None);
    assert_eq!(identifiers.resolve(IdentifierSpace::Numbering, "01"), None);
    assert!(!identifiers.is_identity());
    assert!(
      collect("<x:num x:numId=\"1\"/><x:abstractNum x:abstractNumId=\"0\"/>")?
        .is_identity()
    );
    Ok(())
  }

  #[test]
  fn special_note_types_do_not_impose_numeric_ids()
  -> Result<(), DocxRewriteError> {
    let identifiers = collect(
      "<x:footnote x:id=\"-1\" x:type=\"continuationNotice\"/><x:footnote x:id=\"0\" x:type=\"separator\"/><x:footnote x:id=\"99\" x:type=\"continuationSeparator\"/><x:footnote x:id=\"123\" x:type=\"continuationNotice\"/>",
    )?;
    for (original, mapped) in
      [("-1", "-1"), ("0", "0"), ("99", "1"), ("123", "2")]
    {
      assert_eq!(
        identifiers.resolve(IdentifierSpace::Footnote, original),
        Some(mapped.to_owned())
      );
    }
    Ok(())
  }

  #[test]
  fn special_note_references_are_not_definitions()
  -> Result<(), DocxRewriteError> {
    let identifiers = collect(
      "<x:footnote x:id=\"9\"/><x:footnotePr><x:footnote x:id=\"9\"/><x:footnote x:id=\"123\"/></x:footnotePr>",
    )?;
    assert_eq!(
      identifiers.resolve(IdentifierSpace::Footnote, "9"),
      Some("1".to_owned())
    );
    assert_eq!(identifiers.resolve(IdentifierSpace::Footnote, "123"), None);
    Ok(())
  }

  #[test]
  fn namespace_identity_uses_uris() -> Result<(), DocxRewriteError> {
    for namespace in WORDPROCESSING_NAMESPACES {
      let xml = format!(
        "<alias:num xmlns:alias=\"{namespace}\" alias:numId=\"99\"/><foreign:num xmlns:foreign=\"urn:other\" foreign:numId=\"99\"/>"
      );
      let identifiers = collect(&xml)?;
      assert_eq!(
        identifiers.resolve(IdentifierSpace::Numbering, "99"),
        Some("1".to_owned())
      );
    }
    Ok(())
  }

  #[test]
  fn generated_maps_are_total_injective_dense_and_idempotent()
  -> Result<(), DocxRewriteError> {
    use std::{collections::BTreeSet, fmt::Write as _};

    for count in 1_i32..=32 {
      for reverse in [false, true] {
        let originals = (0..count)
          .map(|index| {
            let position = if reverse { count - index - 1 } else { index };
            (202_555 + position * 997).to_string()
          })
          .collect::<Vec<_>>();
        let mut xml = String::new();
        for original in &originals {
          for (element, attribute) in [
            ("footnote", "id"),
            ("endnote", "id"),
            ("num", "numId"),
            ("abstractNum", "abstractNumId"),
            ("eastAsianLayout", "id"),
          ] {
            write!(xml, "<x:{element} x:{attribute}=\"{original}\"/>")
              .map_err(|_| {
                unsupported("Cannot construct identifier fixture")
              })?;
          }
        }
        let identifiers = collect(&xml)?;
        let mut rewritten = String::new();
        for (space, element, attribute, start) in [
          (IdentifierSpace::Footnote, "footnote", "id", 1),
          (IdentifierSpace::Endnote, "endnote", "id", 1),
          (IdentifierSpace::Numbering, "num", "numId", 1),
          (IdentifierSpace::EastAsianLayout, "eastAsianLayout", "id", 1),
          (
            IdentifierSpace::AbstractNumbering,
            "abstractNum",
            "abstractNumId",
            0,
          ),
        ] {
          let mut mapped_values = BTreeSet::new();
          for original in &originals {
            let mapped =
              identifiers.resolve(space, original).ok_or_else(|| {
                unsupported("Generated identifier was not mapped")
              })?;
            assert!(
              mapped_values.insert(mapped.clone()),
              "mapping is injective"
            );
            write!(rewritten, "<x:{element} x:{attribute}=\"{mapped}\"/>")
              .map_err(|_| {
                unsupported("Cannot construct identifier fixture")
              })?;
          }
          let expected = (start..start + count)
            .map(|value| value.to_string())
            .collect::<BTreeSet<_>>();
          assert_eq!(mapped_values, expected, "mapping is dense and total");
        }
        assert!(collect(&rewritten)?.is_identity());
      }
    }
    Ok(())
  }

  #[test]
  fn layout_groups_share_fresh_ids_without_reserving_zero()
  -> Result<(), DocxRewriteError> {
    let identifiers = collect(
      "<x:rPr><x:eastAsianLayout x:id=\"0\"/><x:eastAsianLayout x:id=\"202555\"/><x:eastAsianLayout x:id=\"0\"/><x:eastAsianLayout/></x:rPr>",
    )?;
    assert_eq!(
      identifiers.resolve(IdentifierSpace::EastAsianLayout, "0"),
      Some("1".to_owned())
    );
    assert_eq!(
      identifiers.resolve(IdentifierSpace::EastAsianLayout, "202555"),
      Some("2".to_owned())
    );
    assert_eq!(
      identifiers
        .values
        .get(&IdentifierSpace::EastAsianLayout)
        .map(HashMap::len),
      Some(2)
    );
    assert!(!identifiers.is_identity());
    Ok(())
  }

  #[test]
  fn cross_part_groups_follow_export_path_order() -> Result<(), DocxRewriteError>
  {
    use std::collections::HashSet;

    let mut entries = [
      ("word/header99.xml", "header", ["202555", "404777"]),
      ("word/footer87.xml", "footer", ["303666", "202555"]),
      ("word/document.xml", "document.main", ["101444", "202555"]),
    ]
    .map(|(path, suffix, ids)| {
      let xml = format!(
        "<w:document xmlns:w=\"{}\"><w:rPr><w:eastAsianLayout w:id=\"{}\"/><w:eastAsianLayout w:id=\"{}\"/></w:rPr></w:document>",
        WORDPROCESSING_NAMESPACES[0], ids[0], ids[1]
      );
      (ArchiveEntry { path: path.to_owned(), bytes: xml.into_bytes() }, suffix)
    });
    for _ in 0..2 {
      let archive = entries
        .iter()
        .map(|(entry, _)| entry.clone())
        .collect::<Vec<_>>();
      let types_owned = entries.iter().map(|(entry, suffix)| {
        (entry.path.clone(), format!("application/vnd.openxmlformats-officedocument.wordprocessingml.{suffix}+xml"))
      }).collect::<Vec<_>>();
      let types = types_owned
        .iter()
        .map(|(path, content_type)| (path.as_str(), content_type.as_str()))
        .collect();
      let names = super::super::package_names(&archive, &HashSet::new())?;
      let identifiers = NumericIdentifiers::collect(&archive, &types, &names)?;
      for (original, expected) in [
        ("101444", "1"),
        ("202555", "2"),
        ("303666", "3"),
        ("404777", "4"),
      ] {
        assert_eq!(
          identifiers.resolve(IdentifierSpace::EastAsianLayout, original),
          Some(expected.to_owned())
        );
      }
      let mut rewritten = Vec::new();
      let mut rewritten_types = Vec::new();
      for (entry, suffix) in &entries {
        let xml = std::str::from_utf8(&entry.bytes)
          .map_err(|_| unsupported("Invalid fixture"))?;
        let mut xml = xml.to_owned();
        for original in ["101444", "202555", "303666", "404777"] {
          let mapped = identifiers
            .resolve(IdentifierSpace::EastAsianLayout, original)
            .ok_or_else(|| unsupported("Missing fixture group"))?;
          xml = xml.replace(original, &mapped);
        }
        let path = names.path(&entry.path).to_owned();
        rewritten_types.push((path.clone(), format!("application/vnd.openxmlformats-officedocument.wordprocessingml.{suffix}+xml")));
        rewritten.push(ArchiveEntry {
          path,
          bytes: xml.into_bytes(),
        });
      }
      rewritten.sort_by(|left, right| left.path.cmp(&right.path));
      let rewritten_content_types = rewritten_types
        .iter()
        .map(|(path, content_type)| (path.as_str(), content_type.as_str()))
        .collect();
      let rewritten_names =
        super::super::package_names(&rewritten, &HashSet::new())?;
      assert!(
        NumericIdentifiers::collect(
          &rewritten,
          &rewritten_content_types,
          &rewritten_names,
        )?
        .is_identity()
      );
      entries.reverse();
    }
    Ok(())
  }

  #[test]
  fn removed_subtrees_do_not_consume_group_ids() -> Result<(), DocxRewriteError>
  {
    use std::collections::HashSet;

    for (path, suffix, removed) in [
      ("word/document.xml", "document.main", "sdtPr"),
      ("word/numbering.xml", "numbering", "latentStyles"),
    ] {
      let entries = [ArchiveEntry {
        path: path.to_owned(),
        bytes: format!(
          "<w:document xmlns:w=\"{}\"><w:{removed}><w:eastAsianLayout w:id=\"202555\"/></w:{removed}><w:rPr><w:eastAsianLayout w:id=\"303666\"/></w:rPr></w:document>",
          WORDPROCESSING_NAMESPACES[0]
        ).into_bytes(),
      }];
      let content_type = format!(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.{suffix}+xml"
      );
      let types = HashMap::from([(path, content_type.as_str())]);
      let names = super::super::package_names(&entries, &HashSet::new())?;
      let identifiers = NumericIdentifiers::collect(&entries, &types, &names)?;
      assert_eq!(
        identifiers.resolve(IdentifierSpace::EastAsianLayout, "202555"),
        None
      );
      assert_eq!(
        identifiers.resolve(IdentifierSpace::EastAsianLayout, "303666"),
        Some("1".to_owned())
      );
    }
    Ok(())
  }

  #[test]
  fn invalid_definitions_fail_closed() {
    for xml in [
      "<x:num x:numId=\"2\"/><x:num x:numId=\"2\"/>",
      "<x:num x:numId=\"0\"/>",
      "<x:num x:numId=\"01\"/>",
      "<x:num x:numId=\"1000001\"/>",
      "<x:footnote x:id=\"-2\"/>",
      "<x:num numId=\"2\"/>",
      "<x:abstractNum/>",
      "<x:eastAsianLayout x:id=\"-1\"/>",
      "<x:eastAsianLayout x:id=\"01\"/>",
    ] {
      assert!(collect(xml).is_err(), "definition must be rejected");
    }
  }
}
