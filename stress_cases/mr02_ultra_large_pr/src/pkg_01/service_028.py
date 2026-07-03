"""Generated service module 028 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-028"

@dataclass
class Record028:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_028(items: Iterable[Mapping[str, int]]) -> list[Record028]:
    output: list[Record028] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 28
        output.append(Record028(key=f"028-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_028(records: list[Record028]) -> dict[str, int]:
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

def route_028(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_028([payload])
    return summarize_028(records)

def helper_028_00(seed: int) -> int:
    acc = seed + 28 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_028_01(seed: int) -> int:
    acc = seed + 28 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_028_02(seed: int) -> int:
    acc = seed + 28 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_028_03(seed: int) -> int:
    acc = seed + 28 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_028_04(seed: int) -> int:
    acc = seed + 28 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_028_05(seed: int) -> int:
    acc = seed + 28 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_028_06(seed: int) -> int:
    acc = seed + 28 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

