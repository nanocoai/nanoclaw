"""Generated service module 013 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-013"

@dataclass
class Record013:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_013(items: Iterable[Mapping[str, int]]) -> list[Record013]:
    output: list[Record013] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 13
        output.append(Record013(key=f"013-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_013(records: list[Record013]) -> dict[str, int]:
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

def route_013(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_013([payload])
    return summarize_013(records)

def helper_013_00(seed: int) -> int:
    acc = seed + 13 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_013_01(seed: int) -> int:
    acc = seed + 13 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_013_02(seed: int) -> int:
    acc = seed + 13 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_013_03(seed: int) -> int:
    acc = seed + 13 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_013_04(seed: int) -> int:
    acc = seed + 13 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_013_05(seed: int) -> int:
    acc = seed + 13 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_013_06(seed: int) -> int:
    acc = seed + 13 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

