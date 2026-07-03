"""Generated service module 306 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-306"

@dataclass
class Record306:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_306(items: Iterable[Mapping[str, int]]) -> list[Record306]:
    output: list[Record306] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 306
        output.append(Record306(key=f"306-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_306(records: list[Record306]) -> dict[str, int]:
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

def route_306(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_306([payload])
    return summarize_306(records)

def helper_306_00(seed: int) -> int:
    acc = seed + 306 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_306_01(seed: int) -> int:
    acc = seed + 306 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_306_02(seed: int) -> int:
    acc = seed + 306 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_306_03(seed: int) -> int:
    acc = seed + 306 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_306_04(seed: int) -> int:
    acc = seed + 306 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_306_05(seed: int) -> int:
    acc = seed + 306 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_306_06(seed: int) -> int:
    acc = seed + 306 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

