"""Generated service module 041 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-041"

@dataclass
class Record041:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_041(items: Iterable[Mapping[str, int]]) -> list[Record041]:
    output: list[Record041] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 41
        output.append(Record041(key=f"041-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_041(records: list[Record041]) -> dict[str, int]:
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

def route_041(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_041([payload])
    return summarize_041(records)

def helper_041_00(seed: int) -> int:
    acc = seed + 41 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_041_01(seed: int) -> int:
    acc = seed + 41 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_041_02(seed: int) -> int:
    acc = seed + 41 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_041_03(seed: int) -> int:
    acc = seed + 41 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_041_04(seed: int) -> int:
    acc = seed + 41 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_041_05(seed: int) -> int:
    acc = seed + 41 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_041_06(seed: int) -> int:
    acc = seed + 41 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

