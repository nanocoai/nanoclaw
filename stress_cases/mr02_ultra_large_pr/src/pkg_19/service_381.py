"""Generated service module 381 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-381"

@dataclass
class Record381:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_381(items: Iterable[Mapping[str, int]]) -> list[Record381]:
    output: list[Record381] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 381
        output.append(Record381(key=f"381-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_381(records: list[Record381]) -> dict[str, int]:
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

def route_381(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_381([payload])
    return summarize_381(records)

def helper_381_00(seed: int) -> int:
    acc = seed + 381 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_381_01(seed: int) -> int:
    acc = seed + 381 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_381_02(seed: int) -> int:
    acc = seed + 381 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_381_03(seed: int) -> int:
    acc = seed + 381 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_381_04(seed: int) -> int:
    acc = seed + 381 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_381_05(seed: int) -> int:
    acc = seed + 381 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_381_06(seed: int) -> int:
    acc = seed + 381 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

