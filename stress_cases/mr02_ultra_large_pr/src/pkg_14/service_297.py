"""Generated service module 297 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-297"

@dataclass
class Record297:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_297(items: Iterable[Mapping[str, int]]) -> list[Record297]:
    output: list[Record297] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 297
        output.append(Record297(key=f"297-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_297(records: list[Record297]) -> dict[str, int]:
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

def route_297(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_297([payload])
    return summarize_297(records)

def helper_297_00(seed: int) -> int:
    acc = seed + 297 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_297_01(seed: int) -> int:
    acc = seed + 297 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_297_02(seed: int) -> int:
    acc = seed + 297 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_297_03(seed: int) -> int:
    acc = seed + 297 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_297_04(seed: int) -> int:
    acc = seed + 297 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_297_05(seed: int) -> int:
    acc = seed + 297 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_297_06(seed: int) -> int:
    acc = seed + 297 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

