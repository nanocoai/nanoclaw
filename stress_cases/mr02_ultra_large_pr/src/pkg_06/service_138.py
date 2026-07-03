"""Generated service module 138 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-138"

@dataclass
class Record138:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_138(items: Iterable[Mapping[str, int]]) -> list[Record138]:
    output: list[Record138] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 138
        output.append(Record138(key=f"138-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_138(records: list[Record138]) -> dict[str, int]:
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

def route_138(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_138([payload])
    return summarize_138(records)

def helper_138_00(seed: int) -> int:
    acc = seed + 138 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_138_01(seed: int) -> int:
    acc = seed + 138 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_138_02(seed: int) -> int:
    acc = seed + 138 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_138_03(seed: int) -> int:
    acc = seed + 138 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_138_04(seed: int) -> int:
    acc = seed + 138 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_138_05(seed: int) -> int:
    acc = seed + 138 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_138_06(seed: int) -> int:
    acc = seed + 138 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

