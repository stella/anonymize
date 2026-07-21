"""Microsoft Presidio adapter for the anonymize benchmark.

Reads a JSON job on stdin: {"docs": [{"id","language","text"}, ...]}.
Emits a JSON result on stdout with native Presidio entity labels and spans,
plus init/cold/warm timings measured inside this process (so throughput
excludes interpreter and model-load startup, which is reported separately).

Configured generously and multilingually: per-language spaCy models for
person/organization/location/date, plus the language-agnostic pattern
recognizers (email, phone, credit card, IBAN, crypto) enabled for every
language. Czech uses the multilingual xx_ent_wiki_sm model, which has no DATE
entity; that limitation is reported, not hidden.
"""

import json
import sys
import time
from importlib.metadata import version as pkg_version

from presidio_analyzer import AnalyzerEngine, RecognizerRegistry
from presidio_analyzer.nlp_engine import NlpEngineProvider

LANG_MODELS = {
    "en": "en_core_web_lg",
    "de": "de_core_news_lg",
    "es": "es_core_news_lg",
    "cs": "xx_ent_wiki_sm",
}
LANGUAGES = list(LANG_MODELS.keys())


def build_analyzer() -> AnalyzerEngine:
    provider = NlpEngineProvider(
        nlp_configuration={
            "nlp_engine_name": "spacy",
            "models": [
                {"lang_code": lang, "model_name": model}
                for lang, model in LANG_MODELS.items()
            ],
        }
    )
    nlp_engine = provider.create_engine()
    registry = RecognizerRegistry(supported_languages=LANGUAGES)
    registry.load_predefined_recognizers(languages=LANGUAGES, nlp_engine=nlp_engine)
    return AnalyzerEngine(
        nlp_engine=nlp_engine,
        registry=registry,
        supported_languages=LANGUAGES,
    )


def analyze_all(analyzer: AnalyzerEngine, docs: list[dict]) -> list[dict]:
    results = []
    for doc in docs:
        language = doc["language"]
        if language not in LANGUAGES:
            raise ValueError(f"unsupported Presidio benchmark language: {language}")
        text = doc["text"]
        found = analyzer.analyze(text=text, language=language)
        entities = [
            {
                "start": r.start,
                "end": r.end,
                "label": r.entity_type,
                "text": text[r.start : r.end],
            }
            for r in found
        ]
        results.append({"id": doc["id"], "entities": entities})
    return results


def main() -> None:
    job = json.load(sys.stdin)
    docs = job["docs"]

    init_start = time.perf_counter()
    analyzer = build_analyzer()
    init_seconds = time.perf_counter() - init_start

    cold_start = time.perf_counter()
    results = analyze_all(analyzer, docs)
    cold_seconds = time.perf_counter() - cold_start

    warm_start = time.perf_counter()
    analyze_all(analyzer, docs)
    warm_seconds = time.perf_counter() - warm_start

    total_chars = sum(len(doc["text"]) for doc in docs)
    json.dump(
        {
            "version": pkg_version("presidio-analyzer"),
            "initSeconds": init_seconds,
            "coldSeconds": cold_seconds,
            "warmSeconds": warm_seconds,
            "totalChars": total_chars,
            "results": results,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
