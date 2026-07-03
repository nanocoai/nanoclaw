"""Generated service module 130 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-130"

@dataclass
class Record130:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_130(items: Iterable[Mapping[str, int]]) -> list[Record130]:
    output: list[Record130] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 130
        output.append(Record130(key=f"130-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_130(records: list[Record130]) -> dict[str, int]:
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

def route_130(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_130([payload])
    return summarize_130(records)

def helper_130_00(seed: int) -> int:
    acc = seed + 130 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_130_01(seed: int) -> int:
    acc = seed + 130 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_130_02(seed: int) -> int:
    acc = seed + 130 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_130_03(seed: int) -> int:
    acc = seed + 130 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_130_04(seed: int) -> int:
    acc = seed + 130 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_130_05(seed: int) -> int:
    acc = seed + 130 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_130_06(seed: int) -> int:
    acc = seed + 130 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

