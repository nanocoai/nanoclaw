"""Generated service module 376 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-376"

@dataclass
class Record376:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_376(items: Iterable[Mapping[str, int]]) -> list[Record376]:
    output: list[Record376] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 376
        output.append(Record376(key=f"376-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_376(records: list[Record376]) -> dict[str, int]:
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

def route_376(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_376([payload])
    return summarize_376(records)

def helper_376_00(seed: int) -> int:
    acc = seed + 376 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_376_01(seed: int) -> int:
    acc = seed + 376 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_376_02(seed: int) -> int:
    acc = seed + 376 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_376_03(seed: int) -> int:
    acc = seed + 376 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_376_04(seed: int) -> int:
    acc = seed + 376 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_376_05(seed: int) -> int:
    acc = seed + 376 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_376_06(seed: int) -> int:
    acc = seed + 376 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

