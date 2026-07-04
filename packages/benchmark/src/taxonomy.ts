/**
 * Common entity taxonomy for the cross-library benchmark.
 *
 * Every library reports its own label vocabulary. To compare fairly we map
 * each library's native labels onto this shared, deliberately coarse set of
 * eight categories. Coarseness is a fairness choice: competitors that lump all
 * government/financial identifiers under one bucket are not penalised for not
 * distinguishing "tax id" from "passport number", and stella's finer labels are
 * collapsed the same way. Mapping decisions live here so the report can quote a
 * single source of truth.
 */

export const COMMON_LABELS = [
  "person",
  "organization",
  "address",
  "email",
  "phone",
  "id-number",
  "date",
  "money",
] as const;

export type CommonLabel = (typeof COMMON_LABELS)[number];

const COMMON_LABEL_SET: ReadonlySet<string> = new Set(COMMON_LABELS);

export const isCommonLabel = (value: string): value is CommonLabel =>
  COMMON_LABEL_SET.has(value);

/**
 * A native label maps either to a common label or to `null`, meaning "the
 * library emits this, but it is out of scope for this benchmark" (e.g. URLs,
 * usernames, IP addresses). `null`-mapped predictions are dropped before
 * scoring so a library is never charged a false positive for detecting a real
 * category the ground truth does not track.
 */
export type NativeMapping = Record<string, CommonLabel | null>;

/**
 * stella (`@stll/anonymize`) — DEFAULT_ENTITY_LABELS.
 * The many identifier labels collapse into `id-number`; `country` and
 * `land parcel` fold into `address`; `date of birth` folds into `date`.
 */
export const STELLA_MAPPING: NativeMapping = {
  person: "person",
  organization: "organization",
  "phone number": "phone",
  address: "address",
  country: "address",
  "land parcel": "address",
  "email address": "email",
  date: "date",
  "date of birth": "date",
  "monetary amount": "money",
  "bank account number": "id-number",
  iban: "id-number",
  "tax identification number": "id-number",
  "identity card number": "id-number",
  "birth number": "id-number",
  "national identification number": "id-number",
  "social security number": "id-number",
  "registration number": "id-number",
  "credit card number": "id-number",
  "passport number": "id-number",
  crypto: "id-number",
  misc: null,
};

/**
 * Microsoft Presidio — predefined recognizer entity types.
 * PII financial/government identifiers all fold into `id-number`. Presidio has
 * no monetary recognizer by default, so `money` recall is expected to be zero
 * (reported, not hidden). LOCATION/GPE/NRP land in `address` as the closest
 * fit; NRP (nationalities/religious/political groups) is a generous match.
 */
export const PRESIDIO_MAPPING: NativeMapping = {
  PERSON: "person",
  ORGANIZATION: "organization",
  ORG: "organization",
  LOCATION: "address",
  GPE: "address",
  NRP: "address",
  ADDRESS: "address",
  EMAIL_ADDRESS: "email",
  PHONE_NUMBER: "phone",
  DATE_TIME: "date",
  US_SSN: "id-number",
  US_ITIN: "id-number",
  US_PASSPORT: "id-number",
  US_DRIVER_LICENSE: "id-number",
  US_BANK_NUMBER: "id-number",
  IBAN_CODE: "id-number",
  CREDIT_CARD: "id-number",
  CRYPTO: "id-number",
  IP_ADDRESS: null,
  URL: null,
  DOMAIN_NAME: null,
  MEDICAL_LICENSE: "id-number",
  UK_NHS: "id-number",
  IN_PAN: "id-number",
  IN_AADHAAR: "id-number",
};

/**
 * scrubadub — detector names. English-only library. The BASE install ships
 * `email`, `phone`, `url`, `twitter`, and `credential` detectors plus
 * UK-specific identifier detectors; it has NO name detector (that needs the
 * optional `scrubadub_spacy`/`scrubadub_stanford` plugin, deliberately not
 * installed here). `name` is therefore intentionally absent from this mapping,
 * so `person` is not counted among scrubadub's supported labels: it can never
 * emit one, and listing it would inflate the supported-labels denominator with
 * a category the base install does not attempt. No org/address/date/money
 * detectors either, so those score zero recall (reported).
 */
export const SCRUBADUB_MAPPING: NativeMapping = {
  email: "email",
  phone: "phone",
  credit_card: "id-number",
  social_security_number: "id-number",
  url: null,
  twitter: null,
  credential: null,
  drivers_licence: "id-number",
  national_insurance_number: "id-number",
  tax_reference_number: "id-number",
  vehicle_licence_plate: "id-number",
};

/**
 * redact-pii — built-in redactor names (v3). English-only. Street address and
 * zipcode fold into `address`; credit card and SSN fold into `id-number`.
 * No org/date/money support (reported as zero recall).
 */
export const REDACT_PII_MAPPING: NativeMapping = {
  names: "person",
  emailAddress: "email",
  phoneNumber: "phone",
  streetAddress: "address",
  zipcode: "address",
  creditCardNumber: "id-number",
  usSocialSecurityNumber: "id-number",
  ipAddress: null,
  url: null,
  // redact-pii ships the digits rule enabled by default, so its real-world
  // behavior redacts digit runs; count them as id-number attempts rather than
  // dropping an active detector's spans before scoring.
  digits: "id-number",
  username: null,
  password: null,
  credentials: null,
};

/**
 * Labels each library can, in principle, emit after mapping. Used to compute a
 * "supported-labels-only" overall score alongside the all-labels overall, so a
 * library is not judged solely on categories it never attempts.
 */
export const supportedLabels = (mapping: NativeMapping): Set<CommonLabel> => {
  const set = new Set<CommonLabel>();
  for (const mapped of Object.values(mapping)) {
    if (mapped !== null) {
      set.add(mapped);
    }
  }
  return set;
};
