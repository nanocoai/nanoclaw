"""Generated service module 290 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-290"

@dataclass
class Record290:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_290(items: Iterable[Mapping[str, int]]) -> list[Record290]:
    output: list[Record290] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 290
        output.append(Record290(key=f"290-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_290(records: list[Record290]) -> dict[str, int]:
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

def route_290(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_290([payload])
    return summarize_290(records)

def helper_290_00(seed: int) -> int:
    acc = seed + 290 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_290_01(seed: int) -> int:
    acc = seed + 290 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_290_02(seed: int) -> int:
    acc = seed + 290 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_290_03(seed: int) -> int:
    acc = seed + 290 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_290_04(seed: int) -> int:
    acc = seed + 290 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_290_05(seed: int) -> int:
    acc = seed + 290 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_290_06(seed: int) -> int:
    acc = seed + 290 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

