export type InferRequest = {
  text: string;
  labels: string[];
  threshold: number;
};

export type EntityOutput = {
  text: string;
  start: number;
  end: number;
  label: string;
  score: number;
};

export type InferResponse = {
  entities: EntityOutput[];
};

export type HealthResponse = {
  status: string;
  model_loaded: boolean;
  version: string;
};
