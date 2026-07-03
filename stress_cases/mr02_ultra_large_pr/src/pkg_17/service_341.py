"""Generated service module 341 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-341"

@dataclass
class Record341:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_341(items: Iterable[Mapping[str, int]]) -> list[Record341]:
    output: list[Record341] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 341
        output.append(Record341(key=f"341-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_341(records: list[Record341]) -> dict[str, int]:
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

def route_341(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_341([payload])
    return summarize_341(records)

def helper_341_00(seed: int) -> int:
    acc = seed + 341 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_341_01(seed: int) -> int:
    acc = seed + 341 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_341_02(seed: int) -> int:
    acc = seed + 341 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_341_03(seed: int) -> int:
    acc = seed + 341 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_341_04(seed: int) -> int:
    acc = seed + 341 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_341_05(seed: int) -> int:
    acc = seed + 341 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_341_06(seed: int) -> int:
    acc = seed + 341 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

