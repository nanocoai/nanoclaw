"""Generated service module 273 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-273"

@dataclass
class Record273:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_273(items: Iterable[Mapping[str, int]]) -> list[Record273]:
    output: list[Record273] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 273
        output.append(Record273(key=f"273-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_273(records: list[Record273]) -> dict[str, int]:
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

def route_273(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_273([payload])
    return summarize_273(records)

def helper_273_00(seed: int) -> int:
    acc = seed + 273 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_273_01(seed: int) -> int:
    acc = seed + 273 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_273_02(seed: int) -> int:
    acc = seed + 273 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_273_03(seed: int) -> int:
    acc = seed + 273 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_273_04(seed: int) -> int:
    acc = seed + 273 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_273_05(seed: int) -> int:
    acc = seed + 273 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_273_06(seed: int) -> int:
    acc = seed + 273 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

