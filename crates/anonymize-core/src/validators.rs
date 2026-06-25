const SPANISH_CHECK_LETTERS: &str = "TRWAGMYFPDXBNJZSQVHLCKE";
const SPANISH_CIF_LETTERS: &str = "JABCDEFGHI";

pub(crate) fn validate_named_id(validator: &str, value: &str) -> bool {
  validate_id(validator, value, None)
}

pub(crate) fn validate_id(
  validator: &str,
  value: &str,
  input: Option<&str>,
) -> bool {
  let candidate = validator_candidate(value, input);
  match validator {
    "au.abn" => validate_au_abn(&candidate),
    "br.cnpj" => validate_cnpj(&candidate),
    "br.cpf" => validate_cpf(&candidate),
    "cz.dic" => validate_cz_dic(&candidate),
    "cz.rc" => validate_cz_rc(&candidate),
    "es.cif" => validate_es_cif(&candidate),
    "es.dni" => validate_es_dni(&candidate),
    "es.nie" => validate_es_nie(&candidate),
    "gb.nhs" => validate_gb_nhs(&candidate),
    "gb.nino" => validate_gb_nino(&candidate),
    "no.mva" => validate_no_mva(&candidate),
    "no.orgnr" => validate_no_orgnr(&candidate),
    "us.ein" => validate_us_ein(&candidate),
    "us.rtn" => validate_us_routing(&candidate),
    _ => false,
  }
}

fn validator_candidate(value: &str, input: Option<&str>) -> String {
  match input {
    Some("digits-only") => decimal_digit_chars(value).collect(),
    _ => value.to_owned(),
  }
}

fn validate_us_ein(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-']);
  if compact.len() != 9 || !is_ascii_digits(&compact) {
    return false;
  }
  let Some(prefix) = compact.get(0..2) else {
    return false;
  };
  matches!(
    prefix,
    "01"
      | "02"
      | "03"
      | "04"
      | "05"
      | "06"
      | "10"
      | "11"
      | "12"
      | "13"
      | "14"
      | "15"
      | "16"
      | "20"
      | "21"
      | "22"
      | "23"
      | "24"
      | "25"
      | "26"
      | "27"
      | "30"
      | "31"
      | "32"
      | "33"
      | "34"
      | "35"
      | "36"
      | "37"
      | "38"
      | "39"
      | "40"
      | "41"
      | "42"
      | "43"
      | "44"
      | "45"
      | "46"
      | "47"
      | "48"
      | "50"
      | "51"
      | "52"
      | "53"
      | "54"
      | "55"
      | "56"
      | "57"
      | "58"
      | "59"
      | "60"
      | "61"
      | "62"
      | "63"
      | "64"
      | "65"
      | "66"
      | "67"
      | "68"
      | "71"
      | "72"
      | "73"
      | "74"
      | "75"
      | "76"
      | "77"
      | "80"
      | "81"
      | "82"
      | "83"
      | "84"
      | "85"
      | "86"
      | "87"
      | "88"
      | "90"
      | "91"
      | "92"
      | "93"
      | "94"
      | "95"
      | "98"
      | "99"
  )
}

fn validate_cpf(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-', '.']);
  let Ok(digits) = <[u32; 11]>::try_from(decimal_digits_strict(&compact))
  else {
    return false;
  };
  let [d0, d1, d2, d3, d4, d5, d6, d7, d8, d9, d10] = digits;
  if digits.iter().all(|digit| *digit == d0) {
    return false;
  }
  let first = cpf_digit(&[d0, d1, d2, d3, d4, d5, d6, d7, d8], 10);
  let second = cpf_digit(&[d0, d1, d2, d3, d4, d5, d6, d7, d8, d9], 11);
  d9 == first && d10 == second
}

fn cpf_digit(digits: &[u32], weight_start: u32) -> u32 {
  let sum = digits
    .iter()
    .enumerate()
    .map(|(index, digit)| {
      let index = u32::try_from(index).unwrap_or(u32::MAX);
      digit.saturating_mul(weight_start.saturating_sub(index))
    })
    .sum::<u32>();
  let value = 11_u32.saturating_sub(sum.rem_euclid(11));
  if value >= 10 { 0 } else { value }
}

fn validate_cnpj(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-', '.', '/']).to_uppercase();
  let chars = compact.chars().collect::<Vec<_>>();
  let Ok(chars) = <[char; 14]>::try_from(chars) else {
    return false;
  };
  if !chars
    .iter()
    .all(|ch| ch.is_ascii_digit() || ch.is_ascii_uppercase())
  {
    return false;
  }
  if chars.iter().take(12).all(|ch| *ch == '0') {
    return false;
  }
  let first = cnpj_digit(
    chars.get(..12).unwrap_or(&[]),
    &[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  let second = cnpj_digit(
    chars.get(..13).unwrap_or(&[]),
    &[6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  chars.get(12).and_then(|ch| ascii_digit_value(*ch)) == Some(first)
    && chars.get(13).and_then(|ch| ascii_digit_value(*ch)) == Some(second)
}

fn cnpj_digit(chars: &[char], weights: &[u32]) -> u32 {
  let sum = chars
    .iter()
    .zip(weights)
    .filter_map(|(ch, weight)| {
      cnpj_char_value(*ch).map(|value| value.saturating_mul(*weight))
    })
    .sum::<u32>();
  let value = sum.rem_euclid(11);
  if value < 2 {
    0
  } else {
    11_u32.saturating_sub(value)
  }
}

fn cnpj_char_value(ch: char) -> Option<u32> {
  (ch.is_ascii_digit() || ch.is_ascii_uppercase())
    .then(|| u32::from(ch).saturating_sub(u32::from('0')))
}

fn validate_cz_rc(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '/']);
  let digits = decimal_digits_strict(&compact);
  let len = digits.len();
  if len != 9 && len != 10 {
    return false;
  }

  let Some(yy) = number_from_digits(digits.get(0..2)) else {
    return false;
  };
  let Some(raw_month) = number_from_digits(digits.get(2..4)) else {
    return false;
  };
  let Some(day) = number_from_digits(digits.get(4..6)) else {
    return false;
  };

  let mut year = 1900_u32.saturating_add(yy);
  if len == 9 {
    if year >= 1980 {
      year = year.saturating_sub(100);
    }
    if year > 1953 {
      return false;
    }
  } else if year < 1954 {
    year = year.saturating_add(100);
  }

  let Some(month) = decode_cz_month(raw_month, year, len) else {
    return false;
  };
  if !valid_date(year, month, day) {
    return false;
  }
  if len != 10 {
    return true;
  }

  let Some(front) = number_from_digits(digits.get(0..9)) else {
    return false;
  };
  let Some(check) = digits.get(9).copied() else {
    return false;
  };
  (front % 11) % 10 == check
}

fn decode_cz_month(raw_month: u32, year: u32, len: usize) -> Option<u32> {
  let offsets: &[u32] = if len == 10 && year >= 2004 {
    &[0, 50, 20, 70]
  } else {
    &[0, 50]
  };
  offsets.iter().find_map(|offset| {
    let month = raw_month.checked_sub(*offset)?;
    (1..=12).contains(&month).then_some(month)
  })
}

fn validate_cz_dic(value: &str) -> bool {
  let mut compact = compact_without(value, &[' ', '-']);
  if compact.starts_with("CZ") || compact.starts_with("cz") {
    compact = compact.chars().skip(2).collect();
  }
  let digits = decimal_digits_strict(&compact);
  if !(8..=10).contains(&digits.len()) {
    return false;
  }
  match digits.len() {
    8 => validate_cz_dic_legal(&digits),
    9 if digits.first() == Some(&6) => validate_cz_dic_special(&digits),
    9 | 10 => validate_cz_rc(&compact),
    _ => false,
  }
}

fn validate_cz_dic_legal(digits: &[u32]) -> bool {
  if digits.first() == Some(&9) {
    return false;
  }
  let Some(check) = digits.get(7).copied() else {
    return false;
  };
  let sum =
    weighted_sum(digits.get(0..7).unwrap_or(&[]), &[8, 7, 6, 5, 4, 3, 2])
      .rem_euclid(11);
  let v11 = 11_u32.saturating_sub(sum).rem_euclid(11);
  let expected = if v11 == 0 { 1 } else { v11 % 10 };
  check == expected
}

fn validate_cz_dic_special(digits: &[u32]) -> bool {
  let Some(check_digit) = digits.get(8).copied() else {
    return false;
  };
  let sum =
    weighted_sum(digits.get(1..8).unwrap_or(&[]), &[8, 7, 6, 5, 4, 3, 2])
      .rem_euclid(11);
  let inner = 10_u32.saturating_add(11).saturating_sub(sum).rem_euclid(11);
  let check = 8_u32
    .saturating_add(10)
    .saturating_sub(inner)
    .rem_euclid(10);
  check_digit == check
}

fn validate_gb_nhs(value: &str) -> bool {
  let digits = decimal_digits_strict(value);
  let Ok(digits) = <[u32; 10]>::try_from(digits) else {
    return false;
  };
  let [d0, d1, d2, d3, d4, d5, d6, d7, d8, d9] = digits;
  let total = weighted_sum(
    &[d0, d1, d2, d3, d4, d5, d6, d7, d8],
    &[10, 9, 8, 7, 6, 5, 4, 3, 2],
  );
  let check = 11_u32.saturating_sub(total.rem_euclid(11));
  let expected = match check {
    10 => return false,
    11 => 0,
    candidate => candidate,
  };
  d9 == expected
}

fn validate_gb_nino(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-']).to_uppercase();
  let chars = compact.chars().collect::<Vec<_>>();
  let Ok(chars) = <[char; 9]>::try_from(chars) else {
    return false;
  };
  let [first, second, d0, d1, d2, d3, d4, d5, suffix] = chars;
  if !matches!(
    first,
    'A'
      | 'B'
      | 'C'
      | 'E'
      | 'G'
      | 'H'
      | 'J'
      | 'K'
      | 'L'
      | 'M'
      | 'N'
      | 'O'
      | 'P'
      | 'R'
      | 'S'
      | 'T'
      | 'W'
      | 'X'
      | 'Y'
      | 'Z'
  ) {
    return false;
  }
  if !matches!(
    second,
    'A'
      | 'B'
      | 'C'
      | 'E'
      | 'G'
      | 'H'
      | 'J'
      | 'K'
      | 'L'
      | 'M'
      | 'N'
      | 'P'
      | 'R'
      | 'S'
      | 'T'
      | 'W'
      | 'X'
      | 'Y'
      | 'Z'
  ) {
    return false;
  }
  if ![d0, d1, d2, d3, d4, d5].iter().all(char::is_ascii_digit) {
    return false;
  }
  if !matches!(suffix, 'A' | 'B' | 'C' | 'D') {
    return false;
  }
  let prefix = [first, second].iter().collect::<String>();
  !matches!(
    prefix.as_str(),
    "BG" | "GB" | "NK" | "KN" | "TN" | "NT" | "ZZ"
  )
}

fn validate_es_dni(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-']).to_uppercase();
  let chars = compact.chars().collect::<Vec<_>>();
  let Ok(chars) = <[char; 9]>::try_from(chars) else {
    return false;
  };
  let [d0, d1, d2, d3, d4, d5, d6, d7, letter] = chars;
  let digits = [d0, d1, d2, d3, d4, d5, d6, d7];
  let Some(number) = number_from_ascii_digits(&digits) else {
    return false;
  };
  spanish_check_letter(number) == Some(letter)
}

fn validate_es_nie(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-']).to_uppercase();
  let chars = compact.chars().collect::<Vec<_>>();
  let Ok(chars) = <[char; 9]>::try_from(chars) else {
    return false;
  };
  let [prefix, d0, d1, d2, d3, d4, d5, d6, letter] = chars;
  let prefix_value: u32 = match prefix {
    'X' => 0,
    'Y' => 1,
    'Z' => 2,
    _ => return false,
  };
  let digits = [d0, d1, d2, d3, d4, d5, d6];
  let Some(number) = number_from_ascii_digits(&digits) else {
    return false;
  };
  spanish_check_letter(
    prefix_value
      .saturating_mul(10_000_000)
      .saturating_add(number),
  ) == Some(letter)
}

fn validate_es_cif(value: &str) -> bool {
  let mut compact = compact_without(value, &[' ', '-', '/', '.']);
  if compact.starts_with("ES") || compact.starts_with("es") {
    compact = compact.chars().skip(2).collect();
  }
  let compact = compact.to_uppercase();
  let chars = compact.chars().collect::<Vec<_>>();
  let Ok(chars) = <[char; 9]>::try_from(chars) else {
    return false;
  };
  let [prefix, d0, d1, d2, d3, d4, d5, d6, check] = chars;
  if !matches!(
    prefix,
    'A'
      | 'B'
      | 'C'
      | 'D'
      | 'E'
      | 'F'
      | 'G'
      | 'H'
      | 'J'
      | 'N'
      | 'P'
      | 'Q'
      | 'R'
      | 'S'
      | 'U'
      | 'V'
      | 'W'
  ) {
    return false;
  }
  let digits = [d0, d1, d2, d3, d4, d5, d6];
  if !digits.iter().all(char::is_ascii_digit) {
    return false;
  }
  let Some(cif_check) = spanish_cif_checksum(&digits) else {
    return false;
  };
  ascii_digit_value(check) == Some(cif_check)
    || char_at(SPANISH_CIF_LETTERS, cif_check) == Some(check)
}

fn spanish_check_letter(number: u32) -> Option<char> {
  char_at(SPANISH_CHECK_LETTERS, number % 23)
}

fn spanish_cif_checksum(digits: &[char; 7]) -> Option<u32> {
  let mut even = 0_u32;
  let mut odd = 0_u32;
  for (index, ch) in digits.iter().enumerate() {
    let digit = ascii_digit_value(*ch)?;
    if index.is_multiple_of(2) {
      let doubled = digit.saturating_mul(2);
      odd = odd.saturating_add(
        doubled
          .div_euclid(10)
          .saturating_add(doubled.rem_euclid(10)),
      );
    } else {
      even = even.saturating_add(digit);
    }
  }
  Some(
    10_u32
      .saturating_sub(even.saturating_add(odd).rem_euclid(10))
      .rem_euclid(10),
  )
}

fn validate_au_abn(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-']);
  let Ok(mut digits) = <[u32; 11]>::try_from(decimal_digits_strict(&compact))
  else {
    return false;
  };
  let Some(first) = digits.first_mut() else {
    return false;
  };
  *first = (*first).saturating_sub(1);
  weighted_sum(&digits, &[10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19])
    .is_multiple_of(89)
}

fn validate_no_orgnr(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-']);
  let digits = decimal_digits_strict(&compact);
  if digits.len() != 9 {
    return false;
  }
  weighted_sum(&digits, &[3, 2, 7, 6, 5, 4, 3, 2, 1]).is_multiple_of(11)
}

fn validate_no_mva(value: &str) -> bool {
  let mut compact = compact_without(value, &[' ', '-']).to_uppercase();
  if compact.starts_with("NO") {
    compact = compact.chars().skip(2).collect();
  }
  if !compact.ends_with("MVA") {
    return false;
  }
  let digits = compact
    .get(..compact.len().saturating_sub(3))
    .unwrap_or_default();
  validate_no_orgnr(digits)
}

fn validate_us_routing(value: &str) -> bool {
  let compact = compact_without(value, &[' ', '-']);
  let Ok(digits) = <[u32; 9]>::try_from(decimal_digits_strict(&compact)) else {
    return false;
  };
  let [d0, d1, d2, d3, d4, d5, d6, d7, d8] = digits;
  let prefix = d0.saturating_mul(10).saturating_add(d1);
  if !((1..=12).contains(&prefix)
    || (21..=32).contains(&prefix)
    || (61..=72).contains(&prefix)
    || prefix == 80)
  {
    return false;
  }
  let first = d0.saturating_add(d3).saturating_add(d6).saturating_mul(3);
  let second = d1.saturating_add(d4).saturating_add(d7).saturating_mul(7);
  let checksum = first
    .saturating_add(second)
    .saturating_add(d2)
    .saturating_add(d5)
    .saturating_add(d8);
  checksum.is_multiple_of(10)
}

fn compact_without(value: &str, skipped: &[char]) -> String {
  value.chars().filter(|ch| !skipped.contains(ch)).collect()
}

fn decimal_digits(value: &str) -> Vec<u32> {
  decimal_digit_chars(value)
    .filter_map(|ch| ch.to_digit(10))
    .collect()
}

fn decimal_digits_strict(value: &str) -> Vec<u32> {
  if !is_ascii_digits(value) {
    return Vec::new();
  }
  decimal_digits(value)
}

fn decimal_digit_chars(value: &str) -> impl Iterator<Item = char> + '_ {
  value.chars().filter(char::is_ascii_digit)
}

fn is_ascii_digits(value: &str) -> bool {
  !value.is_empty() && value.chars().all(|ch| ch.is_ascii_digit())
}

fn ascii_digit_value(ch: char) -> Option<u32> {
  ch.to_digit(10).filter(|_| ch.is_ascii_digit())
}

fn number_from_digits(digits: Option<&[u32]>) -> Option<u32> {
  digits?.iter().try_fold(0_u32, |total, digit| {
    total.checked_mul(10)?.checked_add(*digit)
  })
}

fn number_from_ascii_digits(chars: &[char]) -> Option<u32> {
  chars.iter().try_fold(0_u32, |total, ch| {
    total.checked_mul(10)?.checked_add(ascii_digit_value(*ch)?)
  })
}

fn char_at(text: &str, index: u32) -> Option<char> {
  usize::try_from(index)
    .ok()
    .and_then(|index| text.chars().nth(index))
}

fn weighted_sum(digits: &[u32], weights: &[u32]) -> u32 {
  digits
    .iter()
    .zip(weights)
    .map(|(digit, weight)| digit.saturating_mul(*weight))
    .sum()
}

fn valid_date(year: u32, month: u32, day: u32) -> bool {
  let days = match month {
    1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
    4 | 6 | 9 | 11 => 30,
    2 if is_leap_year(year) => 29,
    2 => 28,
    _ => return false,
  };
  (1..=days).contains(&day)
}

const fn is_leap_year(year: u32) -> bool {
  year.is_multiple_of(4) && !year.is_multiple_of(100)
    || year.is_multiple_of(400)
}
