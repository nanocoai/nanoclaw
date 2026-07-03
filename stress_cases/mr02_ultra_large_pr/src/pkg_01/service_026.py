"""Generated service module 026 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-026"

@dataclass
class Record026:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_026(items: Iterable[Mapping[str, int]]) -> list[Record026]:
    output: list[Record026] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 26
        output.append(Record026(key=f"026-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_026(records: list[Record026]) -> dict[str, int]:
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

def route_026(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_026([payload])
    return summarize_026(records)

def helper_026_00(seed: int) -> int:
    acc = seed + 26 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_026_01(seed: int) -> int:
    acc = seed + 26 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_026_02(seed: int) -> int:
    acc = seed + 26 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_026_03(seed: int) -> int:
    acc = seed + 26 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_026_04(seed: int) -> int:
    acc = seed + 26 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_026_05(seed: int) -> int:
    acc = seed + 26 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_026_06(seed: int) -> int:
    acc = seed + 26 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

