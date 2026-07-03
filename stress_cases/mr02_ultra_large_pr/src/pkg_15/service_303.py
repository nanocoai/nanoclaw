"""Generated service module 303 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-303"

@dataclass
class Record303:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_303(items: Iterable[Mapping[str, int]]) -> list[Record303]:
    output: list[Record303] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 303
        output.append(Record303(key=f"303-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_303(records: list[Record303]) -> dict[str, int]:
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

def route_303(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_303([payload])
    return summarize_303(records)

def helper_303_00(seed: int) -> int:
    acc = seed + 303 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_303_01(seed: int) -> int:
    acc = seed + 303 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_303_02(seed: int) -> int:
    acc = seed + 303 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_303_03(seed: int) -> int:
    acc = seed + 303 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_303_04(seed: int) -> int:
    acc = seed + 303 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_303_05(seed: int) -> int:
    acc = seed + 303 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_303_06(seed: int) -> int:
    acc = seed + 303 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

