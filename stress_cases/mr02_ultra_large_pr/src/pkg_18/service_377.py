"""Generated service module 377 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-377"

@dataclass
class Record377:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_377(items: Iterable[Mapping[str, int]]) -> list[Record377]:
    output: list[Record377] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 377
        output.append(Record377(key=f"377-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_377(records: list[Record377]) -> dict[str, int]:
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

def route_377(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_377([payload])
    return summarize_377(records)

def helper_377_00(seed: int) -> int:
    acc = seed + 377 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_377_01(seed: int) -> int:
    acc = seed + 377 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_377_02(seed: int) -> int:
    acc = seed + 377 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_377_03(seed: int) -> int:
    acc = seed + 377 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_377_04(seed: int) -> int:
    acc = seed + 377 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_377_05(seed: int) -> int:
    acc = seed + 377 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_377_06(seed: int) -> int:
    acc = seed + 377 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

