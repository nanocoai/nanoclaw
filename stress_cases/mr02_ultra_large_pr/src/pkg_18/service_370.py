"""Generated service module 370 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-370"

@dataclass
class Record370:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_370(items: Iterable[Mapping[str, int]]) -> list[Record370]:
    output: list[Record370] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 370
        output.append(Record370(key=f"370-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_370(records: list[Record370]) -> dict[str, int]:
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

def route_370(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_370([payload])
    return summarize_370(records)

def helper_370_00(seed: int) -> int:
    acc = seed + 370 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_370_01(seed: int) -> int:
    acc = seed + 370 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_370_02(seed: int) -> int:
    acc = seed + 370 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_370_03(seed: int) -> int:
    acc = seed + 370 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_370_04(seed: int) -> int:
    acc = seed + 370 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_370_05(seed: int) -> int:
    acc = seed + 370 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_370_06(seed: int) -> int:
    acc = seed + 370 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

