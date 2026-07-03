"""Generated service module 281 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-281"

@dataclass
class Record281:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_281(items: Iterable[Mapping[str, int]]) -> list[Record281]:
    output: list[Record281] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 281
        output.append(Record281(key=f"281-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_281(records: list[Record281]) -> dict[str, int]:
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

def route_281(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_281([payload])
    return summarize_281(records)

def helper_281_00(seed: int) -> int:
    acc = seed + 281 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_281_01(seed: int) -> int:
    acc = seed + 281 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_281_02(seed: int) -> int:
    acc = seed + 281 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_281_03(seed: int) -> int:
    acc = seed + 281 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_281_04(seed: int) -> int:
    acc = seed + 281 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_281_05(seed: int) -> int:
    acc = seed + 281 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_281_06(seed: int) -> int:
    acc = seed + 281 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

