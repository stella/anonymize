// Header, footer and theme part numbers and relationship identifiers are
// chosen by the producer and survive in ZIP paths, content types and
// references without passing through extraction. The export renumbers both
// sequentially, consistently across every place that names them, so they
// carry no producer-chosen value.

use std::collections::{HashMap, HashSet};

use roxmltree::Node;

use super::{
  ArchiveEntry, DocxRewriteError, allowed_relationship_suffix,
  parse_export_xml, relationship_entry, relationship_removed,
  relationship_source_path, resolve_relationship_target, unsupported,
};

const NUMBERED_PART_STEMS: [&str; 3] =
  ["word/header", "word/footer", "word/theme/theme"];

#[derive(Debug)]
pub(super) struct PackageNames {
  // Original path to export path for each renumbered part and the
  // relationships part that belongs to it.
  paths: HashMap<String, String>,
  // Relationship source path (empty for the package) to original and export
  // relationship identifiers.
  relationships: HashMap<String, HashMap<String, String>>,
}

impl PackageNames {
  pub(super) fn path<'a>(&'a self, path: &'a str) -> &'a str {
    self.paths.get(path).map_or(path, String::as_str)
  }

  pub(super) fn relationships(
    &self,
    source: &str,
  ) -> Option<&HashMap<String, String>> {
    self.relationships.get(source)
  }

  pub(super) fn is_identity(&self) -> bool {
    self.paths.iter().all(|(from, to)| from == to)
      && self
        .relationships
        .values()
        .flatten()
        .all(|(from, to)| from == to)
  }
}

pub(super) fn part_number(path: &str, stem: &str) -> Option<u64> {
  let digits = path.strip_prefix(stem)?.strip_suffix(".xml")?;
  if digits.is_empty()
    || digits.len() > 10
    || !digits.bytes().all(|byte| byte.is_ascii_digit())
  {
    return None;
  }
  digits.parse().ok()
}

fn relationships_path(source: &str) -> String {
  let (directory, file) = source.rsplit_once('/').unwrap_or(("", source));
  format!("{directory}/_rels/{file}.rels")
}

fn relationship_number(identifier: &str) -> u64 {
  identifier
    .strip_prefix("rId")
    .and_then(|digits| digits.parse().ok())
    .unwrap_or(u64::MAX)
}

// Retained relationships are numbered in (type, export target, original
// number) order, so equal packages get equal identifiers whatever the
// producer chose.
fn relationship_identifiers(
  entry: &ArchiveEntry,
  paths: &HashMap<String, String>,
  removed_paths: &HashSet<String>,
) -> Result<HashMap<String, String>, DocxRewriteError> {
  let xml = std::str::from_utf8(&entry.bytes)
    .map_err(|_| unsupported("DOCX relationships are not valid UTF-8"))?;
  let document = parse_export_xml(xml, "relationships part")?;
  let mut retained = Vec::new();
  for node in document.descendants().filter(|node: &Node<'_, '_>| {
    node.is_element() && node.tag_name().name() == "Relationship"
  }) {
    let relation_type = node.attribute("Type").unwrap_or_default();
    let resolved = resolve_relationship_target(
      node.attribute("Target").unwrap_or_default(),
      &entry.path,
    );
    if relationship_removed(relation_type, resolved.as_deref(), removed_paths) {
      continue;
    }
    let identifier = node.attribute("Id").unwrap_or_default();
    let target = resolved
      .map(|target| paths.get(&target).cloned().unwrap_or(target))
      .unwrap_or_default();
    retained.push((
      allowed_relationship_suffix(relation_type).unwrap_or(relation_type),
      target,
      relationship_number(identifier),
      identifier,
    ));
  }
  retained.sort_unstable();
  let mut identifiers = HashMap::new();
  for (index, (_, _, _, identifier)) in (1_usize..).zip(retained) {
    if identifiers
      .insert(identifier.to_owned(), format!("rId{index}"))
      .is_some()
    {
      return Err(unsupported(
        "DOCX relationships contain duplicate identifiers",
      ));
    }
  }
  Ok(identifiers)
}

pub(super) fn package_names(
  entries: &[ArchiveEntry],
  removed_paths: &HashSet<String>,
) -> Result<PackageNames, DocxRewriteError> {
  let mut paths = HashMap::new();
  for stem in NUMBERED_PART_STEMS {
    let mut numbered = entries
      .iter()
      .filter_map(|entry| {
        part_number(&entry.path, stem).map(|number| (number, &entry.path))
      })
      .collect::<Vec<_>>();
    numbered.sort_unstable();
    for (index, (_, path)) in (1_usize..).zip(numbered) {
      paths.insert(path.clone(), format!("{stem}{index}.xml"));
    }
  }
  let renamed_relationships = entries
    .iter()
    .filter_map(|entry| {
      let source = paths.get(&relationship_source_path(&entry.path)?)?;
      Some((entry.path.clone(), relationships_path(source)))
    })
    .collect::<Vec<_>>();
  paths.extend(renamed_relationships);
  let mut relationships = HashMap::new();
  for entry in entries
    .iter()
    .filter(|entry| relationship_entry(&entry.path))
  {
    relationships.insert(
      relationship_source_path(&entry.path).unwrap_or_default(),
      relationship_identifiers(entry, &paths, removed_paths)?,
    );
  }
  Ok(PackageNames {
    paths,
    relationships,
  })
}
