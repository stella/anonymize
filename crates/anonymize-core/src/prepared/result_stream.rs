use crate::types::Result;

use super::results::StaticRedactionStreamEvent;

pub(super) type StaticRedactionResultObserver<'a> =
  &'a mut dyn FnMut(StaticRedactionStreamEvent<'_>) -> Result<()>;

pub(super) struct StaticRedactionResultStream<'a> {
  observer: Option<StaticRedactionResultObserver<'a>>,
}

impl<'a> StaticRedactionResultStream<'a> {
  pub(super) const fn none() -> Self {
    Self { observer: None }
  }

  pub(super) const fn observed(
    observer: StaticRedactionResultObserver<'a>,
  ) -> Self {
    Self {
      observer: Some(observer),
    }
  }

  pub(super) fn observe(
    &mut self,
    event: StaticRedactionStreamEvent<'_>,
  ) -> Result<()> {
    let Some(observer) = self.observer.as_deref_mut() else {
      return Ok(());
    };
    observer(event)
  }
}
