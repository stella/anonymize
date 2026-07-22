"""Model-free DataFog adapter for the anonymize benchmark.

Reads {"docs": [{"id","language","text"}, ...]} on stdin and emits native
DataFog entity labels and spans plus timings on stdout. Only DataFog's core
``regex`` engine is enabled: optional spaCy and GLiNER dependencies are neither
installed nor invoked.

The base structured detectors run for every document. German documents also
enable DataFog's upstream ``de`` locale, which adds its German structured-ID
detectors. Other language codes receive no locale-specific detector pack.
"""

import json
import sys
import time
from importlib.metadata import version as pkg_version

import datafog

BASE_DETECTORS = [
    "CREDIT_CARD",
    "DATE",
    "EMAIL",
    "IP_ADDRESS",
    "PHONE",
    "SSN",
    "ZIP_CODE",
]
GERMAN_DETECTORS = [
    "DE_IBAN",
    "DE_PASSPORT_NUMBER",
    "DE_POSTAL_CODE",
    "DE_RESIDENCE_PERMIT_NUMBER",
    "DE_SOCIAL_SECURITY_NUMBER",
    "DE_TAX_ID",
    "DE_VAT_ID",
]
LOCALES_BY_LANGUAGE = {"de": ["de"]}


def active_detectors(docs: list[dict]) -> list[str]:
    detectors = list(BASE_DETECTORS)
    if any(doc["language"] == "de" for doc in docs):
        detectors.extend(GERMAN_DETECTORS)
    return detectors


def scan_all(docs: list[dict]) -> list[dict]:
    results = []
    for doc in docs:
        text = doc["text"]
        scan = datafog.scan(
            text,
            engine="regex",
            locales=LOCALES_BY_LANGUAGE.get(doc["language"]),
        )
        entities = [
            {
                "start": entity.start,
                "end": entity.end,
                "label": entity.type,
                "text": text[entity.start : entity.end],
            }
            for entity in scan.entities
        ]
        results.append({"id": doc["id"], "entities": entities})
    return results


def main() -> None:
    job = json.load(sys.stdin)
    docs = job["docs"]

    # Import and module initialization happen before this point. The regex
    # engine itself has no separately constructed pipeline, so init is zero;
    # first-use compilation remains visible in the cold pass.
    init_seconds = 0.0

    cold_start = time.perf_counter()
    results = scan_all(docs)
    cold_seconds = time.perf_counter() - cold_start

    warm_start = time.perf_counter()
    scan_all(docs)
    warm_seconds = time.perf_counter() - warm_start

    json.dump(
        {
            "version": pkg_version("datafog"),
            "activeDetectors": active_detectors(docs),
            "initSeconds": init_seconds,
            "coldSeconds": cold_seconds,
            "warmSeconds": warm_seconds,
            "results": results,
        },
        sys.stdout,
    )


if __name__ == "__main__":
    main()
