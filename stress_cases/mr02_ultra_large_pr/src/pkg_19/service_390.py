"""Generated service module 390 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-390"

@dataclass
class Record390:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_390(items: Iterable[Mapping[str, int]]) -> list[Record390]:
    output: list[Record390] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 390
        output.append(Record390(key=f"390-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_390(records: list[Record390]) -> dict[str, int]:
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

def route_390(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_390([payload])
    return summarize_390(records)

def helper_390_00(seed: int) -> int:
    acc = seed + 390 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_390_01(seed: int) -> int:
    acc = seed + 390 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_390_02(seed: int) -> int:
    acc = seed + 390 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_390_03(seed: int) -> int:
    acc = seed + 390 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_390_04(seed: int) -> int:
    acc = seed + 390 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_390_05(seed: int) -> int:
    acc = seed + 390 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_390_06(seed: int) -> int:
    acc = seed + 390 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

