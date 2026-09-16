use std::{
  collections::{HashMap, HashSet},
  io::{Cursor, Write as _},
};

use roxmltree::{Document, Node};
use serde::Serialize;
use zip::{CompressionMethod, ZipWriter, write::SimpleFileOptions};

use super::{
  ArchiveEntry, CONTENT_TYPES_NAMESPACE, CONTENT_TYPES_PATH,
  CORE_PROPERTIES_CONTENT_TYPE, CUSTOM_PROPERTIES_CONTENT_TYPE,
  ContentTypePart, DocxExtraction, DocxRewriteError, DocxRewriteErrorCode,
  DocxSegmentSource, EXTENDED_PROPERTIES_CONTENT_TYPE,
  PACKAGE_RELATIONSHIP_NAMESPACES, RELATIONSHIP_NAMESPACES,
  RELATIONSHIPS_CONTENT_TYPE, ROOT_RELATIONSHIPS_PATH,
  WORDPROCESSING_CONTENT_TYPE_PREFIX, WORDPROCESSING_NAMESPACES, classify_part,
  extract_docx_text, parse_content_types, parse_xml, read_archive,
  resolve_relationship_target, rewrite_error,
};

const DRAWINGML_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/drawingml/2006/main";
const STRICT_DRAWINGML_NAMESPACE: &str =
  "http://purl.oclc.org/ooxml/drawingml/main";
const DRAWINGML_NAMESPACES: [&str; 2] =
  [DRAWINGML_NAMESPACE, STRICT_DRAWINGML_NAMESPACE];
const XML_NAMESPACE: &str = "http://www.w3.org/XML/1998/namespace";
const WORD_2010_NAMESPACE: &str =
  "http://schemas.microsoft.com/office/word/2010/wordml";
const MARKUP_COMPATIBILITY_NAMESPACES: [&str; 2] = [
  "http://purl.oclc.org/ooxml/markup-compatibility/main",
  "http://schemas.openxmlformats.org/markup-compatibility/2006",
];
const THEME_CONTENT_TYPE: &str =
  "application/vnd.openxmlformats-officedocument.theme+xml";
const OFFICE_WEB_EXTENSION_CONTENT_TYPE_PREFIX: &str =
  "application/vnd.ms-office.webextension";

const REMOVED_WORD_PART_SUFFIXES: [&str; 4] = [
  "comments+xml",
  "commentsExtended+xml",
  "commentsIds+xml",
  "people+xml",
];
const REMOVED_FORMATTING_WORD_PART_SUFFIXES: [&str; 4] = [
  "fontTable+xml",
  "settings+xml",
  "stylesWithEffects+xml",
  "webSettings+xml",
];
const FORMATTING_WORD_PART_SUFFIXES: [&str; 2] =
  ["numbering+xml", "styles+xml"];
const REMOVED_RELATIONSHIP_SUFFIXES: [&str; 15] = [
  "/comments",
  "/commentsExtended",
  "/commentsIds",
  "/core-properties",
  "/custom-properties",
  "/extended-properties",
  "/hyperlink",
  "/people",
  "/fontTable",
  "/settings",
  "/stylesWithEffects",
  "/webSettings",
  "/taskpanes",
  "/webextension",
  "/webextensiontaskpanes",
];
const ALLOWED_RELATIONSHIP_SUFFIXES: [&str; 8] = [
  "/endnotes",
  "/footer",
  "/footnotes",
  "/header",
  "/numbering",
  "/officeDocument",
  "/styles",
  "/theme",
];
const PROHIBITED_WORD_ELEMENTS: [&str; 22] = [
  "altChunk",
  "cellDel",
  "cellIns",
  "cellMerge",
  "del",
  "delInstrText",
  "ins",
  "moveFrom",
  "moveFromRangeEnd",
  "moveFromRangeStart",
  "moveTo",
  "moveToRangeEnd",
  "moveToRangeStart",
  "numberingChange",
  "object",
  "pict",
  "sectPrChange",
  "sym",
  "tblPrChange",
  "tcPrChange",
  "trPrChange",
  "rPrChange",
];
const STYLE_REFERENCE_ELEMENTS: [&str; 8] = [
  "basedOn",
  "link",
  "next",
  "numStyleLink",
  "pStyle",
  "rStyle",
  "styleLink",
  "tblStyle",
];
const REMOVED_WORD_ELEMENTS: [&str; 10] = [
  "bookmarkEnd",
  "bookmarkStart",
  "commentRangeEnd",
  "commentRangeStart",
  "commentReference",
  "customXmlPr",
  "proofErr",
  "permEnd",
  "permStart",
  "sdtPr",
];
const SAFE_CONTENT_WORD_ELEMENTS: &[&str] = &[
  "adjustRightInd",
  "b",
  "bCs",
  "background",
  "bidi",
  "body",
  "bottom",
  "bidiVisual",
  "br",
  "cantSplit",
  "caps",
  "cnfStyle",
  "color",
  "cols",
  "contextualSpacing",
  "continuationSeparator",
  "cr",
  "docGrid",
  "document",
  "cs",
  "dstrike",
  "eastAsianLayout",
  "effect",
  "em",
  "endnote",
  "endnotePr",
  "endnoteReference",
  "endnotes",
  "ftr",
  "footerReference",
  "footnote",
  "footnotePr",
  "footnoteReference",
  "footnotes",
  "gridAfter",
  "gridBefore",
  "gridCol",
  "gridSpan",
  "hdr",
  "headerReference",
  "hideMark",
  "highlight",
  "hMerge",
  "i",
  "iCs",
  "ilvl",
  "imprint",
  "ind",
  "insideH",
  "insideV",
  "jc",
  "keepLines",
  "keepNext",
  "kern",
  "lang",
  "lastRenderedPageBreak",
  "left",
  "lnNumType",
  "mirrorInd",
  "noBreakHyphen",
  "noProof",
  "noWrap",
  "numId",
  "numFmt",
  "numPr",
  "numRestart",
  "numStart",
  "outline",
  "outlineLvl",
  "p",
  "pBdr",
  "pPr",
  "pStyle",
  "pageBreakBefore",
  "pageNumber",
  "paperSrc",
  "pgBorders",
  "pgMar",
  "pgNumType",
  "pgSz",
  "pos",
  "position",
  "r",
  "rFonts",
  "rPr",
  "rStyle",
  "right",
  "rtl",
  "sectPr",
  "shd",
  "shadow",
  "smallCaps",
  "snapToGrid",
  "softHyphen",
  "spacing",
  "specVanish",
  "strike",
  "separator",
  "suppressAutoHyphens",
  "suppressLineNumbers",
  "sz",
  "szCs",
  "t",
  "tab",
  "tabs",
  "tbl",
  "tblBorders",
  "tblCellMar",
  "tblCellSpacing",
  "tblGrid",
  "tblHeader",
  "tblInd",
  "tblLayout",
  "tblLook",
  "tblOverlap",
  "tblPr",
  "tblPrEx",
  "tblStyle",
  "tblStyleColBandSize",
  "tblStyleRowBandSize",
  "tblW",
  "tblpPr",
  "tc",
  "tcBorders",
  "tcFitText",
  "tcMar",
  "tcPr",
  "tcW",
  "textAlignment",
  "textDirection",
  "titlePg",
  "top",
  "tr",
  "trHeight",
  "trPr",
  "type",
  "u",
  "vAlign",
  "vanish",
  "vertAlign",
  "vMerge",
  "w",
  "webHidden",
  "widowControl",
  "wordWrap",
];
const SAFE_STYLE_WORD_ELEMENTS: &[&str] = &[
  "autoRedefine",
  "basedOn",
  "docDefaults",
  "hidden",
  "link",
  "locked",
  "next",
  "pPrDefault",
  "personal",
  "personalCompose",
  "personalReply",
  "qFormat",
  "rPrDefault",
  "semiHidden",
  "style",
  "styles",
  "tblStylePr",
  "uiPriority",
  "unhideWhenUsed",
];
const SAFE_NUMBERING_WORD_ELEMENTS: &[&str] = &[
  "abstractNum",
  "abstractNumId",
  "isLgl",
  "lvl",
  "lvlJc",
  "lvlOverride",
  "lvlRestart",
  "lvlText",
  "multiLevelType",
  "nsid",
  "num",
  "numbering",
  "numFmt",
  "numIdMacAtCleanup",
  "numStyleLink",
  "pStyle",
  "start",
  "startOverride",
  "suff",
  "styleLink",
  "tmpl",
];
const WORD_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const OFFICE_RELATIONSHIP_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const PACKAGE_RELATIONSHIP_NAMESPACE: &str =
  "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_DECLARATION: &str =
  "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>";

#[derive(Debug, Clone, Eq, PartialEq, Serialize)]
pub struct DocxAnonymizedExportReport {
  #[serde(rename = "contractVersion")]
  pub contract_version: u8,
  #[serde(rename = "removedPartCount")]
  pub removed_part_count: usize,
  #[serde(rename = "sanitizedXmlPartCount")]
  pub sanitized_xml_part_count: usize,
}

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct DocxAnonymizedExportPreparation {
  pub document: Vec<u8>,
  pub extraction: DocxExtraction,
  pub report: DocxAnonymizedExportReport,
}

fn unsupported(message: impl Into<String>) -> DocxRewriteError {
  rewrite_error(DocxRewriteErrorCode::UnsupportedReplacement, message)
}

fn word_local<'input>(node: Node<'_, 'input>) -> Option<&'input str> {
  WORDPROCESSING_NAMESPACES
    .contains(&node.tag_name().namespace().unwrap_or_default())
    .then(|| node.tag_name().name())
}

fn metadata_content_type(content_type: &str) -> bool {
  matches!(
    content_type,
    CORE_PROPERTIES_CONTENT_TYPE
      | EXTENDED_PROPERTIES_CONTENT_TYPE
      | CUSTOM_PROPERTIES_CONTENT_TYPE
  )
}

fn word_suffix(content_type: &str) -> Option<&str> {
  content_type.strip_prefix(WORDPROCESSING_CONTENT_TYPE_PREFIX)
}

fn removed_content_type(content_type: &str) -> bool {
  metadata_content_type(content_type)
    || content_type.starts_with(OFFICE_WEB_EXTENSION_CONTENT_TYPE_PREFIX)
    || word_suffix(content_type).is_some_and(|suffix| {
      REMOVED_WORD_PART_SUFFIXES.contains(&suffix)
        || REMOVED_FORMATTING_WORD_PART_SUFFIXES.contains(&suffix)
    })
}

fn formatting_content_type(content_type: &str) -> bool {
  content_type == THEME_CONTENT_TYPE
    || word_suffix(content_type)
      .is_some_and(|suffix| FORMATTING_WORD_PART_SUFFIXES.contains(&suffix))
}

fn conventional_supported_path(path: &str, content_type: &str) -> bool {
  if classify_part(&ContentTypePart {
    path: path.to_owned(),
    content_type: content_type.to_owned(),
  })
  .is_some()
  {
    return path == "word/document.xml"
      || path == "word/footnotes.xml"
      || path == "word/endnotes.xml"
      || numbered_word_part(path, "header")
      || numbered_word_part(path, "footer");
  }
  match word_suffix(content_type) {
    Some("fontTable+xml") => path == "word/fontTable.xml",
    Some("numbering+xml") => path == "word/numbering.xml",
    Some("settings+xml") => path == "word/settings.xml",
    Some("styles+xml") => path == "word/styles.xml",
    Some("stylesWithEffects+xml") => path == "word/stylesWithEffects.xml",
    Some("webSettings+xml") => path == "word/webSettings.xml",
    _ if content_type == THEME_CONTENT_TYPE => theme_path(path),
    _ => false,
  }
}

fn numbered_word_part(path: &str, stem: &str) -> bool {
  path
    .strip_prefix(&format!("word/{stem}"))
    .and_then(|tail| tail.strip_suffix(".xml"))
    .is_some_and(|digits| {
      !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn theme_path(path: &str) -> bool {
  path
    .strip_prefix("word/theme/theme")
    .and_then(|tail| tail.strip_suffix(".xml"))
    .is_some_and(|digits| {
      !digits.is_empty()
        && digits.len() <= 10
        && digits.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn relationship_entry(path: &str) -> bool {
  path == ROOT_RELATIONSHIPS_PATH
    || path.rsplit_once("/_rels/").is_some_and(|(_, name)| {
      !name.contains('/')
        && name
          .rsplit_once('.')
          .is_some_and(|(_, extension)| extension == "rels")
    })
}

fn relationship_source_path(path: &str) -> Option<String> {
  if path == ROOT_RELATIONSHIPS_PATH {
    return None;
  }
  let (directory, filename) = path.rsplit_once("/_rels/")?;
  let source = filename.strip_suffix(".rels")?;
  Some(format!("{directory}/{source}"))
}

fn parse_export_xml<'a>(
  xml: &'a str,
  kind: &str,
) -> Result<Document<'a>, DocxRewriteError> {
  let document = parse_xml(xml.as_bytes(), kind).map_err(|error| {
    rewrite_error(DocxRewriteErrorCode::InvalidPackage, error.to_string())
  })?;
  if document
    .descendants()
    .any(|node| node.is_comment() || node.is_pi())
  {
    return Err(unsupported(
      "DOCX export XML must not contain comments or processing instructions",
    ));
  }
  Ok(document)
}

fn escape_text(value: &str) -> String {
  value
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

fn escape_attribute(value: &str) -> String {
  let mut output = String::with_capacity(value.len());
  for character in value.chars() {
    match character {
      '&' => output.push_str("&amp;"),
      '<' => output.push_str("&lt;"),
      '>' => output.push_str("&gt;"),
      '"' => output.push_str("&quot;"),
      '\'' => output.push_str("&apos;"),
      '\t' => output.push_str("&#x9;"),
      '\n' => output.push_str("&#xA;"),
      '\r' => output.push_str("&#xD;"),
      _ => output.push(character),
    }
  }
  output
}

fn valid_relationship_id(value: &str) -> bool {
  value.strip_prefix("rId").is_some_and(|digits| {
    !digits.is_empty()
      && digits.len() <= 10
      && digits.bytes().all(|byte| byte.is_ascii_digit())
  })
}

const SAFE_WORD_VALUES: &[&str] = &[
  "0",
  "1",
  "true",
  "false",
  "on",
  "off",
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "after",
  "all",
  "atLeast",
  "auto",
  "autofit",
  "bar",
  "baseline",
  "before",
  "between",
  "both",
  "bottom",
  "center",
  "character",
  "clear",
  "continuous",
  "decimal",
  "decimalZero",
  "default",
  "distributed",
  "dot",
  "dotted",
  "double",
  "dxa",
  "eastAsia",
  "end",
  "evenPage",
  "even",
  "exact",
  "firstLine",
  "first",
  "firstColumn",
  "firstRow",
  "fixed",
  "heavy",
  "hanging",
  "hybridMultilevel",
  "highKashida",
  "inside",
  "left",
  "light",
  "line",
  "lowerLetter",
  "lowerRoman",
  "lowKashida",
  "majorAscii",
  "majorBidi",
  "majorEastAsia",
  "majorHAnsi",
  "mediumKashida",
  "minorAscii",
  "minorBidi",
  "minorEastAsia",
  "minorHAnsi",
  "multiple",
  "multilevel",
  "nextPage",
  "nil",
  "none",
  "nothing",
  "num",
  "numbering",
  "oddPage",
  "page",
  "paragraph",
  "portrait",
  "pct",
  "right",
  "restart",
  "section",
  "separator",
  "single",
  "singleLevel",
  "space",
  "start",
  "continuationNotice",
  "continuationSeparator",
  "landscape",
  "tab",
  "table",
  "text",
  "thick",
  "top",
  "transparent",
  "upperLetter",
  "upperRoman",
  "bullet",
  "wave",
  "word",
  "black",
  "blue",
  "cyan",
  "darkBlue",
  "darkCyan",
  "darkGray",
  "darkGreen",
  "darkMagenta",
  "darkRed",
  "darkYellow",
  "green",
  "lightGray",
  "magenta",
  "red",
  "white",
  "yellow",
];

fn safe_word_value(value: &str) -> bool {
  !value.is_empty()
    && value.len() <= 32
    && value.trim() == value
    && SAFE_WORD_VALUES.contains(&value)
}

fn collect_style_identifiers(
  entries: &[ArchiveEntry],
  content_types: &HashMap<&str, &str>,
) -> Result<HashMap<String, String>, DocxRewriteError> {
  let mut identifiers = HashMap::new();
  for entry in entries {
    if content_types
      .get(entry.path.as_str())
      .and_then(|content_type| word_suffix(content_type))
      != Some("styles+xml")
    {
      continue;
    }
    let xml = std::str::from_utf8(&entry.bytes)
      .map_err(|_| unsupported("DOCX style part is not valid UTF-8"))?;
    let document = parse_export_xml(xml, "style part")?;
    for node in document.descendants().filter(Node::is_element) {
      if word_local(node) != Some("style") {
        continue;
      }
      let Some(identifier) = node.attributes().find(|attribute| {
        attribute.name() == "styleId"
          && WORDPROCESSING_NAMESPACES
            .contains(&attribute.namespace().unwrap_or_default())
      }) else {
        return Err(unsupported("DOCX style is missing its identifier"));
      };
      if identifiers.contains_key(identifier.value()) {
        return Err(unsupported("DOCX style identifiers must be unique"));
      }
      identifiers.insert(
        identifier.value().to_owned(),
        format!("stellaStyle{}", identifiers.len().saturating_add(1)),
      );
    }
  }
  Ok(identifiers)
}

const WORD_VAL_ATTRIBUTE_ELEMENTS: &[&str] = &[
  "abstractNumId",
  "basedOn",
  "cnfStyle",
  "effect",
  "em",
  "fitText",
  "gridSpan",
  "highlight",
  "hMerge",
  "ilvl",
  "jc",
  "kern",
  "link",
  "lvlJc",
  "lvlRestart",
  "lvlText",
  "multiLevelType",
  "next",
  "nsid",
  "numFmt",
  "numId",
  "numIdMacAtCleanup",
  "numRestart",
  "numStart",
  "numStyleLink",
  "outlineLvl",
  "paperSrc",
  "position",
  "pos",
  "pStyle",
  "rStyle",
  "start",
  "startOverride",
  "styleLink",
  "suff",
  "sz",
  "szCs",
  "tblLayout",
  "tblOverlap",
  "tblStyle",
  "tblStyleColBandSize",
  "tblStyleRowBandSize",
  "textAlignment",
  "textDirection",
  "tmpl",
  "type",
  "uiPriority",
  "vAlign",
  "vertAlign",
  "vMerge",
  "w",
];

fn word_border_attribute_allowed(
  node: Node<'_, '_>,
  name: &str,
) -> Option<bool> {
  let local = node.tag_name().name();
  if !matches!(
    local,
    "top"
      | "left"
      | "bottom"
      | "right"
      | "start"
      | "end"
      | "insideH"
      | "insideV"
  ) {
    return None;
  }
  let parent = node.parent_element().and_then(word_local);
  if parent
    .is_some_and(|value| matches!(value, "pBdr" | "tblBorders" | "tcBorders"))
  {
    return Some(matches!(
      name,
      "val"
        | "color"
        | "sz"
        | "space"
        | "shadow"
        | "frame"
        | "themeColor"
        | "themeTint"
        | "themeShade"
        | "w"
        | "type"
    ));
  }
  if !matches!(local, "insideH" | "insideV")
    && parent.is_some_and(|value| matches!(value, "tblCellMar" | "tcMar"))
  {
    return Some(matches!(name, "w" | "type"));
  }
  None
}

fn word_layout_attribute_allowed(local: &str, name: &str) -> Option<bool> {
  let allowed = match local {
    "ind" => matches!(
      name,
      "left"
        | "right"
        | "firstLine"
        | "hanging"
        | "leftChars"
        | "rightChars"
        | "firstLineChars"
        | "hangingChars"
    ),
    "spacing" => matches!(
      name,
      "before"
        | "after"
        | "line"
        | "lineRule"
        | "beforeAutospacing"
        | "afterAutospacing"
        | "beforeLines"
        | "afterLines"
    ),
    "shd" => matches!(
      name,
      "val"
        | "color"
        | "fill"
        | "themeColor"
        | "themeTint"
        | "themeShade"
        | "themeFill"
        | "themeFillTint"
        | "themeFillShade"
    ),
    "color" => {
      matches!(name, "val" | "themeColor" | "themeTint" | "themeShade")
    }
    "u" => matches!(
      name,
      "val" | "color" | "themeColor" | "themeTint" | "themeShade"
    ),
    "tblLook" => matches!(
      name,
      "val"
        | "firstRow"
        | "lastRow"
        | "firstColumn"
        | "lastColumn"
        | "noHBand"
        | "noVBand"
    ),
    "cols" => matches!(name, "num" | "space" | "sep" | "equalWidth"),
    "trHeight" => matches!(name, "val" | "hRule"),
    "tblCellSpacing" => matches!(name, "w" | "type"),
    "tblpPr" => matches!(
      name,
      "leftFromText"
        | "rightFromText"
        | "topFromText"
        | "bottomFromText"
        | "vertAnchor"
        | "horzAnchor"
        | "tblpX"
        | "tblpY"
        | "tblpXSpec"
        | "tblpYSpec"
    ),
    _ => return None,
  };
  Some(allowed)
}

fn word_attribute_allowed(node: Node<'_, '_>, name: &str) -> bool {
  let local = node.tag_name().name();
  if let Some(allowed) = word_border_attribute_allowed(node, name) {
    return allowed;
  }
  if WORD_VAL_ATTRIBUTE_ELEMENTS.contains(&local)
    || BOOLEAN_WORD_ELEMENTS.contains(&local)
  {
    return name == "val";
  }
  if let Some(allowed) = word_layout_attribute_allowed(local, name) {
    return allowed;
  }
  match local {
    "style" => matches!(name, "styleId" | "type" | "default" | "customStyle"),
    "rFonts" => matches!(
      name,
      "ascii"
        | "hAnsi"
        | "eastAsia"
        | "cs"
        | "asciiTheme"
        | "hAnsiTheme"
        | "eastAsiaTheme"
        | "csTheme"
        | "cstheme"
    ),
    "footnote" | "endnote" => matches!(name, "id" | "type"),
    "footnoteReference" | "endnoteReference" => {
      matches!(name, "id" | "customMarkFollows")
    }
    "headerReference" | "footerReference" | "tblStylePr" => name == "type",
    "abstractNum" => name == "abstractNumId",
    "num" => name == "numId",
    "lvl" => matches!(name, "ilvl" | "tplc" | "tentative"),
    "lvlOverride" => name == "ilvl",
    "gridCol" | "tblInd" | "tblW" | "tcW" => matches!(name, "w" | "type"),
    "pgSz" => matches!(name, "w" | "h" | "orient" | "code"),
    "pgMar" => matches!(
      name,
      "top" | "right" | "bottom" | "left" | "header" | "footer" | "gutter"
    ),
    "br" => matches!(name, "type" | "clear"),
    "tab" => matches!(name, "val" | "pos" | "leader"),
    "lnNumType" => matches!(name, "countBy" | "start" | "distance" | "restart"),
    "pgBorders" => matches!(name, "display" | "offsetFrom" | "zOrder"),
    "docGrid" => matches!(name, "type" | "linePitch" | "charSpace"),
    "pgNumType" => {
      matches!(name, "start" | "fmt" | "chapterStyle" | "chapterSep")
    }
    "eastAsianLayout" => matches!(
      name,
      "id" | "combine" | "combineBrackets" | "vert" | "vertCompress"
    ),
    _ => false,
  }
}

fn bounded_number(value: &str, maximum: u32) -> bool {
  value
    .parse::<i32>()
    .is_ok_and(|number| number.unsigned_abs() <= maximum)
}

fn fixed_hex(value: &str, lengths: &[usize]) -> bool {
  lengths.contains(&value.len())
    && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

const BOOLEAN_WORD_ATTRIBUTES: &[&str] = &[
  "default",
  "customStyle",
  "tentative",
  "customMarkFollows",
  "beforeAutospacing",
  "afterAutospacing",
  "shadow",
  "frame",
  "firstRow",
  "lastRow",
  "firstColumn",
  "lastColumn",
  "noHBand",
  "noVBand",
  "sep",
  "equalWidth",
  "combine",
  "vert",
  "vertCompress",
];
const NUMERIC_WORD_ATTRIBUTES: &[&str] = &[
  "id",
  "abstractNumId",
  "numId",
  "ilvl",
  "code",
  "num",
  "countBy",
  "start",
  "distance",
  "top",
  "right",
  "bottom",
  "left",
  "header",
  "footer",
  "gutter",
  "before",
  "after",
  "line",
  "beforeLines",
  "afterLines",
  "w",
  "h",
  "firstLine",
  "hanging",
  "leftChars",
  "rightChars",
  "firstLineChars",
  "hangingChars",
  "pos",
  "space",
  "sz",
  "topFromText",
  "bottomFromText",
  "leftFromText",
  "rightFromText",
  "tblpX",
  "tblpY",
];
const BOOLEAN_WORD_ELEMENTS: &[&str] = &[
  "adjustRightInd",
  "autoRedefine",
  "b",
  "bCs",
  "bidi",
  "bidiVisual",
  "cantSplit",
  "caps",
  "contextualSpacing",
  "cs",
  "dstrike",
  "hidden",
  "hideMark",
  "i",
  "iCs",
  "imprint",
  "isLgl",
  "keepLines",
  "keepNext",
  "locked",
  "mirrorInd",
  "noProof",
  "noWrap",
  "outline",
  "pageBreakBefore",
  "personal",
  "personalCompose",
  "personalReply",
  "qFormat",
  "rtl",
  "semiHidden",
  "shadow",
  "smallCaps",
  "snapToGrid",
  "specVanish",
  "strike",
  "suppressAutoHyphens",
  "suppressLineNumbers",
  "tblHeader",
  "tcFitText",
  "titlePg",
  "unhideWhenUsed",
  "vanish",
  "webHidden",
  "widowControl",
  "wordWrap",
];
const NUMERIC_WORD_ELEMENTS: &[&str] = &[
  "sz",
  "szCs",
  "kern",
  "position",
  "numId",
  "ilvl",
  "start",
  "startOverride",
  "abstractNumId",
  "lvlRestart",
  "outlineLvl",
  "tblStyleRowBandSize",
  "tblStyleColBandSize",
  "gridSpan",
  "fitText",
  "paperSrc",
  "w",
];
const THEME_COLOR_VALUES: &[&str] = &[
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "background1",
  "background2",
  "dark1",
  "dark2",
  "followedHyperlink",
  "hyperlink",
  "light1",
  "light2",
  "text1",
  "text2",
];
const SHADING_VALUES: &[&str] = &[
  "clear", "nil", "solid", "pct5", "pct10", "pct20", "pct25", "pct30", "pct40",
  "pct50", "pct60", "pct70", "pct75", "pct80", "pct90",
];

fn boolean_word_value(value: &str) -> bool {
  matches!(value, "0" | "1" | "true" | "false" | "on" | "off")
}

fn word_attribute_value_allowed(
  node: Node<'_, '_>,
  name: &str,
  value: &str,
) -> bool {
  let local = node.tag_name().name();
  if local == "uiPriority" && name == "val" {
    return value.parse::<u8>().is_ok_and(|number| number <= 99);
  }
  if BOOLEAN_WORD_ATTRIBUTES.contains(&name) {
    return boolean_word_value(value);
  }
  if NUMERIC_WORD_ATTRIBUTES.contains(&name) {
    return bounded_number(value, 1_000_000);
  }
  if matches!(name, "color" | "fill") {
    return value == "auto" || fixed_hex(value, &[6]);
  }
  if matches!(
    name,
    "themeTint" | "themeShade" | "themeFillTint" | "themeFillShade"
  ) {
    return fixed_hex(value, &[2]);
  }
  if matches!(name, "themeColor" | "themeFill") {
    return THEME_COLOR_VALUES.contains(&value);
  }
  if local == "tblLook" && name == "val" {
    return fixed_hex(value, &[4]);
  }
  if local == "cnfStyle" && name == "val" {
    return value.len() == 12
      && value.bytes().all(|byte| matches!(byte, b'0' | b'1'));
  }
  if local == "color" && name == "val" {
    return value == "auto" || fixed_hex(value, &[6]);
  }
  if local == "shd" && name == "val" {
    return SHADING_VALUES.contains(&value);
  }
  if BOOLEAN_WORD_ELEMENTS.contains(&local) && name == "val" {
    return boolean_word_value(value);
  }
  if NUMERIC_WORD_ELEMENTS.contains(&local) && name == "val" {
    return bounded_number(value, 1_000_000);
  }
  safe_word_value(value)
}

fn common_font(value: &str) -> bool {
  matches!(
    value,
    "Arial"
      | "Arial Unicode MS"
      | "Aptos"
      | "Aptos Display"
      | "Aptos Narrow"
      | "Calibri"
      | "Cambria"
      | "Courier New"
      | "Garamond"
      | "Georgia"
      | "Helvetica"
      | "Malgun Gothic"
      | "Meiryo"
      | "Microsoft YaHei"
      | "MS Mincho"
      | "Noto Sans"
      | "Noto Sans CJK JP"
      | "Noto Sans CJK KR"
      | "Noto Sans CJK SC"
      | "Noto Serif"
      | "SimSun"
      | "Symbol"
      | "Tahoma"
      | "Times New Roman"
      | "Trebuchet MS"
      | "Verdana"
      | "Wingdings"
      | "Yu Mincho"
      | "Angsana New"
      | "DokChampa"
      | "Estrangelo Edessa"
      | "Euphemia"
      | "Gautami"
      | "Iskoola Pota"
      | "Kalinga"
      | "Kartika"
      | "Latha"
      | "Mangal"
      | "Microsoft Himalaya"
      | "Microsoft Uighur"
      | "Microsoft Yi Baiti"
      | "Mongolian Baiti"
      | "MoolBoran"
      | "MV Boli"
      | "Nyala"
      | "Plantagenet Cherokee"
      | "Raavi"
      | "Shruti"
      | "Sylfaen"
      | "Tunga"
      | "ＭＳ Ｐゴシック"
      | "游ゴシック Light"
      | "맑은 고딕"
      | "宋体"
      | "等线 Light"
      | "新細明體"
  )
}

fn canonical_word_attributes(
  node: Node<'_, '_>,
  local: &str,
  styles: &HashMap<String, String>,
) -> Result<Vec<(String, String)>, DocxRewriteError> {
  let mut attributes = Vec::new();
  for attribute in node.attributes() {
    let name = attribute.name();
    let namespace = attribute.namespace().unwrap_or_default();
    if MARKUP_COMPATIBILITY_NAMESPACES.contains(&namespace)
      || matches!(name, "durableId" | "paraId" | "paraIdParent" | "textId")
      || WORDPROCESSING_NAMESPACES.contains(&namespace)
        && (name.starts_with("rsid")
          || matches!(name, "author" | "date" | "initials" | "tag"))
    {
      continue;
    }
    if RELATIONSHIP_NAMESPACES.contains(&namespace) {
      if name != "id" || !valid_relationship_id(attribute.value()) {
        return Err(unsupported(
          "DOCX content has an invalid relationship reference",
        ));
      }
      attributes.push(("r:id".to_owned(), attribute.value().to_owned()));
      continue;
    }
    if namespace == XML_NAMESPACE {
      if name != "space" || !matches!(attribute.value(), "default" | "preserve")
      {
        return Err(unsupported(
          "DOCX content has an unsupported XML attribute",
        ));
      }
      attributes.push(("xml:space".to_owned(), attribute.value().to_owned()));
      continue;
    }
    if !WORDPROCESSING_NAMESPACES.contains(&namespace)
      || !word_attribute_allowed(node, name)
    {
      return Err(unsupported("DOCX content has an unsupported XML attribute"));
    }
    let value = if local == "style" && name == "styleId"
      || STYLE_REFERENCE_ELEMENTS.contains(&local) && name == "val"
    {
      styles.get(attribute.value()).cloned().ok_or_else(|| {
        unsupported("DOCX content references an unknown style")
      })?
    } else if local == "rFonts"
      && matches!(name, "ascii" | "hAnsi" | "eastAsia" | "cs")
    {
      if !common_font(attribute.value()) {
        return Err(unsupported("DOCX formatting uses an unsupported font"));
      }
      attribute.value().to_owned()
    } else if local == "rFonts" && name.ends_with("Theme") {
      if !matches!(
        attribute.value(),
        "majorAscii"
          | "majorBidi"
          | "majorEastAsia"
          | "majorHAnsi"
          | "minorAscii"
          | "minorBidi"
          | "minorEastAsia"
          | "minorHAnsi"
      ) {
        return Err(unsupported(
          "DOCX formatting uses an unsupported theme font",
        ));
      }
      attribute.value().to_owned()
    } else if matches!(local, "nsid" | "tmpl") && name == "val"
      || local == "lvl" && name == "tplc"
    {
      "00000001".to_owned()
    } else if local == "lvlText" && name == "val" {
      if !valid_numbering_label(attribute.value()) {
        return Err(unsupported(
          "DOCX numbering contains unsupported label text",
        ));
      }
      attribute.value().to_owned()
    } else {
      if !word_attribute_value_allowed(node, name, attribute.value()) {
        return Err(unsupported(
          "DOCX content has an unsupported attribute value",
        ));
      }
      attribute.value().to_owned()
    };
    attributes.push((format!("w:{name}"), value));
  }
  attributes.sort_unstable();
  Ok(attributes)
}

fn write_attributes(output: &mut String, attributes: &[(String, String)]) {
  for (name, value) in attributes {
    output.push(' ');
    output.push_str(name);
    output.push_str("=\"");
    output.push_str(&escape_attribute(value));
    output.push('"');
  }
}

fn content_node_is_removed(local: &str) -> bool {
  REMOVED_WORD_ELEMENTS.contains(&local)
    || matches!(local, "lang" | "tblCaption" | "tblDescription")
}

fn validate_retained_content_node(
  node: Node<'_, '_>,
  local: &str,
) -> Result<(), DocxRewriteError> {
  if !SAFE_CONTENT_WORD_ELEMENTS.contains(&local) {
    return Err(unsupported(
      "DOCX content contains an unclassified Word element",
    ));
  }
  if local == "p"
    && node
      .ancestors()
      .skip(1)
      .any(|parent| word_local(parent) == Some("p"))
  {
    return Err(unsupported("DOCX content contains nested paragraphs"));
  }
  if local == "t"
    && (node.parent_element().and_then(word_local) != Some("r")
      || !node
        .ancestors()
        .any(|ancestor| word_local(ancestor) == Some("p"))
      || node.children().any(|child| !child.is_text()))
  {
    return Err(unsupported(
      "DOCX text is outside a supported paragraph run",
    ));
  }
  let is_run_control = matches!(local, "tab" | "br" | "cr")
    && node.parent_element().and_then(word_local) == Some("r")
    && node
      .ancestors()
      .any(|ancestor| word_local(ancestor) == Some("p"));
  let is_tab_stop = local == "tab"
    && node.parent_element().and_then(word_local) == Some("tabs")
    && node
      .ancestors()
      .any(|ancestor| word_local(ancestor) == Some("pPr"));
  if matches!(local, "tab" | "br" | "cr") && !is_run_control && !is_tab_stop {
    return Err(unsupported(
      "DOCX control text is outside a supported paragraph run",
    ));
  }
  Ok(())
}

fn serialize_content_node(
  node: Node<'_, '_>,
  styles: &HashMap<String, String>,
  output: &mut String,
  is_root: bool,
) -> Result<(), DocxRewriteError> {
  let namespace = node.tag_name().namespace().unwrap_or_default();
  if namespace == WORD_2010_NAMESPACE && node.tag_name().name() == "textOutline"
  {
    return serialize_text_outline(node, output);
  }
  if !WORDPROCESSING_NAMESPACES.contains(&namespace) {
    return Err(unsupported(
      "DOCX content contains an unsupported XML namespace",
    ));
  }
  let local = node.tag_name().name();
  if PROHIBITED_WORD_ELEMENTS.contains(&local)
    || matches!(local, "delText" | "ffData" | "formField" | "drawing")
    || local.ends_with("Change")
  {
    return Err(unsupported(
      "DOCX content contains an unsupported Word structure",
    ));
  }
  if content_node_is_removed(local) {
    return Ok(());
  }
  if matches!(local, "fldChar" | "instrText") {
    return Ok(());
  }
  if matches!(
    local,
    "fldSimple" | "hyperlink" | "customXml" | "sdt" | "sdtContent"
  ) {
    if node.children().any(|child| {
      child.is_text()
        && child.text().is_some_and(|text| !text.trim().is_empty())
    }) {
      return Err(unsupported(
        "DOCX wrapper contains unclassified direct text",
      ));
    }
    for child in node.children().filter(Node::is_element) {
      serialize_content_node(child, styles, output, false)?;
    }
    return Ok(());
  }
  validate_retained_content_node(node, local)?;
  output.push_str("<w:");
  output.push_str(local);
  if is_root {
    output.push_str(" xmlns:w=\"");
    output.push_str(WORD_NAMESPACE);
    output.push_str("\" xmlns:r=\"");
    output.push_str(OFFICE_RELATIONSHIP_NAMESPACE);
    output.push('"');
  }
  write_attributes(output, &canonical_word_attributes(node, local, styles)?);
  let mut children = String::new();
  for child in node.children() {
    if child.is_element() {
      serialize_content_node(child, styles, &mut children, false)?;
    } else if child.is_text() {
      let value = child.text().unwrap_or_default();
      if local == "t" {
        children.push_str(&escape_text(value));
      } else if !value.trim().is_empty() {
        return Err(unsupported("DOCX content contains unclassified text"));
      }
    }
  }
  if children.is_empty() {
    output.push_str("/>");
  } else {
    output.push('>');
    output.push_str(&children);
    output.push_str("</w:");
    output.push_str(local);
    output.push('>');
  }
  Ok(())
}

fn sanitize_content_xml(
  xml: &str,
  path: &str,
  styles: &HashMap<String, String>,
) -> Result<String, DocxRewriteError> {
  let document = parse_export_xml(xml, "content part")?;
  let root = document.root_element();
  let expected_root = if path == "word/document.xml" {
    "document"
  } else if path.contains("header") {
    "hdr"
  } else if path.contains("footer") {
    "ftr"
  } else if path == "word/footnotes.xml" {
    "footnotes"
  } else if path == "word/endnotes.xml" {
    "endnotes"
  } else {
    return Err(unsupported("DOCX content part has an unsupported path"));
  };
  if word_local(root) != Some(expected_root) {
    return Err(unsupported(
      "DOCX content part has an unexpected root element",
    ));
  }
  let mut output = XML_DECLARATION.to_owned();
  serialize_content_node(root, styles, &mut output, true)?;
  Ok(output)
}

fn valid_numbering_label(value: &str) -> bool {
  if value.is_empty() || value.len() > 64 {
    return false;
  }
  let mut characters = value.chars();
  while let Some(character) = characters.next() {
    if character == '%' {
      if !characters
        .next()
        .is_some_and(|level| matches!(level, '1'..='9'))
      {
        return false;
      }
      continue;
    }
    if character.is_ascii_digit()
      || !(character.is_whitespace()
        || matches!(
          character,
          '.'
            | ','
            | ':'
            | ';'
            | '-'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | '/'
            | '\\'
            | '\u{2022}'
            | '\u{25e6}'
            | '\u{25aa}'
        ))
    {
      return false;
    }
  }
  true
}

fn serialize_formatting_node(
  node: Node<'_, '_>,
  suffix: &str,
  styles: &HashMap<String, String>,
  output: &mut String,
  is_root: bool,
) -> Result<(), DocxRewriteError> {
  if node.tag_name().namespace() == Some(WORD_2010_NAMESPACE)
    && node.tag_name().name() == "textOutline"
  {
    return serialize_text_outline(node, output);
  }
  if word_local(node).is_none() {
    return Err(unsupported(
      "DOCX formatting contains an unsupported XML namespace",
    ));
  }
  let local = node.tag_name().name();
  if local.ends_with("Change") || PROHIBITED_WORD_ELEMENTS.contains(&local) {
    return Err(unsupported("DOCX formatting contains a revision structure"));
  }
  if matches!(local, "name" | "aliases" | "lang" | "latentStyles" | "rsid") {
    return Ok(());
  }
  let structural = match suffix {
    "styles+xml" => SAFE_STYLE_WORD_ELEMENTS.contains(&local),
    "numbering+xml" => SAFE_NUMBERING_WORD_ELEMENTS.contains(&local),
    _ => false,
  };
  if !structural && !SAFE_CONTENT_WORD_ELEMENTS.contains(&local) {
    return Err(unsupported(
      "DOCX formatting contains an unclassified Word element",
    ));
  }
  let attributes = canonical_word_attributes(node, local, styles)?;
  if local == "lvlText"
    && attributes
      .iter()
      .find(|(name, _)| name == "w:val")
      .is_none_or(|(_, value)| !valid_numbering_label(value))
  {
    return Err(unsupported(
      "DOCX numbering contains unsupported label text",
    ));
  }
  output.push_str("<w:");
  output.push_str(local);
  if is_root {
    output.push_str(" xmlns:w=\"");
    output.push_str(WORD_NAMESPACE);
    output.push('"');
  }
  write_attributes(output, &attributes);
  let mut children = String::new();
  for child in node.children() {
    if child.is_element() {
      serialize_formatting_node(child, suffix, styles, &mut children, false)?;
    } else if child.is_text()
      && child.text().is_some_and(|text| !text.trim().is_empty())
    {
      return Err(unsupported("DOCX formatting contains unclassified text"));
    }
  }
  if children.is_empty() {
    output.push_str("/>");
  } else {
    output.push('>');
    output.push_str(&children);
    output.push_str("</w:");
    output.push_str(local);
    output.push('>');
  }
  Ok(())
}

const SAFE_THEME_ELEMENTS: &[&str] = &[
  "accent1",
  "accent2",
  "accent3",
  "accent4",
  "accent5",
  "accent6",
  "alpha",
  "alphaMod",
  "alphaOff",
  "bevel",
  "bevelT",
  "bgClr",
  "bgFillStyleLst",
  "blur",
  "camera",
  "clrScheme",
  "cs",
  "dk1",
  "dk2",
  "ea",
  "effectDag",
  "effectLst",
  "effectStyle",
  "effectStyleLst",
  "extraClrSchemeLst",
  "fgClr",
  "fillStyleLst",
  "fillToRect",
  "flatTx",
  "fmtScheme",
  "folHlink",
  "font",
  "fontScheme",
  "glow",
  "gradFill",
  "gs",
  "gsLst",
  "headEnd",
  "hlink",
  "hslClr",
  "innerShdw",
  "latin",
  "lin",
  "ln",
  "lnStyleLst",
  "lt1",
  "lt2",
  "lightRig",
  "lumMod",
  "lumOff",
  "majorFont",
  "minorFont",
  "miter",
  "noFill",
  "objectDefaults",
  "outerShdw",
  "path",
  "pattFill",
  "prstClr",
  "prstDash",
  "reflection",
  "rot",
  "round",
  "satMod",
  "schemeClr",
  "scrgbClr",
  "scene3d",
  "shade",
  "softEdge",
  "solidFill",
  "sp3d",
  "srgbClr",
  "sysClr",
  "tailEnd",
  "theme",
  "themeElements",
  "tint",
];

fn safe_theme_script(value: &str) -> bool {
  matches!(
    value,
    "Arab"
      | "Armn"
      | "Beng"
      | "Bopo"
      | "Bugi"
      | "Cans"
      | "Cher"
      | "Deva"
      | "Ethi"
      | "Geor"
      | "Gujr"
      | "Guru"
      | "Hang"
      | "Hans"
      | "Hant"
      | "Hebr"
      | "Jpan"
      | "Khmr"
      | "Knda"
      | "Laoo"
      | "Latn"
      | "Mlym"
      | "Mong"
      | "Mymr"
      | "Orya"
      | "Sinh"
      | "Syrc"
      | "Taml"
      | "Telu"
      | "Thaa"
      | "Thai"
      | "Tibt"
      | "Uigh"
      | "Viet"
      | "Yiii"
  )
}

fn valid_preset_dash(value: &str) -> bool {
  matches!(
    value,
    "dash" | "dashDot" | "dot" | "lgDash" | "solid" | "sysDash" | "sysDot"
  )
}

const SCHEME_COLOR_VALUES: &[&str] = &[
  "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "bg1",
  "bg2", "dk1", "dk2", "folHlink", "hlink", "lt1", "lt2", "phClr", "tx1",
  "tx2",
];
const PATTERN_FILL_VALUES: &[&str] = &[
  "cross",
  "dashDnDiag",
  "dashHorz",
  "dashUpDiag",
  "dashVert",
  "diagCross",
  "dkDnDiag",
  "dkHorz",
  "dkUpDiag",
  "dkVert",
  "dnDiag",
  "horz",
  "ltDnDiag",
  "ltHorz",
  "ltUpDiag",
  "ltVert",
  "pct10",
  "pct20",
  "pct25",
  "pct30",
  "pct40",
  "pct5",
  "pct50",
  "pct60",
  "pct70",
  "pct75",
  "pct80",
  "pct90",
  "smCheck",
  "smGrid",
  "solidDmnd",
  "upDiag",
  "vert",
];

fn theme_enum_attribute_allowed(local: &str, name: &str, value: &str) -> bool {
  match (local, name) {
    ("sysClr", "val") => {
      matches!(value, "window" | "windowText" | "btnFace" | "btnText")
    }
    ("schemeClr", "val") => SCHEME_COLOR_VALUES.contains(&value),
    ("prstClr", "val") => matches!(
      value,
      "black" | "blue" | "gray" | "green" | "red" | "white" | "yellow"
    ),
    ("prstDash", "val") => valid_preset_dash(value),
    ("path", "path") => matches!(value, "circle" | "rect" | "shape"),
    ("pattFill", "prst") => PATTERN_FILL_VALUES.contains(&value),
    ("camera", "prst") => matches!(
      value,
      "legacyObliqueFront"
        | "legacyPerspectiveFront"
        | "orthographicFront"
        | "perspectiveFront"
        | "perspectiveRelaxed"
    ),
    ("bevelT", "prst") => {
      matches!(value, "angle" | "circle" | "convex" | "relaxedInset")
    }
    ("lightRig", "rig") => matches!(
      value,
      "balanced"
        | "brightRoom"
        | "contrasting"
        | "flat"
        | "soft"
        | "threePt"
        | "twoPt"
    ),
    ("lightRig", "dir") => {
      matches!(value, "b" | "bl" | "br" | "l" | "r" | "t" | "tl" | "tr")
    }
    (_, "rotWithShape") | ("lin", "scaled") => {
      matches!(value, "0" | "1" | "true" | "false")
    }
    ("headEnd" | "tailEnd", "w" | "len") => {
      matches!(value, "lg" | "med" | "sm")
    }
    ("headEnd" | "tailEnd", "type") => matches!(
      value,
      "arrow" | "diamond" | "none" | "oval" | "stealth" | "triangle"
    ),
    (_, "cap") => matches!(value, "flat" | "rnd" | "sq"),
    (_, "cmpd") => {
      matches!(value, "dbl" | "sng" | "thickThin" | "thinThick" | "tri")
    }
    (_, "algn") => matches!(
      value,
      "b" | "bl" | "br" | "ctr" | "in" | "l" | "out" | "r" | "t" | "tl" | "tr"
    ),
    (_, "flip") => matches!(value, "none" | "x" | "xy" | "y"),
    _ => false,
  }
}

fn parsed_i32_in(value: &str, minimum: i32, maximum: i32) -> bool {
  value
    .parse::<i32>()
    .is_ok_and(|number| (minimum..=maximum).contains(&number))
}

fn theme_numeric_attribute_allowed(
  local: &str,
  name: &str,
  value: &str,
) -> bool {
  match (local, name) {
    (
      "alpha" | "alphaMod" | "alphaOff" | "lumMod" | "lumOff" | "satMod"
      | "shade" | "tint",
      "val",
    )
    | ("gs", "pos")
    | ("scrgbClr", "r" | "g" | "b") => parsed_i32_in(value, 0, 100_000),
    ("ln" | "bevelT", "w") => parsed_i32_in(value, 0, 20_116_800),
    ("fillToRect", "l" | "t" | "r" | "b") => {
      parsed_i32_in(value, -100_000, 100_000)
    }
    ("lin", "ang") | ("hslClr", "hue" | "sat" | "lum") => {
      parsed_i32_in(value, 0, 21_600_000)
    }
    ("miter", "lim") => parsed_i32_in(value, 0, 1_000_000),
    (
      element,
      "h" | "blurRad" | "dist" | "dir" | "kx" | "ky" | "sx" | "sy" | "rad",
    ) if element != "lightRig" => bounded_number(value, 21_600_000),
    ("rot", "lat" | "lon" | "rev") => bounded_number(value, 21_600_000),
    _ => false,
  }
}

fn canonical_theme_attribute(
  local: &str,
  name: &str,
  value: &str,
) -> Option<String> {
  if name == "name"
    && matches!(local, "theme" | "clrScheme" | "fontScheme" | "fmtScheme")
  {
    return Some("stella".to_owned());
  }
  if name == "script" && local == "font" && safe_theme_script(value) {
    return Some(value.to_owned());
  }
  if (name == "val" && local == "srgbClr" && fixed_hex(value, &[6]))
    || (name == "lastClr" && local == "sysClr" && fixed_hex(value, &[6]))
  {
    return Some(value.to_ascii_uppercase());
  }
  if theme_enum_attribute_allowed(local, name, value)
    || theme_numeric_attribute_allowed(local, name, value)
  {
    return Some(value.to_owned());
  }
  None
}

fn canonical_theme_attributes(
  node: Node<'_, '_>,
) -> Result<Vec<(String, String)>, DocxRewriteError> {
  let local = node.tag_name().name();
  let mut output = Vec::new();
  for attribute in node.attributes() {
    if attribute.namespace().is_some() {
      return Err(unsupported("DOCX theme contains a namespaced attribute"));
    }
    let name = attribute.name();
    let value = attribute.value();
    let canonical = if name == "typeface"
      && matches!(local, "latin" | "ea" | "cs" | "font")
    {
      if !value.is_empty() && !common_font(value) {
        return Err(unsupported("DOCX theme uses an unsupported font"));
      }
      value.to_owned()
    } else {
      canonical_theme_attribute(local, name, value).ok_or_else(|| {
        unsupported("DOCX theme contains an unsupported attribute")
      })?
    };
    output.push((name.to_owned(), canonical));
  }
  output.sort_unstable();
  Ok(output)
}

fn serialize_theme_node(
  node: Node<'_, '_>,
  output: &mut String,
  is_root: bool,
) -> Result<(), DocxRewriteError> {
  if !DRAWINGML_NAMESPACES
    .contains(&node.tag_name().namespace().unwrap_or_default())
  {
    return Err(unsupported(
      "DOCX theme contains an unsupported XML namespace",
    ));
  }
  let local = node.tag_name().name();
  if local == "extLst" {
    return Ok(());
  }
  if !SAFE_THEME_ELEMENTS.contains(&local) {
    return Err(unsupported("DOCX theme contains an unclassified element"));
  }
  output.push_str("<a:");
  output.push_str(local);
  if is_root {
    output.push_str(" xmlns:a=\"");
    output.push_str(DRAWINGML_NAMESPACE);
    output.push('"');
  }
  write_attributes(output, &canonical_theme_attributes(node)?);
  let mut children = String::new();
  for child in node.children() {
    if child.is_element() {
      serialize_theme_node(child, &mut children, false)?;
    } else if child.is_text()
      && child.text().is_some_and(|text| !text.trim().is_empty())
    {
      return Err(unsupported("DOCX theme contains unclassified text"));
    }
  }
  if children.is_empty() {
    output.push_str("/>");
  } else {
    output.push('>');
    output.push_str(&children);
    output.push_str("</a:");
    output.push_str(local);
    output.push('>');
  }
  Ok(())
}

const SAFE_TEXT_OUTLINE_DRAWING_ELEMENTS: &[&str] = &[
  "alpha",
  "alphaMod",
  "alphaOff",
  "bevel",
  "bgClr",
  "fgClr",
  "fillToRect",
  "gradFill",
  "gs",
  "gsLst",
  "headEnd",
  "hslClr",
  "lin",
  "lumMod",
  "lumOff",
  "miter",
  "noFill",
  "pattFill",
  "path",
  "prstClr",
  "prstDash",
  "round",
  "satMod",
  "schemeClr",
  "scrgbClr",
  "shade",
  "solidFill",
  "srgbClr",
  "sysClr",
  "tailEnd",
  "tint",
];

fn canonical_text_outline_word_2010_attributes(
  node: Node<'_, '_>,
) -> Result<Vec<(String, String)>, DocxRewriteError> {
  let local = node.tag_name().name();
  let mut output = Vec::new();
  for attribute in node.attributes() {
    if attribute.namespace() != Some(WORD_2010_NAMESPACE) {
      return Err(unsupported(
        "DOCX text outline contains an unsupported Word extension attribute",
      ));
    }
    let canonical = canonical_theme_attribute(
      local,
      attribute.name(),
      attribute.value(),
    )
    .ok_or_else(|| {
      unsupported(
        "DOCX text outline contains an unsupported Word extension attribute",
      )
    })?;
    output.push((format!("w14:{}", attribute.name()), canonical));
  }
  output.sort_unstable();
  Ok(output)
}

fn serialize_text_outline_drawing_node(
  node: Node<'_, '_>,
  output: &mut String,
) -> Result<(), DocxRewriteError> {
  let namespace = node.tag_name().namespace().unwrap_or_default();
  let local = node.tag_name().name();
  let is_drawing = DRAWINGML_NAMESPACES.contains(&namespace)
    && SAFE_TEXT_OUTLINE_DRAWING_ELEMENTS.contains(&local);
  let is_word_2010 = namespace == WORD_2010_NAMESPACE
    && SAFE_TEXT_OUTLINE_DRAWING_ELEMENTS.contains(&local);
  if !is_drawing && !is_word_2010 {
    return Err(unsupported(
      "DOCX text outline contains an unsupported DrawingML element",
    ));
  }
  let prefix = if is_word_2010 { "w14" } else { "a" };
  output.push('<');
  output.push_str(prefix);
  output.push(':');
  output.push_str(local);
  let attributes = if is_word_2010 {
    canonical_text_outline_word_2010_attributes(node)?
  } else {
    canonical_theme_attributes(node)?
  };
  write_attributes(output, &attributes);
  let mut children = String::new();
  for child in node.children() {
    if child.is_element() {
      serialize_text_outline_drawing_node(child, &mut children)?;
    } else if child.is_text()
      && child.text().is_some_and(|text| !text.trim().is_empty())
    {
      return Err(unsupported("DOCX text outline contains unclassified text"));
    }
  }
  if children.is_empty() {
    output.push_str("/>");
  } else {
    output.push('>');
    output.push_str(&children);
    output.push_str("</");
    output.push_str(prefix);
    output.push(':');
    output.push_str(local);
    output.push('>');
  }
  Ok(())
}

fn serialize_text_outline(
  node: Node<'_, '_>,
  output: &mut String,
) -> Result<(), DocxRewriteError> {
  if node.tag_name().namespace() != Some(WORD_2010_NAMESPACE)
    || node.tag_name().name() != "textOutline"
    || node.parent_element().and_then(word_local) != Some("rPr")
  {
    return Err(unsupported("DOCX contains an unsupported Word extension"));
  }
  let mut attributes = Vec::new();
  for attribute in node.attributes() {
    if attribute.namespace() != Some(WORD_2010_NAMESPACE) {
      return Err(unsupported(
        "DOCX text outline has an unsupported attribute",
      ));
    }
    let value = match attribute.name() {
      "w"
        if attribute
          .value()
          .parse::<i32>()
          .is_ok_and(|number| (0..=20_116_800).contains(&number)) =>
      {
        attribute.value()
      }
      "cap" if matches!(attribute.value(), "flat" | "rnd" | "sq") => {
        attribute.value()
      }
      "cmpd"
        if matches!(
          attribute.value(),
          "dbl" | "sng" | "thickThin" | "thinThick" | "tri"
        ) =>
      {
        attribute.value()
      }
      "algn" if matches!(attribute.value(), "ctr" | "in" | "out") => {
        attribute.value()
      }
      _ => {
        return Err(unsupported(
          "DOCX text outline has an unsupported attribute value",
        ));
      }
    };
    attributes.push((format!("w14:{}", attribute.name()), value.to_owned()));
  }
  attributes.sort_unstable();
  output.push_str("<w14:textOutline xmlns:w14=\"");
  output.push_str(WORD_2010_NAMESPACE);
  output.push_str("\" xmlns:a=\"");
  output.push_str(DRAWINGML_NAMESPACE);
  output.push('"');
  write_attributes(output, &attributes);
  let mut children = String::new();
  for child in node.children() {
    if child.is_element() {
      serialize_text_outline_drawing_node(child, &mut children)?;
    } else if child.is_text()
      && child.text().is_some_and(|text| !text.trim().is_empty())
    {
      return Err(unsupported("DOCX text outline contains unclassified text"));
    }
  }
  if children.is_empty() {
    output.push_str("/>");
  } else {
    output.push('>');
    output.push_str(&children);
    output.push_str("</w14:textOutline>");
  }
  Ok(())
}

fn sanitize_formatting_xml(
  xml: &str,
  _path: &str,
  content_type: &str,
  styles: &HashMap<String, String>,
) -> Result<String, DocxRewriteError> {
  let document = parse_export_xml(xml, "formatting part")?;
  if content_type == THEME_CONTENT_TYPE {
    if !DRAWINGML_NAMESPACES.contains(
      &document
        .root_element()
        .tag_name()
        .namespace()
        .unwrap_or_default(),
    ) || document.root_element().tag_name().name() != "theme"
    {
      return Err(unsupported("DOCX theme has an unexpected root element"));
    }
    let mut output = XML_DECLARATION.to_owned();
    serialize_theme_node(document.root_element(), &mut output, true)?;
    return Ok(output);
  }
  let suffix = word_suffix(content_type).ok_or_else(|| {
    unsupported("DOCX formatting has an unsupported content type")
  })?;
  let expected_root = match suffix {
    "styles+xml" => "styles",
    "numbering+xml" => "numbering",
    _ => {
      return Err(unsupported(
        "DOCX formatting has an unsupported content type",
      ));
    }
  };
  let root = document.root_element();
  if word_local(root) != Some(expected_root) {
    return Err(unsupported(
      "DOCX formatting has an unexpected root element",
    ));
  }
  let mut output = XML_DECLARATION.to_owned();
  serialize_formatting_node(root, suffix, styles, &mut output, true)?;
  Ok(output)
}

fn relationship_type_removed(value: &str) -> bool {
  REMOVED_RELATIONSHIP_SUFFIXES
    .iter()
    .any(|suffix| value.ends_with(suffix))
}

fn allowed_relationship_suffix(value: &str) -> Option<&'static str> {
  for namespace in RELATIONSHIP_NAMESPACES {
    let Some(suffix) = value.strip_prefix(namespace) else {
      continue;
    };
    if ALLOWED_RELATIONSHIP_SUFFIXES.contains(&suffix) {
      return ALLOWED_RELATIONSHIP_SUFFIXES
        .iter()
        .copied()
        .find(|allowed| *allowed == suffix);
    }
  }
  None
}

fn canonical_relationship_target(path: &str, resolved: &str) -> String {
  let Some(source) = relationship_source_path(path) else {
    return resolved.to_owned();
  };
  let directory = source
    .rsplit_once('/')
    .map_or("", |(directory, _)| directory);
  resolved
    .strip_prefix(&format!("{directory}/"))
    .unwrap_or(resolved)
    .to_owned()
}

fn sanitize_relationships(
  xml: &str,
  path: &str,
  removed_paths: &HashSet<String>,
) -> Result<String, DocxRewriteError> {
  let document = parse_export_xml(xml, "relationships part")?;
  let root = document.root_element();
  if root.tag_name().name() != "Relationships"
    || !PACKAGE_RELATIONSHIP_NAMESPACES
      .contains(&root.tag_name().namespace().unwrap_or_default())
    || root.attributes().len() != 0
  {
    return Err(unsupported(
      "DOCX relationships have an invalid root element",
    ));
  }
  let mut relationships = Vec::new();
  for node in root.children() {
    if node.is_text() && node.text().is_some_and(|text| text.trim().is_empty())
    {
      continue;
    }
    if !node.is_element()
      || node.tag_name().name() != "Relationship"
      || !PACKAGE_RELATIONSHIP_NAMESPACES
        .contains(&node.tag_name().namespace().unwrap_or_default())
      || node.children().any(|child| {
        child.is_element()
          || child.is_text()
            && child.text().is_some_and(|text| !text.trim().is_empty())
      })
    {
      return Err(unsupported(
        "DOCX relationships contain an unsupported node",
      ));
    }
    if node.attributes().any(|attribute| {
      attribute.namespace().is_some()
        || !matches!(attribute.name(), "Id" | "Type" | "Target" | "TargetMode")
    }) {
      return Err(unsupported(
        "DOCX relationships contain an unsupported attribute",
      ));
    }
    let identifier = node.attribute("Id").unwrap_or_default();
    let relation_type = node.attribute("Type").unwrap_or_default();
    let target = node.attribute("Target").unwrap_or_default();
    let resolved = resolve_relationship_target(target, path);
    let remove = relationship_type_removed(relation_type)
      || resolved
        .as_ref()
        .is_some_and(|resolved| removed_paths.contains(resolved));
    if remove {
      continue;
    }
    if node
      .attribute("TargetMode")
      .is_some_and(|mode| mode != "Internal")
    {
      return Err(unsupported(
        "DOCX relationships contain an unsafe target mode",
      ));
    }
    if !valid_relationship_id(identifier) || identifier.trim() != identifier {
      return Err(unsupported(
        "DOCX relationships contain an unsafe identifier or mode",
      ));
    }
    let suffix =
      allowed_relationship_suffix(relation_type).ok_or_else(|| {
        unsupported("DOCX relationships contain an unsupported type")
      })?;
    let resolved = resolved.ok_or_else(|| {
      unsupported("DOCX relationships contain an unsafe target")
    })?;
    relationships.push((
      identifier.to_owned(),
      format!("{OFFICE_RELATIONSHIP_NAMESPACE}{suffix}"),
      canonical_relationship_target(path, &resolved),
    ));
  }
  relationships.sort_unstable();
  let mut output = format!(
    "{XML_DECLARATION}<Relationships xmlns=\"{PACKAGE_RELATIONSHIP_NAMESPACE}\">"
  );
  for (identifier, relation_type, target) in relationships {
    output.push_str("<Relationship Id=\"");
    output.push_str(&identifier);
    output.push_str("\" Type=\"");
    output.push_str(&relation_type);
    output.push_str("\" Target=\"");
    output.push_str(&escape_attribute(&target));
    output.push_str("\"/>");
  }
  output.push_str("</Relationships>");
  Ok(output)
}

fn sanitize_content_types(
  xml: &str,
  removed_paths: &HashSet<String>,
) -> Result<String, DocxRewriteError> {
  let document = parse_export_xml(xml, "content types part")?;
  let root = document.root_element();
  if root.tag_name().name() != "Types"
    || root.tag_name().namespace() != Some(CONTENT_TYPES_NAMESPACE)
    || root.attributes().len() != 0
  {
    return Err(unsupported(
      "DOCX content types have an invalid root element",
    ));
  }
  let mut overrides = Vec::new();
  for node in root.children() {
    if node.is_text() && node.text().is_some_and(|text| text.trim().is_empty())
    {
      continue;
    }
    if !node.is_element()
      || node.tag_name().namespace() != Some(CONTENT_TYPES_NAMESPACE)
      || !matches!(node.tag_name().name(), "Default" | "Override")
      || node.children().any(|child| {
        child.is_element()
          || child.is_text()
            && child.text().is_some_and(|text| !text.trim().is_empty())
      })
    {
      return Err(unsupported(
        "DOCX content types contain an unsupported node",
      ));
    }
    let expected = if node.tag_name().name() == "Default" {
      ["Extension", "ContentType"]
    } else {
      ["PartName", "ContentType"]
    };
    if node.attributes().len() != expected.len()
      || node.attributes().any(|attribute| {
        attribute.namespace().is_some() || !expected.contains(&attribute.name())
      })
    {
      return Err(unsupported(
        "DOCX content types contain unsupported attributes",
      ));
    }
    if node.tag_name().name() == "Default" {
      continue;
    }
    let raw_path = node.attribute("PartName").unwrap_or_default();
    let content_type = node.attribute("ContentType").unwrap_or_default();
    let Some(path) = raw_path.strip_prefix('/') else {
      return Err(unsupported("DOCX content type path is not canonical"));
    };
    if !removed_paths.contains(path) {
      overrides.push((path.to_owned(), content_type.to_owned()));
    }
  }
  overrides.sort_unstable();
  let mut output = format!(
    "{XML_DECLARATION}<Types xmlns=\"{CONTENT_TYPES_NAMESPACE}\"><Default Extension=\"rels\" ContentType=\"{RELATIONSHIPS_CONTENT_TYPE}\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/>"
  );
  for (path, content_type) in overrides {
    output.push_str("<Override PartName=\"/");
    output.push_str(&escape_attribute(&path));
    output.push_str("\" ContentType=\"");
    output.push_str(&escape_attribute(&content_type));
    output.push_str("\"/>");
  }
  output.push_str("</Types>");
  Ok(output)
}

fn write_archive(
  mut entries: Vec<ArchiveEntry>,
) -> Result<Vec<u8>, DocxRewriteError> {
  entries.retain(|entry| !entry.path.ends_with('/'));
  entries.sort_unstable_by(|left, right| left.path.cmp(&right.path));
  let output = Cursor::new(Vec::new());
  let mut writer = ZipWriter::new(output);
  let options = SimpleFileOptions::default()
    .compression_method(CompressionMethod::Deflated);
  for entry in entries {
    writer.start_file(entry.path, options).map_err(|_| {
      unsupported("Sanitized DOCX archive could not be created")
    })?;
    writer.write_all(&entry.bytes).map_err(|_| {
      unsupported("Sanitized DOCX archive could not be created")
    })?;
  }
  writer
    .finish()
    .map(Cursor::into_inner)
    .map_err(|_| unsupported("Sanitized DOCX archive could not be created"))
}

fn validate_relationship_identifiers(
  entries: &[ArchiveEntry],
) -> Result<HashMap<String, HashSet<String>>, DocxRewriteError> {
  let mut relationship_ids = HashMap::<String, HashSet<String>>::new();
  let mut main_relationship_count = 0_usize;
  for entry in entries
    .iter()
    .filter(|entry| relationship_entry(&entry.path))
  {
    let xml = std::str::from_utf8(&entry.bytes)
      .map_err(|_| unsupported("Sanitized DOCX relationships are not UTF-8"))?;
    let relationships = parse_export_xml(xml, "relationships part")?;
    let source = relationship_source_path(&entry.path).unwrap_or_default();
    let ids = relationship_ids.entry(source).or_default();
    for relation in relationships.descendants().filter(|node| {
      node.is_element() && node.tag_name().name() == "Relationship"
    }) {
      let identifier = relation.attribute("Id").unwrap_or_default();
      if !ids.insert(identifier.to_owned()) {
        return Err(unsupported(
          "Sanitized DOCX contains duplicate relationship identifiers",
        ));
      }
      let is_main = entry.path == ROOT_RELATIONSHIPS_PATH
        && relation.attribute("Type").is_some_and(|value| {
          value == format!("{OFFICE_RELATIONSHIP_NAMESPACE}/officeDocument")
        })
        && resolve_relationship_target(
          relation.attribute("Target").unwrap_or_default(),
          &entry.path,
        )
        .as_deref()
          == Some("word/document.xml");
      if is_main {
        main_relationship_count = main_relationship_count.saturating_add(1);
      }
    }
  }
  if main_relationship_count != 1 {
    return Err(unsupported(
      "Sanitized DOCX must have one main-document relationship",
    ));
  }
  Ok(relationship_ids)
}

fn validate_relationship_entry(
  entry: &ArchiveEntry,
  entry_paths: &HashSet<&str>,
) -> Result<(), DocxRewriteError> {
  if entry.path != ROOT_RELATIONSHIPS_PATH
    && relationship_source_path(&entry.path)
      .as_ref()
      .is_none_or(|source| !entry_paths.contains(source.as_str()))
  {
    return Err(unsupported(
      "Sanitized DOCX contains an orphaned relationships part",
    ));
  }
  let xml = std::str::from_utf8(&entry.bytes)
    .map_err(|_| unsupported("Sanitized DOCX relationships are not UTF-8"))?;
  if sanitize_relationships(xml, &entry.path, &HashSet::new())? != xml {
    return Err(unsupported(
      "Sanitized DOCX relationships are not canonical",
    ));
  }
  let relationships = parse_export_xml(xml, "relationships part")?;
  for relation in relationships.descendants().filter(|node| {
    node.is_element() && node.tag_name().name() == "Relationship"
  }) {
    let target = relation.attribute("Target").unwrap_or_default();
    if resolve_relationship_target(target, &entry.path)
      .is_none_or(|target| !entry_paths.contains(target.as_str()))
    {
      return Err(unsupported(
        "Sanitized DOCX contains a dangling relationship",
      ));
    }
  }
  Ok(())
}

fn validate_xml_entry(
  entry: &ArchiveEntry,
  content_type: &str,
  styles: &HashMap<String, String>,
  relationship_ids: &HashMap<String, HashSet<String>>,
) -> Result<(), DocxRewriteError> {
  let xml = std::str::from_utf8(&entry.bytes)
    .map_err(|_| unsupported("Sanitized DOCX XML is not UTF-8"))?;
  let part = ContentTypePart {
    path: entry.path.clone(),
    content_type: content_type.to_owned(),
  };
  let is_content = classify_part(&part).is_some();
  let canonical = if is_content {
    sanitize_content_xml(xml, &entry.path, styles)?
  } else if formatting_content_type(content_type) {
    sanitize_formatting_xml(xml, &entry.path, content_type, styles)?
  } else {
    return Err(unsupported("Sanitized DOCX contains an unsupported part"));
  };
  if canonical != xml {
    return Err(unsupported("Sanitized DOCX XML is not canonical"));
  }
  if !is_content {
    return Ok(());
  }
  let parsed = parse_export_xml(xml, "content part")?;
  for attribute in parsed
    .descendants()
    .filter(Node::is_element)
    .flat_map(|node| node.attributes())
    .filter(|attribute| {
      attribute.name() == "id"
        && RELATIONSHIP_NAMESPACES
          .contains(&attribute.namespace().unwrap_or_default())
    })
  {
    if relationship_ids
      .get(&entry.path)
      .is_none_or(|ids| !ids.contains(attribute.value()))
    {
      return Err(unsupported(
        "Sanitized DOCX content has an unresolved relationship reference",
      ));
    }
  }
  Ok(())
}

fn retained_text_node_count(
  entries: &[ArchiveEntry],
  by_path: &HashMap<&str, &str>,
) -> Result<usize, DocxRewriteError> {
  entries
    .iter()
    .filter(|entry| {
      by_path
        .get(entry.path.as_str())
        .is_some_and(|content_type| {
          classify_part(&ContentTypePart {
            path: entry.path.clone(),
            content_type: (*content_type).to_owned(),
          })
          .is_some()
        })
    })
    .try_fold(0_usize, |count, entry| {
      let xml = std::str::from_utf8(&entry.bytes)
        .map_err(|_| unsupported("Sanitized DOCX content is not UTF-8"))?;
      let parsed = parse_export_xml(xml, "content part")?;
      let part_count = parsed
        .descendants()
        .filter(|node| {
          node.is_element()
            && word_local(*node) == Some("t")
            && node.text().is_some_and(|text| !text.is_empty())
        })
        .count();
      count
        .checked_add(part_count)
        .ok_or_else(|| unsupported("Sanitized DOCX text count overflowed"))
    })
}

fn validate_extraction_coverage(
  extraction: &DocxExtraction,
  retained_text_count: usize,
) -> Result<(), DocxRewriteError> {
  if extraction.coverage.hyperlink_text_segment_count > 0
    || extraction.coverage.revision_text_segment_count > 0
    || extraction.coverage.unsupported_alternate_content_count > 0
    || extraction.coverage.unsupported_symbol_count > 0
    || extraction.coverage.unsupported_field_instruction_count > 0
  {
    return Err(unsupported(
      "Sanitized DOCX still contains unsupported coverage",
    ));
  }
  let extracted_text_count = extraction
    .blocks
    .iter()
    .flat_map(|block| &block.segments)
    .filter(|segment| segment.source == DocxSegmentSource::Text)
    .count();
  if retained_text_count != extracted_text_count {
    return Err(unsupported(
      "Sanitized DOCX text is not fully covered by extraction",
    ));
  }
  Ok(())
}

fn validate_profile(
  document: &[u8],
) -> Result<DocxExtraction, DocxRewriteError> {
  let entries = read_archive(document).map_err(|error| {
    rewrite_error(DocxRewriteErrorCode::InvalidPackage, error.to_string())
  })?;
  if entries.iter().any(|entry| entry.path.ends_with('/')) {
    return Err(unsupported("Sanitized DOCX contains directory entries"));
  }
  if write_archive(entries.clone())? != document {
    return Err(unsupported("Sanitized DOCX archive is not canonical"));
  }
  let entry_paths = entries
    .iter()
    .map(|entry| entry.path.as_str())
    .collect::<HashSet<_>>();
  let content_types_entry = entries
    .iter()
    .find(|entry| entry.path == CONTENT_TYPES_PATH)
    .ok_or_else(|| unsupported("Sanitized DOCX is missing content types"))?;
  let content_types =
    parse_content_types(&content_types_entry.bytes).map_err(|error| {
      rewrite_error(DocxRewriteErrorCode::InvalidPackage, error.to_string())
    })?;
  let by_path = content_types
    .iter()
    .map(|part| (part.path.as_str(), part.content_type.as_str()))
    .collect::<HashMap<_, _>>();
  let styles = collect_style_identifiers(&entries, &by_path)?;
  let relationship_ids = validate_relationship_identifiers(&entries)?;
  let content_types_xml = std::str::from_utf8(&content_types_entry.bytes)
    .map_err(|_| unsupported("Sanitized DOCX content types are not UTF-8"))?;
  if sanitize_content_types(content_types_xml, &HashSet::new())?
    != content_types_xml
  {
    return Err(unsupported(
      "Sanitized DOCX content types are not canonical",
    ));
  }
  for part in &content_types {
    if !conventional_supported_path(&part.path, &part.content_type)
      || !entry_paths.contains(part.path.as_str())
    {
      return Err(unsupported(
        "Sanitized DOCX contains an unsupported declared part",
      ));
    }
  }
  for entry in &entries {
    if entry.path == CONTENT_TYPES_PATH {
      continue;
    }
    if relationship_entry(&entry.path) {
      validate_relationship_entry(entry, &entry_paths)?;
      continue;
    }
    let content_type =
      by_path.get(entry.path.as_str()).copied().ok_or_else(|| {
        unsupported("Sanitized DOCX contains an undeclared part")
      })?;
    validate_xml_entry(entry, content_type, &styles, &relationship_ids)?;
  }
  let extraction = extract_docx_text(document).map_err(|error| {
    rewrite_error(DocxRewriteErrorCode::InvalidPackage, error.to_string())
  })?;
  validate_extraction_coverage(
    &extraction,
    retained_text_node_count(&entries, &by_path)?,
  )?;
  Ok(extraction)
}

fn sanitize_export_entry(
  entry: &mut ArchiveEntry,
  content_types: &HashMap<&str, &str>,
  removed_paths: &HashSet<String>,
  styles: &HashMap<String, String>,
) -> Result<bool, DocxRewriteError> {
  if entry.path == CONTENT_TYPES_PATH {
    let xml = std::str::from_utf8(&entry.bytes)
      .map_err(|_| unsupported("DOCX content types are not valid UTF-8"))?;
    entry.bytes = sanitize_content_types(xml, removed_paths)?.into_bytes();
    return Ok(true);
  }
  if relationship_entry(&entry.path) {
    let xml = std::str::from_utf8(&entry.bytes)
      .map_err(|_| unsupported("DOCX relationships are not valid UTF-8"))?;
    entry.bytes =
      sanitize_relationships(xml, &entry.path, removed_paths)?.into_bytes();
    return Ok(true);
  }
  let content_type = content_types
    .get(entry.path.as_str())
    .copied()
    .ok_or_else(|| {
      unsupported(format!(
        "DOCX anonymized export does not support undeclared part: {}",
        entry.path
      ))
    })?;
  if removed_content_type(content_type) {
    return Ok(false);
  }
  let part = ContentTypePart {
    path: entry.path.clone(),
    content_type: content_type.to_owned(),
  };
  if classify_part(&part).is_some() {
    if !conventional_supported_path(&entry.path, content_type) {
      return Err(unsupported(
        "DOCX anonymized export requires conventional content-part paths",
      ));
    }
    let xml = std::str::from_utf8(&entry.bytes)
      .map_err(|_| unsupported("DOCX content part is not valid UTF-8"))?;
    entry.bytes = sanitize_content_xml(xml, &entry.path, styles)?.into_bytes();
    return Ok(true);
  }
  if formatting_content_type(content_type)
    && conventional_supported_path(&entry.path, content_type)
  {
    let xml = std::str::from_utf8(&entry.bytes)
      .map_err(|_| unsupported("DOCX formatting part is not valid UTF-8"))?;
    entry.bytes =
      sanitize_formatting_xml(xml, &entry.path, content_type, styles)?
        .into_bytes();
    return Ok(true);
  }
  if content_type == RELATIONSHIPS_CONTENT_TYPE {
    return Ok(false);
  }
  Err(unsupported(format!(
    "DOCX anonymized export does not support package part: {}",
    entry.path
  )))
}

pub fn prepare_docx_anonymized_export(
  document: &[u8],
) -> Result<DocxAnonymizedExportPreparation, DocxRewriteError> {
  let mut entries = read_archive(document).map_err(|error| {
    rewrite_error(DocxRewriteErrorCode::InvalidPackage, error.to_string())
  })?;
  let content_types_entry = entries
    .iter()
    .find(|entry| entry.path == CONTENT_TYPES_PATH)
    .ok_or_else(|| unsupported("DOCX archive is missing content types"))?;
  let content_types =
    parse_content_types(&content_types_entry.bytes).map_err(|error| {
      rewrite_error(DocxRewriteErrorCode::InvalidPackage, error.to_string())
    })?;
  let by_path = content_types
    .iter()
    .map(|part| (part.path.as_str(), part.content_type.as_str()))
    .collect::<HashMap<_, _>>();
  let removed_paths = entries
    .iter()
    .filter(|entry| {
      entry.path.starts_with("docProps/")
        || entry.path.starts_with("customXml/")
        || entry.path.starts_with("word/webextensions/")
        || entry.path.starts_with("webextensions/")
        || entry.path.starts_with("word/comments")
        || entry.path == "word/people.xml"
        || by_path
          .get(entry.path.as_str())
          .is_some_and(|content_type| removed_content_type(content_type))
    })
    .map(|entry| entry.path.clone())
    .collect::<HashSet<_>>();
  let removed_relationship_paths = entries
    .iter()
    .filter(|entry| {
      !removed_paths.contains(&entry.path)
        && relationship_source_path(&entry.path)
          .is_some_and(|source| removed_paths.contains(&source))
    })
    .map(|entry| entry.path.clone())
    .collect::<HashSet<_>>();
  let styles = collect_style_identifiers(&entries, &by_path)?;
  let removed_part_count = removed_paths
    .len()
    .saturating_add(removed_relationship_paths.len());
  entries.retain(|entry| {
    !entry.path.ends_with('/')
      && !removed_paths.contains(&entry.path)
      && !removed_relationship_paths.contains(&entry.path)
  });
  let mut sanitized_xml_part_count = 0_usize;
  for entry in &mut entries {
    if sanitize_export_entry(entry, &by_path, &removed_paths, &styles)? {
      sanitized_xml_part_count = sanitized_xml_part_count.saturating_add(1);
    }
  }
  let sanitized = write_archive(entries)?;
  let extraction = validate_profile(&sanitized)?;
  Ok(DocxAnonymizedExportPreparation {
    document: sanitized,
    extraction,
    report: DocxAnonymizedExportReport {
      contract_version: 1,
      removed_part_count,
      sanitized_xml_part_count,
    },
  })
}

pub fn validate_docx_anonymized_export(
  document: &[u8],
) -> Result<DocxExtraction, DocxRewriteError> {
  validate_profile(document)
}

pub fn finalize_docx_anonymized_export(
  document: &[u8],
) -> Result<Vec<u8>, DocxRewriteError> {
  prepare_docx_anonymized_export(document).map(|prepared| prepared.document)
}

#[cfg(test)]
mod tests {
  use std::{
    collections::HashMap,
    io::{Cursor, Read as _, Write as _},
  };

  use zip::{ZipArchive, ZipWriter, write::SimpleFileOptions};

  use crate::{
    DocxBlockRewrite, DocxRewriteErrorCode, DocxTextReplacement,
    rewrite_docx_text,
  };

  use super::{
    BOOLEAN_WORD_ELEMENTS, DRAWINGML_NAMESPACE, FORMATTING_WORD_PART_SUFFIXES,
    SAFE_CONTENT_WORD_ELEMENTS, SAFE_NUMBERING_WORD_ELEMENTS,
    SAFE_STYLE_WORD_ELEMENTS, STRICT_DRAWINGML_NAMESPACE, THEME_CONTENT_TYPE,
    WORD_2010_NAMESPACE, common_font, escape_attribute,
    finalize_docx_anonymized_export, prepare_docx_anonymized_export,
    sanitize_formatting_xml, valid_numbering_label,
    validate_docx_anonymized_export, word_attribute_allowed,
    word_attribute_value_allowed,
  };

  const CONTENT_TYPES: &str =
    "http://schemas.openxmlformats.org/package/2006/content-types";
  const PACKAGE_RELS: &str =
    "http://schemas.openxmlformats.org/package/2006/relationships";
  const OFFICE_RELS: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const WORD: &str =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const WORD_CONTENT: &str =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.";

  fn archive(
    entries: &[(&str, &str)],
  ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    let mut writer = ZipWriter::new(Cursor::new(Vec::new()));
    writer.add_directory("_rels/", SimpleFileOptions::default())?;
    writer.add_directory("word/", SimpleFileOptions::default())?;
    for (path, content) in entries {
      writer.start_file(*path, SimpleFileOptions::default())?;
      writer.write_all(content.as_bytes())?;
    }
    Ok(writer.finish()?.into_inner())
  }

  fn entry(
    document: &[u8],
    path: &str,
  ) -> Result<String, Box<dyn std::error::Error>> {
    let mut archive = ZipArchive::new(Cursor::new(document))?;
    let mut content = String::new();
    archive.by_name(path)?.read_to_string(&mut content)?;
    Ok(content)
  }

  fn archive_text(
    document: &[u8],
  ) -> Result<String, Box<dyn std::error::Error>> {
    let mut archive = ZipArchive::new(Cursor::new(document))?;
    let mut output = String::new();
    for index in 0..archive.len() {
      let mut file = archive.by_index(index)?;
      let extension = file.name().rsplit_once('.').map(|(_, value)| value);
      if matches!(extension, Some("xml" | "rels")) {
        file.read_to_string(&mut output)?;
      }
    }
    Ok(output)
  }

  fn has_entry(
    document: &[u8],
    path: &str,
  ) -> Result<bool, Box<dyn std::error::Error>> {
    let mut archive = ZipArchive::new(Cursor::new(document))?;
    let found = archive.by_name(path).is_ok();
    Ok(found)
  }

  fn ordinary_document(
    body: &str,
  ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    archive(&[
      (
        "[Content_Types].xml",
        &format!(
          "<Types xmlns=\"{CONTENT_TYPES}\"><Override PartName=\"/word/document.xml\" ContentType=\"{WORD_CONTENT}document.main+xml\"/><Override PartName=\"/word/styles.xml\" ContentType=\"{WORD_CONTENT}styles+xml\"/><Override PartName=\"/word/numbering.xml\" ContentType=\"{WORD_CONTENT}numbering+xml\"/><Override PartName=\"/word/settings.xml\" ContentType=\"{WORD_CONTENT}settings+xml\"/><Override PartName=\"/word/comments.xml\" ContentType=\"{WORD_CONTENT}comments+xml\"/><Override PartName=\"/docProps/core.xml\" ContentType=\"application/vnd.openxmlformats-package.core-properties+xml\"/></Types>"
        ),
      ),
      (
        "_rels/.rels",
        &format!(
          "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\"/><Relationship Id=\"rId2\" Type=\"{PACKAGE_RELS}/metadata/core-properties\" Target=\"docProps/core.xml\"/></Relationships>"
        ),
      ),
      (
        "word/document.xml",
        &format!(
          "<w:document xmlns:w=\"{WORD}\" xmlns:r=\"{OFFICE_RELS}\"><w:body>{body}</w:body></w:document>"
        ),
      ),
      (
        "word/_rels/document.xml.rels",
        &format!(
          "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/styles\" Target=\"styles.xml\"/><Relationship Id=\"rId2\" Type=\"{OFFICE_RELS}/numbering\" Target=\"numbering.xml\"/><Relationship Id=\"rId3\" Type=\"{OFFICE_RELS}/settings\" Target=\"settings.xml\"/><Relationship Id=\"rId4\" Type=\"{OFFICE_RELS}/comments\" Target=\"comments.xml\"/></Relationships>"
        ),
      ),
      (
        "word/styles.xml",
        &format!(
          "<w:styles xmlns:w=\"{WORD}\" xmlns:w14=\"{WORD_2010_NAMESPACE}\"><w:style w:type=\"paragraph\" w:styleId=\"PrivateStyleName\"><w:name w:val=\"Private Style Name\"/><w:uiPriority w:val=\"9\"/><w:rPr><w:b/><w14:textOutline w14:w=\"12700\" w14:cap=\"rnd\" w14:cmpd=\"sng\" w14:algn=\"ctr\"><w14:gradFill w14:rotWithShape=\"1\"><w14:gsLst><w14:gs w14:pos=\"0\"><w14:srgbClr w14:val=\"112233\"/></w14:gs></w14:gsLst></w14:gradFill><w14:prstDash w14:val=\"solid\"/><w14:miter w14:lim=\"800000\"/></w14:textOutline></w:rPr></w:style><w:style w:type=\"character\" w:styleId=\"SecondaryStyle\"><w:rPr><w14:textOutline><w14:solidFill><w14:srgbClr w14:val=\"AABBCC\"/></w14:solidFill><w14:round/></w14:textOutline></w:rPr></w:style></w:styles>"
        ),
      ),
      (
        "word/numbering.xml",
        &format!(
          "<w:numbering xmlns:w=\"{WORD}\"><w:abstractNum w:abstractNumId=\"0\"><w:lvl w:ilvl=\"0\"><w:numFmt w:val=\"decimal\"/><w:lvlText w:val=\"%1.\"/></w:lvl></w:abstractNum></w:numbering>"
        ),
      ),
      (
        "word/settings.xml",
        &format!(
          "<w:settings xmlns:w=\"{WORD}\"><w:zoom w:percent=\"100\"/><w:rsids><w:rsid w:val=\"00112233\"/></w:rsids><w:docVars><w:docVar w:name=\"owner\" w:val=\"Private Owner\"/></w:docVars></w:settings>"
        ),
      ),
      (
        "word/comments.xml",
        &format!(
          "<w:comments xmlns:w=\"{WORD}\"><w:comment w:id=\"0\" w:author=\"Private Author\" w:date=\"2020-01-01T00:00:00Z\"><w:p><w:r><w:t>Private comment</w:t></w:r></w:p></w:comment></w:comments>"
        ),
      ),
      (
        "docProps/core.xml",
        "<cp:coreProperties xmlns:cp=\"http://schemas.openxmlformats.org/package/2006/metadata/core-properties\"><cp:keywords>Private Metadata</cp:keywords></cp:coreProperties>",
      ),
    ])
  }

  fn minimal_document(
    root_relationships: &str,
    body: &str,
  ) -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    archive(&[
      (
        "[Content_Types].xml",
        &format!(
          "<Types xmlns=\"{CONTENT_TYPES}\"><Override PartName=\"/word/document.xml\" ContentType=\"{WORD_CONTENT}document.main+xml\"/></Types>"
        ),
      ),
      ("_rels/.rels", root_relationships),
      (
        "word/document.xml",
        &format!(
          "<w:document xmlns:w=\"{WORD}\" xmlns:r=\"{OFFICE_RELS}\"><w:body>{body}</w:body></w:document>"
        ),
      ),
    ])
  }

  fn field_and_addin_document() -> Result<Vec<u8>, Box<dyn std::error::Error>> {
    const WEB_EXTENSION: &str =
      "http://schemas.microsoft.com/office/2011/relationships/webextension";
    const WEB_EXTENSION_TASKPANES: &str = "http://schemas.microsoft.com/office/2011/relationships/webextensiontaskpanes";
    archive(&[
      (
        "[Content_Types].xml",
        &format!(
          "<Types xmlns=\"{CONTENT_TYPES}\"><Override PartName=\"/word/document.xml\" ContentType=\"{WORD_CONTENT}document.main+xml\"/><Override PartName=\"/word/footnotes.xml\" ContentType=\"{WORD_CONTENT}footnotes+xml\"/><Override PartName=\"/word/webextensions/taskpanes.xml\" ContentType=\"application/vnd.ms-office.webextensiontaskpanes+xml\"/><Override PartName=\"/word/webextensions/webextension1.xml\" ContentType=\"application/vnd.ms-office.webextension+xml\"/></Types>"
        ),
      ),
      (
        "_rels/.rels",
        &format!(
          "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\"/><Relationship Id=\"rId2\" Type=\"{WEB_EXTENSION_TASKPANES}\" Target=\"word/webextensions/taskpanes.xml\"/></Relationships>"
        ),
      ),
      (
        "word/document.xml",
        &format!(
          "<w:document xmlns:w=\"{WORD}\"><w:body><w:p><w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText>HIDDEN OUTER INSTRUCTION</w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r><w:fldSimple w:instr=\"HIDDEN SIMPLE INSTRUCTION\"><w:r><w:t>Cached Client </w:t></w:r><w:r><w:fldChar w:fldCharType=\"begin\"/></w:r><w:r><w:instrText>HIDDEN NESTED INSTRUCTION</w:instrText></w:r><w:r><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r><w:t>Name</w:t></w:r><w:r><w:fldChar w:fldCharType=\"end\"/></w:r></w:fldSimple><w:r><w:fldChar w:fldCharType=\"end\"/></w:r></w:p></w:body></w:document>"
        ),
      ),
      (
        "word/_rels/document.xml.rels",
        &format!(
          "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/footnotes\" Target=\"footnotes.xml\"/></Relationships>"
        ),
      ),
      (
        "word/footnotes.xml",
        &format!(
          "<w:footnotes xmlns:w=\"{WORD}\"><w:footnote w:id=\"-1\" w:type=\"separator\"><w:p><w:r><w:separator/></w:r></w:p></w:footnote><w:footnote w:id=\"0\" w:type=\"continuationSeparator\"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote></w:footnotes>"
        ),
      ),
      (
        "word/webextensions/taskpanes.xml",
        "<wetp:taskpanes xmlns:wetp=\"http://schemas.microsoft.com/office/webextensions/taskpanes/2010/11\"><wetp:taskpane dockstate=\"HIDDEN ADDIN STATE\"/></wetp:taskpanes>",
      ),
      (
        "word/webextensions/_rels/taskpanes.xml.rels",
        &format!(
          "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{WEB_EXTENSION}\" Target=\"webextension1.xml\"/></Relationships>"
        ),
      ),
      (
        "word/webextensions/webextension1.xml",
        "<we:webextension xmlns:we=\"http://schemas.microsoft.com/office/webextensions/webextension/2010/11\"><we:property name=\"HIDDEN ADDIN OWNER\" value=\"HIDDEN ADDIN VALUE\"/></we:webextension>",
      ),
    ])
  }

  #[test]
  fn sanitizes_hidden_metadata_and_preserves_visible_formatting()
  -> Result<(), Box<dyn std::error::Error>> {
    let source = ordinary_document(
      "<w:sdt><w:sdtPr><w:alias w:val=\"Private Alias\"/><w:tag w:val=\"Private Tag\"/></w:sdtPr><w:sdtContent><w:p w:rsidR=\"00112233\"><w:pPr><w:pStyle w:val=\"PrivateStyleName\"/></w:pPr><w:bookmarkStart w:id=\"1\" w:name=\"Private Bookmark\"/><w:r><w:rPr><w:b/></w:rPr><w:t>Alice</w:t></w:r><w:commentRangeStart w:id=\"0\"/><w:commentRangeEnd w:id=\"0\"/><w:r><w:commentReference w:id=\"0\"/></w:r></w:p></w:sdtContent></w:sdt>",
    )?;
    let prepared = prepare_docx_anonymized_export(&source)?;
    assert_eq!(
      prepared
        .extraction
        .blocks
        .first()
        .map(|block| block.text.as_str()),
      Some("Alice")
    );
    assert_eq!(prepared.report.removed_part_count, 3);
    let document_xml = entry(&prepared.document, "word/document.xml")?;
    let styles_xml = entry(&prepared.document, "word/styles.xml")?;
    assert!(document_xml.contains("<w:b/>"));
    assert!(document_xml.contains("stellaStyle1"));
    assert!(styles_xml.contains("stellaStyle1"));
    assert!(styles_xml.contains("<w14:textOutline"));
    assert!(styles_xml.contains("<w14:gradFill w14:rotWithShape=\"1\">"));
    assert!(styles_xml.contains("<w14:srgbClr w14:val=\"112233\"/>"));
    assert!(styles_xml.contains("<w14:prstDash w14:val=\"solid\"/>"));
    assert!(styles_xml.contains("<w14:miter w14:lim=\"800000\"/>"));
    assert!(styles_xml.contains("<w14:solidFill>"));
    assert!(styles_xml.contains("<w14:round/>"));
    assert!(styles_xml.contains("<w:uiPriority w:val=\"9\"/>"));
    assert!(!styles_xml.contains("Private"));
    let all_xml = archive_text(&prepared.document)?;
    for hidden in [
      "Private Alias",
      "Private Tag",
      "Private Bookmark",
      "00112233",
      "Private Author",
      "Private comment",
      "Private Metadata",
    ] {
      assert!(!all_xml.contains(hidden));
    }
    validate_docx_anonymized_export(&prepared.document)?;
    let second = prepare_docx_anonymized_export(&prepared.document)?;
    assert_eq!(second.document, prepared.document);
    Ok(())
  }

  #[test]
  fn finalizes_cross_run_unicode_rewrites_with_control_segments()
  -> Result<(), Box<dyn std::error::Error>> {
    let source = ordinary_document(
      "<w:p><w:pPr><w:tabs><w:tab w:val=\"left\" w:pos=\"720\" w:leader=\"dot\"/></w:tabs></w:pPr><w:r><w:t>Al</w:t></w:r><w:r><w:t>😀</w:t></w:r><w:r><w:t>ice</w:t><w:tab/><w:t>tail</w:t></w:r></w:p>",
    )?;
    let prepared = prepare_docx_anonymized_export(&source)?;
    let block = prepared.extraction.blocks.first().ok_or("missing block")?;
    assert_eq!(block.text, "Al😀ice\ttail");
    let rewritten = rewrite_docx_text(
      &prepared.document,
      &[DocxBlockRewrite {
        location: block.location.clone(),
        expected_text: block.text.clone(),
        replacements: vec![DocxTextReplacement {
          start: 0,
          end: 7,
          replacement: "██".to_owned(),
        }],
      }],
    )?;
    let finalized = finalize_docx_anonymized_export(&rewritten.document)?;
    let extraction = validate_docx_anonymized_export(&finalized)?;
    assert_eq!(
      extraction
        .blocks
        .first()
        .map(|extracted_block| extracted_block.text.as_str()),
      Some("██\ttail")
    );
    assert!(
      entry(&finalized, "word/document.xml")?
        .contains("<w:tab w:leader=\"dot\" w:pos=\"720\" w:val=\"left\"/>")
    );
    Ok(())
  }

  #[test]
  fn canonicalizes_strict_drawingml_and_escaped_attributes()
  -> Result<(), Box<dyn std::error::Error>> {
    let strict_theme = format!(
      "<a:theme xmlns:a=\"{STRICT_DRAWINGML_NAMESPACE}\" name=\"Display&#x9;Name\"><a:themeElements><a:clrScheme name=\"Colors\"><a:dk1><a:srgbClr val=\"112233\"/></a:dk1></a:clrScheme></a:themeElements></a:theme>"
    );
    let canonical = sanitize_formatting_xml(
      &strict_theme,
      "word/theme/theme1.xml",
      THEME_CONTENT_TYPE,
      &HashMap::new(),
    )?;
    assert!(canonical.contains(&format!("xmlns:a=\"{DRAWINGML_NAMESPACE}\"")));
    assert!(!canonical.contains(STRICT_DRAWINGML_NAMESPACE));
    assert!(!canonical.contains("Display"));
    assert!(common_font("游ゴシック Light"));
    assert!(common_font("等线 Light"));
    assert_eq!(escape_attribute("a\tb\nc\rd"), "a&#x9;b&#xA;c&#xD;d");
    let priority_xml =
      format!("<w:uiPriority xmlns:w=\"{WORD}\" w:val=\"99\"/>");
    let priority = roxmltree::Document::parse(&priority_xml)?;
    assert!(word_attribute_value_allowed(
      priority.root_element(),
      "val",
      "99"
    ));
    assert!(!word_attribute_value_allowed(
      priority.root_element(),
      "val",
      "100"
    ));
    Ok(())
  }

  #[test]
  fn preserves_automatic_numbering_tab_alignment()
  -> Result<(), Box<dyn std::error::Error>> {
    let xml = format!(
      "<w:numbering xmlns:w=\"{WORD}\"><w:abstractNum w:abstractNumId=\"0\"><w:lvl w:ilvl=\"0\"><w:pPr><w:tabs><w:tab w:val=\"num\" w:pos=\"720\"/></w:tabs></w:pPr></w:lvl></w:abstractNum></w:numbering>"
    );
    let canonical = sanitize_formatting_xml(
      &xml,
      "word/numbering.xml",
      &format!("{WORD_CONTENT}numbering+xml"),
      &HashMap::new(),
    )?;
    assert!(
      canonical.contains("<w:tab w:pos=\"720\" w:val=\"num\"/>"),
      "automatic numbering alignment must survive sanitization"
    );
    Ok(())
  }

  #[test]
  fn rejects_unclassified_text_in_every_word_formatting_part()
  -> Result<(), Box<dyn std::error::Error>> {
    for suffix in FORMATTING_WORD_PART_SUFFIXES {
      let root = suffix.trim_end_matches("+xml");
      for text in [
        "Synthetic secret",
        "<![CDATA[Synthetic secret]]>",
        "&#83;ynthetic secret",
      ] {
        let xml = format!(
          "<w:{root} xmlns:w=\"{WORD}\"><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:{root}>"
        );
        let failure = sanitize_formatting_xml(
          &xml,
          &format!("word/{root}.xml"),
          &format!("{WORD_CONTENT}{suffix}"),
          &HashMap::new(),
        )
        .err()
        .ok_or("formatting text was accepted")?;
        assert_eq!(
          failure.code(),
          DocxRewriteErrorCode::UnsupportedReplacement,
          "formatting parts must reject text outside extraction coverage"
        );
      }
    }
    Ok(())
  }

  #[test]
  fn every_preserved_on_off_element_accepts_explicit_values()
  -> Result<(), Box<dyn std::error::Error>> {
    for element in BOOLEAN_WORD_ELEMENTS {
      assert!(
        SAFE_CONTENT_WORD_ELEMENTS.contains(element)
          || SAFE_STYLE_WORD_ELEMENTS.contains(element)
          || SAFE_NUMBERING_WORD_ELEMENTS.contains(element)
      );
      let xml = format!("<w:{element} xmlns:w=\"{WORD}\" w:val=\"true\"/>");
      let parsed = roxmltree::Document::parse(&xml)?;
      let node = parsed.root_element();
      assert!(word_attribute_allowed(node, "val"));
      for value in ["0", "1", "true", "false", "on", "off"] {
        assert!(word_attribute_value_allowed(node, "val", value));
      }
      assert!(!word_attribute_value_allowed(node, "val", "yes"));
    }
    Ok(())
  }

  #[test]
  fn flattens_cached_fields_and_removes_addin_metadata()
  -> Result<(), Box<dyn std::error::Error>> {
    let prepared =
      prepare_docx_anonymized_export(&field_and_addin_document()?)?;
    let block = prepared.extraction.blocks.first().ok_or("missing block")?;
    assert_eq!(block.text, "Cached Client Name");
    let rewritten = rewrite_docx_text(
      &prepared.document,
      &[DocxBlockRewrite {
        location: block.location.clone(),
        expected_text: block.text.clone(),
        replacements: vec![DocxTextReplacement {
          start: 0,
          end: block.text.encode_utf16().count(),
          replacement: "████".to_owned(),
        }],
      }],
    )?;
    let finalized = finalize_docx_anonymized_export(&rewritten.document)?;
    assert!(!has_entry(&finalized, "word/webextensions/taskpanes.xml")?);
    assert!(!has_entry(
      &finalized,
      "word/webextensions/webextension1.xml"
    )?);
    let all_xml = archive_text(&finalized)?;
    assert!(all_xml.contains("████"));
    assert!(all_xml.contains("<w:separator/>"));
    assert!(all_xml.contains("<w:continuationSeparator/>"));
    for hidden in [
      "HIDDEN OUTER INSTRUCTION",
      "HIDDEN SIMPLE INSTRUCTION",
      "HIDDEN NESTED INSTRUCTION",
      "HIDDEN ADDIN STATE",
      "HIDDEN ADDIN OWNER",
      "HIDDEN ADDIN VALUE",
    ] {
      assert!(!all_xml.contains(hidden));
    }
    Ok(())
  }

  #[test]
  fn rejects_revisions_fields_and_visual_payloads()
  -> Result<(), Box<dyn std::error::Error>> {
    for body in [
      "<w:p w:val=\"1234567890\"><w:r><w:t>Alice</w:t></w:r></w:p>",
      "<w:p><w:pPr><w:pPrChange w:id=\"1\" w:author=\"Author\"/></w:pPr><w:r><w:t>Alice</w:t></w:r></w:p>",
      "<w:p><w:r><w:drawing><w:inline/></w:drawing><w:t>Alice</w:t></w:r></w:p>",
    ] {
      let source = ordinary_document(body)?;
      assert!(prepare_docx_anonymized_export(&source).is_err());
    }
    assert!(!valid_numbering_label("1234567890"));
    assert!(!valid_numbering_label("%1. 1234567890"));
    assert!(valid_numbering_label("%1.%2."));
    Ok(())
  }

  #[test]
  fn validates_package_relationship_modes_and_graphs()
  -> Result<(), Box<dyn std::error::Error>> {
    let empty_root = format!("<Relationships xmlns=\"{PACKAGE_RELS}\"/>");
    let missing_main =
      minimal_document(&empty_root, "<w:p><w:r><w:t>Alice</w:t></w:r></w:p>")?;
    assert!(prepare_docx_anonymized_export(&missing_main).is_err());

    let duplicate_ids = format!(
      "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\"/><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
    );
    let duplicate = minimal_document(
      &duplicate_ids,
      "<w:p><w:r><w:t>Alice</w:t></w:r></w:p>",
    )?;
    assert!(prepare_docx_anonymized_export(&duplicate).is_err());

    let valid_root = format!(
      "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
    );
    let explicit_internal_root = format!(
      "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\" TargetMode=\"Internal\"/></Relationships>"
    );
    let explicit_internal = minimal_document(
      &explicit_internal_root,
      "<w:p><w:r><w:t>Alice</w:t></w:r></w:p>",
    )?;
    let prepared = prepare_docx_anonymized_export(&explicit_internal)?;
    assert!(!entry(&prepared.document, "_rels/.rels")?.contains("TargetMode"));

    let external_root = format!(
      "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\" TargetMode=\"External\"/></Relationships>"
    );
    let external = minimal_document(
      &external_root,
      "<w:p><w:r><w:t>Alice</w:t></w:r></w:p>",
    )?;
    assert!(prepare_docx_anonymized_export(&external).is_err());

    let unresolved = minimal_document(
      &valid_root,
      "<w:p><w:r><w:t>Alice</w:t></w:r></w:p><w:sectPr><w:headerReference w:type=\"default\" r:id=\"rId9\"/></w:sectPr>",
    )?;
    assert!(prepare_docx_anonymized_export(&unresolved).is_err());
    Ok(())
  }

  #[test]
  fn strips_external_hyperlinks_but_preserves_visible_text()
  -> Result<(), Box<dyn std::error::Error>> {
    let source = archive(&[
      (
        "[Content_Types].xml",
        &format!(
          "<Types xmlns=\"{CONTENT_TYPES}\"><Override PartName=\"/word/document.xml\" ContentType=\"{WORD_CONTENT}document.main+xml\"/></Types>"
        ),
      ),
      (
        "_rels/.rels",
        &format!(
          "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
        ),
      ),
      (
        "word/document.xml",
        &format!(
          "<w:document xmlns:w=\"{WORD}\" xmlns:r=\"{OFFICE_RELS}\"><w:body><w:p><w:hyperlink r:id=\"rId1\"><w:r><w:t>Visible link</w:t></w:r></w:hyperlink></w:p></w:body></w:document>"
        ),
      ),
      (
        "word/_rels/document.xml.rels",
        &format!(
          "<Relationships xmlns=\"{PACKAGE_RELS}\"><Relationship Id=\"rId1\" Type=\"{OFFICE_RELS}/hyperlink\" Target=\"https://example.invalid/private\" TargetMode=\"External\"/></Relationships>"
        ),
      ),
    ])?;
    let prepared = prepare_docx_anonymized_export(&source)?;
    assert_eq!(
      prepared
        .extraction
        .blocks
        .first()
        .map(|extracted_block| extracted_block.text.as_str()),
      Some("Visible link")
    );
    assert!(
      !entry(&prepared.document, "word/document.xml")?.contains("hyperlink")
    );
    let relationships =
      entry(&prepared.document, "word/_rels/document.xml.rels")?;
    assert!(!relationships.contains("TargetMode"));
    assert!(!relationships.contains("example.invalid"));
    Ok(())
  }

  #[test]
  fn rejects_xml_over_the_shared_depth_limit()
  -> Result<(), Box<dyn std::error::Error>> {
    let mut body = "<w:sdt>".repeat(300);
    body.push_str("<w:p><w:r><w:t>Alice</w:t></w:r></w:p>");
    body.push_str(&"</w:sdt>".repeat(300));
    let source = ordinary_document(&body)?;
    assert!(prepare_docx_anonymized_export(&source).is_err());
    Ok(())
  }
}
