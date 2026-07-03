"""Generated service module 274 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-274"

@dataclass
class Record274:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_274(items: Iterable[Mapping[str, int]]) -> list[Record274]:
    output: list[Record274] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 274
        output.append(Record274(key=f"274-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_274(records: list[Record274]) -> dict[str, int]:
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

def route_274(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_274([payload])
    return summarize_274(records)

def helper_274_00(seed: int) -> int:
    acc = seed + 274 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_274_01(seed: int) -> int:
    acc = seed + 274 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_274_02(seed: int) -> int:
    acc = seed + 274 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_274_03(seed: int) -> int:
    acc = seed + 274 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_274_04(seed: int) -> int:
    acc = seed + 274 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_274_05(seed: int) -> int:
    acc = seed + 274 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_274_06(seed: int) -> int:
    acc = seed + 274 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

