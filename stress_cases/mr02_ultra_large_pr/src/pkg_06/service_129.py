"""Generated service module 129 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-129"

@dataclass
class Record129:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_129(items: Iterable[Mapping[str, int]]) -> list[Record129]:
    output: list[Record129] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 129
        output.append(Record129(key=f"129-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_129(records: list[Record129]) -> dict[str, int]:
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

def route_129(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_129([payload])
    return summarize_129(records)

def helper_129_00(seed: int) -> int:
    acc = seed + 129 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_129_01(seed: int) -> int:
    acc = seed + 129 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_129_02(seed: int) -> int:
    acc = seed + 129 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_129_03(seed: int) -> int:
    acc = seed + 129 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_129_04(seed: int) -> int:
    acc = seed + 129 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_129_05(seed: int) -> int:
    acc = seed + 129 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_129_06(seed: int) -> int:
    acc = seed + 129 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

