"""Generated service module 398 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-398"

@dataclass
class Record398:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_398(items: Iterable[Mapping[str, int]]) -> list[Record398]:
    output: list[Record398] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 398
        output.append(Record398(key=f"398-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_398(records: list[Record398]) -> dict[str, int]:
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

def route_398(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_398([payload])
    return summarize_398(records)

def helper_398_00(seed: int) -> int:
    acc = seed + 398 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_398_01(seed: int) -> int:
    acc = seed + 398 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_398_02(seed: int) -> int:
    acc = seed + 398 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_398_03(seed: int) -> int:
    acc = seed + 398 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_398_04(seed: int) -> int:
    acc = seed + 398 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_398_05(seed: int) -> int:
    acc = seed + 398 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_398_06(seed: int) -> int:
    acc = seed + 398 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

