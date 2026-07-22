"""Fresh-process performance worker for model-free Python providers."""

import hashlib
import importlib
import json
import sys
import time
from importlib.metadata import version as package_version


PROVIDER = sys.argv[1] if len(sys.argv) > 1 else ""
if PROVIDER not in {"scrubadub-base", "datafog-regex-only"}:
    raise ValueError("unknown Python performance provider")

print(json.dumps({"type": "ready"}), flush=True)
request = json.load(sys.stdin)
text = request["inputText"]


def identity(entities: list[dict]) -> tuple[int, str, dict[str, int]]:
    digest = hashlib.sha256()
    label_counts: dict[str, int] = {}
    for entity in entities:
        label = entity["label"]
        digest.update(
            f'{entity["start"]}\0{entity["end"]}\0{label}\n'.encode("utf-8")
        )
        label_counts[label] = label_counts.get(label, 0) + 1
    return len(entities), digest.hexdigest(), dict(sorted(label_counts.items()))


init_started = time.perf_counter()
if PROVIDER == "scrubadub-base":
    scrubadub = importlib.import_module("scrubadub")
    scrubber = scrubadub.Scrubber()
    provider_version = package_version("scrubadub")

    def detect() -> list[dict]:
        entities = []
        for filth in scrubber.iter_filth(text):
            leaves = getattr(filth, "filths", None) or [filth]
            for leaf in leaves:
                entities.append(
                    {
                        "start": leaf.beg,
                        "end": leaf.end,
                        "label": getattr(leaf, "type", None) or "unknown",
                    }
                )
        return entities

    scope = "base-install"
else:
    datafog = importlib.import_module("datafog")
    provider_version = package_version("datafog")

    def detect() -> list[dict]:
        scan = datafog.scan(text, engine="regex")
        return [
            {"start": entity.start, "end": entity.end, "label": entity.type}
            for entity in scan.entities
        ]

    scope = "regex-only"
init_seconds = time.perf_counter() - init_started

cold_started = time.perf_counter()
cold = detect()
cold_seconds = time.perf_counter() - cold_started
warm_started = time.perf_counter()
warm = detect()
warm_seconds = time.perf_counter() - warm_started
cold_identity = identity(cold)
warm_identity = identity(warm)
if cold_identity != warm_identity:
    raise RuntimeError("Python provider cold and warm outputs differ")

sample = {
    "provider": PROVIDER,
    "providerVersion": provider_version,
    "runtimeVersion": f"Python {sys.version.split()[0]}",
    "scope": scope,
    "inputBytes": request["inputBytes"],
    "inputCharacters": len(text),
    "inputSha256": request["inputSha256"],
    "outputCount": warm_identity[0],
    "outputDigest": warm_identity[1],
    "outputLabelCounts": warm_identity[2],
    "initSeconds": init_seconds,
    "coldSeconds": cold_seconds,
    "warmSeconds": warm_seconds,
}
print(json.dumps({"type": "result", "sample": sample}), flush=True)
