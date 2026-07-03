"""Generated service module 388 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-388"

@dataclass
class Record388:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_388(items: Iterable[Mapping[str, int]]) -> list[Record388]:
    output: list[Record388] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 388
        output.append(Record388(key=f"388-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_388(records: list[Record388]) -> dict[str, int]:
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

def route_388(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_388([payload])
    return summarize_388(records)

def helper_388_00(seed: int) -> int:
    acc = seed + 388 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_388_01(seed: int) -> int:
    acc = seed + 388 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_388_02(seed: int) -> int:
    acc = seed + 388 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_388_03(seed: int) -> int:
    acc = seed + 388 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_388_04(seed: int) -> int:
    acc = seed + 388 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_388_05(seed: int) -> int:
    acc = seed + 388 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_388_06(seed: int) -> int:
    acc = seed + 388 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

