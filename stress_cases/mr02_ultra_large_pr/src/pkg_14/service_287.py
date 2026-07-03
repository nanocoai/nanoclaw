"""Generated service module 287 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-287"

@dataclass
class Record287:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_287(items: Iterable[Mapping[str, int]]) -> list[Record287]:
    output: list[Record287] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 287
        output.append(Record287(key=f"287-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_287(records: list[Record287]) -> dict[str, int]:
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

def route_287(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_287([payload])
    return summarize_287(records)

def helper_287_00(seed: int) -> int:
    acc = seed + 287 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_287_01(seed: int) -> int:
    acc = seed + 287 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_287_02(seed: int) -> int:
    acc = seed + 287 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_287_03(seed: int) -> int:
    acc = seed + 287 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_287_04(seed: int) -> int:
    acc = seed + 287 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_287_05(seed: int) -> int:
    acc = seed + 287 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_287_06(seed: int) -> int:
    acc = seed + 287 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

