"""Generated service module 037 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-037"

@dataclass
class Record037:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_037(items: Iterable[Mapping[str, int]]) -> list[Record037]:
    output: list[Record037] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 37
        output.append(Record037(key=f"037-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_037(records: list[Record037]) -> dict[str, int]:
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

def route_037(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_037([payload])
    return summarize_037(records)

def helper_037_00(seed: int) -> int:
    acc = seed + 37 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_037_01(seed: int) -> int:
    acc = seed + 37 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_037_02(seed: int) -> int:
    acc = seed + 37 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_037_03(seed: int) -> int:
    acc = seed + 37 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_037_04(seed: int) -> int:
    acc = seed + 37 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_037_05(seed: int) -> int:
    acc = seed + 37 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_037_06(seed: int) -> int:
    acc = seed + 37 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

