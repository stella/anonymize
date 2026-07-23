#!/usr/bin/env python3
"""Pinned Nym multilingual PII model adapter for the assisted German lane.

The token-classification and BIO decoding shape follows nym's MIT-licensed
``src/engine/ner_token.rs`` at commit
56f6dac6454edb6349e60a8366047577ab10b4f5. This narrower Python adapter keeps
the model out of stella's default dependency graph and emits provider-native
code-point spans; TypeScript validates and imports those spans through
ExternalDetectionBatch v1 before stella resolves overlaps.
"""

import json
import math
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from huggingface_hub import hf_hub_download
from tokenizers import Tokenizer

MODEL_REPO = "Wismut/nym-pii-multilingual-small"
MODEL_REVISION = "4348999cd3c2e20c49615e9af7c6bbb45b64cd85"
MODEL_SUBFOLDER = "int8"
MODEL_FILE = "model_int8.onnx"
MODEL_VERSION = f"{MODEL_REPO}@{MODEL_REVISION}/{MODEL_SUBFOLDER}"
WINDOW_TOKENS = 480
WINDOW_OVERLAP = 64
THRESHOLD = 0.5


class NymModel:
    def __init__(self) -> None:
        files = {
            name: hf_hub_download(
                repo_id=MODEL_REPO,
                filename=f"{MODEL_SUBFOLDER}/{name}",
                revision=MODEL_REVISION,
            )
            for name in ("config.json", "tokenizer.json", MODEL_FILE)
        }
        self.tokenizer = Tokenizer.from_file(files["tokenizer.json"])
        # The serialized tokenizer carries training-time truncation. Windowing
        # below owns truncation so no tail can disappear silently.
        self.tokenizer.no_truncation()
        config = json.loads(Path(files["config.json"]).read_text())
        self.id2label = {
            int(label_id): label for label_id, label in config["id2label"].items()
        }
        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = ort.InferenceSession(
            files[MODEL_FILE], options, providers=["CPUExecutionProvider"]
        )
        self.inputs = {model_input.name for model_input in self.session.get_inputs()}

    def _chunks(self, text: str) -> list[tuple[str, int]]:
        encoding = self.tokenizer.encode(text, add_special_tokens=False)
        offsets = encoding.offsets
        if not offsets:
            return []
        if len(offsets) <= WINDOW_TOKENS:
            return [(text, 0)]

        chunks = []
        step = max(WINDOW_TOKENS - WINDOW_OVERLAP, 1)
        token_index = 0
        while token_index < len(offsets):
            end_index = min(token_index + WINDOW_TOKENS, len(offsets))
            start = offsets[token_index][0]
            end = offsets[end_index - 1][1]
            if start < end <= len(text):
                chunks.append((text[start:end], start))
            if end_index >= len(offsets):
                break
            token_index += step
        return chunks

    def _detect_chunk(self, text: str, offset: int) -> list[dict]:
        encoding = self.tokenizer.encode(text, add_special_tokens=True)
        input_ids = np.asarray([encoding.ids], dtype=np.int64)
        feed = {"input_ids": input_ids}
        if "attention_mask" in self.inputs:
            feed["attention_mask"] = np.asarray(
                [encoding.attention_mask], dtype=np.int64
            )
        if "token_type_ids" in self.inputs:
            feed["token_type_ids"] = np.zeros_like(input_ids)
        logits = self.session.run(None, feed)[0][0]
        predictions = logits.argmax(axis=-1)

        spans: list[dict] = []
        current: dict | None = None

        def push() -> None:
            nonlocal current
            if current is None:
                return
            start = current["start"]
            end = current["end"]
            while start < end and text[start].isspace():
                start += 1
            while end > start and text[end - 1].isspace():
                end -= 1
            if end > start:
                spans.append(
                    {
                        "start": start + offset,
                        "end": end + offset,
                        "label": current["label"],
                        "score": current["probability_sum"] / current["tokens"],
                    }
                )
            current = None

        for token_index, prediction in enumerate(predictions):
            if token_index >= len(encoding.offsets):
                break
            start, end = encoding.offsets[token_index]
            if start == end:
                continue
            label = self.id2label[int(prediction)]
            row = logits[token_index]
            maximum = float(row.max())
            denominator = float(np.exp(row - maximum).sum())
            probability = math.exp(float(row[int(prediction)]) - maximum) / denominator
            if label == "O" or probability < THRESHOLD:
                push()
                continue
            prefix, base_label = label.split("-", 1)
            if (
                current is not None
                and prefix == "I"
                and current["label"] == base_label
            ):
                current["end"] = end
                current["probability_sum"] += probability
                current["tokens"] += 1
            else:
                push()
                current = {
                    "start": start,
                    "end": end,
                    "label": base_label,
                    "probability_sum": probability,
                    "tokens": 1,
                }
        push()
        return spans

    def detect(self, text: str) -> list[dict]:
        found = [
            span
            for chunk, offset in self._chunks(text)
            for span in self._detect_chunk(chunk, offset)
        ]
        # Overlapping windows can yield the same provider span twice. Retain
        # the strongest exact duplicate and leave semantic overlap resolution
        # to stella's native caller-detection path.
        deduplicated: dict[tuple[int, int, str], dict] = {}
        for span in found:
            key = (span["start"], span["end"], span["label"])
            previous = deduplicated.get(key)
            if previous is None or span["score"] > previous["score"]:
                deduplicated[key] = span
        return sorted(
            deduplicated.values(), key=lambda span: (span["start"], -span["end"])
        )


def detect_all(model: NymModel, docs: list[dict]) -> list[dict]:
    results = []
    for doc in docs:
        if doc["language"] != "de":
            raise ValueError("the Nym assisted benchmark lane accepts German only")
        results.append({"id": doc["id"], "detections": model.detect(doc["text"])})
    return results


def main() -> None:
    job = json.load(sys.stdin)
    docs = job["docs"]

    init_start = time.perf_counter()
    model = NymModel()
    init_seconds = time.perf_counter() - init_start

    cold_start = time.perf_counter()
    results = detect_all(model, docs)
    cold_seconds = time.perf_counter() - cold_start

    warm_start = time.perf_counter()
    warm_results = detect_all(model, docs)
    warm_seconds = time.perf_counter() - warm_start
    if warm_results != results:
        raise RuntimeError("Nym ONNX inference was not deterministic across passes")

    json.dump(
        {
            "version": MODEL_VERSION,
            "initSeconds": init_seconds,
            "coldSeconds": cold_seconds,
            "warmSeconds": warm_seconds,
            "results": results,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
