"""Runs Microsoft Presidio over the bench contract corpus and writes
predictions in the bench interchange format (packages/bench/README.md).

Czech fixtures are skipped: Presidio has no Czech language support
(no spaCy model and no Czech recognizers); that absence is reported
in the results rather than scored as zero.

Offsets are converted from Python code-point indices to UTF-16 code
units to match the reference annotations.

Usage:
  python run.py [--out ../../results/predictions.presidio.json]
"""

import argparse
import json
from pathlib import Path

from presidio_analyzer import AnalyzerEngine
from presidio_analyzer.nlp_engine import NlpEngineProvider

LANGUAGE_MODELS = {"en": "en_core_web_lg", "de": "de_core_news_lg"}

LABEL_MAP = {
    "PERSON": "person",
    "ORGANIZATION": "organization",
    "EMAIL_ADDRESS": "email address",
    "PHONE_NUMBER": "phone number",
    "DATE_TIME": "date",
}

FIXTURES_DIR = (
    Path(__file__).resolve().parents[3]
    / "anonymize"
    / "src"
    / "__test__"
    / "fixtures"
    / "contracts"
)
DEFAULT_OUT = (
    Path(__file__).resolve().parents[2] / "results" / "predictions.presidio.json"
)


def utf16_offsets(text: str) -> list[int]:
    """Cumulative UTF-16 code-unit offset for each code-point index."""
    offsets = [0] * (len(text) + 1)
    for index, char in enumerate(text):
        offsets[index + 1] = offsets[index] + (2 if ord(char) > 0xFFFF else 1)
    return offsets


def build_analyzer() -> AnalyzerEngine:
    configuration = {
        "nlp_engine_name": "spacy",
        "models": [
            {"lang_code": lang, "model_name": model}
            for lang, model in LANGUAGE_MODELS.items()
        ],
        # Default Presidio config ignores ORG spans from spaCy; the
        # comparison needs organizations, so keep only the truly
        # non-PII tags ignored.
        "ner_model_configuration": {
            "labels_to_ignore": ["CARDINAL", "ORDINAL", "QUANTITY", "PERCENT"],
        },
    }
    provider = NlpEngineProvider(nlp_configuration=configuration)
    return AnalyzerEngine(
        nlp_engine=provider.create_engine(),
        supported_languages=list(LANGUAGE_MODELS),
    )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    analyzer = build_analyzer()
    docs = []
    for language_dir in sorted(FIXTURES_DIR.iterdir()):
        language = language_dir.name
        if language not in LANGUAGE_MODELS:
            print(f"skipping {language}: no Presidio language support")
            continue
        for fixture in sorted(language_dir.glob("*.txt")):
            text = fixture.read_text(encoding="utf-8").replace("\r\n", "\n")
            offsets = utf16_offsets(text)
            results = analyzer.analyze(
                text=text, language=language, entities=list(LABEL_MAP)
            )
            entities = [
                {
                    "start": offsets[result.start],
                    "end": offsets[result.end],
                    "label": LABEL_MAP[result.entity_type],
                }
                for result in results
            ]
            docs.append({"id": f"{language}/{fixture.name}", "entities": entities})
            print(f"{language}/{fixture.name}: {len(entities)} entities")

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"tool": "presidio", "docs": docs}, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"written: {args.out}")


if __name__ == "__main__":
    main()
