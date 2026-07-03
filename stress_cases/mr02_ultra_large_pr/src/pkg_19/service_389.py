"""Generated service module 389 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-389"

@dataclass
class Record389:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_389(items: Iterable[Mapping[str, int]]) -> list[Record389]:
    output: list[Record389] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 389
        output.append(Record389(key=f"389-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_389(records: list[Record389]) -> dict[str, int]:
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

def route_389(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_389([payload])
    return summarize_389(records)

def helper_389_00(seed: int) -> int:
    acc = seed + 389 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_389_01(seed: int) -> int:
    acc = seed + 389 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_389_02(seed: int) -> int:
    acc = seed + 389 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_389_03(seed: int) -> int:
    acc = seed + 389 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_389_04(seed: int) -> int:
    acc = seed + 389 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_389_05(seed: int) -> int:
    acc = seed + 389 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_389_06(seed: int) -> int:
    acc = seed + 389 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

