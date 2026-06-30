use crate::diagnostics::{DiagnosticEvent, StaticRedactionDiagnostics};
use crate::types::{Error, Result};

pub(super) type DiagnosticObserver<'a> =
  &'a mut dyn FnMut(&[DiagnosticEvent]) -> Result<()>;

pub(super) struct DiagnosticEventStream<'a> {
  observed_event_count: usize,
  observer: Option<DiagnosticObserver<'a>>,
}

impl<'a> DiagnosticEventStream<'a> {
  pub(super) const fn none() -> Self {
    Self {
      observed_event_count: 0,
      observer: None,
    }
  }

  pub(super) const fn observed(observer: DiagnosticObserver<'a>) -> Self {
    Self {
      observed_event_count: 0,
      observer: Some(observer),
    }
  }

  pub(super) fn observe(
    &mut self,
    diagnostics: Option<&StaticRedactionDiagnostics>,
  ) -> Result<()> {
    let Some(observer) = self.observer.as_deref_mut() else {
      return Ok(());
    };
    let Some(diagnostics) = diagnostics else {
      return Ok(());
    };
    let events = diagnostics
      .events
      .get(self.observed_event_count..)
      .ok_or_else(|| Error::InvalidStaticData {
        field: "diagnostics.events",
        reason: String::from("observed event cursor is out of bounds"),
      })?;
    if events.is_empty() {
      return Ok(());
    }
    observer(events)?;
    self.observed_event_count = diagnostics.events.len();
    Ok(())
  }
}
