"""Generated service module 040 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-040"

@dataclass
class Record040:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_040(items: Iterable[Mapping[str, int]]) -> list[Record040]:
    output: list[Record040] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 40
        output.append(Record040(key=f"040-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_040(records: list[Record040]) -> dict[str, int]:
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

def route_040(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_040([payload])
    return summarize_040(records)

def helper_040_00(seed: int) -> int:
    acc = seed + 40 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_040_01(seed: int) -> int:
    acc = seed + 40 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_040_02(seed: int) -> int:
    acc = seed + 40 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_040_03(seed: int) -> int:
    acc = seed + 40 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_040_04(seed: int) -> int:
    acc = seed + 40 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_040_05(seed: int) -> int:
    acc = seed + 40 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_040_06(seed: int) -> int:
    acc = seed + 40 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

