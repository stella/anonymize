export const PIPELINE_TO_MODEL: Record<string, readonly string[]> = {
  person: ["person", "full_name", "first_name", "middle_name", "last_name"],
  "phone number": ["phone_number"],
  address: ["address", "street_address"],
  "email address": ["email"],
  "date of birth": ["date_of_birth"],
  "bank account number": ["bank_account", "account_number"],
  iban: ["iban"],
  "tax identification number": ["tax_id", "tax_number"],
  "identity card number": ["government_id", "national_id_number"],
  "birth number": ["national_id_number"],
  "national identification number": ["national_id_number"],
  "social security number": ["national_id_number"],
  "credit card number": ["payment_card", "card_number"],
  "passport number": ["passport_number"],
  date: ["sensitive_date", "document_date", "expiration_date"],
};

const MODEL_TO_PIPELINE: Record<string, string> = {};
for (const [pipeline, models] of Object.entries(PIPELINE_TO_MODEL)) {
  for (const model of models) {
    if (!(model in MODEL_TO_PIPELINE)) {
      MODEL_TO_PIPELINE[model] = pipeline;
    }
  }
}

export const expandLabels = (pipelineLabels: readonly string[]): string[] => {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const label of pipelineLabels) {
    const modelLabels = PIPELINE_TO_MODEL[label];
    if (!modelLabels) continue;
    for (const ml of modelLabels) {
      if (!seen.has(ml)) {
        seen.add(ml);
        result.push(ml);
      }
    }
  }
  return result;
};

export const collapseLabel = (
  modelLabel: string,
  requestedPipelineLabels: ReadonlySet<string>,
): string => {
  const defaultLabel = MODEL_TO_PIPELINE[modelLabel];
  if (!defaultLabel) return modelLabel;

  if (requestedPipelineLabels.has(defaultLabel)) return defaultLabel;

  for (const [pipeline, models] of Object.entries(PIPELINE_TO_MODEL)) {
    if (models.includes(modelLabel) && requestedPipelineLabels.has(pipeline)) {
      return pipeline;
    }
  }

  return defaultLabel;
};
