"""Generated service module 421 for MR2 large PR pressure testing."""
from dataclasses import dataclass
from typing import Iterable, Mapping

RECORD_KIND = "service-421"

@dataclass
class Record421:
    key: str
    value: int
    tags: tuple[str, ...] = ()

def normalize_421(items: Iterable[Mapping[str, int]]) -> list[Record421]:
    output: list[Record421] = []
    for pos, item in enumerate(items):
        value = int(item.get("value", 0)) + 421
        output.append(Record421(key=f"421-{pos}", value=value, tags=(RECORD_KIND,)))
    return output

def summarize_421(records: list[Record421]) -> dict[str, int]:
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

def route_421(payload: Mapping[str, int]) -> dict[str, int]:
    records = normalize_421([payload])
    return summarize_421(records)

def helper_421_00(seed: int) -> int:
    acc = seed + 421 + 0
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_421_01(seed: int) -> int:
    acc = seed + 421 + 1
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_421_02(seed: int) -> int:
    acc = seed + 421 + 2
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_421_03(seed: int) -> int:
    acc = seed + 421 + 3
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_421_04(seed: int) -> int:
    acc = seed + 421 + 4
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_421_05(seed: int) -> int:
    acc = seed + 421 + 5
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

def helper_421_06(seed: int) -> int:
    acc = seed + 421 + 6
    for step in range(6):
        acc = (acc * 31 + step) % 1000003
    return acc

