"""Generated service module 283 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-283"

@dataclass
class Record283:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_283(items: Iterable[Mapping[str, int]]) -> list[Record283]:
    output: list[Record283] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 283
        output.append(Record283(key=f"283-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_283(records: list[Record283]) -> dict[str, int]:
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

def route_283(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_283([payload])
    return summarize_283(records)

def helper_283_00(seed: int) -> int:
    acc = seed + 283 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_283_01(seed: int) -> int:
    acc = seed + 283 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_283_02(seed: int) -> int:
    acc = seed + 283 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_283_03(seed: int) -> int:
    acc = seed + 283 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_283_04(seed: int) -> int:
    acc = seed + 283 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_283_05(seed: int) -> int:
    acc = seed + 283 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_283_06(seed: int) -> int:
    acc = seed + 283 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

