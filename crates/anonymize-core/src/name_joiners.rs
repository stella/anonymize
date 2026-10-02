//! Punctuation that joins the parts of one name word (`Smith-Jones`,
//! `O'Neil`). Gazetteer matching folds every spelling to its canonical
//! character and person-name extension continues a name across any of them,
//! so both stages read the same compound as one name.

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NameJoiner {
  Hyphen,
  Apostrophe,
}

/// Every spelling of a name joiner. Dashes that set off a clause (em dash)
/// and quotation marks are not joiners.
pub(crate) const NAME_JOINERS: [(char, NameJoiner); 8] = [
  ('-', NameJoiner::Hyphen),
  // HYPHEN
  ('\u{2010}', NameJoiner::Hyphen),
  // NON-BREAKING HYPHEN
  ('\u{2011}', NameJoiner::Hyphen),
  // EN DASH
  ('\u{2013}', NameJoiner::Hyphen),
  ('\'', NameJoiner::Apostrophe),
  // RIGHT SINGLE QUOTATION MARK, the typographic apostrophe
  ('\u{2019}', NameJoiner::Apostrophe),
  // MODIFIER LETTER APOSTROPHE
  ('\u{02bc}', NameJoiner::Apostrophe),
  ('`', NameJoiner::Apostrophe),
];

impl NameJoiner {
  pub(crate) fn of(ch: char) -> Option<Self> {
    NAME_JOINERS
      .iter()
      .find_map(|(spelling, joiner)| (*spelling == ch).then_some(*joiner))
  }

  /// The spelling every joiner of this kind folds to.
  pub(crate) const fn canonical(self) -> char {
    match self {
      Self::Hyphen => '-',
      Self::Apostrophe => '\'',
    }
  }
}
