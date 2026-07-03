"""Generated service module 305 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-305"

@dataclass
class Record305:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_305(items: Iterable[Mapping[str, int]]) -> list[Record305]:
    output: list[Record305] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 305
        output.append(Record305(key=f"305-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_305(records: list[Record305]) -> dict[str, int]:
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

def route_305(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_305([payload])
    return summarize_305(records)

def helper_305_00(seed: int) -> int:
    acc = seed + 305 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_305_01(seed: int) -> int:
    acc = seed + 305 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_305_02(seed: int) -> int:
    acc = seed + 305 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_305_03(seed: int) -> int:
    acc = seed + 305 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_305_04(seed: int) -> int:
    acc = seed + 305 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_305_05(seed: int) -> int:
    acc = seed + 305 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_305_06(seed: int) -> int:
    acc = seed + 305 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

