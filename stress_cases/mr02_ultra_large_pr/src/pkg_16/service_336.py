"""Generated service module 336 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-336"

@dataclass
class Record336:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_336(items: Iterable[Mapping[str, int]]) -> list[Record336]:
    output: list[Record336] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 336
        output.append(Record336(key=f"336-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_336(records: list[Record336]) -> dict[str, int]:
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

def route_336(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_336([payload])
    return summarize_336(records)

def helper_336_00(seed: int) -> int:
    acc = seed + 336 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_336_01(seed: int) -> int:
    acc = seed + 336 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_336_02(seed: int) -> int:
    acc = seed + 336 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_336_03(seed: int) -> int:
    acc = seed + 336 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_336_04(seed: int) -> int:
    acc = seed + 336 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_336_05(seed: int) -> int:
    acc = seed + 336 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_336_06(seed: int) -> int:
    acc = seed + 336 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

