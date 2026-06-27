use std::env;
use std::error::Error;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

const NATIVE_PACKAGE_SCOPED_PREFIX: &str = "native-pipeline.";
const NATIVE_PACKAGE_SUFFIX: &str = ".stlanonpkg";
const DEFAULT_NATIVE_PACKAGE: &str = "native-pipeline.stlanonpkg";

fn main() -> Result<(), Box<dyn Error>> {
  pyo3_build_config::add_extension_module_link_args();
  copy_generated_native_packages()?;
  Ok(())
}

#[allow(clippy::disallowed_macros)]
fn copy_generated_native_packages() -> io::Result<()> {
  let manifest_dir = env::var_os("CARGO_MANIFEST_DIR")
    .map(PathBuf::from)
    .ok_or_else(|| {
      io::Error::new(io::ErrorKind::NotFound, "CARGO_MANIFEST_DIR is unset")
    })?;
  let Some(repo_root) = manifest_dir.parent().and_then(Path::parent) else {
    return Ok(());
  };
  let source_dir = repo_root.join("packages").join("anonymize");
  println!("cargo:rerun-if-changed={}", source_dir.display());
  if !source_dir.exists() {
    return Ok(());
  }

  let target_dir = manifest_dir
    .join("python")
    .join("stella_anonymize")
    .join("native_packages");
  fs::create_dir_all(&target_dir)?;
  for entry in fs::read_dir(source_dir)? {
    let entry = entry?;
    let file_name = entry.file_name();
    let file_name = file_name.to_string_lossy();
    if !is_native_package_name(&file_name) {
      continue;
    }
    fs::copy(entry.path(), target_dir.join(file_name.as_ref()))?;
  }
  Ok(())
}

fn is_native_package_name(file_name: &str) -> bool {
  file_name == DEFAULT_NATIVE_PACKAGE
    || (file_name
      .strip_prefix(NATIVE_PACKAGE_SCOPED_PREFIX)
      .is_some()
      && file_name.ends_with(NATIVE_PACKAGE_SUFFIX))
}
