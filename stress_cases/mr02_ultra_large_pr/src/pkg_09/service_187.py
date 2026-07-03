"""Generated service module 187 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-187"

@dataclass
class Record187:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_187(items: Iterable[Mapping[str, int]]) -> list[Record187]:
    output: list[Record187] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 187
        output.append(Record187(key=f"187-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_187(records: list[Record187]) -> dict[str, int]:
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

def route_187(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_187([payload])
    return summarize_187(records)

def helper_187_00(seed: int) -> int:
    acc = seed + 187 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_187_01(seed: int) -> int:
    acc = seed + 187 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_187_02(seed: int) -> int:
    acc = seed + 187 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_187_03(seed: int) -> int:
    acc = seed + 187 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_187_04(seed: int) -> int:
    acc = seed + 187 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_187_05(seed: int) -> int:
    acc = seed + 187 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_187_06(seed: int) -> int:
    acc = seed + 187 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

