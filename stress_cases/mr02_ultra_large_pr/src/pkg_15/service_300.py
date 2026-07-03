"""Generated service module 300 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-300"

@dataclass
class Record300:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_300(items: Iterable[Mapping[str, int]]) -> list[Record300]:
    output: list[Record300] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 300
        output.append(Record300(key=f"300-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_300(records: list[Record300]) -> dict[str, int]:
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

def route_300(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_300([payload])
    return summarize_300(records)

def helper_300_00(seed: int) -> int:
    acc = seed + 300 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_300_01(seed: int) -> int:
    acc = seed + 300 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_300_02(seed: int) -> int:
    acc = seed + 300 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_300_03(seed: int) -> int:
    acc = seed + 300 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_300_04(seed: int) -> int:
    acc = seed + 300 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_300_05(seed: int) -> int:
    acc = seed + 300 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_300_06(seed: int) -> int:
    acc = seed + 300 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

