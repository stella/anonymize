//! Use the production acceptance policy without exposing a public runtime API.
// The production source shares its script class crate-wide.
#![allow(clippy::redundant_pub_crate)]

include!("../../src/gazetteer_policy.rs");
