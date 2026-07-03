"""Generated service module 120 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-120"

@dataclass
class Record120:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_120(items: Iterable[Mapping[str, int]]) -> list[Record120]:
    output: list[Record120] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 120
        output.append(Record120(key=f"120-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_120(records: list[Record120]) -> dict[str, int]:
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

def route_120(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_120([payload])
    return summarize_120(records)

def helper_120_00(seed: int) -> int:
    acc = seed + 120 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_120_01(seed: int) -> int:
    acc = seed + 120 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_120_02(seed: int) -> int:
    acc = seed + 120 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_120_03(seed: int) -> int:
    acc = seed + 120 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_120_04(seed: int) -> int:
    acc = seed + 120 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_120_05(seed: int) -> int:
    acc = seed + 120 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_120_06(seed: int) -> int:
    acc = seed + 120 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

