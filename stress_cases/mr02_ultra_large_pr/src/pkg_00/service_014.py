"""Generated service module 014 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-014"

@dataclass
class Record014:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_014(items: Iterable[Mapping[str, int]]) -> list[Record014]:
    output: list[Record014] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 14
        output.append(Record014(key=f"014-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_014(records: list[Record014]) -> dict[str, int]:
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

def route_014(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_014([payload])
    return summarize_014(records)

def helper_014_00(seed: int) -> int:
    acc = seed + 14 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_014_01(seed: int) -> int:
    acc = seed + 14 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_014_02(seed: int) -> int:
    acc = seed + 14 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_014_03(seed: int) -> int:
    acc = seed + 14 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_014_04(seed: int) -> int:
    acc = seed + 14 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_014_05(seed: int) -> int:
    acc = seed + 14 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_014_06(seed: int) -> int:
    acc = seed + 14 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

