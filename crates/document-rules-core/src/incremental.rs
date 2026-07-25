use std::collections::BTreeMap;
use std::sync::Arc;

use salsa::Setter as _;

use crate::engine::{
  AnalysisSnapshot, BlockAnalysis, ExecutionCounters, RuleEngine,
  analyze_block, run_block_rules, run_document_rules, run_neighborhood_rules,
  validate_findings,
};
use crate::model::{
  BlockId, Document, DocumentBlock, DocumentPatch, Error, Metadata, Result,
  Revision,
};
use crate::rule::{BlockFact, DocumentFacts, Finding, RuleSet};

#[salsa::input]
#[derive(Debug)]
struct BlockInput {
  #[returns(clone)]
  id: BlockId,
  #[returns(clone)]
  text: Arc<str>,
  #[returns(clone)]
  metadata: Metadata,
}

#[salsa::input]
#[derive(Debug)]
struct LinkInput {
  #[returns(clone)]
  before: Arc<[BlockInput]>,
  #[returns(clone)]
  after: Arc<[BlockInput]>,
}

#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
struct BlockRecord {
  block: BlockInput,
  links: LinkInput,
}

#[salsa::input]
struct DocumentInput {
  #[returns(clone)]
  blocks: Arc<[BlockRecord]>,
  #[returns(clone)]
  metadata: Metadata,
}

#[salsa::db]
trait DocumentDatabase: salsa::Database {
  fn rules(&self) -> &RuleSet;
  fn counters(&self) -> &ExecutionCounters;
}

#[salsa::db]
#[derive(Clone)]
struct Database {
  storage: salsa::Storage<Self>,
  rules: Arc<RuleSet>,
  counters: Arc<ExecutionCounters>,
}

impl Database {
  fn new(engine: &RuleEngine) -> Self {
    Self {
      storage: salsa::Storage::new(None),
      rules: Arc::clone(&engine.rules),
      counters: Arc::clone(&engine.counters),
    }
  }
}

#[salsa::db]
impl salsa::Database for Database {}

#[salsa::db]
impl DocumentDatabase for Database {
  fn rules(&self) -> &RuleSet {
    &self.rules
  }

  fn counters(&self) -> &ExecutionCounters {
    &self.counters
  }
}

#[salsa::tracked(returns(clone))]
fn tracked_block_analysis(
  db: &dyn DocumentDatabase,
  block: BlockInput,
) -> Result<Arc<BlockAnalysis>> {
  let document_block = DocumentBlock::with_metadata(
    block.id(db),
    block.text(db),
    block.metadata(db),
  )?;
  analyze_block(&document_block, db.counters())
}

#[salsa::tracked(returns(clone))]
fn tracked_block_findings(
  db: &dyn DocumentDatabase,
  block: BlockInput,
) -> Result<Arc<[Finding]>> {
  let analysis = tracked_block_analysis(db, block)?;
  Ok(run_block_rules(db.rules(), db.counters(), &analysis)?.into())
}

#[salsa::tracked(returns(clone))]
fn tracked_neighborhood_findings(
  db: &dyn DocumentDatabase,
  block: BlockInput,
  links: LinkInput,
) -> Result<Arc<[Finding]>> {
  let analysis = tracked_block_analysis(db, block)?;
  let before = links
    .before(db)
    .iter()
    .map(|neighbor| tracked_block_analysis(db, *neighbor))
    .collect::<Result<Vec<_>>>()?;
  let after = links
    .after(db)
    .iter()
    .map(|neighbor| tracked_block_analysis(db, *neighbor))
    .collect::<Result<Vec<_>>>()?;
  Ok(
    run_neighborhood_rules(
      db.rules(),
      db.counters(),
      &before,
      &analysis,
      &after,
    )?
    .into(),
  )
}

#[salsa::tracked(returns(clone))]
fn tracked_document_facts(
  db: &dyn DocumentDatabase,
  document: DocumentInput,
) -> Result<Arc<DocumentFacts>> {
  let records = document.blocks(db);
  let mut facts = Vec::with_capacity(records.len());
  for record in records.iter().copied() {
    let analysis = tracked_block_analysis(db, record.block)?;
    let local = tracked_block_findings(db, record.block)?;
    let neighborhood =
      tracked_neighborhood_findings(db, record.block, record.links)?;
    facts.push(BlockFact::new(
      &analysis,
      local.len().saturating_add(neighborhood.len()),
    ));
  }
  Ok(Arc::new(DocumentFacts::new(facts, document.metadata(db))))
}

#[salsa::tracked(returns(clone))]
fn tracked_document_findings(
  db: &dyn DocumentDatabase,
  document: DocumentInput,
) -> Result<Arc<[Finding]>> {
  let facts = tracked_document_facts(db, document)?;
  Ok(run_document_rules(db.rules(), db.counters(), &facts)?.into())
}

#[salsa::tracked(returns(clone))]
fn tracked_all_findings(
  db: &dyn DocumentDatabase,
  document: DocumentInput,
) -> Result<Arc<[Finding]>> {
  let records = document.blocks(db);
  let mut findings = Vec::new();
  for record in records.iter().copied() {
    findings.extend(tracked_block_findings(db, record.block)?.iter().cloned());
    findings.extend(
      tracked_neighborhood_findings(db, record.block, record.links)?
        .iter()
        .cloned(),
    );
  }
  findings.extend(tracked_document_findings(db, document)?.iter().cloned());
  Ok(findings.into())
}

pub struct IncrementalDocumentSession {
  database: Database,
  document_input: DocumentInput,
  records: BTreeMap<BlockId, BlockRecord>,
  document: Document,
  revision: Revision,
}

impl IncrementalDocumentSession {
  #[must_use]
  pub fn new(engine: &RuleEngine, document: Document) -> Self {
    let database = Database::new(engine);
    let (records, ordered) = create_records(&database, &document);
    let document_input = DocumentInput::new(
      &database,
      ordered.into(),
      document.metadata().clone(),
    );
    Self {
      database,
      document_input,
      records,
      document,
      revision: Revision::initial(),
    }
  }

  #[must_use]
  pub const fn revision(&self) -> Revision {
    self.revision
  }

  #[must_use]
  pub const fn document(&self) -> &Document {
    &self.document
  }

  pub fn analyze(&self) -> Result<AnalysisSnapshot> {
    let findings = tracked_all_findings(&self.database, self.document_input)?;
    validate_findings(&self.document, &findings)?;
    Ok(AnalysisSnapshot::new(self.revision, findings.to_vec()))
  }

  pub fn apply_patch(&mut self, patch: &DocumentPatch) -> Result<Revision> {
    if patch.expected_revision() != self.revision {
      return Err(Error::StaleRevision {
        expected: patch.expected_revision(),
        actual: self.revision,
      });
    }
    let next_document = self.document.apply_changes(patch.changes())?;
    if next_document == self.document {
      return Ok(self.revision);
    }
    let next_revision = self.revision.next()?;
    self.reconcile_inputs(&next_document);
    self.document = next_document;
    self.revision = next_revision;
    Ok(next_revision)
  }

  fn reconcile_inputs(&mut self, document: &Document) {
    let mut inputs = BTreeMap::<BlockId, BlockInput>::new();
    for block in document.blocks() {
      let input = match self.records.get(block.id()) {
        Some(record) => {
          if record.block.text(&self.database).as_ref() != block.text() {
            record
              .block
              .set_text(&mut self.database)
              .to(block.text_arc());
          }
          if record.block.metadata(&self.database) != *block.metadata() {
            record
              .block
              .set_metadata(&mut self.database)
              .to(block.metadata().clone());
          }
          record.block
        }
        None => BlockInput::new(
          &self.database,
          block.id().clone(),
          block.text_arc(),
          block.metadata().clone(),
        ),
      };
      inputs.insert(block.id().clone(), input);
    }

    let ordered_inputs = document
      .blocks()
      .iter()
      .filter_map(|block| inputs.get(block.id()).copied())
      .collect::<Vec<_>>();
    let mut next_records = BTreeMap::new();
    let mut ordered_records = Vec::with_capacity(ordered_inputs.len());
    let radius = self.database.rules().max_neighborhood_radius();
    for (position, block) in ordered_inputs.iter().copied().enumerate() {
      let id = block.id(&self.database);
      let (before, after) =
        neighborhood_inputs(&ordered_inputs, position, radius);
      let links = match self.records.get(&id) {
        Some(record) => {
          if record.links.before(&self.database) != before {
            record.links.set_before(&mut self.database).to(before);
          }
          if record.links.after(&self.database) != after {
            record.links.set_after(&mut self.database).to(after);
          }
          record.links
        }
        None => LinkInput::new(&self.database, before, after),
      };
      let record = BlockRecord { block, links };
      next_records.insert(id, record);
      ordered_records.push(record);
    }
    let ordered_records: Arc<[BlockRecord]> = ordered_records.into();
    if self.document_input.blocks(&self.database) != ordered_records {
      self
        .document_input
        .set_blocks(&mut self.database)
        .to(ordered_records);
    }
    if self.document_input.metadata(&self.database) != *document.metadata() {
      self
        .document_input
        .set_metadata(&mut self.database)
        .to(document.metadata().clone());
    }
    self.records = next_records;
  }
}

fn create_records(
  database: &Database,
  document: &Document,
) -> (BTreeMap<BlockId, BlockRecord>, Vec<BlockRecord>) {
  let inputs = document
    .blocks()
    .iter()
    .map(|block| {
      BlockInput::new(
        database,
        block.id().clone(),
        block.text_arc(),
        block.metadata().clone(),
      )
    })
    .collect::<Vec<_>>();
  let mut records = BTreeMap::new();
  let mut ordered = Vec::with_capacity(inputs.len());
  let radius = database.rules().max_neighborhood_radius();
  for (position, block) in inputs.iter().copied().enumerate() {
    let (before, after) = neighborhood_inputs(&inputs, position, radius);
    let links = LinkInput::new(database, before, after);
    let record = BlockRecord { block, links };
    records.insert(block.id(database), record);
    ordered.push(record);
  }
  (records, ordered)
}

fn neighborhood_inputs(
  inputs: &[BlockInput],
  position: usize,
  radius: usize,
) -> (Arc<[BlockInput]>, Arc<[BlockInput]>) {
  let before_start = position.saturating_sub(radius);
  let after_start = position.saturating_add(1).min(inputs.len());
  let after_end = after_start.saturating_add(radius).min(inputs.len());
  let before = inputs
    .get(before_start..position)
    .unwrap_or_default()
    .to_vec()
    .into();
  let after = inputs
    .get(after_start..after_end)
    .unwrap_or_default()
    .to_vec()
    .into();
  (before, after)
}
