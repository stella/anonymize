#![allow(clippy::redundant_pub_crate)]

//! Shared adapter contract between the Rust core and the host-language
//! bindings (Node, Python, WASM).
//!
//! Module map:
//! - `error`: typed error surface (`ContractError`, `Result`).
//! - `caller`: versioned caller-detection requests and offset handling.
//! - `types`: binding-facing configuration and operator DTOs.
//! - `config`: binding DTO to core prepared-engine config conversion.
//! - `results`: core result/diagnostic conversion back to binding DTOs.
//! - `offsets`: UTF-8/UTF-16/character offset maps.
//! - `names`: stable string names for core enums.
//! - `package`: prepared search package encode/decode (headers,
//!   versions, digests, compression, payload codec).
//! - `assemble`: static search config assembly from data files.

mod assemble;
pub(crate) mod caller;
pub(crate) mod config;
pub(crate) mod error;
pub(crate) mod names;
pub(crate) mod offsets;
pub(crate) mod package;
pub(crate) mod results;
pub(crate) mod types;

pub use assemble::{
  FIELDS_IMPLEMENTED, FIELDS_PENDING, assemble_static_search_config,
};
pub use caller::*;
pub use config::*;
pub use error::*;
pub use package::*;
pub use results::*;
pub use types::*;
