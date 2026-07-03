"""Generated service module 058 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-058"

@dataclass
class Record058:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_058(items: Iterable[Mapping[str, int]]) -> list[Record058]:
    output: list[Record058] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 58
        output.append(Record058(key=f"058-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_058(records: list[Record058]) -> dict[str, int]:
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

def route_058(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_058([payload])
    return summarize_058(records)

def helper_058_00(seed: int) -> int:
    acc = seed + 58 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_058_01(seed: int) -> int:
    acc = seed + 58 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_058_02(seed: int) -> int:
    acc = seed + 58 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_058_03(seed: int) -> int:
    acc = seed + 58 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_058_04(seed: int) -> int:
    acc = seed + 58 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_058_05(seed: int) -> int:
    acc = seed + 58 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_058_06(seed: int) -> int:
    acc = seed + 58 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

