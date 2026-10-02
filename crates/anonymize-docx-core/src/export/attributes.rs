// Every attribute the anonymized export retains has exactly one row below that
// names its element, optional parent, and value domain. An attribute without a
// row is rejected, and a retained value is re-serialized in one canonical
// spelling, so typed values cannot carry producer-chosen lexical variants.

use std::collections::HashMap;

use super::{common_font, valid_numbering_label};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum AttributeDomain {
  /// `ST_OnOff` lexemes, copied unchanged.
  OnOff,
  /// A decimal integer in canonical spelling within the inclusive range.
  Integer {
    minimum: i32,
    maximum: i32,
  },
  /// A rendered starting number. Lists, notes, pages and line numbers render
  /// it without passing through extraction, so any producer-chosen value is
  /// normalized: 0 stays 0 and every other start becomes 1.
  StartNumber,
  Enumeration(&'static [&'static str]),
  /// Six hexadecimal digits, upper-cased; `auto` too when `automatic`.
  Color {
    automatic: bool,
  },
  /// A fixed number of hexadecimal digits, upper-cased.
  HexDigits(usize),
  /// A fixed number of `0`/`1` digits.
  BinaryDigits(usize),
  /// A style identifier, replaced by its export identifier.
  StyleReference,
  /// A font family from the export's common-font list.
  Font,
  /// A theme typeface: empty or a common font.
  ThemeTypeface,
  /// A numbering level label without literal text or digits.
  NumberingLabel,
  /// Any value, replaced by a constant.
  Replaced(&'static str),
  /// Any value, dropped from the export.
  Omitted,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum CanonicalAttribute {
  Retain(String),
  Omit,
}

fn canonical_integer(value: &str) -> Option<i32> {
  let number = value.parse::<i32>().ok()?;
  (number.to_string() == value).then_some(number)
}

fn upper_hex(value: &str, length: usize) -> Option<String> {
  (value.len() == length && value.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then(|| value.to_ascii_uppercase())
}

const ON_OFF_VALUES: &[&str] = &["0", "1", "true", "false", "on", "off"];

impl AttributeDomain {
  /// Returns `None` when `value` lies outside the domain.
  pub(super) fn canonical(
    self,
    value: &str,
    styles: &HashMap<String, String>,
  ) -> Option<CanonicalAttribute> {
    let retained = match self {
      Self::OnOff => ON_OFF_VALUES.contains(&value).then(|| value.to_owned()),
      Self::Integer { minimum, maximum } => canonical_integer(value)
        .filter(|number| (minimum..=maximum).contains(number))
        .map(|number| number.to_string()),
      Self::StartNumber => canonical_integer(value)
        .filter(|number| *number >= 0)
        .map(|number| if number == 0 { "0" } else { "1" }.to_owned()),
      Self::Enumeration(values) => {
        values.contains(&value).then(|| value.to_owned())
      }
      Self::Color { automatic } => {
        if automatic && value == "auto" {
          Some(value.to_owned())
        } else {
          upper_hex(value, 6)
        }
      }
      Self::HexDigits(length) => upper_hex(value, length),
      Self::BinaryDigits(length) => (value.len() == length
        && value.bytes().all(|byte| matches!(byte, b'0' | b'1')))
      .then(|| value.to_owned()),
      Self::StyleReference => styles.get(value).cloned(),
      Self::Font => common_font(value).then(|| value.to_owned()),
      Self::ThemeTypeface => {
        (value.is_empty() || common_font(value)).then(|| value.to_owned())
      }
      Self::NumberingLabel => {
        valid_numbering_label(value).then(|| value.to_owned())
      }
      Self::Replaced(constant) => Some(constant.to_owned()),
      Self::Omitted => return Some(CanonicalAttribute::Omit),
    };
    retained.map(CanonicalAttribute::Retain)
  }
}

#[derive(Clone, Copy, Debug)]
pub(super) struct AttributeSpec {
  pub(super) elements: &'static [&'static str],
  /// `None` accepts any parent element.
  pub(super) parents: Option<&'static [&'static str]>,
  pub(super) attributes: &'static [&'static str],
  pub(super) domain: AttributeDomain,
}

const fn any(
  elements: &'static [&'static str],
  attributes: &'static [&'static str],
  domain: AttributeDomain,
) -> AttributeSpec {
  AttributeSpec {
    elements,
    parents: None,
    attributes,
    domain,
  }
}

const fn within(
  elements: &'static [&'static str],
  parents: &'static [&'static str],
  attributes: &'static [&'static str],
  domain: AttributeDomain,
) -> AttributeSpec {
  AttributeSpec {
    elements,
    parents: Some(parents),
    attributes,
    domain,
  }
}

const fn integer(minimum: i32, maximum: i32) -> AttributeDomain {
  AttributeDomain::Integer { minimum, maximum }
}

const fn one_of(values: &'static [&'static str]) -> AttributeDomain {
  AttributeDomain::Enumeration(values)
}

fn find_spec(
  tables: &'static [&'static [AttributeSpec]],
  element: &str,
  parent: Option<&str>,
  attribute: &str,
) -> Option<&'static AttributeSpec> {
  tables.iter().copied().flatten().find(|spec| {
    spec.elements.contains(&element)
      && spec.attributes.contains(&attribute)
      && spec.parents.is_none_or(|parents| {
        parent.is_some_and(|parent| parents.contains(&parent))
      })
  })
}

pub(super) fn word_attribute_spec(
  element: &str,
  parent: Option<&str>,
  attribute: &str,
) -> Option<&'static AttributeSpec> {
  find_spec(WORD_ATTRIBUTE_TABLES, element, parent, attribute)
}

pub(super) fn drawing_attribute_spec(
  element: &str,
  attribute: &str,
) -> Option<&'static AttributeSpec> {
  find_spec(DRAWING_ATTRIBUTE_TABLES, element, None, attribute)
}

// Identifier numbers (numbering, notes) and lengths in twentieths of a point.
const IDENTIFIER_MAX: i32 = 1_000_000;
const LENGTH_MAX: i32 = 1_000_000;
// Font sizes and kerning thresholds in half-points; Word caps text at 1638 pt.
const HALF_POINTS_MAX: i32 = 3_276;
// Word caps raised or lowered text at 1584 points.
const POSITION_MAX_HALF_POINTS: i32 = 3_168;
// Word caps expanded or condensed character spacing at 1584 points.
const CHARACTER_SPACING_MAX_TWIPS: i32 = 31_680;
const UNSIGNED_LENGTH: AttributeDomain = integer(0, LENGTH_MAX);
const SIGNED_LENGTH: AttributeDomain = integer(-LENGTH_MAX, LENGTH_MAX);
const IDENTIFIER: AttributeDomain = integer(0, IDENTIFIER_MAX);
const NOTE_IDENTIFIER: AttributeDomain = integer(-1, IDENTIFIER_MAX);
const LEVEL: AttributeDomain = integer(0, 8);
const HEX_BYTE: AttributeDomain = AttributeDomain::HexDigits(2);
const AUTOMATIC_COLOR: AttributeDomain =
  AttributeDomain::Color { automatic: true };
const NUMBERING_IDENTIFIER: &str = "00000001";

pub(super) const BOOLEAN_WORD_ELEMENTS: &[&str] = &[
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
  "formProt",
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
const STYLE_REFERENCE_ELEMENTS: &[&str] = &[
  "basedOn",
  "link",
  "next",
  "numStyleLink",
  "pStyle",
  "rStyle",
  "styleLink",
  "tblStyle",
];
const BORDER_ELEMENTS: &[&str] =
  &["top", "left", "bottom", "right", "insideH", "insideV"];
const BORDER_PARENTS: &[&str] = &["pBdr", "tblBorders", "tcBorders"];
const MARGIN_ELEMENTS: &[&str] = &["top", "left", "bottom", "right"];
const MARGIN_PARENTS: &[&str] = &["tblCellMar", "tcMar"];
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
const BORDER_STYLES: &[&str] = &[
  "nil",
  "none",
  "single",
  "thick",
  "double",
  "dotted",
  "dashed",
  "dotDash",
  "dotDotDash",
  "triple",
  "thinThickSmallGap",
  "thickThinSmallGap",
  "thinThickThinSmallGap",
  "thinThickMediumGap",
  "thickThinMediumGap",
  "thinThickThinMediumGap",
  "thinThickLargeGap",
  "thickThinLargeGap",
  "thinThickThinLargeGap",
  "wave",
  "doubleWave",
  "dashSmallGap",
  "dashDotStroked",
  "threeDEmboss",
  "threeDEngrave",
  "outset",
  "inset",
];
const SHADING_VALUES: &[&str] = &[
  "clear", "nil", "solid", "pct5", "pct10", "pct20", "pct25", "pct30", "pct40",
  "pct50", "pct60", "pct70", "pct75", "pct80", "pct90",
];
const UNDERLINE_VALUES: &[&str] = &[
  "single",
  "words",
  "double",
  "thick",
  "dotted",
  "dottedHeavy",
  "dash",
  "dashedHeavy",
  "dashLong",
  "dashLongHeavy",
  "dotDash",
  "dashDotHeavy",
  "dotDotDash",
  "dashDotDotHeavy",
  "wave",
  "wavyHeavy",
  "wavyDouble",
  "none",
];
const HIGHLIGHT_COLORS: &[&str] = &[
  "black",
  "blue",
  "cyan",
  "green",
  "magenta",
  "red",
  "yellow",
  "white",
  "darkBlue",
  "darkCyan",
  "darkGreen",
  "darkMagenta",
  "darkRed",
  "darkYellow",
  "darkGray",
  "lightGray",
  "none",
];
const JUSTIFICATION_VALUES: &[&str] = &[
  "start",
  "center",
  "end",
  "both",
  "mediumKashida",
  "distribute",
  "numTab",
  "highKashida",
  "lowKashida",
  "thaiDistribute",
  "left",
  "right",
];
// `custom` is excluded: it renders producer-chosen text from `w:format`.
const NUMBER_FORMATS: &[&str] = &[
  "decimal",
  "upperRoman",
  "lowerRoman",
  "upperLetter",
  "lowerLetter",
  "ordinal",
  "cardinalText",
  "ordinalText",
  "hex",
  "chicago",
  "ideographDigital",
  "japaneseCounting",
  "aiueo",
  "iroha",
  "decimalFullWidth",
  "decimalHalfWidth",
  "japaneseLegal",
  "japaneseDigitalTenThousand",
  "decimalEnclosedCircle",
  "decimalFullWidth2",
  "aiueoFullWidth",
  "irohaFullWidth",
  "decimalZero",
  "bullet",
  "ganada",
  "chosung",
  "decimalEnclosedFullstop",
  "decimalEnclosedParen",
  "decimalEnclosedCircleChinese",
  "ideographEnclosedCircle",
  "ideographTraditional",
  "ideographZodiac",
  "ideographZodiacTraditional",
  "taiwaneseCounting",
  "ideographLegalTraditional",
  "taiwaneseCountingThousand",
  "taiwaneseDigital",
  "chineseCounting",
  "chineseLegalSimplified",
  "chineseCountingThousand",
  "koreanDigital",
  "koreanCounting",
  "koreanLegal",
  "koreanDigital2",
  "vietnameseCounting",
  "russianLower",
  "russianUpper",
  "none",
  "numberInDash",
  "hebrew1",
  "hebrew2",
  "arabicAlpha",
  "arabicAbjad",
  "hindiVowels",
  "hindiConsonants",
  "hindiNumbers",
  "hindiCounting",
  "thaiLetters",
  "thaiNumbers",
  "thaiCounting",
  "bahtText",
  "dollarText",
];
const THEME_FONT_VALUES: &[&str] = &[
  "majorAscii",
  "majorBidi",
  "majorEastAsia",
  "majorHAnsi",
  "minorAscii",
  "minorBidi",
  "minorEastAsia",
  "minorHAnsi",
];
const VERTICAL_ALIGNMENT_VALUES: &[&str] =
  &["baseline", "subscript", "superscript"];
const DOCUMENT_GRID_TYPES: &[&str] =
  &["default", "lines", "linesAndChars", "snapToChars"];
const TEXT_DIRECTION_VALUES: &[&str] =
  &["btLr", "lrTb", "lrTbV", "tbLrV", "tbRl", "tbRlV"];
const TABLE_STYLE_OVERRIDE_TYPES: &[&str] = &[
  "band1Horz",
  "band1Vert",
  "band2Horz",
  "band2Vert",
  "firstCol",
  "firstRow",
  "lastCol",
  "lastRow",
  "neCell",
  "nwCell",
  "seCell",
  "swCell",
  "wholeTable",
];
const WIDTH_TYPES: &[&str] = &["nil", "pct", "dxa", "auto"];
const LINE_RULES: &[&str] = &["auto", "exact", "atLeast"];

const WORD_VALUE_SPECS: &[AttributeSpec] = &[
  any(BOOLEAN_WORD_ELEMENTS, &["val"], AttributeDomain::OnOff),
  any(
    STYLE_REFERENCE_ELEMENTS,
    &["val"],
    AttributeDomain::StyleReference,
  ),
  any(
    &["abstractNumId", "numId", "numIdMacAtCleanup"],
    &["val"],
    IDENTIFIER,
  ),
  any(&["cnfStyle"], &["val"], AttributeDomain::BinaryDigits(12)),
  any(
    &["effect"],
    &["val"],
    one_of(&[
      "blinkBackground",
      "lights",
      "antsBlack",
      "antsRed",
      "shimmer",
      "sparkle",
      "none",
    ]),
  ),
  any(
    &["em"],
    &["val"],
    one_of(&["none", "dot", "comma", "circle", "underDot"]),
  ),
  any(&["gridSpan"], &["val"], integer(1, 4_096)),
  any(&["gridBefore", "gridAfter"], &["val"], integer(0, 4_096)),
  any(&["highlight"], &["val"], one_of(HIGHLIGHT_COLORS)),
  any(
    &["hMerge", "vMerge"],
    &["val"],
    one_of(&["restart", "continue"]),
  ),
  any(&["ilvl"], &["val"], LEVEL),
  any(&["jc"], &["val"], one_of(JUSTIFICATION_VALUES)),
  any(
    &["kern", "sz", "szCs"],
    &["val"],
    integer(0, HALF_POINTS_MAX),
  ),
  any(
    &["lvlJc"],
    &["val"],
    one_of(&["start", "center", "end", "left", "right"]),
  ),
  any(&["lvlRestart", "outlineLvl"], &["val"], integer(0, 9)),
  any(&["lvlText"], &["val"], AttributeDomain::NumberingLabel),
  any(
    &["multiLevelType"],
    &["val"],
    one_of(&["singleLevel", "multilevel", "hybridMultilevel"]),
  ),
  any(
    &["nsid", "tmpl"],
    &["val"],
    AttributeDomain::Replaced(NUMBERING_IDENTIFIER),
  ),
  any(&["numFmt"], &["val"], one_of(NUMBER_FORMATS)),
  any(
    &["numRestart"],
    &["val"],
    one_of(&["continuous", "eachSect", "eachPage"]),
  ),
  within(&["start"], &["lvl"], &["val"], AttributeDomain::StartNumber),
  within(
    &["startOverride"],
    &["lvlOverride"],
    &["val"],
    AttributeDomain::StartNumber,
  ),
  within(
    &["numStart"],
    &["footnotePr", "endnotePr"],
    &["val"],
    AttributeDomain::StartNumber,
  ),
  within(
    &["pos"],
    &["footnotePr"],
    &["val"],
    one_of(&["pageBottom", "beneathText"]),
  ),
  within(
    &["pos"],
    &["endnotePr"],
    &["val"],
    one_of(&["sectEnd", "docEnd"]),
  ),
  any(
    &["position"],
    &["val"],
    integer(-POSITION_MAX_HALF_POINTS, POSITION_MAX_HALF_POINTS),
  ),
  within(
    &["spacing"],
    &["rPr"],
    &["val"],
    integer(-CHARACTER_SPACING_MAX_TWIPS, CHARACTER_SPACING_MAX_TWIPS),
  ),
  any(&["suff"], &["val"], one_of(&["tab", "space", "nothing"])),
  any(&["tblLayout"], &["type"], one_of(&["fixed", "autofit"])),
  any(&["tblOverlap"], &["val"], one_of(&["never", "overlap"])),
  any(
    &["tblStyleColBandSize", "tblStyleRowBandSize"],
    &["val"],
    integer(0, 1_000),
  ),
  any(
    &["textAlignment"],
    &["val"],
    one_of(&["top", "center", "baseline", "bottom", "auto"]),
  ),
  any(&["textDirection"], &["val"], one_of(TEXT_DIRECTION_VALUES)),
  any(
    &["type"],
    &["val"],
    one_of(&[
      "nextPage",
      "nextColumn",
      "continuous",
      "evenPage",
      "oddPage",
    ]),
  ),
  any(&["uiPriority"], &["val"], integer(0, 99)),
  any(
    &["vAlign"],
    &["val"],
    one_of(&["top", "center", "both", "bottom"]),
  ),
  any(&["vertAlign"], &["val"], one_of(VERTICAL_ALIGNMENT_VALUES)),
  any(&["w"], &["val"], integer(1, 600)),
];

const WORD_STRUCTURE_SPECS: &[AttributeSpec] = &[
  any(&["style"], &["styleId"], AttributeDomain::StyleReference),
  any(
    &["style"],
    &["type"],
    one_of(&["paragraph", "character", "table", "numbering"]),
  ),
  any(
    &["style"],
    &["default", "customStyle"],
    AttributeDomain::OnOff,
  ),
  any(
    &["rFonts"],
    &["ascii", "hAnsi", "eastAsia", "cs"],
    AttributeDomain::Font,
  ),
  any(
    &["rFonts"],
    &["asciiTheme", "hAnsiTheme", "eastAsiaTheme", "cstheme"],
    one_of(THEME_FONT_VALUES),
  ),
  any(
    &["rFonts"],
    &["hint"],
    one_of(&["default", "eastAsia", "cs"]),
  ),
  any(&["footnote", "endnote"], &["id"], NOTE_IDENTIFIER),
  any(
    &["footnote", "endnote"],
    &["type"],
    one_of(&[
      "normal",
      "separator",
      "continuationSeparator",
      "continuationNotice",
    ]),
  ),
  any(
    &["footnoteReference", "endnoteReference"],
    &["id"],
    IDENTIFIER,
  ),
  any(
    &["footnoteReference", "endnoteReference"],
    &["customMarkFollows"],
    AttributeDomain::OnOff,
  ),
  any(
    &["headerReference", "footerReference"],
    &["type"],
    one_of(&["default", "first", "even"]),
  ),
  any(
    &["tblStylePr"],
    &["type"],
    one_of(TABLE_STYLE_OVERRIDE_TYPES),
  ),
  any(&["abstractNum"], &["abstractNumId"], IDENTIFIER),
  any(&["num"], &["numId"], IDENTIFIER),
  any(&["lvl", "lvlOverride"], &["ilvl"], LEVEL),
  any(
    &["lvl"],
    &["tplc"],
    AttributeDomain::Replaced(NUMBERING_IDENTIFIER),
  ),
  any(&["lvl"], &["tentative"], AttributeDomain::OnOff),
  any(
    &["eastAsianLayout"],
    &["combine", "vert", "vertCompress"],
    AttributeDomain::OnOff,
  ),
  any(&["eastAsianLayout"], &["id"], IDENTIFIER),
  any(
    &["eastAsianLayout"],
    &["combineBrackets"],
    one_of(&["none", "round", "square", "angle", "curly"]),
  ),
];

const WORD_COLOR_SPECS: &[AttributeSpec] = &[
  within(
    BORDER_ELEMENTS,
    BORDER_PARENTS,
    &["val"],
    one_of(BORDER_STYLES),
  ),
  within(BORDER_ELEMENTS, BORDER_PARENTS, &["color"], AUTOMATIC_COLOR),
  within(
    BORDER_ELEMENTS,
    BORDER_PARENTS,
    &["themeColor"],
    one_of(THEME_COLOR_VALUES),
  ),
  within(
    BORDER_ELEMENTS,
    BORDER_PARENTS,
    &["themeTint", "themeShade"],
    HEX_BYTE,
  ),
  within(BORDER_ELEMENTS, BORDER_PARENTS, &["sz"], integer(0, 1_000)),
  within(
    BORDER_ELEMENTS,
    BORDER_PARENTS,
    &["space"],
    integer(0, 1_584),
  ),
  within(
    BORDER_ELEMENTS,
    BORDER_PARENTS,
    &["shadow", "frame"],
    AttributeDomain::OnOff,
  ),
  any(&["shd"], &["val"], one_of(SHADING_VALUES)),
  any(&["shd", "u"], &["color"], AUTOMATIC_COLOR),
  any(&["shd"], &["fill"], AUTOMATIC_COLOR),
  any(
    &["shd", "color", "u"],
    &["themeColor"],
    one_of(THEME_COLOR_VALUES),
  ),
  any(&["shd"], &["themeFill"], one_of(THEME_COLOR_VALUES)),
  any(
    &["shd"],
    &["themeTint", "themeShade", "themeFillTint", "themeFillShade"],
    HEX_BYTE,
  ),
  any(&["color", "u"], &["themeTint", "themeShade"], HEX_BYTE),
  any(&["color"], &["val"], AUTOMATIC_COLOR),
  any(&["u"], &["val"], one_of(UNDERLINE_VALUES)),
];

const WORD_LAYOUT_SPECS: &[AttributeSpec] = &[
  within(MARGIN_ELEMENTS, MARGIN_PARENTS, &["w"], UNSIGNED_LENGTH),
  within(
    MARGIN_ELEMENTS,
    MARGIN_PARENTS,
    &["type"],
    one_of(WIDTH_TYPES),
  ),
  any(
    &["ind"],
    &["left", "right", "leftChars", "rightChars"],
    SIGNED_LENGTH,
  ),
  any(
    &["ind"],
    &["firstLine", "hanging", "firstLineChars", "hangingChars"],
    UNSIGNED_LENGTH,
  ),
  within(
    &["spacing"],
    &["pPr"],
    &["before", "after", "beforeLines", "afterLines"],
    UNSIGNED_LENGTH,
  ),
  within(&["spacing"], &["pPr"], &["line"], SIGNED_LENGTH),
  within(&["spacing"], &["pPr"], &["lineRule"], one_of(LINE_RULES)),
  within(
    &["spacing"],
    &["pPr"],
    &["beforeAutospacing", "afterAutospacing"],
    AttributeDomain::OnOff,
  ),
  any(&["tblLook"], &["val"], AttributeDomain::HexDigits(4)),
  any(
    &["tblLook"],
    &[
      "firstRow",
      "lastRow",
      "firstColumn",
      "lastColumn",
      "noHBand",
      "noVBand",
    ],
    AttributeDomain::OnOff,
  ),
  any(&["cols"], &["num"], integer(1, 100)),
  any(&["cols"], &["space"], UNSIGNED_LENGTH),
  any(&["cols"], &["sep", "equalWidth"], AttributeDomain::OnOff),
  any(&["trHeight"], &["val"], UNSIGNED_LENGTH),
  any(&["trHeight"], &["hRule"], one_of(LINE_RULES)),
  any(
    &["tblpPr"],
    &[
      "leftFromText",
      "rightFromText",
      "topFromText",
      "bottomFromText",
    ],
    UNSIGNED_LENGTH,
  ),
  any(
    &["tblpPr"],
    &["vertAnchor", "horzAnchor"],
    one_of(&["text", "margin", "page"]),
  ),
  any(&["tblpPr"], &["tblpX", "tblpY"], SIGNED_LENGTH),
  any(
    &["tblpPr"],
    &["tblpXSpec"],
    one_of(&["left", "center", "right", "inside", "outside"]),
  ),
  any(
    &["tblpPr"],
    &["tblpYSpec"],
    one_of(&["inline", "top", "center", "bottom", "inside", "outside"]),
  ),
  any(&["gridCol"], &["w"], UNSIGNED_LENGTH),
  any(&["tblInd"], &["w"], SIGNED_LENGTH),
  any(&["tblW", "tcW", "tblCellSpacing"], &["w"], UNSIGNED_LENGTH),
  any(
    &["tblInd", "tblW", "tcW", "tblCellSpacing"],
    &["type"],
    one_of(WIDTH_TYPES),
  ),
];

const WORD_SECTION_SPECS: &[AttributeSpec] = &[
  any(&["pgSz"], &["w", "h"], UNSIGNED_LENGTH),
  any(&["pgSz"], &["orient"], one_of(&["portrait", "landscape"])),
  any(&["pgSz"], &["code"], integer(0, 1_000)),
  any(&["pgMar"], &["top", "bottom"], SIGNED_LENGTH),
  any(
    &["pgMar"],
    &["right", "left", "header", "footer", "gutter"],
    UNSIGNED_LENGTH,
  ),
  any(
    &["br"],
    &["type"],
    one_of(&["page", "column", "textWrapping"]),
  ),
  any(
    &["br"],
    &["clear"],
    one_of(&["none", "left", "right", "all"]),
  ),
  within(
    &["tab"],
    &["tabs"],
    &["val"],
    one_of(&[
      "clear", "start", "center", "end", "decimal", "bar", "num", "left",
      "right",
    ]),
  ),
  within(&["tab"], &["tabs"], &["pos"], SIGNED_LENGTH),
  within(
    &["tab"],
    &["tabs"],
    &["leader"],
    one_of(&["none", "dot", "hyphen", "underscore", "heavy", "middleDot"]),
  ),
  any(&["lnNumType"], &["countBy"], integer(0, 100)),
  any(
    &["lnNumType", "pgNumType"],
    &["start"],
    AttributeDomain::StartNumber,
  ),
  any(&["lnNumType"], &["distance"], UNSIGNED_LENGTH),
  any(
    &["lnNumType"],
    &["restart"],
    one_of(&["newPage", "newSection", "continuous"]),
  ),
  any(
    &["pgBorders"],
    &["display"],
    one_of(&["allPages", "firstPage", "notFirstPage"]),
  ),
  any(&["pgBorders"], &["offsetFrom"], one_of(&["page", "text"])),
  any(&["pgBorders"], &["zOrder"], one_of(&["front", "back"])),
  any(&["docGrid"], &["type"], one_of(DOCUMENT_GRID_TYPES)),
  any(&["docGrid"], &["linePitch"], UNSIGNED_LENGTH),
  any(&["docGrid"], &["charSpace"], SIGNED_LENGTH),
  any(&["pgNumType"], &["fmt"], one_of(NUMBER_FORMATS)),
  any(&["pgNumType"], &["chapterStyle"], integer(0, 9)),
  any(
    &["pgNumType"],
    &["chapterSep"],
    one_of(&["hyphen", "period", "colon", "emDash", "enDash"]),
  ),
];

pub(super) const WORD_ATTRIBUTE_TABLES: &[&[AttributeSpec]] = &[
  WORD_VALUE_SPECS,
  WORD_STRUCTURE_SPECS,
  WORD_COLOR_SPECS,
  WORD_LAYOUT_SPECS,
  WORD_SECTION_SPECS,
];

// DrawingML lengths in English Metric Units; 20,116,800 is 1,584 points.
const DRAWING_LENGTH: AttributeDomain = integer(0, 20_116_800);
const DRAWING_ANGLE: AttributeDomain = integer(0, 21_600_000);
const DRAWING_PERCENTAGE: AttributeDomain = integer(0, 100_000);
const DRAWING_BOOLEAN: AttributeDomain = one_of(&["0", "1", "true", "false"]);
const FONT_ELEMENTS: &[&str] = &["latin", "ea", "cs", "font"];
const SHADOW_ELEMENTS: &[&str] = &["outerShdw", "innerShdw", "reflection"];
const SCHEME_COLOR_VALUES: &[&str] = &[
  "accent1", "accent2", "accent3", "accent4", "accent5", "accent6", "bg1",
  "bg2", "dk1", "dk2", "folHlink", "hlink", "lt1", "lt2", "phClr", "tx1",
  "tx2",
];
const THEME_SCRIPTS: &[&str] = &[
  "Arab", "Armn", "Beng", "Bopo", "Bugi", "Cans", "Cher", "Deva", "Ethi",
  "Geor", "Gujr", "Guru", "Hang", "Hans", "Hant", "Hebr", "Java", "Jpan",
  "Khmr", "Knda", "Laoo", "Latn", "Lisu", "Mlym", "Mong", "Mymr", "Nkoo",
  "Olck", "Orya", "Osma", "Phag", "Sinh", "Sora", "Syrc", "Syre", "Syrj",
  "Syrn", "Tale", "Talu", "Taml", "Telu", "Tfng", "Thaa", "Thai", "Tibt",
  "Uigh", "Viet", "Yiii",
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
const LIGATURE_VALUES: &[&str] = &[
  "none",
  "standard",
  "contextual",
  "historical",
  "discretional",
  "standardContextual",
  "standardHistorical",
  "contextualHistorical",
  "standardDiscretional",
  "contextualDiscretional",
  "historicalDiscretional",
  "standardContextualHistorical",
  "standardContextualDiscretional",
  "standardHistoricalDiscretional",
  "contextualHistoricalDiscretional",
  "all",
];

const DRAWING_COLOR_SPECS: &[AttributeSpec] = &[
  any(
    &["theme", "clrScheme", "fontScheme", "fmtScheme"],
    &["name"],
    AttributeDomain::Replaced("stella"),
  ),
  any(&["font"], &["script"], one_of(THEME_SCRIPTS)),
  any(FONT_ELEMENTS, &["typeface"], AttributeDomain::ThemeTypeface),
  // PANOSE classifications are optional font-matching hints; copying them
  // would retain twenty producer-chosen hexadecimal digits per font.
  any(FONT_ELEMENTS, &["panose"], AttributeDomain::Omitted),
  any(FONT_ELEMENTS, &["pitchFamily", "charset"], integer(0, 255)),
  any(
    &["srgbClr"],
    &["val"],
    AttributeDomain::Color { automatic: false },
  ),
  any(
    &["sysClr"],
    &["lastClr"],
    AttributeDomain::Color { automatic: false },
  ),
  any(
    &["sysClr"],
    &["val"],
    one_of(&["window", "windowText", "btnFace", "btnText"]),
  ),
  any(&["schemeClr"], &["val"], one_of(SCHEME_COLOR_VALUES)),
  any(
    &["prstClr"],
    &["val"],
    one_of(&["black", "blue", "gray", "green", "red", "white", "yellow"]),
  ),
  any(
    &["alpha", "alphaOff", "lumOff", "shade", "tint"],
    &["val"],
    DRAWING_PERCENTAGE,
  ),
  // Modulations scale a colour component and may exceed 100%; Office themes
  // use up to 350%.
  any(
    &["alphaMod", "lumMod", "satMod"],
    &["val"],
    integer(0, 1_000_000),
  ),
  any(&["scrgbClr"], &["r", "g", "b"], DRAWING_PERCENTAGE),
  any(&["hslClr"], &["hue", "sat", "lum"], DRAWING_ANGLE),
];

const DRAWING_SHAPE_SPECS: &[AttributeSpec] = &[
  any(
    &["prstDash"],
    &["val"],
    one_of(&[
      "dash", "dashDot", "dot", "lgDash", "solid", "sysDash", "sysDot",
    ]),
  ),
  any(&["path"], &["path"], one_of(&["circle", "rect", "shape"])),
  any(&["pattFill"], &["prst"], one_of(PATTERN_FILL_VALUES)),
  any(
    &["camera"],
    &["prst"],
    one_of(&[
      "legacyObliqueFront",
      "legacyPerspectiveFront",
      "orthographicFront",
      "perspectiveFront",
      "perspectiveRelaxed",
    ]),
  ),
  any(
    &["bevelT"],
    &["prst"],
    one_of(&["angle", "circle", "convex", "relaxedInset"]),
  ),
  any(
    &["lightRig"],
    &["rig"],
    one_of(&[
      "balanced",
      "brightRoom",
      "contrasting",
      "flat",
      "soft",
      "threePt",
      "twoPt",
    ]),
  ),
  any(
    &["lightRig"],
    &["dir"],
    one_of(&["b", "bl", "br", "l", "r", "t", "tl", "tr"]),
  ),
  any(
    &["gradFill", "outerShdw", "reflection"],
    &["rotWithShape"],
    DRAWING_BOOLEAN,
  ),
  any(&["gradFill"], &["flip"], one_of(&["none", "x", "xy", "y"])),
  any(&["gs"], &["pos"], DRAWING_PERCENTAGE),
  any(&["lin"], &["ang"], DRAWING_ANGLE),
  any(&["lin"], &["scaled"], DRAWING_BOOLEAN),
  // Gradient focus rectangles may extend beyond the shape; Office themes
  // place an edge at 180%.
  any(
    &["fillToRect"],
    &["l", "t", "r", "b"],
    integer(-1_000_000, 1_000_000),
  ),
  any(
    &["headEnd", "tailEnd"],
    &["w", "len"],
    one_of(&["lg", "med", "sm"]),
  ),
  any(
    &["headEnd", "tailEnd"],
    &["type"],
    one_of(&["arrow", "diamond", "none", "oval", "stealth", "triangle"]),
  ),
  any(&["miter"], &["lim"], integer(0, 1_000_000)),
  any(&["ln", "textOutline", "bevelT"], &["w"], DRAWING_LENGTH),
  any(&["bevelT"], &["h"], DRAWING_LENGTH),
  any(
    &["ln", "textOutline"],
    &["cap"],
    one_of(&["flat", "rnd", "sq"]),
  ),
  any(
    &["ln", "textOutline"],
    &["cmpd"],
    one_of(&["dbl", "sng", "thickThin", "thinThick", "tri"]),
  ),
  any(&["ln", "textOutline"], &["algn"], one_of(&["ctr", "in"])),
];

const DRAWING_EFFECT_SPECS: &[AttributeSpec] = &[
  any(SHADOW_ELEMENTS, &["blurRad", "dist"], DRAWING_LENGTH),
  any(SHADOW_ELEMENTS, &["dir"], DRAWING_ANGLE),
  any(
    &["outerShdw", "reflection"],
    &["sx", "sy"],
    integer(-21_600_000, 21_600_000),
  ),
  any(
    &["outerShdw", "reflection"],
    &["kx", "ky"],
    integer(-5_400_000, 5_400_000),
  ),
  any(
    &["outerShdw", "reflection"],
    &["algn"],
    one_of(&["b", "bl", "br", "ctr", "l", "r", "t", "tl", "tr"]),
  ),
  any(&["glow", "blur", "softEdge"], &["rad"], DRAWING_LENGTH),
  any(&["rot"], &["lat", "lon", "rev"], DRAWING_ANGLE),
  any(&["ligatures"], &["val"], one_of(LIGATURE_VALUES)),
];

pub(super) const DRAWING_ATTRIBUTE_TABLES: &[&[AttributeSpec]] = &[
  DRAWING_COLOR_SPECS,
  DRAWING_SHAPE_SPECS,
  DRAWING_EFFECT_SPECS,
];

#[cfg(test)]
mod tests {
  use std::collections::HashMap;

  use super::super::{
    SAFE_CONTENT_WORD_ELEMENTS, SAFE_NUMBERING_WORD_ELEMENTS,
    SAFE_STYLE_WORD_ELEMENTS, SAFE_TEXT_OUTLINE_DRAWING_ELEMENTS,
    SAFE_THEME_ELEMENTS, canonical_theme_attributes,
    canonical_word_2010_attributes, canonical_word_attributes,
  };
  use super::{
    AttributeDomain, AttributeSpec, DRAWING_ATTRIBUTE_TABLES, ON_OFF_VALUES,
    WORD_ATTRIBUTE_TABLES,
  };

  const WORD: &str =
    "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const DRAWING: &str = "http://schemas.openxmlformats.org/drawingml/2006/main";
  const WORD_2010: &str =
    "http://schemas.microsoft.com/office/word/2010/wordml";

  type Attributes = Result<Vec<(String, String)>, crate::DocxRewriteError>;

  fn valid_samples(domain: AttributeDomain) -> Vec<(String, Option<String>)> {
    let same = |value: &str| (value.to_owned(), Some(value.to_owned()));
    match domain {
      AttributeDomain::OnOff => {
        ON_OFF_VALUES.iter().map(|value| same(value)).collect()
      }
      AttributeDomain::Integer { minimum, maximum } => {
        vec![same(&minimum.to_string()), same(&maximum.to_string())]
      }
      AttributeDomain::StartNumber => vec![
        same("0"),
        same("1"),
        ("123456".to_owned(), Some("1".to_owned())),
      ],
      AttributeDomain::Enumeration(values) => {
        values.iter().map(|value| same(value)).collect()
      }
      AttributeDomain::Color { automatic } => {
        let mut samples =
          vec![("a1b2c3".to_owned(), Some("A1B2C3".to_owned()))];
        if automatic {
          samples.push(same("auto"));
        }
        samples
      }
      AttributeDomain::HexDigits(length) => {
        vec![("a".repeat(length), Some("A".repeat(length)))]
      }
      AttributeDomain::BinaryDigits(length) => {
        vec![same(&"0".repeat(length)), same(&"1".repeat(length))]
      }
      AttributeDomain::StyleReference => {
        vec![("Synthetic".to_owned(), Some("stellaStyle1".to_owned()))]
      }
      AttributeDomain::Font => vec![same("Calibri")],
      AttributeDomain::ThemeTypeface => vec![same(""), same("Calibri")],
      AttributeDomain::NumberingLabel => vec![same("%1."), same("")],
      AttributeDomain::Replaced(constant) => {
        vec![("SyntheticMarker".to_owned(), Some(constant.to_owned()))]
      }
      AttributeDomain::Omitted => vec![("SyntheticMarker".to_owned(), None)],
    }
  }

  fn invalid_samples(domain: AttributeDomain) -> Vec<String> {
    match domain {
      AttributeDomain::OnOff => vec!["yes".to_owned(), "On".to_owned()],
      AttributeDomain::Integer { minimum, maximum } => vec![
        i64::from(minimum).saturating_sub(1).to_string(),
        i64::from(maximum).saturating_add(1).to_string(),
        format!("+{maximum}"),
        format!("0{maximum}"),
        format!("{maximum}.0"),
      ],
      AttributeDomain::StartNumber => {
        ["-1", "007", "+5", "1st"].map(str::to_owned).to_vec()
      }
      AttributeDomain::Enumeration(values) => vec![
        "SyntheticMarker".to_owned(),
        format!("{} ", values.first().copied().unwrap_or_default()),
      ],
      AttributeDomain::Color { automatic } => {
        let mut samples = vec!["A1B2C".to_owned(), "G1B2C3".to_owned()];
        if !automatic {
          samples.push("auto".to_owned());
        }
        samples
      }
      AttributeDomain::HexDigits(length) => {
        vec!["a".repeat(length.saturating_add(1)), "g".repeat(length)]
      }
      AttributeDomain::BinaryDigits(length) => {
        vec!["2".repeat(length), "0".repeat(length.saturating_add(1))]
      }
      AttributeDomain::StyleReference => vec!["Unknown".to_owned()],
      AttributeDomain::Font | AttributeDomain::ThemeTypeface => {
        vec!["SyntheticOwner".to_owned()]
      }
      AttributeDomain::NumberingLabel => {
        vec!["123".to_owned(), "SyntheticOwner".to_owned()]
      }
      AttributeDomain::Replaced(_) | AttributeDomain::Omitted => Vec::new(),
    }
  }

  fn rows(
    tables: &'static [&'static [AttributeSpec]],
  ) -> impl Iterator<Item = &'static AttributeSpec> {
    tables.iter().copied().flatten()
  }

  fn word_attributes(
    spec: &AttributeSpec,
    element: &str,
    attribute: &str,
    value: &str,
  ) -> Result<Attributes, Box<dyn std::error::Error>> {
    let parent = spec
      .parents
      .and_then(|parents| parents.first().copied())
      .unwrap_or("wrapper");
    let xml = format!(
      "<w:{parent} xmlns:w=\"{WORD}\"><w:{element} w:{attribute}=\"{value}\"/></w:{parent}>"
    );
    let document = roxmltree::Document::parse(&xml)?;
    let node = document
      .root_element()
      .first_element_child()
      .ok_or("missing element")?;
    let styles =
      HashMap::from([("Synthetic".to_owned(), "stellaStyle1".to_owned())]);
    Ok(canonical_word_attributes(node, &styles))
  }

  // A drawing row applies to theme DrawingML and to the Word 2010 text-effect
  // elements that reuse DrawingML names; each element must belong to one.
  fn drawing_attributes(
    element: &str,
    attribute: &str,
    value: &str,
  ) -> Result<Vec<(String, Attributes)>, Box<dyn std::error::Error>> {
    let mut results = Vec::new();
    if SAFE_THEME_ELEMENTS.contains(&element) {
      let xml =
        format!("<a:{element} xmlns:a=\"{DRAWING}\" {attribute}=\"{value}\"/>");
      let document = roxmltree::Document::parse(&xml)?;
      results.push((
        attribute.to_owned(),
        canonical_theme_attributes(document.root_element()),
      ));
    }
    if SAFE_TEXT_OUTLINE_DRAWING_ELEMENTS.contains(&element)
      || matches!(element, "textOutline" | "ligatures")
    {
      let xml = format!(
        "<w14:{element} xmlns:w14=\"{WORD_2010}\" w14:{attribute}=\"{value}\"/>"
      );
      let document = roxmltree::Document::parse(&xml)?;
      results.push((
        format!("w14:{attribute}"),
        canonical_word_2010_attributes(document.root_element()),
      ));
    }
    Ok(results)
  }

  fn assert_canonical(
    result: Attributes,
    name: &str,
    expected: Option<&String>,
    context: &str,
  ) -> Result<(), Box<dyn std::error::Error>> {
    let attributes = result.map_err(|error| format!("{context}: {error}"))?;
    let expected = expected
      .map(|value| vec![(name.to_owned(), value.clone())])
      .unwrap_or_default();
    assert_eq!(attributes, expected, "{context}");
    Ok(())
  }

  #[test]
  fn every_word_attribute_spec_is_enforced_by_the_serializer()
  -> Result<(), Box<dyn std::error::Error>> {
    for spec in rows(WORD_ATTRIBUTE_TABLES) {
      for element in spec.elements {
        assert!(
          SAFE_CONTENT_WORD_ELEMENTS.contains(element)
            || SAFE_STYLE_WORD_ELEMENTS.contains(element)
            || SAFE_NUMBERING_WORD_ELEMENTS.contains(element),
          "{element} has attribute specs but is not a retained element"
        );
        for attribute in spec.attributes {
          for (value, expected) in valid_samples(spec.domain) {
            assert_canonical(
              word_attributes(spec, element, attribute, &value)?,
              &format!("w:{attribute}"),
              expected.as_ref(),
              &format!("{element}/@{attribute}={value}"),
            )?;
          }
          for value in invalid_samples(spec.domain) {
            assert!(
              word_attributes(spec, element, attribute, &value)?.is_err(),
              "{element}/@{attribute}={value} must be rejected"
            );
          }
        }
      }
    }
    Ok(())
  }

  #[test]
  fn every_drawing_attribute_spec_is_enforced_by_the_serializer()
  -> Result<(), Box<dyn std::error::Error>> {
    for spec in rows(DRAWING_ATTRIBUTE_TABLES) {
      for element in spec.elements {
        for attribute in spec.attributes {
          for (value, expected) in valid_samples(spec.domain) {
            let results = drawing_attributes(element, attribute, &value)?;
            assert!(
              !results.is_empty(),
              "{element} has attribute specs but is not a retained element"
            );
            for (name, result) in results {
              assert_canonical(
                result,
                &name,
                expected.as_ref(),
                &format!("{element}/@{attribute}={value}"),
              )?;
            }
          }
          for value in invalid_samples(spec.domain) {
            for (_, result) in drawing_attributes(element, attribute, &value)? {
              assert!(
                result.is_err(),
                "{element}/@{attribute}={value} must be rejected"
              );
            }
          }
        }
      }
    }
    Ok(())
  }

  #[test]
  fn attribute_specs_never_overlap() {
    for tables in [WORD_ATTRIBUTE_TABLES, DRAWING_ATTRIBUTE_TABLES] {
      let all = rows(tables).collect::<Vec<_>>();
      for (index, left) in all.iter().enumerate() {
        for right in all.iter().skip(index.saturating_add(1)) {
          for element in left.elements {
            for attribute in left.attributes {
              if !right.elements.contains(element)
                || !right.attributes.contains(attribute)
              {
                continue;
              }
              let disjoint = left.parents.zip(right.parents).is_some_and(
                |(left_parents, right_parents)| {
                  left_parents
                    .iter()
                    .all(|parent| !right_parents.contains(parent))
                },
              );
              assert!(
                disjoint,
                "{element}/@{attribute} has more than one domain"
              );
            }
          }
        }
      }
    }
  }
}
