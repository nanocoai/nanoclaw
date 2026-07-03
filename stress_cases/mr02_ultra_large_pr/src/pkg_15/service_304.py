"""Generated service module 304 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-304"

@dataclass
class Record304:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_304(items: Iterable[Mapping[str, int]]) -> list[Record304]:
    output: list[Record304] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 304
        output.append(Record304(key=f"304-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_304(records: list[Record304]) -> dict[str, int]:
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

def route_304(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_304([payload])
    return summarize_304(records)

def helper_304_00(seed: int) -> int:
    acc = seed + 304 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_304_01(seed: int) -> int:
    acc = seed + 304 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_304_02(seed: int) -> int:
    acc = seed + 304 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_304_03(seed: int) -> int:
    acc = seed + 304 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_304_04(seed: int) -> int:
    acc = seed + 304 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_304_05(seed: int) -> int:
    acc = seed + 304 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_304_06(seed: int) -> int:
    acc = seed + 304 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

