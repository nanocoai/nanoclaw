"""Generated service module 397 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-397"

@dataclass
class Record397:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_397(items: Iterable[Mapping[str, int]]) -> list[Record397]:
    output: list[Record397] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 397
        output.append(Record397(key=f"397-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_397(records: list[Record397]) -> dict[str, int]:
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

def route_397(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_397([payload])
    return summarize_397(records)

def helper_397_00(seed: int) -> int:
    acc = seed + 397 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_397_01(seed: int) -> int:
    acc = seed + 397 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_397_02(seed: int) -> int:
    acc = seed + 397 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_397_03(seed: int) -> int:
    acc = seed + 397 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_397_04(seed: int) -> int:
    acc = seed + 397 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_397_05(seed: int) -> int:
    acc = seed + 397 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_397_06(seed: int) -> int:
    acc = seed + 397 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

