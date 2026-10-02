#![no_main]

use libfuzzer_sys::fuzz_target;

#[path = "../../crates/anonymize-core/tests/support/gazetteer.rs"]
mod gazetteer;
#[path = "../../crates/anonymize-core/tests/support/gazetteer_fuzz.rs"]
mod gazetteer_fuzz;
#[path = "../../crates/anonymize-core/tests/support/gazetteer_policy.rs"]
mod gazetteer_policy;
#[path = "../../crates/anonymize-core/tests/support/gazetteer_reference.rs"]
mod gazetteer_reference;

fuzz_target!(|data: &[u8]| gazetteer_fuzz::exercise(data));
