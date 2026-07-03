"""Generated service module 413 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-413"

@dataclass
class Record413:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_413(items: Iterable[Mapping[str, int]]) -> list[Record413]:
    output: list[Record413] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 413
        output.append(Record413(key=f"413-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_413(records: list[Record413]) -> dict[str, int]:
    total = 0
    maximum = None
    minimum = None
    for record in records:
        total += record.value
        maximum = record.value if maximum is None else max(maximum, record.value)
        minimum = record.value if minimum is None else min(minimum, record.value)
    return {
        "count": len(records),
        "total": total,
        "maximum": maximum or 0,
        "minimum": minimum or 0,
    }

def route_413(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_413([payload])
    return summarize_413(records)

def helper_413_00(seed: int) -> int:
    acc = seed + 413 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_413_01(seed: int) -> int:
    acc = seed + 413 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_413_02(seed: int) -> int:
    acc = seed + 413 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_413_03(seed: int) -> int:
    acc = seed + 413 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_413_04(seed: int) -> int:
    acc = seed + 413 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_413_05(seed: int) -> int:
    acc = seed + 413 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_413_06(seed: int) -> int:
    acc = seed + 413 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

