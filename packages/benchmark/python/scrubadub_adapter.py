"""scrubadub adapter for the anonymize benchmark.

Reads {"docs": [{"id","language","text"}, ...]} on stdin and emits native
scrubadub filth types with spans plus timings on stdout.

scrubadub's base install detects email, phone, url, twitter, and credential
filth (name/organization/address/date detection needs the optional
scrubadub_spacy or scrubadub_stanford plugins, which are intentionally not
installed here so the comparison reflects the base library). The set of active
detectors is reported in `activeDetectors` so the report can state exactly what
scrubadub attempted.
"""

import json
import sys
import time

import scrubadub


def build_scrubber() -> scrubadub.Scrubber:
    return scrubadub.Scrubber()


def active_detectors(scrubber: scrubadub.Scrubber) -> list[str]:
    return sorted(scrubber._detectors.keys())


def scrub_all(scrubber: scrubadub.Scrubber, docs: list[dict]) -> list[dict]:
    results = []
    for doc in docs:
        text = doc["text"]
        entities = []
        for filth in scrubber.iter_filth(text):
            # MergedFilth exposes .filths; use the leaf type when available.
            filth_type = getattr(filth, "type", None) or "unknown"
            entities.append(
                {
                    "start": filth.beg,
                    "end": filth.end,
                    "label": filth_type,
                    "text": text[filth.beg : filth.end],
                }
            )
        results.append({"id": doc["id"], "entities": entities})
    return results


def main() -> None:
    job = json.load(sys.stdin)
    docs = job["docs"]

    init_start = time.perf_counter()
    scrubber = build_scrubber()
    init_seconds = time.perf_counter() - init_start

    cold_start = time.perf_counter()
    results = scrub_all(scrubber, docs)
    cold_seconds = time.perf_counter() - cold_start

    warm_start = time.perf_counter()
    scrub_all(scrubber, docs)
    warm_seconds = time.perf_counter() - warm_start

    total_chars = sum(len(doc["text"]) for doc in docs)
    json.dump(
        {
            "version": getattr(scrubadub, "__version__", "unknown"),
            "activeDetectors": active_detectors(scrubber),
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
