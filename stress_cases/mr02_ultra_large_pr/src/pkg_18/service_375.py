"""Generated service module 375 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-375"

@dataclass
class Record375:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_375(items: Iterable[Mapping[str, int]]) -> list[Record375]:
    output: list[Record375] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 375
        output.append(Record375(key=f"375-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_375(records: list[Record375]) -> dict[str, int]:
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

def route_375(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_375([payload])
    return summarize_375(records)

def helper_375_00(seed: int) -> int:
    acc = seed + 375 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_375_01(seed: int) -> int:
    acc = seed + 375 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_375_02(seed: int) -> int:
    acc = seed + 375 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_375_03(seed: int) -> int:
    acc = seed + 375 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_375_04(seed: int) -> int:
    acc = seed + 375 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_375_05(seed: int) -> int:
    acc = seed + 375 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_375_06(seed: int) -> int:
    acc = seed + 375 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

