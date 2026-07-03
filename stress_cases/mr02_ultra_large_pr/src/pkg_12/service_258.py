"""Generated service module 258 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-258"

@dataclass
class Record258:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_258(items: Iterable[Mapping[str, int]]) -> list[Record258]:
    output: list[Record258] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 258
        output.append(Record258(key=f"258-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_258(records: list[Record258]) -> dict[str, int]:
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

def route_258(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_258([payload])
    return summarize_258(records)

def helper_258_00(seed: int) -> int:
    acc = seed + 258 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_258_01(seed: int) -> int:
    acc = seed + 258 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_258_02(seed: int) -> int:
    acc = seed + 258 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_258_03(seed: int) -> int:
    acc = seed + 258 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_258_04(seed: int) -> int:
    acc = seed + 258 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_258_05(seed: int) -> int:
    acc = seed + 258 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_258_06(seed: int) -> int:
    acc = seed + 258 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

