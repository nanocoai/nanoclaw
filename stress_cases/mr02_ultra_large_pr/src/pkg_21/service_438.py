"""Generated service module 438 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-438"

@dataclass
class Record438:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_438(items: Iterable[Mapping[str, int]]) -> list[Record438]:
    output: list[Record438] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 438
        output.append(Record438(key=f"438-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_438(records: list[Record438]) -> dict[str, int]:
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

def route_438(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_438([payload])
    return summarize_438(records)

def helper_438_00(seed: int) -> int:
    acc = seed + 438 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_438_01(seed: int) -> int:
    acc = seed + 438 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_438_02(seed: int) -> int:
    acc = seed + 438 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_438_03(seed: int) -> int:
    acc = seed + 438 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_438_04(seed: int) -> int:
    acc = seed + 438 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_438_05(seed: int) -> int:
    acc = seed + 438 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_438_06(seed: int) -> int:
    acc = seed + 438 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

