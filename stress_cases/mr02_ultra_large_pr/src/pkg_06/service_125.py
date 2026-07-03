"""Generated service module 125 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-125"

@dataclass
class Record125:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_125(items: Iterable[Mapping[str, int]]) -> list[Record125]:
    output: list[Record125] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 125
        output.append(Record125(key=f"125-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_125(records: list[Record125]) -> dict[str, int]:
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

def route_125(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_125([payload])
    return summarize_125(records)

def helper_125_00(seed: int) -> int:
    acc = seed + 125 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_125_01(seed: int) -> int:
    acc = seed + 125 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_125_02(seed: int) -> int:
    acc = seed + 125 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_125_03(seed: int) -> int:
    acc = seed + 125 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_125_04(seed: int) -> int:
    acc = seed + 125 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_125_05(seed: int) -> int:
    acc = seed + 125 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_125_06(seed: int) -> int:
    acc = seed + 125 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

