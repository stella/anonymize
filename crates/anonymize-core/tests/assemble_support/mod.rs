use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

pub const BASELINE_FIXTURE: &str = "baseline-all-on";

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ExpectedDelta {
  base: String,
  changes: Vec<ExpectedChange>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ExpectedChange {
  Array {
    path: Vec<String>,
    segments: Vec<ExpectedArraySegment>,
  },
  Remove {
    path: Vec<String>,
  },
  Set {
    path: Vec<String>,
    value: Value,
  },
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum ExpectedArraySegment {
  Copy { start: usize, end: usize },
  Values { values: Vec<Value> },
}

fn expected_path(dir: &Path, name: &str) -> PathBuf {
  if name == BASELINE_FIXTURE {
    return dir.join(format!("{name}.expected.json"));
  }
  dir.join(format!("{name}.expected.delta.json"))
}

fn read_value(path: &Path) -> Result<Value, String> {
  let text = fs::read_to_string(path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))
}

fn read_expected_delta(
  dir: &Path,
  name: &str,
) -> Result<ExpectedDelta, String> {
  let path = expected_path(dir, name);
  let text = fs::read_to_string(&path)
    .map_err(|error| format!("read {}: {error}", path.display()))?;
  let delta: ExpectedDelta = serde_json::from_str(&text)
    .map_err(|error| format!("parse {}: {error}", path.display()))?;
  if delta.base != BASELINE_FIXTURE {
    return Err(format!(
      "{}: unsupported delta base {:?}, expected {BASELINE_FIXTURE:?}",
      path.display(),
      delta.base
    ));
  }
  Ok(delta)
}

fn object_at_path_mut<'a>(
  mut value: &'a mut Value,
  path: &[String],
) -> Result<&'a mut Map<String, Value>, String> {
  for segment in path {
    value = value
      .as_object_mut()
      .and_then(|object| object.get_mut(segment))
      .ok_or_else(|| format!("delta path does not exist: {path:?}"))?;
  }
  value
    .as_object_mut()
    .ok_or_else(|| format!("delta path is not an object: {path:?}"))
}

fn apply_change(
  expected: &mut Value,
  change: ExpectedChange,
) -> Result<(), String> {
  match change {
    ExpectedChange::Array { mut path, segments } => {
      let key = path
        .pop()
        .ok_or_else(|| String::from("cannot replace the fixture root"))?;
      let parent = object_at_path_mut(expected, &path)?;
      let baseline = parent
        .get(&key)
        .and_then(Value::as_array)
        .ok_or_else(|| {
          format!("delta array path is not an array: {path:?}/{key}")
        })?
        .clone();
      let mut replacement = Vec::new();
      for segment in segments {
        match segment {
          ExpectedArraySegment::Copy { start, end } => {
            let values = baseline.get(start..end).ok_or_else(|| {
              format!(
                "delta copy range {start}..{end} exceeds array length {}",
                baseline.len()
              )
            })?;
            replacement.extend_from_slice(values);
          }
          ExpectedArraySegment::Values { values } => {
            replacement.extend(values);
          }
        }
      }
      parent.insert(key, Value::Array(replacement));
    }
    ExpectedChange::Remove { mut path } => {
      let key = path
        .pop()
        .ok_or_else(|| String::from("cannot remove the fixture root"))?;
      let parent = object_at_path_mut(expected, &path)?;
      if parent.remove(&key).is_none() {
        return Err(format!(
          "delta remove path does not exist: {path:?}/{key}"
        ));
      }
    }
    ExpectedChange::Set { mut path, value } => {
      let key = path
        .pop()
        .ok_or_else(|| String::from("cannot replace the fixture root"))?;
      object_at_path_mut(expected, &path)?.insert(key, value);
    }
  }
  Ok(())
}

fn value_key(value: &Value) -> Result<String, String> {
  serde_json::to_string(value)
    .map_err(|error| format!("serialize array item: {error}"))
}

fn push_copy_segment(
  segments: &mut Vec<ExpectedArraySegment>,
  start: usize,
  end: usize,
) {
  if let Some(ExpectedArraySegment::Copy {
    end: previous_end, ..
  }) = segments.last_mut()
    && *previous_end == start
  {
    *previous_end = end;
    return;
  }
  segments.push(ExpectedArraySegment::Copy { start, end });
}

fn push_value_segment(segments: &mut Vec<ExpectedArraySegment>, value: Value) {
  if let Some(ExpectedArraySegment::Values { values }) = segments.last_mut() {
    values.push(value);
    return;
  }
  segments.push(ExpectedArraySegment::Values {
    values: vec![value],
  });
}

fn array_segments(
  baseline: &[Value],
  actual: &[Value],
) -> Result<Vec<ExpectedArraySegment>, String> {
  let baseline_keys = baseline
    .iter()
    .map(value_key)
    .collect::<Result<Vec<_>, _>>()?;
  let mut baseline_indices = HashMap::<String, Vec<usize>>::new();
  for (index, key) in baseline_keys.iter().enumerate() {
    baseline_indices.entry(key.clone()).or_default().push(index);
  }
  let actual_keys = actual
    .iter()
    .map(value_key)
    .collect::<Result<Vec<_>, _>>()?;

  let mut segments = Vec::new();
  let mut remaining_actual = actual;
  let mut remaining_actual_keys = actual_keys.as_slice();
  let mut baseline_cursor = 0usize;
  while let (Some(actual_value), Some(key)) =
    (remaining_actual.first(), remaining_actual_keys.first())
  {
    if let Some(candidates) = baseline_indices.get(key)
      && let Some(&baseline_start) = candidates
        .get(candidates.partition_point(|index| *index < baseline_cursor))
        .or_else(|| candidates.first())
    {
      let baseline_tail =
        baseline_keys.get(baseline_start..).ok_or_else(|| {
          format!("baseline copy start {baseline_start} exceeds array length")
        })?;
      let length = baseline_tail
        .iter()
        .zip(remaining_actual_keys)
        .take_while(|(left, right)| left == right)
        .count();
      let baseline_end = baseline_start
        .checked_add(length)
        .ok_or_else(|| String::from("baseline copy end overflow"))?;
      push_copy_segment(&mut segments, baseline_start, baseline_end);
      baseline_cursor = baseline_end;
      remaining_actual = remaining_actual
        .get(length..)
        .ok_or_else(|| String::from("actual array copy exceeds length"))?;
      remaining_actual_keys = remaining_actual_keys
        .get(length..)
        .ok_or_else(|| String::from("actual array key copy exceeds length"))?;
      continue;
    }
    push_value_segment(&mut segments, actual_value.clone());
    remaining_actual = remaining_actual
      .get(1..)
      .ok_or_else(|| String::from("actual array advance exceeds length"))?;
    remaining_actual_keys = remaining_actual_keys
      .get(1..)
      .ok_or_else(|| String::from("actual array key advance exceeds length"))?;
  }
  Ok(segments)
}

fn build_changes(
  baseline: &Value,
  actual: &Value,
  path: &mut Vec<String>,
  changes: &mut Vec<ExpectedChange>,
) -> Result<(), String> {
  if baseline == actual {
    return Ok(());
  }

  match (baseline, actual) {
    (Value::Object(baseline), Value::Object(actual)) => {
      for (key, baseline_value) in baseline {
        path.push(key.clone());
        match actual.get(key) {
          Some(actual_value) => {
            build_changes(baseline_value, actual_value, path, changes)?;
          }
          None => changes.push(ExpectedChange::Remove { path: path.clone() }),
        }
        path.pop();
      }
      for (key, actual_value) in actual {
        if baseline.contains_key(key) {
          continue;
        }
        path.push(key.clone());
        changes.push(ExpectedChange::Set {
          path: path.clone(),
          value: actual_value.clone(),
        });
        path.pop();
      }
    }
    (Value::Array(baseline), Value::Array(actual)) => {
      changes.push(ExpectedChange::Array {
        path: path.clone(),
        segments: array_segments(baseline, actual)?,
      });
    }
    (_, actual) => changes.push(ExpectedChange::Set {
      path: path.clone(),
      value: actual.clone(),
    }),
  }
  Ok(())
}

pub fn write_expected_delta(
  dir: &Path,
  name: &str,
  baseline: &Value,
  actual: &Value,
) -> Result<(), String> {
  if name == BASELINE_FIXTURE {
    return Err(String::from(
      "refusing to generate the independent baseline oracle",
    ));
  }

  let mut changes = Vec::new();
  build_changes(baseline, actual, &mut Vec::new(), &mut changes)?;
  let delta = ExpectedDelta {
    base: String::from(BASELINE_FIXTURE),
    changes,
  };
  let mut reconstructed = baseline.clone();
  for change in delta.changes.clone() {
    apply_change(&mut reconstructed, change)?;
  }
  if reconstructed != *actual {
    return Err(format!(
      "{name}: generated delta does not reconstruct the actual config"
    ));
  }

  let path = expected_path(dir, name);
  let mut serialized = serde_json::to_string_pretty(&delta)
    .map_err(|error| format!("serialize {}: {error}", path.display()))?;
  serialized.push('\n');
  fs::write(&path, serialized)
    .map_err(|error| format!("write {}: {error}", path.display()))
}

fn is_omittable_serialized_default(value: &Value) -> bool {
  value.is_null()
    || value.as_array().is_some_and(Vec::is_empty)
    || value.as_object().is_some_and(Map::is_empty)
}

fn preserve_omitted_member(actual: &mut Value, path: &[String]) {
  let Some((key, parent_path)) = path.split_last() else {
    return;
  };
  let mut parent = actual;
  for segment in parent_path {
    let Some(next) = parent
      .as_object_mut()
      .and_then(|object| object.get_mut(segment))
    else {
      return;
    };
    parent = next;
  }
  let Some(object) = parent.as_object_mut() else {
    return;
  };
  if object.get(key).is_some_and(is_omittable_serialized_default) {
    object.remove(key);
  }
}

fn preserve_omitted_members(actual: &mut Value, changes: &[ExpectedChange]) {
  for change in changes {
    if let ExpectedChange::Remove { path } = change {
      preserve_omitted_member(actual, path);
    }
  }
}

/// Applies omission-only information from a prior frozen delta.
///
/// This retains intentional JSON omissions that serde represents as `null`,
/// `[]`, or `{}` without applying the stale delta to the new baseline.
pub fn preserve_omission_oracle(
  dir: &Path,
  name: &str,
  actual: &mut Value,
) -> Result<(), String> {
  if name == BASELINE_FIXTURE {
    return Ok(());
  }
  let delta = read_expected_delta(dir, name)?;
  preserve_omitted_members(actual, &delta.changes);
  Ok(())
}

pub fn read_expected_value(dir: &Path, name: &str) -> Result<Value, String> {
  if name == BASELINE_FIXTURE {
    return read_value(&expected_path(dir, name));
  }

  let delta = read_expected_delta(dir, name)?;

  let mut expected = read_value(&expected_path(dir, BASELINE_FIXTURE))?;
  for change in delta.changes {
    apply_change(&mut expected, change)?;
  }
  Ok(expected)
}

#[cfg(test)]
mod tests {
  use proptest::prelude::*;

  use super::*;

  fn structural_snapshot(member: Option<Value>) -> Value {
    let mut object = Map::new();
    if let Some(member) = member {
      object.insert(String::from("member"), member);
    }
    Value::Object(object)
  }

  #[test]
  fn delta_preserves_nulls_and_removes_fields() -> Result<(), String> {
    let mut reconstructed = serde_json::json!({
      "kept": {"value": 1, "removed": true},
      "changed": false,
      "items": [1, 2, 3]
    });
    let changes = [
      ExpectedChange::Array {
        path: vec![String::from("items")],
        segments: vec![
          ExpectedArraySegment::Copy { start: 1, end: 3 },
          ExpectedArraySegment::Values {
            values: vec![Value::from(4)],
          },
        ],
      },
      ExpectedChange::Remove {
        path: vec![String::from("kept"), String::from("removed")],
      },
      ExpectedChange::Set {
        path: vec![String::from("kept"), String::from("value")],
        value: Value::Null,
      },
      ExpectedChange::Set {
        path: vec![String::from("changed")],
        value: Value::Bool(true),
      },
    ];
    for change in changes {
      apply_change(&mut reconstructed, change)?;
    }
    assert_eq!(
      reconstructed,
      serde_json::json!({
        "kept": {"value": null},
        "changed": true,
        "items": [2, 3, 4]
      })
    );
    Ok(())
  }

  #[test]
  fn generated_delta_round_trips_reordered_and_inserted_arrays()
  -> Result<(), String> {
    let baseline = serde_json::json!({
      "kept": true,
      "removed": 1,
      "items": ["a", "b", "c", "d"]
    });
    let actual = serde_json::json!({
      "kept": false,
      "added": 2,
      "items": ["c", "d", "new", "a"]
    });
    let mut changes = Vec::new();
    build_changes(&baseline, &actual, &mut Vec::new(), &mut changes)?;
    let mut reconstructed = baseline;
    for change in changes {
      apply_change(&mut reconstructed, change)?;
    }
    assert_eq!(reconstructed, actual);
    Ok(())
  }

  #[test]
  fn generated_delta_preserves_absent_null_and_empty_members()
  -> Result<(), String> {
    let baseline = serde_json::json!({
      "removed_null": null,
      "removed_array": [],
      "removed_object": {},
      "nested": {
        "removed_null": null,
        "removed_array": [],
        "removed_object": {}
      }
    });
    let actual = serde_json::json!({
      "added_null": null,
      "added_array": [],
      "added_object": {},
      "nested": {
        "added_null": null,
        "added_array": [],
        "added_object": {}
      }
    });
    let mut changes = Vec::new();
    build_changes(&baseline, &actual, &mut Vec::new(), &mut changes)?;

    let mut reconstructed = baseline;
    for change in changes {
      apply_change(&mut reconstructed, change)?;
    }
    assert_eq!(reconstructed, actual);
    Ok(())
  }

  #[test]
  fn omission_oracle_preserves_omitted_null_and_empty_members() {
    let mut actual = serde_json::json!({
      "omitted_null": null,
      "explicit_null": null,
      "omitted_array": [],
      "explicit_array": [],
      "nested": {
        "omitted_object": {},
        "explicit_object": {}
      }
    });
    let changes = vec![
      ExpectedChange::Remove {
        path: vec![String::from("omitted_null")],
      },
      ExpectedChange::Remove {
        path: vec![String::from("omitted_array")],
      },
      ExpectedChange::Remove {
        path: vec![String::from("nested"), String::from("omitted_object")],
      },
    ];
    preserve_omitted_members(&mut actual, &changes);
    assert_eq!(
      actual,
      serde_json::json!({
        "explicit_null": null,
        "explicit_array": [],
        "nested": {"explicit_object": {}}
      })
    );
  }

  proptest! {
    #[test]
    fn generated_delta_round_trips_each_structural_member_state(
      baseline_member in prop_oneof![
        Just(None),
        Just(Some(Value::Null)),
        Just(Some(Value::Array(Vec::new()))),
        Just(Some(Value::Object(Map::new()))),
      ],
      actual_member in prop_oneof![
        Just(None),
        Just(Some(Value::Null)),
        Just(Some(Value::Array(Vec::new()))),
        Just(Some(Value::Object(Map::new()))),
      ],
    ) {
      let baseline = structural_snapshot(baseline_member);
      let actual = structural_snapshot(actual_member);
      let mut changes = Vec::new();
      prop_assert!(
        build_changes(&baseline, &actual, &mut Vec::new(), &mut changes).is_ok()
      );
      let mut reconstructed = baseline;
      for change in changes {
        prop_assert!(apply_change(&mut reconstructed, change).is_ok());
      }
      prop_assert_eq!(reconstructed, actual);
    }
  }

  #[test]
  fn array_delta_stops_at_a_shared_suffix() -> Result<(), String> {
    let baseline = vec![Value::from("prefix"), Value::from("suffix")];
    let actual = vec![Value::from("suffix")];
    let segments = array_segments(&baseline, &actual)?;
    let mut reconstructed = serde_json::json!({"items": baseline});
    apply_change(
      &mut reconstructed,
      ExpectedChange::Array {
        path: vec![String::from("items")],
        segments,
      },
    )?;
    assert_eq!(reconstructed, serde_json::json!({"items": actual}));
    Ok(())
  }
}
