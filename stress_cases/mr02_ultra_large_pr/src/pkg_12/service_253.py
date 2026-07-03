"""Generated service module 253 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-253"

@dataclass
class Record253:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_253(items: Iterable[Mapping[str, int]]) -> list[Record253]:
    output: list[Record253] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 253
        output.append(Record253(key=f"253-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_253(records: list[Record253]) -> dict[str, int]:
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

def route_253(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_253([payload])
    return summarize_253(records)

def helper_253_00(seed: int) -> int:
    acc = seed + 253 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_253_01(seed: int) -> int:
    acc = seed + 253 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_253_02(seed: int) -> int:
    acc = seed + 253 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_253_03(seed: int) -> int:
    acc = seed + 253 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_253_04(seed: int) -> int:
    acc = seed + 253 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_253_05(seed: int) -> int:
    acc = seed + 253 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_253_06(seed: int) -> int:
    acc = seed + 253 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

